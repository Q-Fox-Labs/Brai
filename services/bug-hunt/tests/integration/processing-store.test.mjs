// ABOUTME: Проверяет очередь, бюджеты, fencing и scoped cosine на настоящем PostgreSQL.
// ABOUTME: Использует только отдельную loopback fixture и синтетические наблюдения.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createProcessingStore,enqueueProcessing} from '../../dist/processing-store.js';
import {migrate} from '../../dist/migrate.js';
import {createProcessor} from '../../dist/processing.js';
import {createSystemStore} from '../../dist/system-store.js';
import {EMBEDDING_MODEL,chunkText,searchProjection,GENERATION} from '../../dist/projection.js';
const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
const url=role=>{
 const raw=process.env['BUG_HUNT_TEST_'+role.toUpperCase()+'_URL']??fixture[role+'URL'],u=new URL(raw);
 if(u.hostname!=='127.0.0.1'||u.port!=='18585'||u.pathname!=='/brai_bug_hunt_test')throw new Error('Dedicated loopback fixture required');return raw;
};
const owner=new Pool({connectionString:url('owner'),max:2}),app=new Pool({connectionString:url('app'),max:2});
const base={cursorKey:'synthetic-processing-cursor-at-least-32-bytes',maxDatabaseBytes:1073741824,intakeReserveBytes:1048576,maxDerivativeBytes:268435456};
const user={ownerId:'synthetic-processing-owner',actorId:'codex:synthetic-processing',source:'codex',reviewer:false};
const operator={ownerId:'synthetic-operator',actorId:'web:synthetic-operator',source:'web',reviewer:true};
const vector=Array.from({length:768},(_,i)=>i===0?1:0);
const observation={title:'Synthetic incident',operation:'read',expected:'value',observed:'empty',component_id:'synthetic-component'};
const fault=code=>e=>e.code===code;
let sequence=0;
const context=extra=>{const installationId='processing-fixture-'+randomUUID();return {installationId,store:createProcessingStore(app,{...base,installationId,...extra})};};
async function seed(ctx,own=user.ownerId,obs=observation,branch){
 const id=randomUUID(),case_id=randomUUID(),db=await owner.connect();
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO bug_case(id,owner_id,installation_id,title,component_id,source,registered_at,updated_at) VALUES($1,$2,$3,$4,$5,'codex',clock_timestamp(),clock_timestamp())",[case_id,own,ctx.installationId,obs.title,obs.component_id??'unknown']);
  await db.query("INSERT INTO report(id,case_id,owner_id,installation_id,actor_id,observation,registered_at) VALUES($1,$2,$3,$4,'synthetic-actor',$5,clock_timestamp())",[id,case_id,own,ctx.installationId,obs]);
  await enqueueProcessing(db,{id,case_id,owner_id:own,installation_id:ctx.installationId,observation:obs});
  if(branch)await db.query("UPDATE processing_job SET state='succeeded' WHERE report_id=$1 AND branch<>$2",[id,branch]);
  await db.query('COMMIT');return {id,case_id,own};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
const body=j=>({requestId:randomUUID(),operationId:randomUUID(),ownerId:j.owner_id,deadlineAt:new Date(Date.now()+30000).toISOString(),model:EMBEDDING_MODEL,purpose:'symmetric',texts:['synthetic']});
const metadata={model_id:EMBEDDING_MODEL.modelId,model_revision:EMBEDDING_MODEL.revision,profile_id:EMBEDDING_MODEL.profileId,question_version:null};
test('real processing store lifecycle',async t=>{
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await t.test('every new column has a comment and runtime cannot alter intent or vector',async()=>{
   const r=await owner.query("SELECT c.relname,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN('processing_job','processing_attempt','processing_budget','processing_control','processing_operator_action','embedding_chunk') AND a.attnum>0 AND NOT a.attisdropped AND col_description(c.oid,a.attnum) IS NULL");assert.equal(r.rowCount,0);
   for(const q of ['UPDATE processing_attempt SET body=body','UPDATE processing_attempt SET deadline_at=deadline_at','UPDATE processing_job SET input_hash=input_hash','UPDATE embedding_chunk SET embedding=embedding','DELETE FROM processing_job','DELETE FROM processing_attempt','CREATE TABLE processing_forbidden(id int)'])await assert.rejects(app.query(q),e=>e.code==='42501');
  });
  await t.test('enqueue participates in intake rollback and equal retry creates only three obligations',async()=>{
   const ctx=context(),r=await seed(ctx),db=await app.connect();
   try{await db.query('BEGIN');await enqueueProcessing(db,{id:r.id,case_id:r.case_id,owner_id:r.own,installation_id:ctx.installationId,observation});await db.query('ROLLBACK');}finally{db.release();}
   assert.equal((await owner.query('SELECT count(*)::int AS n FROM processing_job WHERE report_id=$1',[r.id])).rows[0].n,3);
  });
  await t.test('concurrent claims cap total jobs at two and model branch concurrency at one',async()=>{
   const ctx=context();await seed(ctx);await seed(ctx);
   const claims=(await Promise.all([ctx.store.claim(16),ctx.store.claim(16)])).flat();assert.equal(claims.length,2);
   for(const branch of ['embedding','classification'])assert.ok(claims.filter(j=>j.branch===branch).length<=1);
  });
  await t.test('expired lease receives new fence and rejects all late writes',async()=>{
   const ctx=context();await seed(ctx,user.ownerId,observation,'embedding');
   const [old]=await ctx.store.claim();await owner.query("UPDATE processing_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
   const [fresh]=await ctx.store.claim();assert.equal(fresh.fence,old.fence+1);
   assert.equal(await ctx.store.heartbeat(old),false);assert.equal(await ctx.store.finishJob(old,'succeeded'),false);assert.equal(await ctx.store.beginAttempt(old,body(old),0,metadata),null);
   assert.equal(await ctx.store.finishJob(fresh,'succeeded'),true);
  });
  await t.test('daily budgets reserve atomically and unknown remains charged',async()=>{
   const ctx=context({dailyLimits:{embedding:{owner:1,global:1},classification:{owner:1,global:1}}});
   await seed(ctx,user.ownerId,observation,'embedding');let [j]=await ctx.store.claim();
   const a=await ctx.store.beginAttempt(j,body(j),0,metadata);assert.ok(a);
   await ctx.store.finishAttempt(j,a,'outcome_unknown',{code:'MODEL_OUTCOME_UNKNOWN'});await ctx.store.finishJob(j,'outcome_unknown');
   await seed(ctx,user.ownerId,observation,'embedding');[j]=await ctx.store.claim();assert.equal(await ctx.store.beginAttempt(j,body(j),0,metadata),null);
   const counts=await owner.query('SELECT reserved_calls FROM processing_budget WHERE installation_id=$1',[ctx.installationId]);assert.deepEqual(counts.rows.map(r=>r.reserved_calls),[1,1]);
   assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[j.id])).rows[0].state,'budget_exhausted');
   assert.equal((await ctx.store.claim()).length,0);
   await owner.query("UPDATE processing_budget SET budget_day=budget_day-1 WHERE installation_id=$1",[ctx.installationId]);
   await owner.query("UPDATE processing_job SET available_at=clock_timestamp() WHERE id=$1",[j.id]);
   const [resumed]=await ctx.store.claim();assert.equal(resumed.id,j.id);assert.equal(resumed.business_attempt_id,j.business_attempt_id);
   assert.ok(await ctx.store.beginAttempt(resumed,body(resumed),0,metadata));
  });
  await t.test('pause is durable/idempotent and explicit retry requires a fresh business attempt',async()=>{
   const ctx=context();await seed(ctx,user.ownerId,observation,'embedding');const [j]=await ctx.store.claim();
   await ctx.store.finishJob(j,'outcome_unknown');
   const p={request_id:randomUUID(),paused:true,reason:'Synthetic operator pause'};
   assert.equal((await ctx.store.pause(operator,p)).replayed,false);assert.equal((await ctx.store.pause(operator,p)).replayed,true);
   await assert.rejects(ctx.store.pause(operator,{...p,paused:false}),fault('IDEMPOTENCY_CONFLICT'));
   await assert.rejects(ctx.store.pause(user,p),fault('FORBIDDEN'));
   const retry={request_id:randomUUID(),job_id:j.id,business_attempt_id:randomUUID(),reason:'Explicit new synthetic business attempt'};
   assert.equal((await ctx.store.retryUnknown(operator,retry)).replayed,false);assert.equal((await ctx.store.retryUnknown(operator,retry)).replayed,true);
   await assert.rejects(ctx.store.retryUnknown(operator,{...retry,reason:'Changed'}),fault('IDEMPOTENCY_CONFLICT'));
   assert.equal((await ctx.store.claim()).length,0);
   const fresh=createProcessingStore(app,{...base,installationId:ctx.installationId});assert.equal((await fresh.processingStatus(operator)).paused,true);
   await fresh.pause(operator,{request_id:randomUUID(),paused:false,reason:'Continue synthetic fixture'});assert.equal((await fresh.claim()).length,1);
   assert.equal((await owner.query('SELECT count(*)::int AS n FROM processing_operator_action WHERE job_id=$1',[j.id])).rows[0].n,1);
  });
  await t.test('restart does not replay a crashed Local AI intent and heartbeat does not hold a model connection',async()=>{
   const ctx=context();await seed(ctx,user.ownerId,observation,'embedding');const [j]=await ctx.store.claim();const a=await ctx.store.beginAttempt(j,body(j),0,metadata);assert.ok(a);
   await owner.query("UPDATE processing_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);let invokes=0;
   const processor=createProcessor({store:ctx.store,indexReport:async()=>{},embedding:{invoke:async()=>{invokes++;}},classifier:{invoke:async()=>{},get:async()=>{}},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:true,classificationEnabled:false,externalAllowedOwners:[]})});
   await processor.tick();assert.equal(invokes,0);
   assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[j.id])).rows[0].state,'outcome_unknown');
   assert.equal(app.idleCount,app.totalCount);
  });
  await t.test('anti-join reconcile finds a late commit without a registration watermark',async()=>{
   const ctx=context(),r=await seed(ctx,user.ownerId,observation,'local');await owner.query('DELETE FROM processing_job WHERE report_id=$1',[r.id]);
   await owner.query("UPDATE report SET registered_at='2020-01-01T00:00:00Z' WHERE id=$1",[r.id]);
   assert.equal(await ctx.store.reconcile(50),1);assert.equal((await owner.query('SELECT count(*)::int AS n FROM processing_job WHERE report_id=$1',[r.id])).rows[0].n,3);
  });
  await t.test('derivative byte cap preserves raw observations and blocks dispatch intent',async()=>{
   const ctx=context({maxDerivativeBytes:1}),r=await seed(ctx,user.ownerId,observation,'embedding');const [j]=await ctx.store.claim();
   assert.equal(await ctx.store.beginAttempt(j,body(j),0,metadata),null);
   assert.deepEqual((await owner.query('SELECT observation FROM report WHERE id=$1',[r.id])).rows[0].observation,observation);
  });
  await t.test('disabled model backlog cannot occupy local work selection',async()=>{
   const ctx=context();for(let i=0;i<24;i++)await seed(ctx);
   const first=await ctx.store.claim(2,['local']);assert.equal(first.length,2);assert.ok(first.every(j=>j.branch==='local'));
   for(const j of first)await ctx.store.finishJob(j,'succeeded');
   const next=await ctx.store.claim(2,['local']);assert.equal(next.length,2);assert.ok(next.every(j=>j.branch==='local'));
  });
  await t.test('exact cosine is scoped, paginated, filtered and conservatively counts all reports',async()=>{
   const ctx=context(),records=[];for(let i=0;i<4;i++)records.push(await seed(ctx,user.ownerId,{...observation,title:'Synthetic '+i,component_version:'1'},'embedding'));
   const foreign=await seed(ctx,'foreign-synthetic-owner',observation,'embedding');
   const local=createSystemStore(app,{...base,installationId:ctx.installationId});
   for(const record of [...records,foreign]){await local.indexReport(record.id);
    await owner.query("UPDATE processing_job SET priority='new',registered_at=clock_timestamp()+($2::int*interval '1 second') WHERE report_id=$1",[record.id,sequence++]);
   }
   for(let i=0;i<5;i++){
    const [j]=await ctx.store.claim();assert.ok(j);const a=await ctx.store.beginAttempt(j,body(j),0,metadata);
    const [chunk]=chunkText(searchProjection(j.observation)).chunks;assert.equal(await ctx.store.saveChunk(j,a,chunk,vector,'complete'),true);await ctx.store.propose(j,'complete');await ctx.store.finishJob(j,'succeeded');
   }
   assert.equal((await owner.query("SELECT count(*)::int AS n FROM similarity_proposal WHERE installation_id=$1",[ctx.installationId])).rows[0].n,0,'exact duplicates do not occupy semantic proposals');
   const first=await ctx.store.similar(user,{case_id:records[0].case_id,limit:1});assert.equal(first.items.length,1);assert.equal(first.has_more,true);assert.ok(first.next_cursor);
   assert.equal(first.coverage.total_reports,4);assert.equal(first.coverage.indexed_reports,4);assert.equal(first.coverage.state,'complete');
   const next=await ctx.store.similar(user,{case_id:records[0].case_id,limit:50,cursor:first.next_cursor});assert.equal(next.items.length,2);assert.equal(new Set([...first.items,...next.items].map(x=>x.case_id)).size,3);
   assert.equal(next.items.some(x=>x.case_id===foreign.case_id),false);
   await assert.rejects(ctx.store.similar({...user,ownerId:'foreign-synthetic-owner'},{case_id:records[0].case_id}),fault('NOT_FOUND'));
   await assert.rejects(ctx.store.similar(user,{case_id:records[0].case_id,cursor:first.next_cursor,filters:{component_id:'changed'}}),fault('INVALID_ARGUMENT'));
   const pending=await seed(ctx,user.ownerId,observation,'embedding');const partial=await ctx.store.similar(user,{case_id:records[0].case_id});assert.equal(partial.coverage.state,'partial');assert.equal(partial.coverage.total_reports,5);
   assert.equal((await ctx.store.enrichmentModel(user,records[0].case_id)).branches.length,3);
   await assert.rejects(ctx.store.enrichmentModel({...user,ownerId:'foreign-synthetic-owner'},records[0].case_id),fault('NOT_FOUND'));
   assert.ok(pending);
   await assert.rejects(ctx.store.similar(user,{case_id:pending.case_id,filters:{component_id:'missing-corpus'}}),fault('INDEX_NOT_READY'));
   const [late]=await ctx.store.claim();assert.equal(late.report_id,pending.id);
   const attempt=await ctx.store.beginAttempt(late,body(late),0,metadata);assert.ok(attempt);
   const [chunk]=chunkText(searchProjection(late.observation)).chunks;
   assert.equal(await ctx.store.saveChunk(late,attempt,chunk,vector,'partial'),true);await ctx.store.finishJob(late,'succeeded');
   assert.equal((await ctx.store.similar(user,{case_id:pending.case_id,filters:{component_id:'missing-corpus'}})).coverage.state,'partial');
   await assert.rejects(ctx.store.similar(user,{case_id:records[0].case_id,limit:1,cursor:first.next_cursor}),fault('CURSOR_STALE'));
  });
  await t.test('protected budget reload takes effect before the next reservation',async()=>{
   let ownerLimit=1;
   const policy=()=>({dailyLimits:{embedding:{owner:ownerLimit,global:10},classification:{owner:0,global:0}},maxDatabaseBytes:1073741824,intakeReserveBytes:1048576,maxDerivativeBytes:268435456});
   const ctx=context({policy});await seed(ctx,user.ownerId,observation,'embedding');const [j]=await ctx.store.claim();
   ownerLimit=0;assert.equal(await ctx.store.beginAttempt(j,body(j),0,metadata),null);
   const status=await ctx.store.processingStatus(operator);assert.equal(status.limits.dailyLimits.embedding.owner,0);assert.equal(status.limits.maxDerivativeBytes,268435456);assert.equal('cursorKey' in status.limits,false);
   const attempts=await owner.query('SELECT count(*)::int AS n FROM processing_attempt WHERE job_id=$1',[j.id]);assert.equal(attempts.rows[0].n,0);
  });
  await t.test('new work gets priority while every fourth claim admits historical work',async()=>{
   const ctx=context();const old=await seed(ctx,user.ownerId,observation,'local');const fresh=await seed(ctx,user.ownerId,observation,'local');
   await owner.query("UPDATE processing_job SET priority='backfill' WHERE report_id=$1",[old.id]);
   const [first]=await ctx.store.claim(1);assert.equal(first.report_id,fresh.id);await ctx.store.finishJob(first,'succeeded');
   await owner.query('UPDATE processing_control SET claim_counter=3 WHERE installation_id=$1',[ctx.installationId]);await seed(ctx,user.ownerId,observation,'local');
   const [historical]=await ctx.store.claim(1);assert.equal(historical.report_id,old.id);
  });
  await t.test('classifier persistence leaves manual override, review state and originals unchanged',async()=>{
   const ctx=context(),r=await seed(ctx,user.ownerId,observation,'classification');
   const overrideId=randomUUID();
   await owner.query("INSERT INTO classification_override(id,installation_id,owner_id,case_id,revision,actor_id,labels,explanation) VALUES($1,$2,$3,$4,1,'synthetic-reviewer',$5,'Synthetic manual label')",[overrideId,ctx.installationId,user.ownerId,r.case_id,{suspected_type:'configuration'}]);
   const projection={text:'Synthetic reviewed description',excluded_fields:[],policy_version:'reviewed-1'};
   const processor=createProcessor({store:ctx.store,indexReport:async()=>{},embedding:{invoke:async()=>{}},classifier:{invoke:async body=>{
    const choice=keys=>({type:'choice',choice:'unknown',probabilities:Object.fromEntries(keys.map(k=>[k,k==='unknown'?1:0])),confidence:1});
    return {ownerId:body.ownerId,operationId:body.operationId,phase:'succeeded',route:{provider:'typesafe',model:'jev-1.13.0'},resultExpired:false,result:{provider:'typesafe',requestedModel:'jev-1.13.0',actualModel:'jev-1.13.0',usage:null,answers:{suspected_type:choice(['suspected_defect','usage','configuration','limitation','transient','insufficient_evidence','unknown']),suspected_impact:choice(['critical','high','medium','low','unknown']),evidence_sufficiency:{type:'noul',noul:.9},suspected_defect_score:{type:'noul',noul:.7}}}};
   },get:async()=>{}},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:false,classificationEnabled:true,externalAllowedOwners:[user.ownerId],externalProjection:async()=>projection})});
   await processor.tick();
   const result=await ctx.store.enrichmentModel(user,r.case_id);assert.equal(result.classifications.length,1);assert.equal(result.classifications[0].payload.usage,null);
   assert.equal(result.branches.find(x=>x.branch==='classification').state,'succeeded');
   assert.deepEqual((await owner.query('SELECT labels FROM classification_override WHERE id=$1',[overrideId])).rows[0].labels,{suspected_type:'configuration'});
   assert.equal((await owner.query('SELECT review_state FROM bug_case WHERE id=$1',[r.case_id])).rows[0].review_state,'new');
   assert.deepEqual((await owner.query('SELECT observation FROM report WHERE id=$1',[r.id])).rows[0].observation,observation);
  });
 }finally{await Promise.all([owner.end(),app.end()]);}
});
