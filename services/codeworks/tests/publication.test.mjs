// ABOUTME: Проверяет доказательство доставки результата последующим выпуском.
// ABOUTME: Не изменяет PostgreSQL и Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublication} from '../src/publication.mjs';

function fixture({remote='source',receiptValid=true,pending=false,writer=false,delivered=true,dirty=false,head='source'}={}){
  const project={id:'p'},workspace={id:'w',project_id:'p',kind:'feature'},composition={components:[]};
  const row={requested_sha:'source',closed_at:'2026-01-01',state:'failed',original_status:'failed',installed_operation_id:'rollout',commit_sha:'installed',target:'dev',project_id:'p',composition_digest:'digest',composition,receipt:{operation_id:'rollout',project_id:'p',target:'dev',commit_sha:'installed',composition_digest:'digest',composition,verified:receiptValid},rollout_status:'succeeded',evidence_id:'evidence',evidence_at:'2026-01-02',delivery_release_id:'release-b',delivery_release_state:'succeeded'};
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
  for(const options of [{remote:'new'},{head:'new'},{dirty:true},{receiptValid:false},{pending:true},{writer:true},{delivered:false}])assert.equal(await fixture(options)(),null);
});
