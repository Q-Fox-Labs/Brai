// ABOUTME: Проверяет lifecycle worker через независимые подставные порты.
// ABOUTME: Не вызывает реальные модели и не утверждает смысловое качество embedding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProcessor,ModelFault,classificationQuestions,classificationResult,observationHash} from '../dist/processing.js';
import {createModelPorts} from '../dist/model-ports.js';
import {processingConfig,approvedProjection} from '../dist/config.js';
import {EMBEDDING_MODEL} from '../dist/projection.js';
const observation={title:'Synthetic failure',operation:'read',expected:'value',observed:'empty'};
const vector=Array.from({length:768},(_,i)=>i===0?1:0);
const job=branch=>({id:randomUUID(),report_id:randomUUID(),case_id:randomUUID(),owner_id:'synthetic-owner',installation_id:'synthetic-installation',branch,input_hash:observationHash(observation),pipeline_version:'2',fence:1,observation,technical_attempts:0,business_attempt_id:randomUUID()});
const projection={text:'Synthetic component returns empty instead of expected value.',excluded_fields:['steps','diagnostic_text'],policy_version:'operator-reviewed-1'};
function operation(j,a,usage=null){
 const answers=Object.fromEntries(Object.entries(classificationQuestions).map(([name,q])=>[name,q.type==='noul'?{type:'noul',noul:.9312345678901234}:{type:'choice',choice:'unknown',probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k==='unknown'?1:0])),confidence:.9234567890123456}]));
 return {ownerId:j.owner_id,operationId:a.operation_id,phase:'succeeded',route:{provider:'typesafe',model:'jev-1.13.0'},resultExpired:false,result:{provider:'typesafe',requestedModel:'jev-1.13.0',actualModel:'jev-1.13.0',answers,usage}};
}
function fixture(jobs){
 const state={jobs,attempts:[],finished:[],saved:[],invokes:0,gets:0,paused:false,lease:true,active:true};
 const settings={enabled:true,embeddingEnabled:true,classificationEnabled:true,externalAllowedOwners:['synthetic-owner'],externalProjection:async()=>projection,heartbeatMs:100};
 const store={
  async reconcile(){return 0;},async claim(){return state.jobs.splice(0,2);},async heartbeat(){return state.lease;},async mayDispatch(){return !state.paused&&state.lease;},
  async latestAttempt(j,unit){return state.attempts.findLast(a=>a.job_id===j.id&&a.unit===unit)??null;},
  async beginAttempt(j,body,unit,metadata){if(state.paused)return null;const a={id:randomUUID(),job_id:j.id,operation_id:body.operationId,body,input_hash:j.input_hash,deadline_at:body.deadlineAt,phase:'dispatching',unit,metadata};state.attempts.push(a);j.technical_attempts++;return a;},
  async finishAttempt(j,a,phase,result){if(!state.lease)return false;a.phase=phase;a.result=result;return true;},
  async finishJob(j,status,code,delay){state.finished.push({job:j,state:status,code,delay});return state.lease;},
  async chunkExists(j,index){return state.saved.some(s=>s.job_id===j.id&&s.index===index);},
  async saveChunk(j,a,c,v,coverage){if(!state.lease)return false;state.saved.push({job_id:j.id,...c,vector:v,coverage});a.phase='succeeded';return true;},
  async saveClassification(j,a,payload){if(!state.lease)return false;state.saved.push(payload);a.phase='succeeded';return true;},
  async propose(){},
 };
 const deps={store,indexReport:async()=>{},embedding:{invoke:async b=>{state.invokes++;return {requestId:b.requestId,operationId:b.operationId,model:EMBEDDING_MODEL,vectors:[vector]};}},classifier:{invoke:async b=>{state.invokes++;return operation(state.currentJob??jobs[0],{operation_id:b.operationId});},get:async(owner,id)=>{state.gets++;return operation(state.currentJob,{operation_id:id});}},activeOwner:async()=>state.active,settings:()=>settings,random:()=>0};
 const processor=createProcessor(deps);return {state,settings,store,deps,processor};
}
test('local and embedding survive default denied external classification',async()=>{
 const local=job('local'),classified=job('classification'),embedded=job('embedding');
 const f=fixture([local,classified,embedded]);delete f.settings.externalProjection;
 let localCalls=0;f.deps.indexReport=async()=>{localCalls++;};
 await f.processor.tick();await f.processor.tick();
 assert.equal(localCalls,1);assert.equal(f.state.invokes,1);
 assert.equal(f.state.finished.find(x=>x.job.id===classified.id).state,'blocked_policy');
 assert.equal(f.state.saved.length,1);
});
test('crashed Local AI dispatch becomes unknown with zero invoke replay',async()=>{
 const j=job('embedding'),f=fixture([j]);
 f.state.attempts.push({id:randomUUID(),job_id:j.id,unit:0,phase:'dispatching',operation_id:randomUUID()});
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.finished[0].state,'outcome_unknown');
});
test('crashed Providers intent recovers exact operation ID using GET only',async()=>{
 const j=job('classification'),f=fixture([j]);f.state.currentJob=j;
 const a={id:randomUUID(),job_id:j.id,unit:0,phase:'dispatching',operation_id:randomUUID(),metadata:{projection},deadline_at:new Date(Date.now()+10000).toISOString()};
 f.state.attempts.push(a);await f.processor.tick();
 assert.equal(f.state.invokes,0);assert.equal(f.state.gets,1);assert.equal(f.state.finished[0].state,'succeeded');
 assert.equal(f.state.saved[0].operation_id,a.operation_id);assert.equal(f.state.saved[0].usage,null);
});
test('Providers NOT_FOUND never causes another invoke',async()=>{
 const j=job('classification'),f=fixture([j]);
 f.state.attempts.push({id:randomUUID(),job_id:j.id,unit:0,phase:'dispatching',operation_id:randomUUID()});
 f.deps.classifier.get=async()=>{f.state.gets++;throw new ModelFault('NOT_FOUND');};
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.gets,1);assert.equal(f.state.finished[0].state,'outcome_unknown');
});
test('revoked owner between intent and invoke fails closed',async()=>{
 const j=job('embedding'),f=fixture([j]),begin=f.store.beginAttempt;
 f.store.beginAttempt=async(...args)=>{const a=await begin(...args);f.state.active=false;return a;};
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.attempts[0].phase,'not_sent');
});
test('protected projection revoked without replacing callback blocks dispatch',async()=>{
 const j=job('classification'),f=fixture([j]);let projectionAllowed=true;
 f.settings.externalProjection=async()=>projectionAllowed?projection:null;
 const begin=f.store.beginAttempt;
 f.store.beginAttempt=async(...args)=>{const a=await begin(...args);projectionAllowed=false;return a;};
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.finished[0].state,'blocked_policy');
});
test('pause after durable intent prevents new invoke',async()=>{
 const j=job('embedding'),f=fixture([j]),begin=f.store.beginAttempt;
 f.store.beginAttempt=async(...args)=>{const a=await begin(...args);f.state.paused=true;return a;};
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.finished[0].state,'waiting_dependency');
});
test('not_sent BUSY has bounded retry; unknown and schema failure never retry',async()=>{
 for(const [fault,initial,expected] of [[new ModelFault('BUSY','not_sent'),0,'waiting_dependency'],[new ModelFault('BUSY','not_sent'),2,'failed'],[new ModelFault('TRANSPORT_TIMEOUT'),0,'outcome_unknown'],[new ModelFault('INVALID_ARGUMENT','not_sent'),0,'failed']]){
  const j=job('embedding');j.technical_attempts=initial;const f=fixture([j]);f.deps.embedding.invoke=async()=>{throw fault;};
  await f.processor.tick();assert.equal(f.state.finished[0].state,expected);
 }
});
test('wrong actual selector and nonnormal vector are terminal failures',async()=>{
 for(const response of [{model:{...EMBEDDING_MODEL,revision:'wrong'},vectors:[vector]},{model:EMBEDDING_MODEL,vectors:[Array(768).fill(1)]}]){
  const f=fixture([job('embedding')]);f.deps.embedding.invoke=async b=>({...response,requestId:b.requestId,operationId:b.operationId});
  await f.processor.tick();assert.equal(f.state.finished[0].state,'failed');assert.equal(f.state.saved.length,0);
 }
});
test('long local text saves each chunk once and reports full bounded coverage',async()=>{
 const j=job('embedding');j.observation={...observation,diagnostic_text:'synthetic '.repeat(300)};j.input_hash=observationHash(j.observation);
 const f=fixture([j]);await f.processor.tick();assert.ok(f.state.saved.length>=3);assert.equal(f.state.saved.every(x=>x.coverage==='complete'),true);
});
test('Jev result preserves precision and rejects foreign scope/unknown metadata',()=>{
 const j=job('classification'),a={id:randomUUID(),operation_id:randomUUID()},r=operation(j,a);
 assert.equal(classificationResult(r,a,j,projection).answers.evidence_sufficiency.noul,.9312345678901234);
 assert.throws(()=>classificationResult({...r,ownerId:'foreign'},a,j,projection),ModelFault);
 r.result.answers.evidence_sufficiency.text='unsafe';assert.throws(()=>classificationResult(r,a,j,projection),ModelFault);
});
test('NATS adapter validates owner schema before send and rejects extra response fields',async()=>{
 let calls=0;const connection={request:async()=>{calls++;return {data:Buffer.from(JSON.stringify({requestId:randomUUID(),operationId:randomUUID(),model:EMBEDDING_MODEL,durationMs:1,vectors:[vector],extra:'forbidden'}))};}};
 const ports=createModelPorts({connection});
 await assert.rejects(ports.embedding.invoke({texts:['x']}),e=>e.outcome==='not_sent');assert.equal(calls,0);
 const body={requestId:randomUUID(),operationId:randomUUID(),ownerId:'synthetic-owner',deadlineAt:new Date(Date.now()+30000).toISOString(),model:EMBEDDING_MODEL,purpose:'symmetric',texts:['x']};
 await assert.rejects(ports.embedding.invoke(body),e=>e.code==='MODEL_PROTOCOL');assert.equal(calls,1);
});
test('stop prevents new ticks and concurrent ticks share the same bounded flight',async()=>{
 const f=fixture([job('local'),job('local'),job('local')]);let active=0,max=0;
 f.deps.indexReport=async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,20));active--;};
 await Promise.all([f.processor.tick(),f.processor.tick()]);assert.equal(max,2);assert.equal(f.state.finished.length,2);
 await f.processor.stop();await f.processor.tick();assert.equal(f.state.finished.length,2);
});

test('lost Providers invoke reply recovers accepted result through exact-ID GET',async()=>{
 const j=job('classification'),f=fixture([j]);f.state.currentJob=j;
 let sent;f.deps.classifier.invoke=async body=>{f.state.invokes++;sent=body;throw new ModelFault('MODEL_OUTCOME_UNKNOWN');};
 f.deps.classifier.get=async(owner,id)=>{f.state.gets++;assert.equal(owner,j.owner_id);assert.equal(id,sent.operationId);return operation(j,{operation_id:id});};
 await f.processor.tick();assert.equal(f.state.invokes,1);assert.equal(f.state.gets,1);assert.equal(f.state.finished[0].state,'succeeded');
});
test('temporarily unavailable Providers GET retains intent and never invokes again',async()=>{
 const j=job('classification'),f=fixture([j]);
 f.state.attempts.push({id:randomUUID(),job_id:j.id,unit:0,phase:'dispatching',operation_id:randomUUID(),deadline_at:new Date(Date.now()+30000).toISOString()});
 f.deps.classifier.get=async()=>{throw new ModelFault('MODEL_STATUS_UNAVAILABLE');};
 await f.processor.tick();assert.equal(f.state.invokes,0);assert.equal(f.state.attempts[0].phase,'dispatching');assert.equal(f.state.finished[0].state,'waiting_dependency');
});

test('automatic preparation reaches classifier with durable policy metadata and never sends excluded fields',async()=>{
 const j=job('classification');
 j.observation={...observation,steps:'Open then read',diagnostic_text:'token=private',conversation_ref:'private-conversation'};
 j.input_hash=observationHash(j.observation);
 const f=fixture([j]);f.state.currentJob=j;
 let policy=processingConfig({enabled:true,classificationEnabled:true,externalAllowedOwners:[j.owner_id],externalProjectionPolicy:'technical-fields-v1'});
 f.deps.settings=()=>({...policy,externalProjection:async current=>approvedProjection(policy,current.owner_id,current.input_hash,current.observation)});
 const processor=createProcessor(f.deps);
 await processor.tick();
 assert.equal(f.state.invokes,1);assert.equal(f.state.finished[0].state,'succeeded');
 const attempt=f.state.attempts[0];
 assert.match(attempt.body.state,/Open then read/);
 assert.ok(!attempt.body.state.includes('private'));
 assert.equal(attempt.metadata.projection.policy_version,'technical-fields-v1');
 assert.ok(f.state.saved[0].excluded_fields.includes('diagnostic_text'));
 assert.equal(f.state.saved[0].policy_version,'technical-fields-v1');
});
