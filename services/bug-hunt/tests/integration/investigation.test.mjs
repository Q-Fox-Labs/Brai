// ABOUTME: Проверяет настоящую запись расследования и повторное чтение из восстановленной БД.
// ABOUTME: Работает только с выделенным локальным PostgreSQL и синтетическими данными.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';

const fixture = process.env.BUG_HUNT_DIAGNOSTIC_PG_PORT;
const source = process.env.BUG_HUNT_DIAGNOSTIC_RESTORE !== '1';
const installationId = 'diagnostic-fixture';
const principal = {ownerId:'one',actorId:'codex:fixture-one',source:'codex',reviewer:false};
const other = {...principal,ownerId:'two',actorId:'codex:fixture-two'};
const noEvidence = async()=>{};
const service = {ownerId:'',actorId:'service:bug-hunt-investigator',source:'codex',reviewer:false,installationInvestigator:true};

test('diagnostic result, exact reuse, isolation, replay and restore', {skip:!fixture}, async()=>{
 assert.match(fixture,/^[0-9]+$/);
 const port = Number(fixture);
 assert.ok(port > 0 && port < 65536);
 const database = source ? 'brai_bug_hunt_test' : 'brai_bug_hunt_restore';
 const owner = new Pool({host:'127.0.0.1',port,database,user:'bug_hunt_owner',password:'fixture-owner'});
 const app = new Pool({host:'127.0.0.1',port,database,user:'bug_hunt_app',password:'fixture-app'});
 const options = {installationId,cursorKey:'fixture-cursor-key-at-least-32-bytes',maxReports:100,reportsPerMinute:100};
 const store = createStore(app,options);
 const input = {request_id:'ac886e81-cc92-4ad0-b3e5-9eeda5bf72d2',observation:{title:'Fixture worker unavailable',component_id:'hermes',commit_sha:'a'.repeat(40),operation:'read',expected:'ready',observed:'failed'}};
 try {
  if (!source) {
   const receipt = await store.report(principal,input,()=>assert.fail('Replay must return the preserved receipt'));
   const card = await store.getWithInvestigation(principal,{case_id:receipt.case_id});
   assert.equal(card.investigation.state,'processed');
   assert.equal(card.investigation.result.verdict,'confirmed');
   assert.deepEqual(card.report.observation,input.observation);
   return;
  }
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  const receipt = await store.report(principal,input,noEvidence);
  const claim = {request_id:randomUUID(), case_id:receipt.case_id};
  await assert.rejects(store.claimInvestigation(other,claim),{code:'NOT_FOUND'});
  const [job,replay] = await Promise.all([store.claimInvestigation(principal,claim),store.claimInvestigation(principal,claim)]);
  assert.equal(job.investigation_id,replay.investigation_id);
  assert.notEqual(job.replayed,replay.replayed);
  assert.equal((await store.claimInvestigation(principal,{...claim,request_id:randomUUID()})).state,'no_work');
  const result = {verdict:'confirmed',description:'The worker was in failed state.',scope:{commit_sha:input.observation.commit_sha},
   evidence:[{source:'ansible:systemd',observed_at:'2026-11-18T00:00:00Z',fact:'ActiveState=failed'}],advice:{kind:'stop',text:'Wait for service recovery.'}};
  const finish = {request_id:randomUUID(), investigation_id:job.investigation_id, result};
  await assert.rejects(store.finishInvestigation(other,'complete',finish),{code:'NOT_FOUND'});
  await assert.rejects(store.finishInvestigation(principal,'fail',finish),{code:'INVALID_ARGUMENT'});
  assert.equal((await store.finishInvestigation(principal,'complete',finish)).state,'completed');
  assert.equal((await store.finishInvestigation(principal,'complete',finish)).replayed,true);
  assert.equal((await store.getWithInvestigation(principal,{case_id:receipt.case_id})).investigation.state,'processed');
  assert.deepEqual((await store.getWithInvestigation(principal,{case_id:receipt.case_id})).investigation.result,result);
  assert.equal('investigation' in await store.get(principal,{case_id:receipt.case_id}),false);
  const secondInput = {...input,request_id:randomUUID()};
  const second = await store.report(principal,secondInput,noEvidence);
  const known = await store.investigationForReport(principal,second.case_id,secondInput);
  assert.equal(known.applicability,'exact');
  assert.equal(known.state,'pending');
  assert.equal(known.case_id,receipt.case_id);
  const changedInput = {request_id:randomUUID(),observation:{...input.observation,commit_sha:'b'.repeat(40)}};
  const changed = await store.report(principal,changedInput,noEvidence);
  assert.equal((await store.investigationForReport(principal,changed.case_id,changedInput)).applicability,'none');
  const foreign = await store.report(other,{...input,request_id:randomUUID()},noEvidence);
  assert.equal((await store.investigationForReport(other,foreign.case_id,input)).applicability,'none');
  await assert.rejects(store.listInvestigationQueue(principal,{}),{code:'FORBIDDEN'});
  await assert.rejects(store.readInvestigationCard(other,{case_id:foreign.case_id}),{code:'FORBIDDEN'});
  const serviceQueue=await store.listInvestigationQueue(service,{limit:50});
  assert.ok(serviceQueue.items.some(row=>row.id===foreign.case_id));
  assert.ok(serviceQueue.items.some(row=>row.id===receipt.case_id));
  assert.ok(serviceQueue.items.every(row=>!('owner_id' in row) && !('title' in row)));
  const foreignDetail=await store.readInvestigationCard(service,{case_id:foreign.case_id});
  assert.equal(foreignDetail.hints.has_projection,true);
  assert.equal('report' in foreignDetail,false);
  const sharedJob=await store.claimInvestigation(service,{request_id:randomUUID(),case_id:foreign.case_id});
  assert.equal(sharedJob.state,'running');
  const sharedFinish={...finish,request_id:randomUUID(),investigation_id:sharedJob.investigation_id};
  await assert.rejects(store.finishInvestigation(other,'complete',sharedFinish),{code:'NOT_FOUND'});
  assert.equal((await store.finishInvestigation(service,'complete',sharedFinish)).state,'completed');
  assert.equal((await store.getWithInvestigation(other,{case_id:foreign.case_id})).investigation.state,'processed');
  await assert.rejects(store.getWithInvestigation(principal,{case_id:foreign.case_id}),{code:'NOT_FOUND'});
  const orphan=await store.report(other,{...input,request_id:randomUUID()},noEvidence);
  const interrupted=await store.claimInvestigation(service,{request_id:randomUUID(),case_id:orphan.case_id,batch_id:randomUUID()});
  const recovery={request_id:randomUUID()};
  await assert.rejects(store.recoverInvestigationBatch(principal,recovery),{code:'FORBIDDEN'});
  assert.equal((await store.recoverInvestigationBatch(service,recovery)).recovered,1);
  assert.equal((await store.recoverInvestigationBatch(service,recovery)).replayed,true);
  assert.equal((await store.recoverInvestigationBatch(service,{request_id:randomUUID()})).recovered,0);
  assert.equal((await store.getWithInvestigation(other,{case_id:orphan.case_id})).investigation.state,'failed');
  await assert.rejects(store.finishInvestigation(service,'complete',{...finish,request_id:randomUUID(),investigation_id:interrupted.investigation_id}),
   {code:'REVISION_CONFLICT'});
  const reattempt=await store.claimInvestigation(service,{request_id:randomUUID(),case_id:orphan.case_id,batch_id:randomUUID()});
  assert.notEqual(reattempt.investigation_id,interrupted.investigation_id);
  assert.equal((await store.getWithInvestigation(other,{case_id:foreign.case_id})).investigation.state,'processed');


  const competing = await store.claimInvestigation(principal,{request_id:randomUUID(),case_id:changed.case_id});
  await store.review({...other,reviewer:true},{request_id:randomUUID(),case_id:changed.case_id,expected_revision:1,review_state:'archived',explanation:'Manual decision'});
  await assert.rejects(store.finishInvestigation(principal,'complete',{...finish,request_id:randomUUID(),investigation_id:competing.investigation_id}),{code:'REVISION_CONFLICT'});
  const automatic = () => store.claimInvestigation(principal,{request_id:randomUUID(),component:'hermes'});
  const claims = await Promise.all([automatic(),automatic()]);
  assert.deepEqual(claims.map(job=>job.state).sort(),['no_work','running']);
  const failedWork = claims.find(job=>job.state==='running');
  assert.equal(failedWork.case_id,second.case_id);
  assert.equal((await automatic()).state,'no_work');
  const fresh = await store.report(principal,{...input,request_id:randomUUID()},noEvidence);
  await store.finishInvestigation(principal,'fail',{request_id:randomUUID(),investigation_id:failedWork.investigation_id});
  assert.equal((await automatic()).case_id,fresh.case_id);
  const retry = await automatic();
  assert.equal(retry.case_id,second.case_id);
  assert.notEqual(retry.investigation_id,failedWork.investigation_id);
 } finally {await Promise.all([owner.end(),app.end()]);}
});
