// ABOUTME: Исполняет устойчивый lifecycle v1 через порты журнала и модели.
// ABOUTME: Не хранит исходный state и не возобновляет вычисление после сбоя.
import { createHash } from "node:crypto";
import { Failure } from "./core.js";
import { catalogVersion, getModel } from "./catalog.js";
import { validDecideRequest, validDecideUpstream } from "./v1-schema.js";
export const V1_LIMITS = Object.freeze({requestBytes:65536,resultBytes:65536,depth:32,concurrency:2,controlConcurrency:8,keyTtlMs:7*86400000,resultTtlMs:86400000,maxRows:100000});
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type Question = {type:"noul"|"choice"|"score";instructions: string;criteria?: Json};
export type DecideRequest = {operationId:string;ownerId:string;provider:string;model:string;state:string|Json[]|{[key:string]:Json};questions:Record<string,Question>;deadlineAt:string};
export type DecideUpstream = {model:string;answers:Record<string,Record<string,Json>>;usage?: {input_tokens:number;output_tokens:number}|null};
export type DecideV1Port = (request:DecideRequest,signal:AbortSignal)=>Promise<DecideUpstream>;
export type Phase = "accepted"|"dispatching"|"succeeded"|"failed"|"cancelled"|"outcome_unknown";
export type Operation = {operationId:string;ownerId:string;inputHash:string;phase:Phase;cancelRequested:boolean;createdAt:number;finishedAt:number|null;keyExpiresAt:number;resultExpiresAt:number|null;route:{provider:string;model:string;catalogVersion:string};result:Json|null;errorCode:string|null};
/** Все изменения атомарны. claim коммитится до model port; finish не меняет чужой финал. */
export interface OperationStore {
  find(ownerId:string,operationId:string,now:number):Promise<Operation|null>;
  accept(operation:Operation):Promise<{operation:Operation;inserted:boolean}>;
  claim(ownerId:string,operationId:string,inputHash:string):Promise<boolean>;
  finish(ownerId:string,operationId:string,phase:Phase,result:Json|null,errorCode:string|null,now:number,inputHash:string):Promise<void>;
  cancel(ownerId:string,operationId:string,now:number):Promise<Operation|null>;
  recover(now:number):Promise<void>;
  sweep(now:number):Promise<void>;
}
/** Канонические JSON bytes: порядок object keys не влияет, порядок arrays сохраняется. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(",")}}`;
}
/** Ограничивает весь JSON до рекурсивной валидации и хеширования. */
export function boundedJson(value: unknown, depth=0): boolean {
  if (depth > V1_LIMITS.depth) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !value.includes("\u0000") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  return Object.keys(value).every(k=>!k.includes("\u0000")) && Object.values(value).every(v=>boundedJson(v,depth+1));
}
/** Удаляет внутренний hash, скрывает истёкший итог и честно сообщает неопределённость отмены. */
export function operationView(operation:Operation,now:number) {
  const {inputHash,...view}=operation;
  const resultExpired=operation.resultExpiresAt !== null && now>=operation.resultExpiresAt;
  return {...view,result:resultExpired?null:operation.result,resultExpired,billingMayContinue:operation.cancelRequested && operation.phase!=="cancelled"};
}
/** Сверяет все вопросы и сохраняет distributions/legend/confidence без нормализации. */
export function checkAnswer(request:DecideRequest,result:DecideUpstream) {
  if (!boundedJson(result) || !validDecideUpstream(result) || result.model!==request.model || canonical(Object.keys(result.answers).sort())!==canonical(Object.keys(request.questions).sort())) throw new Failure("UPSTREAM_PROTOCOL","unknown");
  for (const [key,q] of Object.entries(request.questions)) {
    const a=result.answers[key];
    if (a.type!==q.type) throw new Failure("UPSTREAM_PROTOCOL","unknown");
    if (q.type==="choice" || q.type==="score") {
      const criteria=q.criteria as Record<string,Json>|Json[];
      const expected=Object.keys(criteria).sort();
      const probabilities=a.probabilities as Record<string,number>;
      if (canonical(Object.keys(probabilities).sort())!==canonical(expected) || Math.abs(Object.values(probabilities).reduce((sum,p)=>sum+p,0)-1)>0.000001) throw new Failure("UPSTREAM_PROTOCOL","unknown");
      if (q.type==="choice" && (!Object.hasOwn(criteria,a.choice as string) || probabilities[a.choice as string]<Math.max(...Object.values(probabilities)))) throw new Failure("UPSTREAM_PROTOCOL","unknown");
      if (q.type==="score" && (canonical(Object.keys(a.legend as object).sort())!==canonical(expected) || (a.score as number)>(criteria as Json[]).length-1)) throw new Failure("UPSTREAM_PROTOCOL","unknown");
    }
  }
}
/** Два вычисления без очереди; повторы присоединяются только к принятию своего ключа. */
export function createOperations(store:OperationStore,port:DecideV1Port,options:{now?:()=>number;lookupModel?:typeof getModel;deadlineMs?:number}={}) {
  const now=options.now ?? Date.now,lookup=options.lookupModel ?? getModel;
  const maximum=options.deadlineMs ?? 30000;
  if (!Number.isInteger(maximum) || maximum<1 || maximum>30000) throw new Error("INVALID_DEADLINE");
  let active=0,admitting=0,healthy=true;
  const accepting=new Map<string,{hash:string;promise:Promise<Operation>}>();
  const running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  const identity=(owner:string,id:string)=>JSON.stringify([owner,id]);
  async function execute(input:DecideRequest,key:string,hash:string,deadlineMs:number) {
    const controller=running.get(key)!.controller;
    let timer:ReturnType<typeof setTimeout>|undefined,claimed=false;
    try {
      // AIDEV-NOTE: Cancel и этот CAS сериализованы БД. Nonce создаётся только после commit.
      if (!(await store.claim(input.ownerId,input.operationId,hash))) return;
      claimed=true;
      const remaining=Math.min(Date.parse(input.deadlineAt)-now(),deadlineMs);
      if (remaining<=0) {await store.finish(input.ownerId,input.operationId,"failed",null,"DEADLINE_EXCEEDED",now(),hash);return;}
      timer=setTimeout(()=>controller.abort(),remaining);
      const result=await port(input,controller.signal);
      if(controller.signal.aborted || now()>=Date.parse(input.deadlineAt)) throw new Failure("OUTCOME_UNKNOWN","unknown");
      checkAnswer(input,result);
      const output={provider:input.provider,requestedModel:input.model,actualModel:result.model,answers:result.answers,usage:result.usage==null?null:{inputTokens:result.usage.input_tokens,outputTokens:result.usage.output_tokens}} as Json;
      if(Buffer.byteLength(JSON.stringify(output))>V1_LIMITS.resultBytes) throw new Failure("UPSTREAM_PROTOCOL","unknown");
      await store.finish(input.ownerId,input.operationId,"succeeded",output,null,now(),hash);
    } catch(error) {
      const failure=error instanceof Failure?error:new Failure("OUTCOME_UNKNOWN",claimed?"unknown":"not_sent");
      try {await store.finish(input.ownerId,input.operationId,failure.outcome==="unknown"?"outcome_unknown":"failed",null,failure.code,now(),hash);} catch {healthy=false;}
    } finally {if(timer)clearTimeout(timer);active--;running.delete(key);}
  }
  async function accept(input:DecideRequest,hash:string,key:string) {
    const old=await store.find(input.ownerId,input.operationId,now());
    if(old){if(old.inputHash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");return old;}
    if(!healthy)throw new Failure("STORAGE_UNAVAILABLE","not_sent");
    const card=lookup(input.provider,input.model);
    if(!card)throw new Failure("MODEL_NOT_ALLOWED","not_sent");
    if(!card.capabilities.includes("decide"))throw new Failure("UNSUPPORTED_OPERATION","not_sent");
    if(Date.parse(input.deadlineAt)<=now())throw new Failure("DEADLINE_EXCEEDED","not_sent");
    if(active>=V1_LIMITS.concurrency)throw new Failure("OVERLOADED","not_sent");
    active++;
    let held=true;
    try {
      const createdAt=now();
      const fresh:Operation={operationId:input.operationId,ownerId:input.ownerId,inputHash:hash,phase:"accepted",cancelRequested:false,createdAt,finishedAt:null,keyExpiresAt:createdAt+V1_LIMITS.keyTtlMs,resultExpiresAt:null,route:{provider:input.provider,model:input.model,catalogVersion},result:null,errorCode:null};
      const accepted=await store.accept(fresh);
      if(accepted.operation.inputHash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");
      if(accepted.inserted){
        held=false;
        // AIDEV-NOTE: Один setImmediate на принятый слот, никакой очереди вычислений.
        const done=new Promise<void>(resolve=>setImmediate(()=>{void execute(input,key,hash,Math.min(maximum,card.deadlineMs)).finally(resolve);}));
        running.set(key,{controller:new AbortController(),done});
      }
      return accepted.operation;
    } finally {if(held)active--;}
  }
  return {
    /** Проверяет неизменяемый wire, затем durable replay до чтения каталога. */
    async invoke(input:DecideRequest) {
      if(!boundedJson(input) || Buffer.byteLength(JSON.stringify(input))>V1_LIMITS.requestBytes || !validDecideRequest(input))throw new Failure("INVALID_REQUEST","not_sent");
      const snapshot=structuredClone(input),key=identity(input.ownerId,input.operationId);
      const hash=createHash("sha256").update(canonical(snapshot)).digest("hex");
      if(admitting>=V1_LIMITS.controlConcurrency)throw new Failure("OVERLOADED","not_sent");
      admitting++;
      try {
        const pending=accepting.get(key);
        if(pending){if(pending.hash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");return operationView(await pending.promise,now());}
        const promise=accept(snapshot,hash,key);accepting.set(key,{hash,promise});
        try{return operationView(await promise,now());}finally{accepting.delete(key);}
      } finally {admitting--;}

    },
    /** Owner обязателен; чужая операция неотличима от отсутствующей. */
    async get(owner:string,id:string){const op=await store.find(owner,id,now());if(!op)throw new Failure("NOT_FOUND","not_sent");return operationView(op,now());},
    /** До dispatch подтверждает отмену; после него прекращение списания не обещает. */
    async cancel(owner:string,id:string){const op=await store.cancel(owner,id,now());if(!op)throw new Failure("NOT_FOUND","not_sent");if(op.phase==="dispatching")running.get(identity(owner,id))?.controller.abort();return operationView(op,now());},
    status(){return {ready:healthy,active,capacity:V1_LIMITS.concurrency,waiting:0};},
    /** Ожидает собственные локальные действия, без новой отправки. */
    async idle(){await Promise.all([...running.values()].map(e=>e.done));}
  };
}
export type Operations = ReturnType<typeof createOperations>;
