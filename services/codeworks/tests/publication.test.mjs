// ABOUTME: Проверяет доказательство доставки результата последующим выпуском.
// ABOUTME: Не изменяет PostgreSQL и Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublication,recheckPublication} from '../src/publication.mjs';

function fixture({remote='source',receiptValid=true,pending=false,writer=false,delivered=true,dirty=false,head='source',deliveryStatus='succeeded',legTarget='dev',legMerged=true,legSha='installed',legEvidence='evidence'}={}){
  const project={id:'p'},workspace={id:'w',project_id:'p',kind:'feature'},composition={components:[]};
  const row={requested_sha:'source',closed_at:'2026-01-01',state:'failed',original_status:'failed',installed_operation_id:'rollout',commit_sha:'installed',target:'dev',project_id:'p',composition_digest:'digest',composition,receipt:{operation_id:'rollout',project_id:'p',target:'dev',commit_sha:'installed',composition_digest:'digest',composition,verified:receiptValid},rollout_status:'succeeded',evidence_id:'evidence',evidence_at:'2026-01-02',delivery_release_id:'release-b',delivery_release_state:'succeeded',delivery_operation_status:deliveryStatus,delivery_release_details:{primary:{target:legTarget,merged:legMerged,merge_sha:legSha,deployment_evidence_id:legEvidence}}};
  const db={query:async sql=>{
    if(sql.includes('SELECT r.operation_id,r.requested_sha'))return {rows:[{operation_id:'attempt-a',requested_sha:'source'}]};
    if(sql.includes('SELECT d.operation_id,d.release_operation_id'))return {rows:[{operation_id:'rollout',release_operation_id:'release-b',commit_sha:'installed',evidence_id:'evidence'}]};
    if(sql.includes('SELECT a.requested_sha'))return {rows:[row]};
    if(sql.includes('SELECT 1 FROM codeworks.write_calls'))return {rowCount:writer?1:0};
    if(sql.includes('SELECT 1 FROM codeworks.operations'))return {rowCount:pending?1:0};
    throw Error('unexpected query');
  }};
  const git={inspectResources:async()=>({worktree:{registered:true,pathExists:true,owned:true,dirty,head},branch:{oid:'source'},remote:{known:true,oid:remote},tracking:{oid:null}})};
  const flowGit={ancestor:async(_,sha)=>delivered&&sha==='source'};
  return ()=>verifyPublication(db,project,workspace,{git,flowGit});
}
test('later installed release proves delivery without changing failed attempt',async()=>{
  const proof=await fixture()();assert.equal(proof.original_attempt_id,'attempt-a');assert.equal(proof.delivery_release_operation_id,'release-b');assert.equal(proof.installed_commit,'installed');
});
test('new refs, unknown receipt or pending work do not authorize cleanup',async()=>{
  for(const options of [{remote:'new'},{head:'new'},{dirty:true},{receiptValid:false},{pending:true},{writer:true},{delivered:false},{deliveryStatus:'failed'},{legTarget:'main'},{legMerged:false},{legSha:'other'},{legEvidence:'other'}])assert.equal(await fixture(options)(),null);
});

test('lock path blocks deployment before the narrow evidence helper and fails closed on mismatch',async()=>{
  const proof=await fixture()(),calls=[];
  const db={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT operation_id FROM codeworks.deployments'))return {rowCount:1,rows:[{operation_id:'rollout'}]};
    if(sql.startsWith('SELECT codeworks.lock_publication_evidence'))return {rows:[{locked:false}]};
    throw Error('proof query must not run after a rejected lock');
  }};
  assert.equal(await recheckPublication(db,{id:'p'},{id:'w',project_id:'p',kind:'feature'},proof,{lock:true}),false);
  assert.match(calls[0].sql,/deployments.*FOR SHARE/);
  assert.deepEqual(calls[1].args,['p','rollout','evidence']);
});

test('the locked proof query uses the helper for trusted tables and locks remaining rows',async()=>{
  const proof=await fixture()(),calls=[];
  const db={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT operation_id FROM codeworks.deployments'))return {rowCount:1,rows:[{operation_id:'rollout'}]};
    if(sql.startsWith('SELECT codeworks.lock_publication_evidence'))return {rows:[{locked:true}]};
    if(sql.includes('SELECT a.requested_sha'))return {rows:[]};
    throw Error('unexpected query');
  }};
  assert.equal(await recheckPublication(db,{id:'p'},{id:'w',project_id:'p',kind:'feature'},proof,{lock:true}),false);
  assert.match(calls[2].sql,/FOR SHARE OF a,ao,d,ro,b,bo/);
  assert.doesNotMatch(calls[2].sql,/FOR SHARE OF[^\n]*(?:,i|,de)/);
});
