// ABOUTME: Проверяет долговечный допуск модельных вызовов на настоящем PostgreSQL.
// ABOUTME: Два отдельных pool используют только synthetic fixture; провайдеры не вызываются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createProcessingStore,enqueueProcessing} from '../../dist/processing-store.js';
import {createProcessor,classificationQuestions,QUESTION_VERSION,ModelFault} from '../../dist/processing.js';
import {migrate} from '../../dist/migrate.js';
const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
for(const role of ['owner','app']){
 const u=new URL(fixture[role+'URL']);
 if(u.hostname!=='127.0.0.1'||u.port!=='18585'||u.pathname!=='/brai_bug_hunt_test')throw Error('Dedicated loopback fixture required');
}
const owner=new Pool({connectionString:fixture.ownerURL,max:2});
const pools=[0,1].map(()=>new Pool({connectionString:fixture.appURL,max:2}));
const base={cursorKey:'synthetic-pending-cursor-more-than-32-bytes',maxDatabaseBytes:1073741824,intakeReserveBytes:1048576,maxDerivativeBytes:268435456};
const principal={ownerId:'synthetic-pending-owner',actorId:'codex:synthetic-pending',source:'codex',reviewer:true};
const observation={title:'Synthetic pending incident',component_id:'synthetic',operation:'read',expected:'value',observed:'empty'};
const projection={text:'Synthetic incident description',policy_version:'synthetic-reviewed-v1',excluded_fields:[]};
const metadata={projection,model_id:'jev-1.13.0',model_revision:'jev-1.13.0',profile_id:'typesafe',question_version:QUESTION_VERSION};
function context(){
 const installationId='pending-fixture-'+randomUUID(),options={...base,installationId};
 return {installationId,stores:pools.map(pool=>createProcessingStore(pool,options))};
}
async function seed(ctx,branch){
 const id=randomUUID(),caseId=randomUUID(),db=await owner.connect();
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO bug_case(id,owner_id,installation_id,title,component_id,source,registered_at,updated_at) VALUES($1,$2,$3,$4,'synthetic','codex',clock_timestamp(),clock_timestamp())",[caseId,principal.ownerId,ctx.installationId,observation.title]);
  await db.query("INSERT INTO report(id,case_id,owner_id,installation_id,actor_id,observation,registered_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())",[id,caseId,principal.ownerId,ctx.installationId,principal.actorId,observation]);
  await enqueueProcessing(db,{id,case_id:caseId,owner_id:principal.ownerId,installation_id:ctx.installationId,observation});
  await db.query("UPDATE processing_job SET state='succeeded' WHERE report_id=$1 AND branch<>$2",[id,branch]);
  await db.query('COMMIT');return {id,caseId};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
const intent=j=>({operationId:randomUUID(),ownerId:j.owner_id,provider:'typesafe',model:'jev-1.13.0',state:projection.text,questions:classificationQuestions,deadlineAt:new Date(Date.now()+30000).toISOString()});
function operation(body,phase='accepted'){
 const result={provider:'typesafe',requestedModel:'jev-1.13.0',actualModel:'jev-1.13.0',usage:null,answers:Object.fromEntries(Object.entries(classificationQuestions).map(([key,q])=>[key,q.type==='noul'?{type:'noul',noul:.5}:{type:'choice',choice:'unknown',confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k==='unknown'?1:0]))}]))};
 return {ownerId:body.ownerId,operationId:body.operationId,route:{provider:'typesafe',model:'jev-1.13.0'},phase,resultExpired:false,...(phase==='succeeded'?{result}:{})};
}
function processors(ctx){
 const state={invokes:0,gets:0,finish:false,mode:'normal',enabled:true,bodies:new Map(),indexed:[]};
 const classifier={invoke:async body=>{state.invokes++;state.bodies.set(body.operationId,body);return operation(body);},get:async(_owner,id)=>{
  state.gets++;const body=state.bodies.get(id);assert.ok(body);
  if(state.mode==='missing')throw new ModelFault('MODEL_NOT_FOUND');
  if(state.mode==='expired')return {...operation(body,'succeeded'),resultExpired:true};
  return operation(body,state.finish?'succeeded':'accepted');
 }};
 const workers=ctx.stores.map(store=>createProcessor({store,indexReport:async id=>{state.indexed.push(id);},embedding:{invoke:async()=>{throw Error('No embedding call expected');}},classifier,activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:false,classificationEnabled:state.enabled,externalAllowedOwners:[principal.ownerId],externalProjection:async()=>projection})}));
 return {state,workers};
}
const ready=ctx=>owner.query("UPDATE processing_job SET available_at=clock_timestamp() WHERE installation_id=$1 AND state='waiting_dependency'",[ctx.installationId]);
const attempts=ctx=>owner.query("SELECT a.id,a.job_id,a.operation_id,a.body_hash,a.business_attempt_id,a.phase FROM processing_attempt a WHERE installation_id=$1 ORDER BY id",[ctx.installationId]);
async function legacyPending(ctx,record){
 // AIDEV-NOTE: Только owner synthetic БД моделирует сохранённое состояние прежнего runtime.
 const row=(await owner.query("UPDATE processing_job SET state='running',fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE report_id=$1 AND branch='classification' RETURNING *",[record.id])).rows[0];
 const job={...row,observation},body=intent(job),attempt=await ctx.stores[0].beginAttempt(job,body,0,metadata);
 assert.ok(attempt);assert.equal(await ctx.stores[0].finishJob(job,'waiting_dependency','PROVIDER_PENDING'),true);
 return {job,body,attempt};
}
test('pending model admission across independent workers',async t=>{
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await t.test('accepted intent blocks later invokes before GET is due and leaves local capacity',async()=>{
   const ctx=context();for(let i=0;i<21;i++)await seed(ctx,'classification');
   const local=await seed(ctx,'local'),{state,workers}=processors(ctx);
   await workers[0].tick();assert.equal(state.invokes,1);
   const before=(await attempts(ctx)).rows;
   await owner.query("UPDATE processing_job SET available_at=clock_timestamp()+interval '10 seconds' WHERE id=$1",[before[0].job_id]);
   await workers[1].tick();assert.equal(state.invokes,1,'pending provider keeps its model slot');
   assert.ok(state.indexed.includes(local.id),'blocked model backlog cannot hide local work before LIMIT');
   for(let i=0;i<6;i++){await ready(ctx);await Promise.all(workers.map(worker=>worker.tick()));}
   assert.equal(state.invokes,1);assert.ok(state.gets>=6);
   assert.deepEqual((await attempts(ctx)).rows,before);
   const budget=await owner.query('SELECT reserved_calls FROM processing_budget WHERE installation_id=$1',[ctx.installationId]);
   assert.ok(budget.rows.every(row=>Number(row.reserved_calls)===1));
   state.finish=true;await ready(ctx);await workers[0].tick();
   await workers[1].tick();assert.equal(state.invokes,2,'terminal GET frees admission for another report');
  });
  await t.test('lease and durable intent count once; recovery fits beside another model lease',async()=>{
   const ctx=context();await seed(ctx,'classification');
   const [old]=await ctx.stores[0].claim(1,['classification']),body=intent(old),a=await ctx.stores[0].beginAttempt(old,body,0,metadata);
   assert.ok(a);const local=await seed(ctx,'local');
   const [localJob]=await ctx.stores[1].claim(2,['local']);assert.equal(localJob.report_id,local.id);
   await ctx.stores[1].finishJob(localJob,'succeeded');
   await seed(ctx,'embedding');const [embedding]=await ctx.stores[1].claim(2,['embedding']);assert.equal(embedding.branch,'embedding');
   const later=await seed(ctx,'local');assert.equal((await ctx.stores[1].claim()).length,0);
   await owner.query("UPDATE processing_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
   const [recovery]=await ctx.stores[1].claim(2,['local']);assert.equal(recovery.id,old.id);assert.equal(recovery.fence,old.fence+1);
   assert.equal((await ctx.stores[1].latestAttempt(recovery,0)).operation_id,a.operation_id);
   assert.equal(await ctx.stores[0].finishAttempt(old,a,'succeeded'),false);
   assert.equal(await ctx.stores[1].finishAttempt(recovery,a,'succeeded'),true);
   await ctx.stores[1].finishJob(recovery,'succeeded');await ctx.stores[1].finishJob(embedding,'succeeded');
   const [next]=await ctx.stores[0].claim(2,['local']);assert.equal(next.report_id,later.id);
  });
  await t.test('legacy oversubscription drains existing GETs ahead of older fresh backlog, even paused and disabled',async()=>{
   const ctx=context();for(let i=0;i<20;i++)await seed(ctx,'classification');
   const {state,workers}=processors(ctx);state.finish=true;
   for(let i=0;i<14;i++){const previous=await legacyPending(ctx,await seed(ctx,'classification'));state.bodies.set(previous.body.operationId,previous.body);}
   const before=(await attempts(ctx)).rows;
   await ready(ctx);await workers[0].tick();assert.equal(state.invokes,0);assert.equal(state.gets,1);
   state.enabled=false;await ctx.stores[0].pause(principal,{request_id:randomUUID(),paused:true,reason:'Synthetic drain only'});
   for(let i=0;i<14;i++){await ready(ctx);await Promise.all(workers.map(worker=>worker.tick()));}
   assert.equal(state.invokes,0);assert.equal(state.gets,14);
   const after=(await attempts(ctx)).rows;assert.equal(after.length,14);assert.ok(after.every(row=>row.phase==='succeeded'));
   assert.deepEqual(after.map(({phase,...row})=>row),before.map(({phase,...row})=>row));
   const budget=await owner.query('SELECT reserved_calls FROM processing_budget WHERE installation_id=$1',[ctx.installationId]);
   assert.ok(budget.rows.every(row=>Number(row.reserved_calls)===14));
   state.enabled=true;await ctx.stores[0].pause(principal,{request_id:randomUUID(),paused:false,reason:'Synthetic resume'});
   await workers[0].tick();assert.equal(state.invokes,1);
  });
  for(const mode of ['missing','expired'])await t.test(mode+' result keeps prior intent and never automatically invokes that report again',async()=>{
   const ctx=context();await seed(ctx,'classification');await seed(ctx,'classification');
   const {state,workers}=processors(ctx);await workers[0].tick();
   const before=(await attempts(ctx)).rows[0];state.mode=mode;await ready(ctx);await workers[1].tick();
   assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[before.job_id])).rows[0].state,'outcome_unknown');
   state.mode='normal';await workers[0].tick();assert.equal(state.invokes,2);
   const after=(await attempts(ctx)).rows.filter(row=>row.job_id===before.job_id);
   assert.equal(after.length,1);assert.equal(after[0].operation_id,before.operation_id);assert.equal(after[0].body_hash,before.body_hash);
   assert.equal(after[0].business_attempt_id,before.business_attempt_id);assert.equal(after[0].phase,'outcome_unknown');
  });
 }finally{await Promise.all([owner.end(),...pools.map(pool=>pool.end())]);}
});
