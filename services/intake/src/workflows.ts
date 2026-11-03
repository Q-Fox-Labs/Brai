// ABOUTME: Ведёт отдельное сообщение до результатов его обязательных веток.
// ABOUTME: Передаёт Activities только ID; исходники и результаты остаются у владельцев.
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities } from './activities.js';
import type { JobKind } from './types.js';
const a=proxyActivities<Activities>({startToCloseTimeout:'35 minutes',heartbeatTimeout:'30 seconds',retry:{initialInterval:'1 second',maximumInterval:'1 minute',nonRetryableErrorTypes:['Permanent']}});
export const changed=defineSignal('changed');
/** Обрабатывает одно сообщение; ответы Hermes запускаются независимо через общий вход. */
export async function intakeMessageV1(id:string):Promise<void> {
 let generation=0;
 setHandler(changed,()=>{generation++;});
 async function pause(reason:string,stage:string):Promise<void> {
  const version=await a.attention(id,reason,stage);
  while(await a.resumeVersion(id)<=version) { const before=generation; if(await a.resumeVersion(id)>version) break; await condition(()=>generation!==before); }
  await a.clearAttention(id,stage,version);
 }
 async function step<T>(stage:string,work:()=>Promise<T>):Promise<T> {
  for(;;) { try{return await work();} catch {await pause('STEP_REQUIRES_ATTENTION',stage);} }
 }
 async function job(kind:JobKind):Promise<void> {
  for(;;) {
   const operationId=await step('start/'+kind,()=>a.startJob(id,kind));
   let unknownVersion:number|undefined;
   for(;;) {
    const before=generation, state=await a.jobState(id,operationId);
    if(state==='succeeded') {if(unknownVersion!==undefined)await a.clearAttention(id,'job/'+operationId,unknownVersion);return;}
    if(state==='failed') {if(unknownVersion!==undefined)await a.clearAttention(id,'job/'+operationId,unknownVersion);await pause(kind.toUpperCase()+'_FAILED','job/'+operationId);await a.retryJob(id,kind,operationId);break;}
    if(state==='unknown' && unknownVersion===undefined) unknownVersion=await a.attention(id,kind.toUpperCase()+'_OUTCOME_UNKNOWN','job/'+operationId);
    if(generation===before) await condition(()=>generation!==before);
   }
  }
 }
 // Ветка истории не задерживает подготовку/отправку сообщения.
 const received=step('audit/receive',()=>a.audit(id,'receive'));
 const scenario=await step('prepare',()=>a.prepare(id));
 await step('inbox',()=>a.saveInbox(id));
 await Promise.all([
  job(scenario==='incoming.v1'?'hermes':'deliver'),
  (async()=>{await job('understand');await job('memory');})(),
  received
 ]);
 await step('audit/complete',()=>a.audit(id,'complete'));
 await a.complete(id);
}
