// ABOUTME: Проверяет очистку orphan ветки без рабочей области и индекса.
// ABOUTME: Использует только временные Git repositories и подставную БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {command} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';
import {createActivityGit} from '../src/git-steps.mjs';
import {branchResourcesAbsent} from '../src/branch-cleanup.mjs';
import {canonical,importCleanup} from '../src/operator.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-branch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=root+'/repo',remote=root+'/origin.git';await command('git',['init','-b','dev',repo]);const run=(...args)=>command('git',['-C',repo,...args]);
 await run('config','user.name','Fixture');await run('config','user.email','fixture@example.invalid');await writeFile(repo+'/file','fixture');await run('add','.');await run('commit','-m','base');await run('branch','codex/old');
 await command('git',['init','--bare',remote]);await run('remote','add','origin',remote);await run('push','origin','codex/old');
 const project={id:'p',repo_path:repo,common_dir:repo+'/.git',github:{repository:'fixture/repo'}},flow=createFlowGit({localRemote:true,requireLock:()=>{}}),{git}=createActivityGit({flowGit:flow});return {root,repo,remote,project,run,git,subject:{ref:'refs/heads/codex/old'}};
}
test('orphan inventory scans ownership and worktrees and resumes CAS steps',async t=>{
 const f=await fixture(t),expected=await f.git.inspectBranchResources(f.project,f.subject);assert.ok(expected.branch.oid);assert.equal(expected.index.scope,'not_allocated_by_codeworks');
 const blob=await command('git',['-C',f.repo,'hash-object','-w','--stdin'],{input:JSON.stringify({branch:'codex/old'})});await f.run('update-ref','refs/codeworks/ownership/fixture',blob.stdout);
 await assert.rejects(f.git.inspectBranchResources(f.project,f.subject),{code:'OWNERSHIP_CONFLICT'});await f.run('update-ref','-d','refs/codeworks/ownership/fixture');
 const wt=f.root+'/other';await f.run('worktree','add',wt,'codex/old');await assert.rejects(f.git.inspectBranchResources(f.project,f.subject),{code:'OWNERSHIP_CONFLICT'});await f.run('worktree','remove',wt);
 assert.equal((await f.git.cleanupBranchStep(f.project,f.subject,expected,'remote')).outcome,'removed');assert.equal((await f.git.cleanupBranchStep(f.project,f.subject,expected,'remote')).outcome,'already_absent');
 assert.equal((await f.git.cleanupBranchStep(f.project,f.subject,expected,'local_refs')).outcome,'removed');assert.ok(branchResourcesAbsent(await f.git.inspectBranchResources(f.project,f.subject)));
});
test('operator admits only proven branch snapshots, no workspace and verified archive',async t=>{
 const f=await fixture(t),snapshot=await f.git.inspectBranchResources(f.project,f.subject),reflog=(await f.run('reflog','show','--format=%H',f.subject.ref)).stdout;
 const m={manifestVersion:1,reviewed:true,subject_type:'branch',workspace_id:null,project_id:'p',common_dir:f.project.common_dir,protected_task_ids:[],...snapshot,provenance:[{kind:'reflog',ref:f.subject.ref,sha256:hash(reflog)}],disposition:{type:'archived'}};m.manifest_sha256=hash(canonical(m));
 let writes=0,hasWorkspace=false;const db={query:async(sql)=>{if(sql.startsWith('SELECT config'))return {rows:[{config:f.project}],rowCount:1};if(sql.startsWith('SELECT pg_try_advisory'))return {rows:[{acquired:true}],rowCount:1};if(sql.startsWith('SELECT id FROM codeworks.workspaces'))return {rows:[],rowCount:hasWorkspace?1:0};if(sql.startsWith('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[],rowCount:0};if(sql.startsWith('INSERT INTO codeworks.cleanup_obligations'))writes++;return {rows:[],rowCount:0};},release(){}};
 const pool={connect:async()=>db},opts={git:f.git,allowedRepositories:[f.repo],preflight:true};assert.equal((await importCleanup(pool,'p',m,opts)).state,'waiting_decision');assert.equal(writes,0);
 hasWorkspace=true;await assert.rejects(importCleanup(pool,'p',m,opts),/ACTIVE_OR_PENDING_WORK/);hasWorkspace=false;
 const {manifest_sha256,...source}=m;source.disposition={type:'archived',archive:{path:'/x',sha256:'a'.repeat(64),heads:[]}};source.manifest_sha256=hash(canonical(source));
 await assert.rejects(importCleanup(pool,'p',source,{...opts,preflight:false,verifyArchive:async()=>{throw Error('ARCHIVE_UNVERIFIED');}}),/ARCHIVE_UNVERIFIED/);assert.equal(writes,0);
});


test('remote recreation and local new commits preserve orphan branch',async t=>{
 const f=await fixture(t),initial=await f.git.inspectBranchResources(f.project,f.subject);
 await assert.rejects(f.git.cleanupBranchStep(f.project,f.subject,initial,'local_refs'),{code:'TARGET_CHANGED'});
 await f.git.cleanupBranchStep(f.project,f.subject,initial,'remote');
 await writeFile(f.repo+'/new','change');await f.run('add','.');await f.run('commit','-m','advance');const next=(await f.run('rev-parse','HEAD')).stdout;await f.run('update-ref',f.subject.ref,next,initial.branch.oid);
 await assert.rejects(f.git.cleanupBranchStep(f.project,f.subject,initial,'local_refs'),{code:'TARGET_CHANGED'});
 assert.equal((await f.run('rev-parse',f.subject.ref)).stdout,next);
});
