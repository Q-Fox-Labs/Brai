// ABOUTME: Проверяет защиту старых Git-ссылок без рабочей области.
// ABOUTME: Использует только подставные порты и не изменяет настоящие refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceBranchCleanup} from '../src/branch-coordinator.mjs';

const ref='refs/heads/feature/old';
const archive={path:'/backup/old.bundle',sha256:'a'.repeat(64),heads:[{ref,oid:'b'.repeat(40)}],authorization_ref:'approved'};
const snapshot={branch:{ref,oid:'b'.repeat(40)},remote:{ref,oid:'b'.repeat(40),known:true},tracking:{ref:'refs/remotes/origin/feature/old',oid:null},ownership:{ref:null,oid:null},worktree:{path:null,registered:false},index:{scope:'not_allocated_by_codeworks'}};
function fixture({active=false,proof=true,empty=false}={}){
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:null,subject_key:'branch:'+ref,state:'pending',outcome:'cancelled',step:'remote',expected:snapshot,evidence:{manifest:{reviewed:true,subject_type:'branch',branch:{ref},disposition:{type:'archived',archive}},archive,archive_authorized:proof}};
  let deleted=0,verified=0;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks.workspaces'))return {rowCount:active?1:0};
    if(sql.includes('UPDATE codeworks.cleanup_obligations'))return {rowCount:1,rows:[{state:proof?'pending':'waiting_decision'}]};
    throw Error('unexpected query '+sql);
  }};
  const git={inspectBranchResources:async()=>empty?{...snapshot,branch:{ref,oid:null},remote:{ref,oid:null,known:true}}:snapshot,cleanupBranchStep:async()=>{deleted++;}};
  const run=()=>advanceBranchCleanup(db,item,{id:'project'},{git,verifyArchive:async()=>{verified++;}});
  return {run,counts:()=>({deleted,verified})};
}
test('active task blocks the branch before any external operation',async()=>{
  const f=fixture({active:true});await assert.rejects(f.run(),/BRANCH_LIVE_TASK/);assert.deepEqual(f.counts(),{deleted:0,verified:0});
});
test('archive proof is required and rechecked before a Git deletion',async()=>{
  const denied=fixture({proof:false});assert.equal((await denied.run()).state,'waiting_decision');assert.deepEqual(denied.counts(),{deleted:0,verified:0});
  const allowed=fixture();assert.equal((await allowed.run()).state,'pending');assert.deepEqual(allowed.counts(),{deleted:1,verified:1});
});
