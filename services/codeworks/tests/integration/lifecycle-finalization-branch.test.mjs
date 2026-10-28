// ABOUTME: Проверяет архивирование и удаление отдельной orphan ветки в disposable Git и PostgreSQL.
// ABOUTME: Не создаёт фиктивную область или индекс; активная задача защищена DB и Git проверками.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {setup,configured,prepareWith} from './fixture.mjs';
import {command,createGit} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {importCleanup,canonical} from '../../src/operator.mjs';
import {reconcileProjectLedger} from '../../src/reconciler.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';

test('branch-only archive import rejects active task and removes exact refs to zero',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'checks',app_id:42}]}});
  const git=(...args)=>command('git',['-C',p.repo_path,...args]),branch='feature/archived-fixture',ref='refs/heads/'+branch;
  await git('checkout','-b',branch);await writeFile(p.repo_path+'/orphan.txt','orphan result\n');await git('add','orphan.txt');await git('commit','-m','orphan result');
  const head=(await git('rev-parse','HEAD')).stdout;await git('push','origin',branch);await git('checkout','dev');
  const archiveRoot=p.workspace_root+'/archive';await mkdir(archiveRoot,{mode:0o700});const file=archiveRoot+'/branch.bundle';
  await git('bundle','create',file,ref);await chmod(file,0o600);const hash=value=>createHash('sha256').update(value).digest('hex');
  const bundle={path:file,sha256:hash(await readFile(file)),heads:[{ref,oid:head}]};
  p.cleanup_archive_roots=[archiveRoot];p.cleanup_archive_uid=process.getuid();await f.owner.query('UPDATE codeworks.projects SET config=$2 WHERE id=$1',[p.id,p]);
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),adapters=createActivityGit({flowGit}),snapshot=await adapters.git.inspectBranchResources(p,{ref});
  const reflog=(await git('reflog','show','--format=%H',ref)).stdout;
  const manifest={manifestVersion:1,reviewed:true,project_id:p.id,common_dir:p.common_dir,workspace_id:null,subject_type:'branch',...snapshot,protected_task_ids:[],provenance:[{kind:'reflog',ref,sha256:hash(reflog)}],disposition:{type:'archived'}};
  const preflight=structuredClone(manifest);preflight.manifest_sha256=hash(canonical(preflight));
  const receiptPath=archiveRoot+'/receipt.json',authorization_ref='01a18284-c791-7902-9879-60203820368b';
  const receipt=JSON.stringify({authorization_ref,source_manifest_sha256:hash(canonical(manifest)),bundle});await writeFile(receiptPath,receipt,{mode:0o600});
  manifest.disposition.archive={...bundle,authorization_ref,receipt:{path:receiptPath,sha256:hash(receipt)}};manifest.manifest_sha256=hash(canonical(manifest));
  const active=randomUUID();await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token) VALUES($1,$2,'active','feature','refs/heads/dev',$3,$4,$5,$6)",[active,p.id,head,branch,p.workspace_root+'/'+active,randomUUID()]);
  const accept=()=>importCleanup(f.app,p.id,manifest,{...adapters,allowedRepositories:[p.repo_path]});
  await assert.rejects(accept(),/ACTIVE_OR_PENDING_WORK/);await f.owner.query('DELETE FROM codeworks.workspaces WHERE id=$1',[active]);
  const dry=await importCleanup(f.app,p.id,preflight,{...adapters,preflight:true,allowedRepositories:[p.repo_path]});assert.equal(dry.dry_run,true);
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.cleanup_obligations WHERE project_id=$1',[p.id])).rows[0].n,0);
  const admitted=await accept();assert.equal(admitted.subject,'branch:'+ref);assert.equal(admitted.state,'pending');
  const handlers=createHandlers(createStore(f.app),createGit({flowGit}),{allowedRepositories:[p.repo_path]});
  await assert.rejects(prepareWith(handlers.call,{project_id:p.id,workspace_key:'archived-fixture',request_key:'reserved-branch'}),{code:'CLEANUP_ALREADY_STARTED'});
  const owner='fixture-reconciler';await reconcileProjectLedger(f.app,p.id,owner);
  const run=()=>runCleanupObligation(f.app,admitted.id,owner,{...adapters,allowedRepositories:[p.repo_path]});
  const terminal=randomUUID();await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,removed_at) VALUES($1,$2,'terminal','feature','refs/heads/dev',$3,$4,$5,$6,now())",[terminal,p.id,head,branch,p.workspace_root+'/'+terminal,randomUUID()]);
  const blocked=await run();assert.equal(blocked.blocker,'BRANCH_LIVE_TASK');assert.equal((await adapters.git.inspectBranchResources(p,{ref})).branch.oid,head);
  await f.owner.query('DELETE FROM codeworks.workspaces WHERE id=$1',[terminal]);await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending' WHERE id=$1",[admitted.id]);
  let result;for(let i=0;i<5;i++){result=await run();assert.notEqual(result?.state,'waiting_decision',JSON.stringify(result));if(result?.state==='done')break;}
  assert.equal(result.state,'done');assert.equal(result.result.scope,'git_refs');assert.equal(result.result.index.scope,'not_allocated_by_codeworks');
  const final=await adapters.git.inspectBranchResources(p,{ref});assert.equal(final.branch.oid,null);assert.equal(final.remote.oid,null);assert.equal(final.tracking.oid,null);
  assert.equal(hash(await readFile(file)),bundle.sha256);assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workspaces WHERE project_id=$1',[p.id])).rows[0].n,0);
});
