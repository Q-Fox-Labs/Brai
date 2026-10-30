// ABOUTME: Выполняет идемпотентные шаги сообщения через предметные порты.
// ABOUTME: Сохраняет intent и успешные результаты до зависимых шагов.
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { inputHash } from './contracts.js';
import { Fault, type Data, type JobKind, type Message, type Packet, type Ports, type Store, type PortConfig } from './types.js';
/** Связывает Activities с собственным хранилищем и внешними операциями. */
export function createActivities(store: Store, ports: Ports, configs: Record<JobKind,PortConfig>) {
 const read = async (id: string): Promise<Packet> => { const p=await store.get(id); if(!p) throw new Fault('NOT_FOUND'); return p; };
 const guard = <A extends unknown[],R>(fn: (...args:A)=>Promise<R>) => async (...args:A):Promise<R> => {
  let ctx:Context|undefined;try{ctx=Context.current();}catch{}
  const pulse=ctx?setInterval(()=>ctx!.heartbeat(),5000):undefined;
  pulse?.unref();
  try { return await fn(...args); } catch(e) {
   if(e instanceof Fault && !e.retryable) throw ApplicationFailure.nonRetryable(e.code,'Permanent');
   throw ApplicationFailure.retryable('DEPENDENCY_UNAVAILABLE','Transient');
  } finally {if(pulse)clearInterval(pulse);}
 };
 return {
  prepare: guard(async(id:string) => {
   let p=await read(id);
   if(!p.context) {
    let replyContext:Data|null=null;
    if(p.original.type==='message.outgoing' && p.original.causationId) {
     const parent=await store.get(p.original.causationId);
     if(!parent || parent.ownerId!==p.ownerId) throw new Fault('INVALID_REPLY_LINK');
     if(!parent.context || !parent.inboxRef) throw new Fault('REPLY_CONTEXT_NOT_READY',true);
     if(p.original.data.replyToMessageId!==parent.inboxRef.messageId || p.original.data.conversationId!==parent.original.data.conversationId) throw new Fault('INVALID_REPLY_LINK');
     replyContext=parent.context;
    }
    const context=await ports.call('channel',p,id+'/channel',{asOf:p.receivedAt,replyContext});
    if(!context.channelId || !context.rulesVersion || !context.locationRef || !context.destination) throw new Fault('INVALID_CHANNEL_RESULT');
    if(replyContext && inputHash(context.destination)!==inputHash(replyContext.destination)) throw new Fault('REPLY_ROUTE_CONFLICT');
    p=await store.update(id,v=>{v.context??=context;});
   }
   if(!p.contact && p.original.type==='message.incoming') { const contact=await ports.call('contact',p,id+'/contact'); if(!contact.contactId) throw new Fault('INVALID_CONTACT_RESULT'); p=await store.update(id,v=>{v.contact??=contact;}); }
   if(!p.prepared) {
    let signal:AbortSignal|undefined;try{signal=Context.current().cancellationSignal;}catch{}
    const attachments=await ports.prepareFiles(p,signal);
    const prepared={...p.original.data,attachments,context:p.context,contact:p.contact??null};
    p=await store.update(id,v=>{v.prepared??=prepared;if(v.state!=='needs_attention')v.state='processing';});
   }
   return p.scenario;
  }),
  saveInbox: guard(async(id:string) => {
   const p=await read(id);
   if(!p.inboxRef) { const ref=await ports.call('inbox',p,id+'/inbox'); if(!ref.messageId) throw new Fault('INVALID_INBOX_RESULT'); await store.update(id,v=>{v.inboxRef??=ref;}); }
  }),
  startJob: guard(async(id:string,kind:JobKind) => {
   let p=await read(id);
   const attempt=p.attempts[kind]??0, operationId=id+'/'+kind+'/'+attempt;
   if(!p.jobs[operationId]) p=await store.update(id,v=>{v.jobs[operationId]??={id:operationId,kind,attempt,expectedSource:configs[kind].resultSource!,state:'pending'};});
   if(p.jobs[operationId].state==='pending') {
    const reply=await ports.call(kind,p,operationId);
    if(reply.operationId!==operationId || reply.accepted!==true) throw new Fault('INVALID_JOB_RECEIPT');
   }
   return operationId;
  }),
  jobState: guard(async(id:string,operationId:string) => (await read(id)).jobs[operationId]?.state ?? 'pending'),
  attention: guard(async(id:string,reason:string,stage:string) => {
   const p=await store.update(id,v=>{v.attention??={};v.attention[stage]={reason,resumeVersion:v.resumeVersion};v.state='needs_attention';v.reason=reason;});
   return p.resumeVersion;
  }),
  clearAttention: guard(async(id:string,stage:string,version:number) => {
   await store.update(id,p=>{
    if(p.attention?.[stage]?.resumeVersion===version)delete p.attention[stage];
    const pending=Object.values(p.attention??{});
    p.state=pending.length?'needs_attention':'processing';p.reason=pending[0]?.reason??null;
   });
  }),
  resumeVersion: guard(async(id:string)=>(await read(id)).resumeVersion),
  retryJob: guard(async(id:string,kind:JobKind,operationId:string) => {
   await store.update(id,v=>{
    const job=v.jobs[operationId];
    if(!job || job.state!=='failed') throw new Fault('UNSAFE_RETRY');
    v.attempts[kind]=(v.attempts[kind]??0)+1;
   });
  }),
  audit: guard(async(id:string,phase:'receive'|'complete') => {
   let p=await read(id);
   if(phase==='complete' && !p.completedAt) p=await store.update(id,v=>{v.completedAt??=new Date().toISOString();});
   await ports.history(p,phase);
  }),
  complete: guard(async(id:string) => {
   await store.update(id,p=>{
    const required:JobKind[]=[p.scenario==='incoming.v1'?'hermes':'deliver','understand','memory'];
    if(Object.keys(p.attention??{}).length || !p.inboxRef || required.some(k=>!Object.values(p.jobs).some(j=>j.kind===k && j.state==='succeeded'))) throw new Fault('INCOMPLETE_PROCESS');
    p.state='completed';p.reason=null;
   });
  })
 };
}
export type Activities=ReturnType<typeof createActivities>;
