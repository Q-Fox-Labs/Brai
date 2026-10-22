// ABOUTME: Принимает durable API на настоящей PostgreSQL, Git, flock и штатном подготовщике.
// ABOUTME: Проверяет реальные SIGKILL, чужие ресурсы, writer CAS и восстановление данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {configured,setup} from './fixture.mjs';
import {command,createGit} from '../../src/git.mjs';
import {migrate} from '../../src/migrate.mjs';
import {recordDeployment} from '../../src/deployment-evidence.mjs';
import {startRuntime} from '../../src/runtime.mjs';
const prepare=(p,key='area',extra={})=>({project_id:p.id,idempotency_key:key,workspace_key:key,kind:'feature',session_id:'first',...extra});
test('real PostgreSQL/Git acceptance',{skip:!configured,timeout:120000},async t=>{
  const f=await setup();
  t.after(()=>f.close());
  const op=async(p,id)=>(await f.h.call('operation-status',{project_id:p.id,operation_id:id},'codex')).operation;
  const area=async id=>(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[id])).rows[0];
  await t.test('runtime role has DML but no schema ownership/DDL or migration journal',async()=>{
    await assert.rejects(f.app.query('CREATE TABLE codeworks.forbidden(id integer)'),{code:'42501'});
    await assert.rejects(f.app.query('SELECT * FROM public.codeworks_migrations'),{code:'42501'});
    await assert.rejects(f.app.query('DELETE FROM codeworks.projects'),{code:'42501'});
  });
  await t.test('migration journal detects changed SQL checksum rather than silently accepting it',async()=>{
    const original=(await f.owner.query('SELECT sha256 FROM public.codeworks_migrations WHERE version=1')).rows[0].sha256;
    await f.owner.query('UPDATE public.codeworks_migrations SET sha256=$1 WHERE version=1',['0'.repeat(64)]);
    try{await assert.rejects(migrate(f.owner,f.config.app_role),{message:'MIGRATION_CHECKSUM_MISMATCH'});}
    finally{await f.owner.query('UPDATE public.codeworks_migrations SET sha256=$1 WHERE version=1',[original]);}
  });
  await t.test('parallel exact and different keys coalesce to one area/branch; intent precedes Git',async()=>{
    const p=await f.project(),a=prepare(p);
    const replies=await Promise.all(Array.from({length:12},()=>f.h.call('prepare-write',a,'codex')));
    assert.equal(new Set(replies.map(r=>r.workspace_id)).size,1);assert.equal(new Set(replies.map(r=>r.operation_id)).size,1);
    const accepted=replies[0],w=await area(accepted.workspace_id);
    assert.equal((await op(p,accepted.operation_id)).step,'intent');
    assert.equal((await command('git',['-C',p.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,128);
    const other=await f.h.call('prepare-write',{...a,idempotency_key:'another'},'codex');assert.deepEqual(other,accepted);
    await f.worker(p,accepted.operation_id);
    assert.equal((await op(p,accepted.operation_id)).status,'succeeded');
    const status=await f.h.call('status',{project_id:p.id,workspace_id:w.id},'codex');
    assert.equal(status.workspace.preparation_state,'ready');assert.equal(status.git.head,w.base_sha);assert.equal(status.git.dirty,false);
    assert.equal('ownership_token' in status.workspace,false);
    assert.equal(await realpath(path.join(w.path,'node_modules/@fixture/leaf')),path.join(w.path,'packages/leaf'));
    await assert.rejects(f.h.call('prepare-write',{...a,kind:'hotfix'},'codex'),{code:'CONFLICT'});
    await assert.rejects(f.h.call('prepare-write',{...a,idempotency_key:'writer',session_id:'other'},'hermes'),{code:'WRITER_BUSY'});
    await assert.rejects(f.h.call('status',{project_id:p.id,workspace_id:w.id},'stranger'),{code:'FORBIDDEN'});
    await assert.rejects(f.h.call('status',{project_id:p.id,workspace_id:randomUUID()},'codex'),{code:'NOT_FOUND'});
  });
  for(const step of ['before-branch','after-branch','after-checkout','after-dependencies','before-ready'])await t.test('SIGKILL at '+step+' resumes original base/owned area',async()=>{
    const p=await f.project(),accepted=await f.h.call('prepare-write',prepare(p),'codex');
    const initial=await area(accepted.workspace_id);
    const interrupted=await f.worker(p,accepted.operation_id,step);assert.equal(interrupted.signal,'SIGKILL');
    assert.equal((await op(p,accepted.operation_id)).status,'running');
    // Обычный runtime самостоятельно обнаруживает running после рестарта, без новой команды prepare.
    const runtime=await startRuntime({databaseURL:f.config.app_url,allowedRepositories:[p.repo_path]});
    try {
      const until=Date.now()+10000;
      while((await op(p,accepted.operation_id)).status==='running'&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
      assert.equal((await op(p,accepted.operation_id)).status,'succeeded');
    } finally {await runtime.close();}
    const w=await area(initial.id);assert.equal(w.base_sha,initial.base_sha);assert.equal(w.branch,initial.branch);assert.equal(w.path,initial.path);
  });
  await t.test('base SHA stays frozen when remote dev advances; hotfix uses remote main',async()=>{
    const p=await f.project(),a=await f.h.call('prepare-write',prepare(p),'codex');
    await f.worker(p,a.operation_id,'after-branch');
    const w=await area(a.workspace_id);
    await writeFile(path.join(p.repo_path,'hello.txt'),'new remote base\n');
    await command('git',['-C',p.repo_path,'add','hello.txt']);await command('git',['-C',p.repo_path,'commit','-m','Advance dev']);
    const newer=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    await command('git',['-C',p.repo_path,'update-ref','refs/remotes/origin/dev',newer]);
    await f.worker(p,a.operation_id);assert.equal((await op(p,a.operation_id)).status,'succeeded');
    assert.equal((await createGit().inspect(p,await area(w.id))).head,w.base_sha);assert.notEqual(newer,w.base_sha);
    await assert.rejects(f.h.call('prepare-write',prepare(p,'missing-prod',{kind:'hotfix'}),'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
    await recordDeployment(f.app,{project_id:p.id,target:'prod',commit_sha:w.base_sha,evidence_url:'https://fixture.invalid/installed'},{allowedRepositories:[p.repo_path]});
    const hotfix=await f.h.call('prepare-write',prepare(p,'hotfix',{kind:'hotfix'}),'codex');
    await f.worker(p,hotfix.operation_id);const hw=await area(hotfix.workspace_id);
    assert.equal(hw.base_ref,'refs/remotes/origin/main');assert.equal(hw.base_sha,w.base_sha);assert.match(hw.branch,/^hotfix\//);
  });
  await t.test('independent workers contend on one project flock without duplicating Git',async()=>{
    const p=await f.project(),a=await f.h.call('prepare-write',prepare(p),'codex');
    const results=await Promise.all([f.worker(p,a.operation_id),f.worker(p,a.operation_id)]);
    assert.equal(results.filter(x=>x.code===0).length,1);assert.equal(results.filter(x=>x.code===75).length,1);
    assert.equal((await op(p,a.operation_id)).status,'succeeded');
    const w=await area(a.workspace_id),list=(await command('git',['-C',p.repo_path,'worktree','list','--porcelain'])).stdout;
    assert.equal(list.split('branch refs/heads/'+w.branch).length-1,1);
  });
  await t.test('existing foreign directory and branch are preserved and never adopted',async()=>{
    for(const resource of ['directory','branch']) {
      const p=await f.project(),a=await f.h.call('prepare-write',prepare(p),'codex'),w=await area(a.workspace_id);
      if(resource==='directory'){await mkdir(w.path);await writeFile(path.join(w.path,'foreign'),'keep');}
      else await command('git',['-C',p.repo_path,'branch',w.branch,w.base_sha]);
      await f.worker(p,a.operation_id);
      const failed=await op(p,a.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'OWNERSHIP_CONFLICT');assert.equal(failed.step,'intent');
      if(resource==='directory')assert.equal(await readFile(path.join(w.path,'foreign'),'utf8'),'keep');
      else assert.equal((await command('git',['-C',p.repo_path,'rev-parse',w.branch])).stdout,w.base_sha);
    }
  });
  await t.test('foreign worktree at reserved path is rejected even with matching base/branch name',async()=>{
    const p=await f.project(),a=await f.h.call('prepare-write',prepare(p),'codex'),w=await area(a.workspace_id);
    await command('git',['-C',p.repo_path,'worktree','add','-b','foreign',w.path,w.base_sha]);
    await f.worker(p,a.operation_id);
    assert.equal((await op(p,a.operation_id)).error.code,'OWNERSHIP_CONFLICT');
    assert.equal((await command('git',['-C',w.path,'symbolic-ref','--short','HEAD'])).stdout,'foreign');
  });
  await t.test('new workspace metadata uses prepared packages without changing the source checkout',async()=>{
    const p=await f.project(),base=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    const manifest={name:'@fixture/new',version:'1.0.0'};
    await mkdir(path.join(p.repo_path,'packages/new'));
    await writeFile(path.join(p.repo_path,'packages/new/package.json'),JSON.stringify(manifest)+'\n');
    const file=path.join(p.repo_path,'package-lock.json'),lock=JSON.parse(await readFile(file,'utf8'));
    lock.packages['packages/new']=manifest;lock.packages['node_modules/@fixture/new']={resolved:'packages/new',link:true};
    await writeFile(file,JSON.stringify(lock)+'\n');
    await command('git',['-C',p.repo_path,'add','.']);await command('git',['-C',p.repo_path,'commit','-m','Add local workspace']);
    const newer=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    await command('git',['-C',p.repo_path,'update-ref','refs/remotes/origin/dev',newer]);
    await command('git',['-C',p.repo_path,'reset','--hard',base]);
    const a=await f.h.call('prepare-write',prepare(p),'codex');await f.worker(p,a.operation_id);
    assert.equal((await op(p,a.operation_id)).status,'succeeded');const w=await area(a.workspace_id);
    assert.equal(await realpath(path.join(w.path,'node_modules/@fixture/new')),path.join(w.path,'packages/new'));
    assert.equal((await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout,base);
    assert.equal((await command(p.preparer_path,['--check',w.path])).code,0);
  });
  await t.test('dependency mismatch leaves intent and owned checkout; retry needs a new key',async()=>{
    const p=await f.project(),a=await f.h.call('prepare-write',prepare(p),'codex');
    await f.worker(p,a.operation_id,'after-checkout');
    const w=await area(a.workspace_id),lock=await readFile(path.join(p.repo_path,'package-lock.json'));
    await writeFile(path.join(p.repo_path,'package-lock.json'),'{}\n');
    await f.worker(p,a.operation_id);
    const failed=await op(p,a.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'DEPENDENCIES_INCOMPATIBLE');assert.equal(failed.step,'checkout');
    assert.equal((await f.h.call('prepare-write',prepare(p),'codex')).operation_id,a.operation_id);
    await writeFile(path.join(p.repo_path,'package-lock.json'),lock);
    const retry=await f.h.call('prepare-write',prepare(p,'area',{idempotency_key:'retry'}),'codex');
    assert.equal(retry.workspace_id,w.id);assert.notEqual(retry.operation_id,a.operation_id);
    await f.worker(p,retry.operation_id);assert.equal((await op(p,retry.operation_id)).status,'succeeded');
  });
  await t.test('same Element new attempt continues area only after explicit old writer quiesce and CAS',async()=>{
    const p=await f.project(),element_id=randomUUID(),firstAttempt=randomUUID();
    const a=await f.h.call('prepare-write',prepare(p,'area',{element_id,attempt_id:firstAttempt}),'codex');await f.worker(p,a.operation_id);
    const base={project_id:p.id,workspace_id:a.workspace_id,expected_epoch:1};
    await assert.rejects(f.h.call('attach-or-transfer',{...base,idempotency_key:'steal',session_id:'next',mode:'attach'},'hermes'),{code:'WRITER_BUSY'});
    await assert.rejects(f.h.call('attach-or-transfer',{...base,idempotency_key:'missing-proof',session_id:'first',mode:'quiesce'},'codex'),{code:'INVALID_ARGUMENT'});
    await f.h.call('attach-or-transfer',{...base,idempotency_key:'stop',session_id:'first',mode:'quiesce',writes_stopped:true},'codex');
    const attempt_id=randomUUID();
    await f.h.call('attach-or-transfer',{...base,idempotency_key:'next',session_id:'next',mode:'attach',attempt_id},'hermes');
    await assert.rejects(f.h.call('attach-or-transfer',{...base,idempotency_key:'stale',session_id:'first',mode:'attach'},'codex'),{code:'WRITER_BUSY'});
    const status=await f.h.call('status',{project_id:p.id,workspace_id:a.workspace_id},'hermes');
    assert.equal(status.workspace.element_id,element_id);assert.deepEqual(status.workspace.writer,{executor_id:'hermes',session_id:'next',epoch:2,state:'active'});
    assert.deepEqual(new Set(status.attachments.map(x=>x.attempt_id)),new Set([firstAttempt,attempt_id]));
    const release=await f.h.call('request-release',{project_id:p.id,workspace_id:a.workspace_id,idempotency_key:'release',session_id:'next',expected_epoch:2,target:'dev',commit_sha:status.git.head},'hermes');
    const record=(await f.h.call('operation-status',{project_id:p.id,operation_id:release.operation_id},'hermes')).operation;
    assert.equal(record.status,'awaiting_execution');assert.equal(record.result.reason,'RELEASE_EXECUTION_NOT_AVAILABLE');
  });
});
