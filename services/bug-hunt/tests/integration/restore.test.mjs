// ABOUTME: Проверяет квитанцию после реального pg_dump/pg_restore в отдельную fixture БД.
// ABOUTME: Принимает только loopback restore-БД; не изменяет первичный источник.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {fixture} from './fixture.mjs';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {createHandlers} from '../../dist/domain.js';
import {createProcessingStore} from '../../dist/processing-store.js';
import {createProcessor} from '../../dist/processing.js';
const database=process.env.BUG_HUNT_TEST_RESTORE_DATABASE??'brai_bug_hunt_restore';
assert.match(database,/^brai_bug_hunt_restore(?:_stage2)?$/);
test('restored database preserves original receipt and observation',async()=>{
 const ownerURL=new URL(fixture.ownerURL),appURL=new URL(fixture.appURL);
 ownerURL.pathname=appURL.pathname='/'+database;
 assert.equal(ownerURL.hostname,'127.0.0.1');assert.equal(appURL.hostname,'127.0.0.1');
 const owner=new Pool({connectionString:ownerURL.href,max:1}),app=new Pool({connectionString:appURL.href,max:1});
 try{
  for(const table of ['report','mutation','group_membership','group_audit','processing_job','processing_attempt','processing_budget','classification','embedding_chunk','embedding_generation','embedding_generation_control','embedding_generation_activation'])await app.query('SELECT 1 FROM '+table+' LIMIT 1');
  for(const sql of ['UPDATE report SET observation=observation','DELETE FROM mutation','UPDATE processing_attempt SET body=body','UPDATE embedding_chunk SET embedding=embedding','CREATE TABLE restore_forbidden(id int)','CREATE TEMP TABLE restore_temp_forbidden(id int)','UPDATE embedding_generation SET metadata=metadata','DELETE FROM embedding_generation_activation'])await assert.rejects(app.query(sql),e=>e.code==='42501');
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  const found=await owner.query("SELECT m.*,r.observation FROM mutation m JOIN report r ON r.id=(m.result->>'report_id')::uuid WHERE m.operation='report' AND m.installation_id='fixture-installation' ORDER BY r.registered_at LIMIT 1");
  assert.equal(found.rowCount,1);const row=found.rows[0];
  const core=createHandlers({store:createStore(app,{installationId:row.installation_id,cursorKey:'fixture-cursor-key-at-least-32-bytes',maxReports:1,reportsPerMinute:1,maxDatabaseBytes:1}),evidence:async()=>{throw Error('Replay must not revalidate evidence');}});
  const p={ownerId:row.owner_id,actorId:row.actor_id,source:'codex',reviewer:false};
  assert.deepEqual(await core.invoke('report',p,{request_id:row.request_id,observation:row.observation}),{...row.result,replayed:true});
  assert.deepEqual((await core.invoke('get',p,{case_id:row.result.case_id})).report.observation,row.observation);
 }finally{await Promise.all([owner.end(),app.end()]);}
});

test('restored unknown attempt cannot dispatch again and retains spent budget',async()=>{
 const ownerURL=new URL(fixture.ownerURL),appURL=new URL(fixture.appURL);ownerURL.pathname=appURL.pathname='/'+database;
 const owner=new Pool({connectionString:ownerURL.href,max:1}),app=new Pool({connectionString:appURL.href,max:2});let processor;
 try{
  const rows=await owner.query("SELECT j.* FROM processing_job j WHERE j.state='outcome_unknown' AND j.branch='embedding' AND EXISTS(SELECT 1 FROM processing_attempt a WHERE a.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM processing_job k WHERE k.installation_id=j.installation_id AND k.state IN('pending','running','waiting_dependency','budget_exhausted')) LIMIT 1");
  assert.equal(rows.rowCount,1);const job=rows.rows[0];
  const before=await owner.query('SELECT body_hash,input_hash,operation_id FROM processing_attempt WHERE job_id=$1 ORDER BY id',[job.id]);
  const budget=await owner.query('SELECT coalesce(sum(reserved_calls),0)::text AS calls FROM processing_budget WHERE installation_id=$1',[job.installation_id]);
  let calls=0;const unavailable=async()=>{calls++;throw new Error('Restore must not invoke models');};
  const store=createProcessingStore(app,{installationId:job.installation_id,cursorKey:'synthetic-restored-processing-cursor-32-bytes'});
  processor=createProcessor({store,indexReport:unavailable,embedding:{invoke:unavailable},classifier:{invoke:unavailable,get:unavailable},activeOwner:async()=>true,settings:()=>({enabled:true,embeddingEnabled:true,classificationEnabled:true,externalAllowedOwners:[]})});
  await processor.tick();await processor.stop();assert.equal(calls,0);
  assert.equal((await owner.query('SELECT state FROM processing_job WHERE id=$1',[job.id])).rows[0].state,'outcome_unknown');
  assert.deepEqual((await owner.query('SELECT body_hash,input_hash,operation_id FROM processing_attempt WHERE job_id=$1 ORDER BY id',[job.id])).rows,before.rows);
  assert.deepEqual((await owner.query('SELECT coalesce(sum(reserved_calls),0)::text AS calls FROM processing_budget WHERE installation_id=$1',[job.installation_id])).rows,budget.rows);
 }finally{if(processor)await processor.stop();await Promise.all([owner.end(),app.end()]);}
});

test('restored generation activation replays receipt without another switch or audit',async()=>{
 const ownerURL=new URL(fixture.ownerURL),appURL=new URL(fixture.appURL);ownerURL.pathname=appURL.pathname='/'+database;
 const owner=new Pool({connectionString:ownerURL.href,max:1}),app=new Pool({connectionString:appURL.href,max:2});
 try{
  const found=await owner.query("SELECT m.*,a.reason FROM v2_mutation m JOIN embedding_generation_activation a ON a.installation_id=m.installation_id AND a.activation_revision=(m.result->>'activation_revision')::int AND a.actor_id=m.actor_id WHERE m.operation='processing-activate-generation' ORDER BY a.registered_at LIMIT 1");
  assert.equal(found.rowCount,1);const row=found.rows[0];
  const snapshot=async()=>({
   control:(await owner.query('SELECT active_generation,activation_revision FROM embedding_generation_control WHERE installation_id=$1',[row.installation_id])).rows,
   audit:(await owner.query('SELECT id,activation_revision FROM embedding_generation_activation WHERE installation_id=$1 ORDER BY activation_revision',[row.installation_id])).rows,
   chunks:(await owner.query('SELECT generation,count(*)::int n FROM embedding_chunk WHERE installation_id=$1 GROUP BY generation ORDER BY generation',[row.installation_id])).rows
  });
  const before=await snapshot();
  const store=createProcessingStore(app,{installationId:row.installation_id,cursorKey:'synthetic-restored-generation-key-32-bytes'});
  const result=await store.activateGeneration({ownerId:row.owner_id,actorId:row.actor_id,source:'web',reviewer:true},{request_id:row.request_id,generation:row.result.generation,expected_active_generation:row.result.previous_generation,reason:row.reason});
  assert.deepEqual(result,{...row.result,replayed:true});assert.deepEqual(await snapshot(),before);
 }finally{await Promise.all([owner.end(),app.end()]);}
});
