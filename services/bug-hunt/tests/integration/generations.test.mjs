// ABOUTME: Проверяет build/activate/rollback поколений на настоящем PostgreSQL и fake vectors.
// ABOUTME: Не вызывает моделей, использует только loopback synthetic fixture и app DML-права.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {migrate} from '../../dist/migrate.js';
import {createProcessingStore,enqueueProcessing} from '../../dist/processing-store.js';
import {createProcessor} from '../../dist/processing.js';
import {createSystemStore} from '../../dist/system-store.js';
import {invokeProcessing} from '../../dist/processing-api.js';
import {createStore} from '../../dist/storage.js';
import {createHandlers} from '../../dist/domain.js';
import {generationMetadata} from '../../dist/generations.js';
import {EMBEDDING_MODEL,chunkText,searchProjection,GENERATION} from '../../dist/projection.js';
const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
for(const key of ['ownerURL','appURL']){
 const u=new URL(fixture[key]);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'18585');assert.equal(u.pathname,'/brai_bug_hunt_test');
}
const owner=new Pool({connectionString:fixture.ownerURL,max:2}),app=new Pool({connectionString:fixture.appURL,max:2});
const base={cursorKey:'synthetic-generation-cursor-key-at-least-32-bytes',maxDatabaseBytes:1073741824,intakeReserveBytes:1048576,maxDerivativeBytes:268435456};
const user={ownerId:'synthetic-generation-owner',actorId:'codex:synthetic-generation-owner',source:'codex',reviewer:false};
const operator={ownerId:'operator',actorId:'nats:operator',source:'codex',reviewer:true};
const obs={title:'Synthetic generation incident',operation:'read',expected:'value',observed:'empty',component_id:'synthetic-generation-component'};
const vector=Array.from({length:768},(_,i)=>i===0?1:0);
const metadata={model_id:EMBEDDING_MODEL.modelId,model_revision:EMBEDDING_MODEL.revision,profile_id:EMBEDDING_MODEL.profileId,question_version:null};
const body=j=>({requestId:randomUUID(),operationId:randomUUID(),ownerId:j.owner_id,deadlineAt:new Date(Date.now()+30000).toISOString(),model:EMBEDDING_MODEL,purpose:'symmetric',texts:['synthetic']});
const fault=code=>e=>e.code===code;
const context=()=>{
 const installationId='generation-fixture-'+randomUUID();let build=GENERATION;
 const store=createProcessingStore(app,{...base,installationId,target:()=>build});
 return {installationId,store,target:()=>build,setTarget:value=>{build=value;}};
};
async function seed(ctx,own=user.ownerId){
 const id=randomUUID(),case_id=randomUUID(),db=await owner.connect();
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO bug_case(id,owner_id,installation_id,title,component_id,source,registered_at,updated_at) VALUES($1,$2,$3,$4,$5,'codex',clock_timestamp(),clock_timestamp())",[case_id,own,ctx.installationId,obs.title,obs.component_id]);
  await db.query("INSERT INTO report(id,case_id,owner_id,installation_id,actor_id,observation,registered_at) VALUES($1,$2,$3,$4,'synthetic-generation-actor',$5,clock_timestamp())",[id,case_id,own,ctx.installationId,obs]);
  await enqueueProcessing(db,{id,case_id,owner_id:own,installation_id:ctx.installationId,observation:obs},'new',ctx.target());
  await db.query("UPDATE processing_job SET state='succeeded' WHERE report_id=$1 AND branch<>'embedding'",[id]);
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 await createSystemStore(app,{...base,installationId:ctx.installationId}).indexReport(id);
 return {id,case_id,own};
}
async function fillOne(ctx){
 const [job]=await ctx.store.claim(1,['embedding']);assert.ok(job,'embedding obligation must be claimable');
 assert.equal(job.index_generation,ctx.target());
 const attempt=await ctx.store.beginAttempt(job,body(job),0,metadata);assert.ok(attempt);
 const chunks=chunkText(searchProjection(job.observation));assert.equal(chunks.chunks.length,1);
 assert.equal(await ctx.store.saveChunk(job,attempt,chunks.chunks[0],vector,'complete'),true);
 assert.equal(await ctx.store.propose(job,'complete'),true);
 await ctx.store.finishJob(job,'succeeded');return job;
}
const activation=(ctx,generation,expected=GENERATION)=>({request_id:randomUUID(),generation,expected_active_generation:expected,reason:'Explicit synthetic generation acceptance'});
test('generation lifecycle uses prepared metadata and an explicit covered CAS',async t=>{
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await t.test('prepare keeps old search; partial activation fails; complete activation retains history and invalidates signed cursors',async()=>{
   const ctx=context(),records=[];for(let i=0;i<3;i++)records.push(await seed(ctx));
   const foreign=await seed(ctx,'synthetic-generation-foreign');
   for(let i=0;i<4;i++)await fillOne(ctx);
   const oldCursor=await ctx.store.similar(user,{case_id:records[0].case_id,limit:1});
   assert.equal(oldCursor.coverage.state,'complete');assert.ok(oldCursor.next_cursor);assert.equal(oldCursor.generation,GENERATION);
   const oldJobs=(await owner.query("SELECT id,branch,business_attempt_id FROM processing_job WHERE installation_id=$1 ORDER BY id",[ctx.installationId])).rows;
   ctx.setTarget('gemma2-synthetic-next');
   let status=await invokeProcessing(ctx.store,'status',{});
   assert.equal(status.generations.active,GENERATION);assert.equal(status.generations.build,ctx.target());
   assert.deepEqual(status.generations.active_coverage,{total_reports:4,indexed_reports:4,state:'complete'});
   assert.deepEqual(status.generations.build_coverage,{total_reports:4,indexed_reports:0,state:'pending'});
   assert.equal(await ctx.store.reconcile(),4);assert.equal(await ctx.store.reconcile(),0);
   assert.equal((await owner.query("SELECT count(*)::int AS n FROM processing_job WHERE installation_id=$1",[ctx.installationId])).rows[0].n,16);
   const action=activation(ctx,ctx.target());
   await fillOne(ctx);
   assert.equal((await ctx.store.similar(user,{case_id:records[0].case_id,limit:1,cursor:oldCursor.next_cursor})).generation,GENERATION);
   await assert.rejects(invokeProcessing(ctx.store,'activate-generation',action),fault('INDEX_NOT_READY'));
   for(let i=0;i<2;i++)await fillOne(ctx);
   await assert.rejects(invokeProcessing(ctx.store,'activate-generation',action),fault('INDEX_NOT_READY'),'all owners are required, not just operator/source owner');
   await fillOne(ctx);
   await assert.rejects(invokeProcessing(ctx.store,'activate-generation',{...action,request_id:randomUUID(),expected_active_generation:'wrong-active'}),fault('REVISION_CONFLICT'));
   await assert.rejects(invokeProcessing(ctx.store,'activate-generation',{...action,owner_id:user.ownerId}),fault('INVALID_ARGUMENT'));
   await assert.rejects(ctx.store.activateGeneration(user,action),fault('FORBIDDEN'));
   const receipt=await invokeProcessing(ctx.store,'activate-generation',action);
   assert.deepEqual(receipt,{generation:ctx.target(),previous_generation:GENERATION,activation_revision:1,total_reports:4,indexed_reports:4,replayed:false});
   assert.deepEqual(await invokeProcessing(ctx.store,'activate-generation',action),{...receipt,replayed:true});
   await assert.rejects(invokeProcessing(ctx.store,'activate-generation',{...action,reason:'Changed'}),fault('IDEMPOTENCY_CONFLICT'));
   await assert.rejects(ctx.store.similar(user,{case_id:records[0].case_id,cursor:oldCursor.next_cursor}),fault('CURSOR_STALE'));
   const active=await ctx.store.similar(user,{case_id:records[0].case_id});assert.equal(active.generation,ctx.target());assert.equal(active.coverage.state,'complete');
   assert.equal(active.items.length,2);assert.ok(!active.items.some(r=>r.case_id===foreign.case_id));
   assert.equal((await ctx.store.enrichmentModel(user,records[0].case_id)).branches.length,3);
   assert.deepEqual((await owner.query("SELECT id,branch,business_attempt_id FROM processing_job WHERE installation_id=$1 AND index_generation=$2 ORDER BY id",[ctx.installationId,GENERATION])).rows,oldJobs);
   await migrate(owner,'bug_hunt_owner','bug_hunt_app');
   status=await invokeProcessing(ctx.store,'status',{});assert.equal(status.generations.active,ctx.target());assert.equal(status.generations.activation_revision,1);
   const rollback=activation(ctx,GENERATION,ctx.target());await invokeProcessing(ctx.store,'activate-generation',rollback);
   assert.equal((await ctx.store.similar(user,{case_id:records[0].case_id})).generation,GENERATION);
   await assert.rejects(ctx.store.similar(user,{case_id:records[0].case_id,cursor:oldCursor.next_cursor}),fault('CURSOR_STALE'),'rollback to the same generation still invalidates an earlier cursor');
   assert.deepEqual(await invokeProcessing(ctx.store,'activate-generation',action),{...receipt,replayed:true},'replay returns original receipt even after another activation');
   assert.equal((await owner.query("SELECT count(*)::int AS n FROM embedding_chunk WHERE installation_id=$1",[ctx.installationId])).rows[0].n,8);
   assert.equal((await owner.query("SELECT count(*)::int AS n FROM embedding_generation_activation WHERE installation_id=$1",[ctx.installationId])).rows[0].n,2);
   assert.equal((await ctx.store.processingStatus(user)).generations.active_coverage.total_reports,3);
  });
  await t.test('target switch cannot repeat uncertain embedding or Jev; explicit scoped retry of new obligation is required',async()=>{
   const ctx=context(),record=await seed(ctx);
   const [old]=await ctx.store.claim(1,['embedding']);const uncertain=await ctx.store.beginAttempt(old,body(old),0,metadata);
   await ctx.store.finishAttempt(old,uncertain,'outcome_unknown',{code:'MODEL_OUTCOME_UNKNOWN'});await ctx.store.finishJob(old,'outcome_unknown');
   await owner.query("UPDATE processing_job SET state='pending' WHERE report_id=$1 AND branch='classification'",[record.id]);
   const [paid]=await ctx.store.claim(1,['classification']);
   const paidIntent=await ctx.store.beginAttempt(paid,{operationId:randomUUID(),ownerId:paid.owner_id,deadlineAt:new Date(Date.now()+30000).toISOString()},0,{...metadata,model_id:'jev-1.13.0',model_revision:'jev-1.13.0',profile_id:'typesafe',question_version:'bug-hunt-jev-1'});
   await ctx.store.finishAttempt(paid,paidIntent,'outcome_unknown',{code:'MODEL_OUTCOME_UNKNOWN'});await ctx.store.finishJob(paid,'outcome_unknown');
   const snapshot=(await owner.query('SELECT id,body_hash,body,operation_id,business_attempt_id,phase FROM processing_attempt WHERE installation_id=$1 ORDER BY id',[ctx.installationId])).rows;
   ctx.setTarget('gemma2-synthetic-unknown');assert.equal(await ctx.store.reconcile(),1);
   let embeddingCalls=0,classifierCalls=0;
   const processor=createProcessor({store:ctx.store,indexReport:async()=>{},embedding:{invoke:async request=>{embeddingCalls++;return {requestId:request.requestId,operationId:request.operationId,model:EMBEDDING_MODEL,vectors:[vector]};}},classifier:{invoke:async()=>{classifierCalls++;},get:async()=>{classifierCalls++;}},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:true,classificationEnabled:true,externalAllowedOwners:[user.ownerId],externalProjection:async()=>({text:'Synthetic approved incident',excluded_fields:[],policy_version:'1'})})});
   await processor.tick();assert.equal(embeddingCalls,0);assert.equal(classifierCalls,0);
   const newJob=(await ctx.store.enrichmentModel(user,record.case_id)).branches.find(j=>j.branch==='embedding');
   assert.equal(newJob.index_generation,ctx.target());assert.ok(newJob.job_id);
   assert.equal(newJob.state,'blocked_policy');assert.equal(newJob.code,'PREVIOUS_GENERATION_UNKNOWN');
   assert.equal((await ctx.store.enrichmentModel(user,record.case_id)).branches.length,3);
   await ctx.store.retryUnknown(operator,{request_id:randomUUID(),job_id:newJob.job_id,business_attempt_id:randomUUID(),reason:'Operator explicitly accepts possible duplicate spend for new generation'});
   await processor.tick();assert.equal(embeddingCalls,1);assert.equal(classifierCalls,0);await processor.tick();assert.equal(embeddingCalls,1);
   const oldAfter=(await owner.query('SELECT id,body_hash,body,operation_id,business_attempt_id,phase FROM processing_attempt WHERE id=ANY($1::uuid[]) ORDER BY id',[snapshot.map(a=>a.id)])).rows;
   assert.deepEqual(oldAfter,snapshot);assert.equal((await owner.query("SELECT count(*)::int AS n FROM processing_job WHERE report_id=$1 AND branch='classification'",[record.id])).rows[0].n,1);
   await processor.stop();
  });
  await t.test('pending retry of old generation cannot clear historical unknown for a different generation',async()=>{
   const ctx=context(),record=await seed(ctx);
   const [old]=await ctx.store.claim(1,['embedding']);
   const intent=await ctx.store.beginAttempt(old,body(old),0,metadata);
   await ctx.store.finishAttempt(old,intent,'outcome_unknown',{code:'MODEL_OUTCOME_UNKNOWN'});
   await ctx.store.finishJob(old,'outcome_unknown');
   const retained=(await owner.query('SELECT body_hash,operation_id,business_attempt_id,phase FROM processing_attempt WHERE id=$1',[intent.id])).rows[0];
   const retryA=randomUUID();
   await ctx.store.retryUnknown(operator,{request_id:randomUUID(),job_id:old.id,business_attempt_id:retryA,reason:'Authorize old generation retry, not yet executed'});
   const pending=(await owner.query('SELECT state,business_attempt_id FROM processing_job WHERE id=$1',[old.id])).rows[0];
   assert.equal(pending.state,'pending');assert.equal(pending.business_attempt_id,retryA);
   assert.notEqual(pending.business_attempt_id,old.business_attempt_id);
   ctx.setTarget('gemma2-synthetic-pending-old-retry');await ctx.store.reconcile();
   let calls=0;
   const processor=createProcessor({store:ctx.store,indexReport:async()=>{},embedding:{invoke:async request=>{calls++;return {requestId:request.requestId,operationId:request.operationId,model:EMBEDDING_MODEL,vectors:[vector]};}},classifier:{invoke:async()=>{throw Error('Jev must not repeat');},get:async()=>{throw Error('Jev must not repeat');}},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:true,classificationEnabled:false,externalAllowedOwners:[]})});
   try{
    await processor.tick();assert.equal(calls,0,'pending retry A must not authorize possible duplicate spend by B');
    const target=(await ctx.store.enrichmentModel(user,record.case_id)).branches.find(j=>j.branch==='embedding');
    assert.equal(target.index_generation,ctx.target());assert.equal(target.state,'blocked_policy');assert.equal(target.code,'PREVIOUS_GENERATION_UNKNOWN');
    await ctx.store.retryUnknown(operator,{request_id:randomUUID(),job_id:target.job_id,business_attempt_id:randomUUID(),reason:'Explicitly accept possible duplicate spend for new generation B'});
    await processor.tick();assert.equal(calls,1);await processor.tick();assert.equal(calls,1);
    assert.deepEqual((await owner.query('SELECT body_hash,operation_id,business_attempt_id,phase FROM processing_attempt WHERE id=$1',[intent.id])).rows[0],retained);
    assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[old.id])).rows[0].state,'pending');
   }finally{await processor.stop();}
  });
  await t.test('in-flight old generation loses dispatch permission and its crashed intent is recovered without reinvoke',async()=>{
   const ctx=context();await seed(ctx);const [old]=await ctx.store.claim(1,['embedding']);
   const intent=await ctx.store.beginAttempt(old,body(old),0,metadata);assert.ok(intent);
   ctx.setTarget('gemma2-synthetic-inflight');
   assert.equal(await ctx.store.mayDispatch(old),false);assert.equal(await ctx.store.beginAttempt(old,body(old),1,metadata),null);
   await owner.query("UPDATE processing_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
   let calls=0;const fail=async()=>{calls++;throw Error('No automatic unknown replay');};
   const processor=createProcessor({store:ctx.store,indexReport:async()=>{},embedding:{invoke:fail},classifier:{invoke:fail,get:fail},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:true,classificationEnabled:false,externalAllowedOwners:[]})});
   for(let i=0;i<3;i++)await processor.tick();assert.equal(calls,0);await processor.stop();
   assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[old.id])).rows[0].state,'outcome_unknown');
   assert.equal((await owner.query("SELECT state FROM processing_job WHERE report_id=$1 AND index_generation=$2 AND branch='embedding'",[old.report_id,ctx.target()])).rows[0].state,'blocked_policy');
  });
  await t.test('intake uses protected build target and replay never adds local or Jev work',async()=>{
   const ctx=context();ctx.setTarget('gemma2-synthetic-intake');
   const core=createHandlers({store:createStore(app,{...base,installationId:ctx.installationId,targetGeneration:ctx.target,maxReports:100,reportsPerMinute:100}),evidence:async()=>{}});
   const input={request_id:randomUUID(),observation:obs};const receipt=await core.invoke('report',user,input);
   assert.equal((await core.invoke('report',user,input)).replayed,true);
   const jobs=(await owner.query("SELECT branch,index_generation FROM processing_job WHERE report_id=$1 ORDER BY branch",[receipt.report_id])).rows;
   assert.equal(jobs.length,3);assert.equal(jobs.find(j=>j.branch==='embedding').index_generation,ctx.target());
   for(const j of jobs.filter(j=>j.branch!=='embedding'))assert.equal(j.index_generation,'gemma2-symmetric-v1');
   const status=await invokeProcessing(ctx.store,'status',{});assert.equal(status.generations.active,GENERATION);assert.equal(status.generations.build,ctx.target());
  });
  await t.test('active historical pipeline metadata controls source and corpus coverage',async()=>{
   const ctx=context(),records=[await seed(ctx),await seed(ctx)];await fillOne(ctx);await fillOne(ctx);
   const historical='synthetic-historical',pipeline='retained-pipeline-fixture';
   await owner.query("INSERT INTO embedding_generation(installation_id,generation,metadata) VALUES($1,$2,$3)",[ctx.installationId,historical,{...generationMetadata,pipeline_version:pipeline}]);
   await owner.query("UPDATE processing_job SET pipeline_version=$2,index_generation=$3 WHERE installation_id=$1 AND branch='embedding'",[ctx.installationId,pipeline,historical]);
   await owner.query("UPDATE embedding_chunk SET generation=$2 WHERE installation_id=$1",[ctx.installationId,historical]);
   await owner.query("UPDATE embedding_generation_control SET active_generation=$2 WHERE installation_id=$1",[ctx.installationId,historical]);
   const result=await ctx.store.similar(user,{case_id:records[0].case_id});assert.equal(result.generation,historical);assert.equal(result.coverage.state,'complete');assert.equal(result.coverage.indexed_reports,2);
   const status=await invokeProcessing(ctx.store,'status',{});assert.equal(status.generations.active_coverage.indexed_reports,2);
  });
  await t.test('successful current old business attempt releases historical unknown without erasing that intent',async()=>{
   const ctx=context();await seed(ctx);const [old]=await ctx.store.claim(1,['embedding']);
   const intent=await ctx.store.beginAttempt(old,body(old),0,metadata);await ctx.store.finishAttempt(old,intent,'outcome_unknown');await ctx.store.finishJob(old,'outcome_unknown');
   await ctx.store.retryUnknown(operator,{request_id:randomUUID(),job_id:old.id,business_attempt_id:randomUUID(),reason:'Explicit recovery of the old generation'});
   await fillOne(ctx);
   ctx.setTarget('gemma2-synthetic-after-recovery');await ctx.store.reconcile();await fillOne(ctx);
   assert.equal((await owner.query('SELECT phase FROM processing_attempt WHERE id=$1',[intent.id])).rows[0].phase,'outcome_unknown');
   assert.equal((await ctx.store.processingStatus(operator)).generations.build_coverage.indexed_reports,1);
  });
  await t.test('partial chunks remain partial and cannot be activated as a full generation',async()=>{
   const ctx=context();await seed(ctx);const [job]=await ctx.store.claim(1,['embedding']);const attempt=await ctx.store.beginAttempt(job,body(job),0,metadata);
   await ctx.store.saveChunk(job,attempt,chunkText(searchProjection(job.observation)).chunks[0],vector,'partial');await ctx.store.finishJob(job,'succeeded');
   assert.deepEqual((await ctx.store.processingStatus(operator)).generations.active_coverage,{total_reports:1,indexed_reports:0,state:'partial'});
   await assert.rejects(ctx.store.activateGeneration(operator,activation(ctx,GENERATION)),fault('INDEX_NOT_READY'));
  });
  await t.test('registry/audit are immutable to runtime and every added column has an SQL comment',async()=>{
   for(const sql of ['UPDATE embedding_generation SET metadata=metadata','DELETE FROM embedding_generation_activation','UPDATE embedding_generation_activation SET reason=reason','UPDATE processing_job SET index_generation=index_generation','UPDATE processing_job SET pipeline_version=pipeline_version'])await assert.rejects(app.query(sql),e=>e.code==='42501');
   const missing=await owner.query("SELECT c.relname,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN('embedding_generation','embedding_generation_control','embedding_generation_activation','processing_job') AND a.attnum>0 AND NOT a.attisdropped AND col_description(c.oid,a.attnum) IS NULL");
   assert.equal(missing.rowCount,0);
  });
 }finally{await Promise.all([owner.end(),app.end()]);}
});
