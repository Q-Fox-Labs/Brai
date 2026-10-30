// ABOUTME: Проверяет исправленные границы COMMIT/Activity completion и управляющих событий.
// ABOUTME: Использует disposable PostgreSQL/Temporal; Telegram и рабочие сервисы не вызываются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {Worker,NativeConnection,Runtime,DefaultLogger} from '@temporalio/worker';
import {createStore} from '../../dist/storage.js';
import {migrate} from '../../dist/migrate.js';
import {createActivities} from '../../dist/activities.js';
import {ingest} from '../../dist/domain.js';
import {consumeOne} from '../../dist/nats.js';
import {inputHash} from '../../dist/contracts.js';
import {integrationConfig} from './fixtures.mjs';
const cfg=integrationConfig(),options={skip:!cfg,timeout:45000};
const owner=cfg?new Pool({connectionString:cfg.ownerUrl}):null,app=cfg?new Pool({connectionString:cfg.databaseUrl}):null;
const store=app?createStore(app):null;
const source='recovery',binding={ownerId:'fixture',types:['message.outgoing','event.recorded','operation.result','processing.resume'],recipients:['constructor'],read:true,resume:true},sources={[source]:binding},delivery={source,stream:'RECOVERY',sequence:1};
const configs=Object.fromEntries(['channel','contact','inbox','hermes','understand','memory','deliver'].map(k=>[k,{subject:'brai.fixture.'+k,resultSource:source}]));
const event=(type,data)=>({version:1,eventId:randomUUID(),source,type,occurredAt:new Date().toISOString(),correlationId:randomUUID(),causationId:null,data});
const basePorts={async history(){},async prepareFiles(){return [];},async startWorkflow(){},async signalWorkflow(){},async publish(){},async call(kind,p,id){return kind==='channel'?{channelId:'channel',rulesVersion:'v1',locationRef:'project',destination:{chatId:'test'}}:kind==='inbox'?{messageId:p.id}:{accepted:true,operationId:id};}};
async function packet(){
 const e=event('message.outgoing',{materialId:randomUUID(),revision:1,conversationId:'test',replyToMessageId:null,author:{kind:'agent',id:'test'},sourceRef:{},text:'synthetic',attachments:[]});
 return store.register(e,binding,inputHash(e));
}
const provenance=p=>({packetId:p.id,materialId:p.original.data.materialId,revision:p.original.data.revision,inputHash:p.inputHash});
async function wait(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,25));}throw Error('RECOVERY_TIMEOUT');}
test.before(async()=>{if(cfg){await migrate(owner,cfg.role);Runtime.install({logger:new DefaultLogger('WARN')});}});
test.after(async()=>{if(cfg)await Promise.all([app.end(),owner.end()]);});
test('allowed constructor receives publish confirmation before ingress ACK',options,async()=>{
 let published=0,ack=0,nak=0;const e=event('event.recorded',{recipient:'constructor',payload:{}});
 const msg={subject:'brai.intake.v1.ingress.'+source,data:Buffer.from(JSON.stringify(e)),info:{stream:'RECOVERY',streamSequence:1,timestampNanos:Date.now()*1000000},working(){},ack(){assert.equal(published,1);ack++;},nak(){nak++;}};
 await consumeOne(msg,store,{...basePorts,async publish(){published++;}},{sources});
 assert.deepEqual({published,ack,nak},{published:1,ack:1,nak:0});
 assert.equal((await store.find(source,e.eventId)).state,'forwarded');
});
test('control identity is atomic, immutable and shared with ordinary event IDs',options,async()=>{
 const p=await packet(),a=createActivities(store,basePorts,configs),id=await a.startJob(p.id,'deliver');
 const e=event('operation.result',{packetId:p.id,operationId:id,outcome:'unknown',result:{}});
 await Promise.all(Array.from({length:8},()=>ingest(store,basePorts,sources,e,delivery)));
 assert.equal((await store.get(p.id)).jobs[id].resultVersion,1);
 assert.equal(Number((await app.query('SELECT count(*) AS n FROM intake.intake_control_events WHERE source=$1 AND event_id=$2',[source,e.eventId])).rows[0].n),1);
 await assert.rejects(ingest(store,basePorts,sources,{...e,data:{...e.data,outcome:'succeeded'}},delivery),{code:'EVENT_ID_CONFLICT'});
 await ingest(store,basePorts,sources,{...e,eventId:randomUUID(),data:{...e.data,outcome:'succeeded'}},delivery);
 await assert.rejects(ingest(store,basePorts,sources,{...event('event.recorded',{recipient:'constructor',payload:{}}),eventId:e.eventId},delivery),{code:'EVENT_ID_CONFLICT'});
 await assert.rejects(ingest(store,basePorts,sources,{...e,eventId:p.eventId},delivery),{code:'EVENT_ID_CONFLICT'});
 await store.update(p.id,v=>{v.state='needs_attention';});
 const resume=event('processing.resume',{packetId:p.id,expectedResumeVersion:0});
 await ingest(store,basePorts,sources,resume,delivery);
 await assert.rejects(ingest(store,basePorts,sources,{...resume,data:{...resume.data,expectedResumeVersion:1}},delivery),{code:'EVENT_ID_CONFLICT'});
 assert.equal((await store.get(p.id)).resumeVersion,1);
 await assert.rejects(app.query('UPDATE intake.intake_control_events SET input_hash=$1 WHERE source=$2 AND event_id=$3',['bad',source,e.eventId]),{code:'42501'});
});
test('invalid successful results never commit control acceptance or completion',options,async()=>{
 const p=await packet(),a=createActivities(store,basePorts,configs);
 await a.prepare(p.id);await a.saveInbox(p.id);
 const deliver=await a.startJob(p.id,'deliver'),understand=await a.startJob(p.id,'understand'),memory=await a.startJob(p.id,'memory');
 const e=event('operation.result',{packetId:p.id,operationId:understand,outcome:'succeeded',result:{}});
 await assert.rejects(ingest(store,basePorts,sources,e,delivery),{code:'INVALID_JOB_RESULT'});
 assert.equal((await app.query('SELECT 1 FROM intake.intake_control_events WHERE source=$1 AND event_id=$2',[source,e.eventId])).rowCount,0);
 assert.equal((await store.get(p.id)).jobs[understand].state,'pending');
 await store.update(p.id,v=>{for(const j of Object.values(v.jobs)){j.state='succeeded';j.result={};}});
 await assert.rejects(a.complete(p.id),{message:'INCOMPLETE_PROCESS'});
 await store.update(p.id,v=>{v.jobs[deliver].result={receiptRef:'sent'};v.jobs[understand].result={resultRef:'understanding/v1',provenance:provenance(p)};v.jobs[memory].result={resultRef:'memory/v1',provenance:provenance(p),understandingRef:'understanding/v1'};});
 await a.complete(p.id);assert.equal((await store.get(p.id)).state,'completed');
});
async function workflowFixture(overrides,work){
 const connection=await Connection.connect({address:cfg.temporalAddress});
 let native,worker,running,p,client;
 try{
  try{await connection.workflowService.registerNamespace({namespace:'intake_test',workflowExecutionRetentionPeriod:{seconds:86400}});}catch(e){if(e.code!==6)throw e;}
  client=new Client({connection,namespace:'intake_test'});native=await NativeConnection.connect({address:cfg.temporalAddress});p=await packet();
  const queue=[],ports={...basePorts,async signalWorkflow(q){await client.workflow.getHandle(q.workflowId).signal('changed');},async call(kind,q,id,extra){
   if(!['hermes','understand','memory','deliver'].includes(kind))return basePorts.call(kind,q,id,extra);
   queue.push({kind,id});return {accepted:true,operationId:id};
  }};
  const send=async(job,outcome)=>{
   const result=job.kind==='deliver'?{receiptRef:'sent'}:{resultRef:job.kind+'/v1',provenance:provenance(p),...(job.kind==='memory'?{understandingRef:'understand/v1'}:{})};
   await ingest(store,ports,sources,event('operation.result',{packetId:p.id,operationId:job.id,outcome,result}),delivery);
  };
  const resume=version=>ingest(store,ports,sources,event('processing.resume',{packetId:p.id,expectedResumeVersion:version}),delivery);
  const activities=createActivities(store,ports,configs),f={p,activities,queue,send,resume,client,job:(kind,attempt)=>wait(()=>queue.find(j=>j.kind===kind&&(attempt===undefined||j.id.endsWith('/'+attempt))))};
  const taskQueue='intake-recovery-'+randomUUID();
  worker=await Worker.create({connection:native,namespace:'intake_test',taskQueue,workflowsPath:new URL('../../dist/workflows.js',import.meta.url).pathname,activities:{...activities,...overrides(f)},maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:8,maxCachedWorkflows:32,shutdownGraceTime:'1 second'});
  running=worker.run();await client.workflow.start('intakeMessageV1',{workflowId:p.workflowId,taskQueue,args:[p.id]});await work(f);
 }finally{
  if(p&&client)try{const h=client.workflow.getHandle(p.workflowId);if((await h.describe()).status.name==='RUNNING')await h.terminate('recovery test cleanup');}catch{}
  if(worker){worker.shutdown();await running.catch(()=>{});}
  if(native)await native.close();await connection.close();
 }
}
test('Temporal retry after retryJob COMMIT uses exactly the next business attempt',options,async()=>{
 let calls=0;
 await workflowFixture(f=>({async retryJob(...args){await f.activities.retryJob(...args);if(++calls===1)throw Error('INJECTED_COMPLETION_LOST_AFTER_COMMIT');}}),async f=>{
  await f.send(await f.job('deliver',0),'failed');await f.send(await f.job('understand',0),'succeeded');await f.send(await f.job('memory',0),'succeeded');
  await wait(async()=>(await store.get(f.p.id)).state==='needs_attention');await f.resume(0);
  const retry=await f.job('deliver',1);assert.equal(calls,2);
  await f.send(retry,'succeeded');await f.client.workflow.getHandle(f.p.workflowId).result();
  const p=await store.get(f.p.id);assert.equal(p.state,'completed');assert.equal(p.attempts.deliver,1);
  assert.deepEqual(Object.values(p.jobs).filter(j=>j.kind==='deliver').map(j=>j.attempt).sort(),[0,1]);
 });
});
test('resume accepted after attention COMMIT survives lost Activity completion',options,async()=>{
 let calls=0;
 await workflowFixture(f=>({async attention(...args){const version=await f.activities.attention(...args);if(++calls===1){await f.resume(0);throw Error('INJECTED_ATTENTION_COMPLETION_LOST_AFTER_COMMIT');}return version;}}),async f=>{
  await f.send(await f.job('deliver',0),'failed');await f.send(await f.job('understand',0),'succeeded');await f.send(await f.job('memory',0),'succeeded');
  const retry=await f.job('deliver',1);assert.equal(calls,2);await f.send(retry,'succeeded');
  await f.client.workflow.getHandle(f.p.workflowId).result();
  const p=await store.get(f.p.id);assert.equal(p.state,'completed');assert.equal(p.resumeVersion,1);assert.deepEqual(p.attention,{});
 });
});
