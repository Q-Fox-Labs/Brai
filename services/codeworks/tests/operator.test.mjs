// ABOUTME: Проверяет безопасный приём манифеста очистки и защиту живых задач.
// ABOUTME: Использует только подставные адаптеры и временный каталог, без внешних удалений.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonical,validateManifest,parseArgs,importCleanup} from '../src/operator.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
const sign=m=>({...m,manifest_sha256:digest(canonical(m))});
async function fixture(t,{active=false,duplicate=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'cleanup-operator-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sha='a'.repeat(40),w={id:'00000000-0000-4000-8000-000000000001',project_id:'p',branch:'feature/example',path:root+'/work',base_sha:sha,kind:'feature',ownership_token:'token'};
 const record={id:w.id,project_id:w.project_id,branch:w.branch,path:w.path,base_sha:w.base_sha};
 const snapshot={branch:{ref:'refs/heads/'+w.branch,oid:sha},ownership:{ref:'refs/codeworks/ownership/'+w.id,oid:null,matches:false},remote:{ref:'refs/heads/'+w.branch,oid:null,known:true},tracking:{ref:'refs/remotes/origin/'+w.branch,oid:null},worktree:{path:w.path,registered:false,pathExists:false,head:null,dirty:null,owned:false,lock:null}};
 const m=sign({manifestVersion:1,reviewed:true,project_id:'p',common_dir:root+'/git',workspace_id:w.id,protected_task_ids:[],branch:snapshot.branch,ownership:snapshot.ownership,remote:snapshot.remote,tracking:snapshot.tracking,worktree:snapshot.worktree,index:{identity:'fixture',collections:[],metadataPoints:[],ownerRecordHash:null},provenance:[{kind:'workspace-record',ref:w.id,sha256:digest(canonical(record))}],disposition:{type:'unused'}});
 const project={id:'p',common_dir:root+'/git',repo_path:root,workspace_root:root,legacy_workspace_roots:[root]};let inserts=0;
 const db={query:async(sql)=>{
  if(sql.startsWith('SELECT config'))return {rows:[{config:project}],rowCount:1};
  if(sql.startsWith('SELECT * FROM codeworks.workspaces'))return {rows:[w],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM codeworks.workflow_registry'))return {rows:[],rowCount:active?1:0};
  if(sql.startsWith('SELECT id,evidence'))return {rows:duplicate?[{id:'existing',evidence:{manifest:m}}]:[],rowCount:duplicate?1:0};
  if(sql.startsWith('INSERT INTO codeworks.cleanup_obligations'))inserts++;
  return {rows:[],rowCount:0};
 },release(){}};
 return {m,allowedRepositories:[root],pool:{connect:async()=>db},git:{inspectResources:async()=>snapshot},codeIndex:{inspect:async()=>({complete:true})},inserts:()=>inserts};
}
test('digest, provenance and command arguments are strict',()=>{
 assert.throws(()=>validateManifest({manifestVersion:1},'p'),/INVALID_MANIFEST/);
 assert.throws(()=>parseArgs(['cleanup-import','--project','p','--manifest','relative']),/INVALID_ARGUMENT/);
 assert.throws(()=>parseArgs(['cleanup-import','--project','p','--project','q','--manifest','/tmp/x']),/INVALID_ARGUMENT/);
});
test('invalid digest and provenance never admit a cleanup',async t=>{
 const f=await fixture(t);assert.throws(()=>validateManifest({...f.m,manifest_sha256:'0'.repeat(64)},'p'),/MANIFEST_DIGEST_MISMATCH/);
 const {manifest_sha256,...copy}=f.m;copy.provenance=[{kind:'workspace-record',ref:f.m.workspace_id,sha256:'0'.repeat(64)}];
 await assert.rejects(importCleanup(f.pool,'p',sign(copy),f),/PROVENANCE_UNVERIFIED/);assert.equal(f.inserts(),0);
});
test('active work is protected and duplicate import is idempotent',async t=>{
 const a=await fixture(t,{active:true});await assert.rejects(importCleanup(a.pool,'p',a.m,a),/ACTIVE_OR_PENDING_WORK/);assert.equal(a.inserts(),0);
 const b=await fixture(t,{duplicate:true});const result=await importCleanup(b.pool,'p',b.m,b);assert.equal(result.duplicate,true);assert.equal(b.inserts(),0);
});
test('dry run validates without admission',async t=>{
 const f=await fixture(t);const result=await importCleanup(f.pool,'p',f.m,{...f,dryRun:true});assert.equal(result.state,'pending');assert.equal(f.inserts(),0);
});
