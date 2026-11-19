// ABOUTME: Собирает снимок очереди и выполняет ручной пакет расследований.
// ABOUTME: Повторы одной сигнатуры разбираются последовательно внутри группы.
import {randomUUID} from "node:crypto";
import {limits,type Observation} from "./contracts.js";
import type {DiagnosticResult} from "./investigation-contract.js";
import {exactSignature,prepareExternalProjection} from "./projection.js";

export type CallTool = (tool:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>;
type Card = {id:string; owner_id:string; installation_id:string; component_id:string; revision:number; review_state:string; registered_at:string};
type Investigation = {state:string; applicability:string; result?:DiagnosticResult};
type CardDetail = {case:Card; report:{observation:Observation}; investigation:Investigation};
type Job = {state:string; replayed:boolean; investigation_id:string; case_id:string; case_revision:number; component:string|null; projection:unknown};
type Window = {component:string; since:string; until:string};
type Facts = Window & {current_scope:DiagnosticResult["scope"]; observed_at:string; facts:unknown[]};
export type DiagnosticInput = Facts | (Window & {unavailable:"no_reader"|"read_failed"|"not_collected"});
type DiagnosticBatch = {diagnostics:Record<string,Facts>; failed_components:string[]; components_without_reader:string[]};
type Candidate = {id:string; revision:number; component:string; signature:string|null; since:string; until:string; known:boolean};
type Snapshot = {as_of:string; examined:number; candidates:Candidate[]};
type Resolve = (job:Job,diagnostics:DiagnosticInput,onDispatch:()=>void)=>Promise<string>;
const second = (date:Date)=>date.toISOString().slice(0,19)+"Z";

async function get(call:CallTool,id:string) {
 return await call("get",{case_id:id,limit:1}) as unknown as CardDetail;
}
const waiting = (card:CardDetail)=>card.case.review_state!=="archived" &&
 (card.investigation.state==="pending" || card.investigation.state==="failed");

/** Enumerates a fixed registration window through the existing paginated, owner-scoped MCP API. */
export async function snapshotQueue(call:CallTool, now:Date, selected?:string[]):Promise<Snapshot> {
 const as_of=now.toISOString();
 const cards:Card[]=[];
 let cursor:string|null=null;
 do {
  const result=await call("list",{limit:limits.maxPage,filters:{registered_to:as_of},...(cursor?{cursor}:{})});
  cards.push(...result.items as Card[]);
  cursor=result.next_cursor as string|null;
 } while (cursor);
 const selectedIds=selected && new Set(selected);
 const candidates:Candidate[]=[];
 let examined=0;
 for (const card of cards) {
  if (card.review_state==="archived" || (selectedIds && !selectedIds.has(card.id))) continue;
  const detail=await get(call,card.id);
  examined++;
  if (!waiting(detail)) continue;
  const observation=detail.report.observation;
  const registered=Date.parse(card.registered_at);
  const occurred=Date.parse(observation.client_occurred_at??"");
  const historical=Number.isFinite(occurred) && occurred<=registered;
  candidates.push({id:card.id,revision:detail.case.revision,component:card.component_id,
   signature:exactSignature(card.installation_id,card.owner_id,observation)?.hash??null,
   since:second(new Date(historical?occurred:registered)),until:second(historical?new Date(registered):now),
   known:detail.investigation.applicability==="exact" && !!detail.investigation.result});
 }
 return {as_of,examined,candidates};
}

/** Returns windows for pending cards that have no exact prior result. Ansible owns reader selection. */
export function diagnosticWindows(snapshot:Snapshot) {
 return snapshot.candidates.filter(card=>!card.known)
  .map(({id,component,since,until})=>({id,component,since,until}));
}

/** Uses the requested concurrency across distinct signatures, claiming work immediately before dispatch. */
export async function runBatch(call:CallTool,snapshot:Snapshot,batch:DiagnosticBatch,parallelism:number,
  checkProvider:()=>Promise<void>,resolve:Resolve) {
 if (!Number.isSafeInteger(parallelism) || parallelism<1) throw new Error("INVALID_INVESTIGATION_PARALLELISM");
 const groups=new Map<string,Candidate[]>();
 for (const card of snapshot.candidates) {
  const key=card.signature??card.id;
  const group=groups.get(key)??[];
  group.push(card);
  groups.set(key,group);
 }
 const queue=[...groups.values()].values();
 const withoutReader=new Set(batch.components_without_reader);
 const failedReaders=new Set(batch.failed_components);
 const counts={reused:0,completed:0,completed_without_diagnostics:0,failed:0,skipped:0,unresolved:0,model_started:0,model_peak:0};
 let modelActive=0;
 let providerCheck:Promise<void>|undefined;
 async function run(card:Candidate) {
  const detail=await get(call,card.id);
  if (!waiting(detail) || detail.case.revision!==card.revision) return "skipped";
  const known=detail.investigation.applicability==="exact" && detail.investigation.result;
  const observation=detail.report.observation;
  if (!known && prepareExternalProjection(observation,[detail.case.owner_id])) await (providerCheck??=checkProvider());
  const job=await call("investigation_claim",{request_id:randomUUID(),case_id:card.id}) as unknown as Job;
  if (job.state!=="running" || job.replayed) return "skipped";
  if (job.case_revision!==card.revision) {
   await call("investigation_fail",{request_id:randomUUID(),investigation_id:job.investigation_id});
   return "skipped";
  }
  if (known) {
   await call("investigation_complete",{request_id:randomUUID(),investigation_id:job.investigation_id,result:known});
   return "reused";
  }
  const {component,since,until}=card;
  const diagnostics:DiagnosticInput=batch.diagnostics[card.id]??{component,since,until,
   unavailable:withoutReader.has(component)?"no_reader":failedReaders.has(component)?"read_failed":"not_collected"};
  const missingDiagnostics="unavailable" in diagnostics;
  if (!job.projection) {
   await call("investigation_complete",{request_id:randomUUID(),investigation_id:job.investigation_id,result:{
    verdict:"insufficient_evidence",
    description:"Нужны обезличенное описание операции, ожидаемый и фактический результат, время события и строка журнала или результат проверки, где видно расхождение.",
    scope:missingDiagnostics?{}:diagnostics.current_scope,evidence:[],
   }});
   return missingDiagnostics?"completed_without_diagnostics":"completed";
  }
  let dispatched=false;
  try {
   const state=await resolve(job,diagnostics,()=>{
    if (dispatched) return;
    dispatched=true;
    modelActive++;
    counts.model_started++;
    counts.model_peak=Math.max(counts.model_peak,modelActive);
   });
   if (state!=="completed") return "failed";
   return missingDiagnostics?"completed_without_diagnostics":"completed";
  } finally {
   if (dispatched) modelActive--;
  }
 }
 async function work() {
  for (const group of queue) {
   for (const card of group) {
    try {
     const outcome=await run(card);
     counts[outcome]++;
     if (outcome==="completed_without_diagnostics") counts.completed++;
    } catch {
     // AIDEV-NOTE: При неизвестном исходе claim/turn карточка остаётся привязанной к исходной попытке.
     counts.unresolved++;
    }
   }
  }
 }
 await Promise.all(Array.from({length:Math.min(parallelism,groups.size)},work));
 return {as_of:snapshot.as_of,examined:snapshot.examined,candidates:snapshot.candidates.length,...counts};
}
