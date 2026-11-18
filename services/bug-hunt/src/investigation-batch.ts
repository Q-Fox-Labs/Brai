// ABOUTME: Собирает снимок очереди и выполняет ручной пакет расследований.
// ABOUTME: Повторы одной сигнатуры разбираются последовательно внутри группы.
import {randomUUID} from "node:crypto";
import {limits,type Observation} from "./contracts.js";
import type {DiagnosticResult} from "./investigation-contract.js";
import {exactSignature} from "./projection.js";

export type CallTool = (tool:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>;
type Card = {id:string; owner_id:string; installation_id:string; component_id:string; revision:number; review_state:string; registered_at:string};
type Investigation = {state:string; applicability:string; result?:DiagnosticResult};
type CardDetail = {case:Card; report:{observation:Observation}; investigation:Investigation};
type Job = {state:string; replayed:boolean; investigation_id:string; case_id:string; case_revision:number; component:string; projection:unknown};
export type Facts = {component:string; current_scope:DiagnosticResult["scope"]; since:string; until:string; observed_at:string; facts:unknown[]};
type Candidate = {id:string; revision:number; component:string; signature:string|null; since:string; until:string; known:boolean};
type Snapshot = {as_of:string; examined:number; candidates:Candidate[]};
type Resolve = (job:Job,facts:Facts,onDispatch:()=>void)=>Promise<string>;
const hasReader = (component:string) => component==="agent" || component==="hermes";
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

/** Returns only the time windows that the approved Ansible readers need to inspect. */
export function diagnosticWindows(snapshot:Snapshot) {
 return snapshot.candidates.filter(card=>hasReader(card.component) && !card.known)
  .map(({id,component,since,until})=>({id,component,since,until}));
}

/** Uses the requested concurrency across distinct signatures, claiming work immediately before dispatch. */
export async function runBatch(call:CallTool,snapshot:Snapshot,diagnostics:Record<string,Facts>,parallelism:number,
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
 const counts={reused:0,completed:0,failed:0,deferred:0,skipped:0,unresolved:0,model_started:0,model_peak:0};
 let modelActive=0;
 let providerCheck:Promise<void>|undefined;
 async function run(card:Candidate) {
  const facts=diagnostics[card.id];
  if (!card.known && !hasReader(card.component)) return "deferred";
  const detail=await get(call,card.id);
  if (!waiting(detail) || detail.case.revision!==card.revision) return "skipped";
  const known=detail.investigation.applicability==="exact" && detail.investigation.result;
  if (!known && (!facts || !hasReader(card.component))) return "deferred";
  if (!known) await (providerCheck??=checkProvider());
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
  if (!job.projection) {
   await call("investigation_complete",{request_id:randomUUID(),investigation_id:job.investigation_id,result:{
    verdict:"insufficient_evidence",description:"В карточке нет технического описания, пригодного для передачи модели.",scope:facts.current_scope,evidence:[],
   }});
   return "completed";
  }
  let dispatched=false;
  try {
   return await resolve(job,facts,()=>{
    if (dispatched) return;
    dispatched=true;
    modelActive++;
    counts.model_started++;
    counts.model_peak=Math.max(counts.model_peak,modelActive);
   })==="completed"?"completed":"failed";
  } finally {
   if (dispatched) modelActive--;
  }
 }
 async function work() {
  for (const group of queue) {
   for (const card of group) {
    try {
     counts[await run(card)]++;
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
