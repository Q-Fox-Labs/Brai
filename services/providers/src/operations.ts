// ABOUTME: Исполняет устойчивый lifecycle v1 через порты журнала и модели.
// ABOUTME: Не хранит исходный state и не возобновляет вычисление после сбоя.
import { createHash } from "node:crypto";
import { Failure } from "./core.js";
import { catalogVersion, getModel } from "./catalog.js";
import { validDecideRequest, validDecideUpstream, validChatRequest, validChatResult } from "./v1-schema.js";
import { CHAT_LIMITS, chatMessages, chatResult, type ChatRequest, type ChatPort, type Message, type EventSink, type ChatPart, type StreamEvent } from "./chat.js";
type InvokeInput=DecideRequest|ChatRequest;
export const V1_LIMITS = Object.freeze({requestBytes:65536,resultBytes:65536,depth:JSON_DEPTH,concurrency:2,controlConcurrency:8,keyTtlMs:7*86400000,resultTtlMs:86400000,maxRows:100000});
import { JSON_DEPTH, boundedJson, canonical, type Json } from "./json.js";
export { boundedJson, canonical, type Json } from "./json.js";
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
export function createOperations(store:OperationStore,port:DecideV1Port,options:{now?:()=>number;lookupModel?:typeof getModel;deadlineMs?:number;chatDeadlineMs?:number;chatPort?:ChatPort}={}) {
  const now=options.now ?? Date.now,lookup=options.lookupModel ?? getModel;
  const maximum=options.deadlineMs ?? 30000;
  if (!Number.isInteger(maximum) || maximum<1 || maximum>30000) throw new Error("INVALID_DEADLINE");
  const chatMaximum=options.chatDeadlineMs??90000;
  if(!Number.isInteger(chatMaximum)||chatMaximum<1||chatMaximum>90000)throw new Error("INVALID_DEADLINE");
  let active=0,admitting=0,healthy=true;
  const accepting=new Map<string,{hash:string;promise:Promise<Operation>}>();
  const running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  const identity=(owner:string,id:string)=>JSON.stringify([owner,id]);
  async function execute(input:InvokeInput,key:string,hash:string,deadlineMs:number,messages:Message[]|undefined,sink?:EventSink) {
    let sequence=0,deliveryInterrupted=false;
    const emit=(part:ChatPart|{type:"started"|"completed"}|{type:"error";code:string;partial:true})=>{
      if(!sink||sequence>=CHAT_LIMITS.events)return;
      if(sequence===CHAT_LIMITS.events-1){part={type:"error",code:"STREAM_DELIVERY_INTERRUPTED",partial:true};deliveryInterrupted=true;}
      try{if(!sink({...part,operationId:input.operationId,sequence:++sequence} as StreamEvent))deliveryInterrupted=true;}catch{deliveryInterrupted=true;}
    };
    const controller=running.get(key)!.controller;
    let timer:ReturnType<typeof setTimeout>|undefined,claimed=false;
    try {
      // AIDEV-NOTE: Cancel и этот CAS сериализованы БД. Nonce создаётся только после commit.
      if (!(await store.claim(input.ownerId,input.operationId,hash))) return;
      claimed=true;
      const remaining=Math.min(Date.parse(input.deadlineAt)-now(),deadlineMs);
      if (remaining<=0) {await store.finish(input.ownerId,input.operationId,"failed",null,"DEADLINE_EXCEEDED",now(),hash);return;}
      timer=setTimeout(()=>controller.abort(),remaining);
      let output:Json;
      if("connectionId" in input){
        emit({type:"started"});
        const result=await options.chatPort!(input,messages!,controller.signal,emit);
        if(controller.signal.aborted || now()>=Date.parse(input.deadlineAt))throw new Failure("OUTCOME_UNKNOWN","unknown");
        output=chatResult(input,messages!,result,deliveryInterrupted);
        if(!boundedJson(output)||!validChatResult(output))throw new Failure("UPSTREAM_PROTOCOL","unknown");
      }else{
        const result=await port(input,controller.signal);
        if(controller.signal.aborted || now()>=Date.parse(input.deadlineAt))throw new Failure("OUTCOME_UNKNOWN","unknown");
        checkAnswer(input,result);
        output={provider:input.provider,requestedModel:input.model,actualModel:result.model,answers:result.answers,usage:result.usage==null?null:{inputTokens:result.usage.input_tokens,outputTokens:result.usage.output_tokens}} as Json;
      }
      if(Buffer.byteLength(JSON.stringify(output))>V1_LIMITS.resultBytes) throw new Failure("UPSTREAM_PROTOCOL","unknown");
      await store.finish(input.ownerId,input.operationId,"succeeded",output,null,now(),hash);
      if("connectionId" in input)emit({type:"completed"});
    } catch(error) {
      const failure=error instanceof Failure?error:new Failure("OUTCOME_UNKNOWN",claimed?"unknown":"not_sent");
      if("connectionId" in input)emit({type:"error",code:failure.code,partial:true});
      try {await store.finish(input.ownerId,input.operationId,failure.outcome==="unknown"?"outcome_unknown":"failed",null,failure.code,now(),hash);} catch {healthy=false;}
    } finally {if(timer)clearTimeout(timer);active--;running.delete(key);}
  }
  async function accept(input:InvokeInput,hash:string,key:string,sink?:EventSink) {
    const old=await store.find(input.ownerId,input.operationId,now());
    if(old){if(old.inputHash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");return old;}
    if(!healthy)throw new Failure("STORAGE_UNAVAILABLE","not_sent");
    const card=lookup(input.provider,input.model);
    if(!card)throw new Failure("MODEL_NOT_ALLOWED","not_sent");
    const isChat="connectionId" in input;
    if(!card.capabilities.includes(isChat?"chat":"decide") || isChat&&!options.chatPort)throw new Failure("UNSUPPORTED_OPERATION","not_sent");
    if(Date.parse(input.deadlineAt)<=now())throw new Failure("DEADLINE_EXCEEDED","not_sent");
    if(active>=V1_LIMITS.concurrency)throw new Failure("OVERLOADED","not_sent");
    active++;
    let held=true;
    try {
      const messages=isChat?await chatMessages(store,input,now()):undefined;
      const createdAt=now();
      const fresh:Operation={operationId:input.operationId,ownerId:input.ownerId,inputHash:hash,phase:"accepted",cancelRequested:false,createdAt,finishedAt:null,keyExpiresAt:createdAt+V1_LIMITS.keyTtlMs,resultExpiresAt:null,route:{provider:input.provider,model:input.model,catalogVersion},result:null,errorCode:null};
      const accepted=await store.accept(fresh);
      if(accepted.operation.inputHash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");
      if(accepted.inserted){
        held=false;
        // AIDEV-NOTE: Один setImmediate на принятый слот, никакой очереди вычислений.
        const done=new Promise<void>(resolve=>setImmediate(()=>{void execute(input,key,hash,Math.min(isChat?chatMaximum:maximum,card.deadlineMs),messages,sink).finally(resolve);}));
        running.set(key,{controller:new AbortController(),done});
      }
      return accepted.operation;
    } finally {if(held)active--;}
  }
  async function invoke(input:InvokeInput,isChat:boolean,sink?:EventSink) {
    if(!boundedJson(input) || Buffer.byteLength(JSON.stringify(input))>V1_LIMITS.requestBytes || !(isChat?validChatRequest(input):validDecideRequest(input)))throw new Failure("INVALID_REQUEST","not_sent");
    const snapshot=structuredClone(input),key=identity(input.ownerId,input.operationId);
    // AIDEV-NOTE: Новый inbox после разрыва меняет доставку, не вычисление; replay не переигрывает tokens.
    const {streamInbox:_,...chatInput}=snapshot as ChatRequest;
    const hash=createHash("sha256").update(canonical(isChat?chatInput:snapshot)).digest("hex");
    if(admitting>=V1_LIMITS.controlConcurrency)throw new Failure("OVERLOADED","not_sent");
    admitting++;
    try {
      const pending=accepting.get(key);
      if(pending){if(pending.hash!==hash)throw new Failure("IDEMPOTENCY_CONFLICT","not_sent");return operationView(await pending.promise,now());}
      const promise=accept(snapshot,hash,key,sink);accepting.set(key,{hash,promise});
      try{return operationView(await promise,now());}finally{accepting.delete(key);}
    } finally {admitting--;}
  }
  return {
    /** Проверяет неизменяемый decide wire, затем durable replay до чтения каталога. */
    invoke:(input:DecideRequest)=>invoke(input,false),
    /** Один chat-ход занимает общий слот. Replay возвращает итог без повторения token events. */
    invokeChat:(input:ChatRequest,sink?:EventSink)=>invoke(input,true,sink),
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
