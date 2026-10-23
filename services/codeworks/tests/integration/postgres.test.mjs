// ABOUTME: Принимает durable API на настоящей PostgreSQL, Git, flock и штатном подготовщике.
// ABOUTME: Проверяет реальные SIGKILL, чужие ресурсы, идемпотентность и сохранность истории.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {configured,setup} from './fixture.mjs';
import {command as runCommand,createGit} from '../../src/git.mjs';
import {fixtureLifecycle,fixtureTimeout} from './fixture-lifecycle.mjs';
import {createStore} from '../../src/storage.mjs';
import {runOperation} from '../../src/worker.mjs';
import {migrate} from '../../src/migrate.mjs';
import {recordDeployment} from '../../src/deployment-evidence.mjs';
import {startRuntime} from '../../src/runtime.mjs';
const prepare=(p,key='area',extra={})=>({project_id:p.id,request_key:key,workspace_key:key,...extra});
test('real PostgreSQL/Git acceptance',{skip:!configured,timeout:fixtureTimeout(process.env.CODEWORKS_TEST_TIMEOUT_MS)},async t=>{
  const own=fixtureLifecycle(t.signal);let fixture;
  t.after(()=>own.close(async()=>{if(fixture)await fixture.close();}));
  return own.run(async()=>{
  const command=own.guard(runCommand);
  fixture=await setup({command});
  const f={...fixture,project:own.guard(fixture.project),worker:own.guard(fixture.worker),h:own.port(fixture.h),app:own.port(fixture.app)};
  const subtest=(name,body)=>{t.signal.throwIfAborted();return t.test(name,()=>own.run(body));};
  const op=async(p,id)=>(await f.h.call('status',{project_id:p.id,operation_id:id},'codex')).operation;
  const area=async id=>(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[id])).rows[0];
  await subtest('runtime role has DML but no schema ownership/DDL or migration journal',async()=>{
    await assert.rejects(f.app.query('CREATE TABLE codeworks.forbidden(id integer)'),{code:'42501'});
    await assert.rejects(f.app.query('SELECT * FROM public.codeworks_migrations'),{code:'42501'});
    await assert.rejects(f.app.query('DELETE FROM codeworks.projects'),{code:'42501'});
  });
  await subtest('migration journal detects changed SQL checksum rather than silently accepting it',async()=>{
    const original=(await f.owner.query('SELECT sha256 FROM public.codeworks_migrations WHERE version=1')).rows[0].sha256;
    await f.owner.query('UPDATE public.codeworks_migrations SET sha256=$1 WHERE version=1',['0'.repeat(64)]);
    try{await assert.rejects(migrate(f.owner,f.config.app_role),{message:'MIGRATION_CHECKSUM_MISMATCH'});}
    finally{await f.owner.query('UPDATE public.codeworks_migrations SET sha256=$1 WHERE version=1',[original]);}
  });
  await subtest('parallel exact and different keys coalesce to one area/branch; intent precedes Git',async()=>{
    const p=await f.project(),a=prepare(p);
    const replies=await Promise.all(Array.from({length:12},()=>f.h.call('prepare',a,'codex')));
    assert.equal(new Set(replies.map(r=>r.workspace_id)).size,1);assert.equal(new Set(replies.map(r=>r.operation_id)).size,1);
    const accepted=replies[0],w=await area(accepted.workspace_id);
    assert.equal((await op(p,accepted.operation_id)).step,'intent');
    assert.equal((await command('git',['-C',p.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,128);
    const other=await f.h.call('prepare',{...a,request_key:'another'},'codex');assert.deepEqual(other,accepted);
    await f.worker(p,accepted.operation_id);
    assert.equal((await op(p,accepted.operation_id)).status,'succeeded');
    const status=await f.h.call('status',{project_id:p.id,workspace_id:w.id},'codex');
    assert.equal(status.workspace.preparation_state,'ready');assert.equal(status.git.head,w.base_sha);assert.equal(status.git.dirty,false);
    assert.equal('ownership_token' in status.workspace,false);
    assert.equal(await realpath(path.join(w.path,'node_modules/@fixture/leaf')),path.join(w.path,'packages/leaf'));
    await assert.rejects(f.h.call('prepare',{...a,kind:'hotfix'},'codex'),{code:'CONFLICT'});
    const continued=await f.h.call('prepare',{...a,request_key:'other-executor'},'hermes');
    assert.deepEqual(continued,accepted);
    assert.equal('writer' in status.workspace,false);assert.equal('legacy_writer' in status.workspace,false);assert.equal('attachments' in status,false);
    assert.deepEqual((await f.h.call('status',{project_id:p.id,workspace_key:a.workspace_key},'hermes')).workspace,status.workspace);
    assert.equal((await f.h.call('status',{project_id:p.id},'codex')).workspaces.length,1);
    await assert.rejects(f.h.call('prepare',{...a,workspace_key:'another'},'codex'),{code:'CONFLICT'});
    await assert.rejects(f.h.call('status',{project_id:p.id,workspace_id:w.id},'stranger'),{code:'FORBIDDEN'});
    await assert.rejects(f.h.call('status',{project_id:p.id,workspace_id:randomUUID()},'codex'),{code:'NOT_FOUND'});
  });
  for(const step of ['before-branch','after-branch','after-checkout','after-dependencies','before-ready'])await subtest('SIGKILL at '+step+' resumes original base/owned area',async()=>{
    const p=await f.project(),accepted=await f.h.call('prepare',prepare(p),'codex');
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
  await subtest('base SHA stays frozen when remote dev advances; hotfix uses remote main',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex');
    await f.worker(p,a.operation_id,'after-branch');
    const w=await area(a.workspace_id);
    await writeFile(path.join(p.repo_path,'hello.txt'),'new remote base\n');
    await command('git',['-C',p.repo_path,'add','hello.txt']);await command('git',['-C',p.repo_path,'commit','-m','Advance dev']);
    const newer=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    await command('git',['-C',p.repo_path,'update-ref','refs/remotes/origin/dev',newer]);
    await f.worker(p,a.operation_id);assert.equal((await op(p,a.operation_id)).status,'succeeded');
    assert.equal((await createGit().inspect(p,await area(w.id))).head,w.base_sha);assert.notEqual(newer,w.base_sha);
    await assert.rejects(f.h.call('prepare',prepare(p,'missing-prod',{kind:'hotfix'}),'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
    await recordDeployment(f.app,{project_id:p.id,target:'prod',commit_sha:w.base_sha,evidence_url:'https://fixture.invalid/installed'},{allowedRepositories:[p.repo_path]});
    const hotfix=await f.h.call('prepare',prepare(p,'hotfix',{kind:'hotfix'}),'codex');
    await f.worker(p,hotfix.operation_id);const hw=await area(hotfix.workspace_id);
    assert.equal(hw.base_ref,'refs/remotes/origin/main');assert.equal(hw.base_sha,w.base_sha);assert.match(hw.branch,/^hotfix\//);
  });
  await subtest('independent workers contend on one project flock without duplicating Git',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex');
    const results=await Promise.all([f.worker(p,a.operation_id),f.worker(p,a.operation_id)]);
    assert.equal(results.filter(x=>x.code===0).length,1);assert.equal(results.filter(x=>x.code===75).length,1);
    assert.equal((await op(p,a.operation_id)).status,'succeeded');
    const w=await area(a.workspace_id),list=(await command('git',['-C',p.repo_path,'worktree','list','--porcelain'])).stdout;
    assert.equal(list.split('branch refs/heads/'+w.branch).length-1,1);
  });
  await subtest('existing foreign directory and branch are preserved and never adopted',async()=>{
    for(const resource of ['directory','branch']) {
      const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex'),w=await area(a.workspace_id);
      if(resource==='directory'){await mkdir(w.path);await writeFile(path.join(w.path,'foreign'),'keep');}
      else await command('git',['-C',p.repo_path,'branch',w.branch,w.base_sha]);
      await f.worker(p,a.operation_id);
      const failed=await op(p,a.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'OWNERSHIP_CONFLICT');assert.equal(failed.step,'intent');
      if(resource==='directory')assert.equal(await readFile(path.join(w.path,'foreign'),'utf8'),'keep');
      else assert.equal((await command('git',['-C',p.repo_path,'rev-parse',w.branch])).stdout,w.base_sha);
    }
  });
  await subtest('foreign worktree at reserved path is rejected even with matching base/branch name',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex'),w=await area(a.workspace_id);
    await command('git',['-C',p.repo_path,'worktree','add','-b','foreign',w.path,w.base_sha]);
    await f.worker(p,a.operation_id);
    assert.equal((await op(p,a.operation_id)).error.code,'OWNERSHIP_CONFLICT');
    assert.equal((await command('git',['-C',w.path,'symbolic-ref','--short','HEAD'])).stdout,'foreign');
  });
  await subtest('new workspace metadata uses prepared packages without changing the source checkout',async()=>{
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
    const a=await f.h.call('prepare',prepare(p),'codex');await f.worker(p,a.operation_id);
    assert.equal((await op(p,a.operation_id)).status,'succeeded');const w=await area(a.workspace_id);
    assert.equal(await realpath(path.join(w.path,'node_modules/@fixture/new')),path.join(w.path,'packages/new'));
    assert.equal((await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout,base);
    assert.equal((await command(p.preparer_path,['--check',w.path])).code,0);
  });
  await subtest('dependency mismatch leaves intent and owned checkout; retry needs a new key',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex');
    await f.worker(p,a.operation_id,'after-checkout');
    const w=await area(a.workspace_id),lock=await readFile(path.join(p.repo_path,'package-lock.json'));
    await writeFile(path.join(p.repo_path,'package-lock.json'),'{}\n');
    await f.worker(p,a.operation_id);
    const failed=await op(p,a.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'DEPENDENCIES_INCOMPATIBLE');assert.equal(failed.step,'checkout');
    assert.equal((await f.h.call('prepare',prepare(p),'codex')).operation_id,a.operation_id);
    await writeFile(path.join(p.repo_path,'package-lock.json'),lock);
    const retry=await f.h.call('prepare',prepare(p,'area',{request_key:'retry'}),'codex');
    assert.equal(retry.workspace_id,w.id);assert.notEqual(retry.operation_id,a.operation_id);
    await f.worker(p,retry.operation_id);assert.equal((await op(p,retry.operation_id)).status,'succeeded');
  });
  await subtest('ordinary Git commits are visible without writer or session state',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex');await f.worker(p,a.operation_id);
    const w=await area(a.workspace_id);
    await writeFile(path.join(w.path,'ordinary.txt'),'ordinary commit\n');
    await command('git',['-C',w.path,'add','ordinary.txt']);await command('git',['-C',w.path,'commit','-m','Ordinary Git commit']);
    const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout;
    const status=await f.h.call('status',{project_id:p.id,workspace_id:w.id},'hermes');
    assert.equal(status.git.head,head);assert.notEqual(head,w.base_sha);assert.equal(status.git.dirty,false);
    assert.equal('writer' in status.workspace,false);assert.equal('legacy_writer' in status.workspace,false);
    await assert.rejects(f.h.call('cleanup',{project_id:p.id,workspace_id:w.id,request_key:'premature'},'codex'),{code:'CONFLICT'});
    for(const field of ['session_id','expected_epoch','writes_stopped'])await assert.rejects(f.h.call('prepare',{...prepare(p,'obsolete'),[field]:field==='expected_epoch'?1:field==='writes_stopped'?true:'s'},'codex'),{code:'INVALID_ARGUMENT'});
  });
  await subtest('archived pending operations remain inspectable and are never recovered',async()=>{
    const p=await f.project(),a=await f.h.call('prepare',prepare(p),'codex');
    await f.owner.query('UPDATE codeworks.operations SET archived=true WHERE id=$1',[a.operation_id]);
    const before=await op(p,a.operation_id),w=await area(a.workspace_id);
    assert.equal(before.archived,true);
    assert.equal((await createStore(f.app).pending(100)).some(row=>row.id===a.operation_id),false);
    await runOperation(f.app,a.operation_id,{branch:()=>assert.fail('archived operation executed')},{allowedRepositories:[p.repo_path]});
    assert.deepEqual(await op(p,a.operation_id),before);
    assert.notEqual((await command('git',['-C',p.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
    await assert.rejects(f.h.call('prepare',prepare(p),'codex'),{code:'CONFLICT'});
    const next=await f.h.call('prepare',prepare(p,'area',{request_key:'after-archive'}),'hermes');
    assert.equal(next.workspace_id,w.id);assert.notEqual(next.operation_id,a.operation_id);
    await f.worker(p,next.operation_id);assert.equal((await op(p,next.operation_id)).status,'succeeded');
    assert.deepEqual(await op(p,a.operation_id),before);
  });
  await subtest('migration 007 preserves legacy rows and repeat migration does not archive new work',async()=>{
    const owner=new Pool({connectionString:f.config.restore_owner_url});
    const legacyProject='test_migration_'+randomUUID(),workspace=randomUUID(),operation=randomUUID(),release=randomUUID(),attachment=randomUUID(),rollout=randomUUID();
    const writer={executor_id:'codex',session_id:'old-session',epoch:7,state:'active'},request={session_id:'old-session',commit_sha:'a'.repeat(40)};
    try{
      // AIDEV-NOTE: Вторая явно разрешённая disposable БД воспроизводит upgrade с 006, не рабочую схему.
      await owner.query('DROP SCHEMA IF EXISTS codeworks CASCADE; DROP TABLE IF EXISTS public.codeworks_migrations');
      await owner.query('CREATE TABLE public.codeworks_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)');
      for(let version=1;version<=6;version++){
        const sql=await readFile(new URL('../../migrations/'+String(version).padStart(3,'0')+'.sql',import.meta.url),'utf8');
        await owner.query(sql);await owner.query('INSERT INTO public.codeworks_migrations VALUES($1,$2)',[version,createHash('sha256').update(sql).digest('hex')]);
      }
      await owner.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[legacyProject,{legacy:true}]);
      await owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,writer,preparation_state) VALUES($1,$2,'old','feature','refs/remotes/origin/dev',$3,'feature/legacy','/fixture/legacy',$4,$5,'ready')",[workspace,legacyProject,'a'.repeat(40),randomUUID(),writer]);
      await owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','request-release','running','legacy-step',$4)",[operation,legacyProject,workspace,request]);
      await owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'awaiting_ci',$5)",[release,workspace,operation,'a'.repeat(40),{primary:{branch:'feature/legacy'}}]);
      await owner.query("INSERT INTO codeworks.attachments(id,workspace_id,executor_id,session_id,writer_epoch) VALUES($1,$2,'codex','old-session',7)",[attachment,workspace]);
      await owner.query("INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,'codex','old-key',$2,$3)",[legacyProject,'b'.repeat(64),operation]);
      await owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codex','rollout','awaiting_deployment','legacy-rollout',$3)",[rollout,legacyProject,{target:'dev'}]);
      const composition={legacy:true},receipt={verified:true,phase:'complete'};
      await owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition,receipt) VALUES($1,$2,'dev',$3,'123','1',$4,$5,$6)",[rollout,legacyProject,'a'.repeat(40),'sha256:'+'c'.repeat(64),composition,receipt]);
      await owner.query("INSERT INTO codeworks.installed(project_id,target,operation_id,composition) VALUES($1,'dev',$2,$3)",[legacyProject,rollout,composition]);
      await migrate(owner,f.config.app_role);
      const preserved=(await owner.query('SELECT legacy_writer,preparation_state FROM codeworks.workspaces WHERE id=$1',[workspace])).rows[0];
      assert.deepEqual(preserved,{legacy_writer:writer,preparation_state:'ready'});
      const archived=(await owner.query('SELECT archived,status,step,request FROM codeworks.operations WHERE id=$1',[operation])).rows[0];
      assert.deepEqual(archived,{archived:true,status:'running',step:'legacy-step',request});
      assert.equal((await owner.query('SELECT session_id FROM codeworks.legacy_attachments WHERE id=$1',[attachment])).rows[0].session_id,'old-session');
      assert.equal((await owner.query('SELECT state FROM codeworks.releases WHERE id=$1',[release])).rows[0].state,'awaiting_ci');
      assert.equal((await owner.query('SELECT operation_id FROM codeworks.requests WHERE project_id=$1',[legacyProject])).rows[0].operation_id,operation);
      assert.deepEqual((await owner.query('SELECT archived,composition,receipt FROM codeworks.deployments WHERE operation_id=$1',[rollout])).rows[0],{archived:true,composition,receipt});
      assert.equal((await owner.query("SELECT operation_id FROM codeworks.installed WHERE project_id=$1 AND target='dev'",[legacyProject])).rows[0].operation_id,rollout);
      const fresh=randomUUID(),freshRollout=randomUUID();
      await owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'hermes','prepare','pending','intent','{}')",[fresh,legacyProject,workspace]);
      await owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','pending','verified-ci',$3)",[freshRollout,legacyProject,{target:'dev'}]);
      await owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition) VALUES($1,$2,'dev',$3,'123','1',$4,$5)",[freshRollout,legacyProject,'a'.repeat(40),'sha256:'+'c'.repeat(64),composition]);
      await migrate(owner,f.config.app_role);
      assert.equal((await owner.query('SELECT archived FROM codeworks.operations WHERE id=$1',[fresh])).rows[0].archived,false);
      assert.equal((await owner.query('SELECT archived FROM codeworks.deployments WHERE operation_id=$1',[freshRollout])).rows[0].archived,false);
      assert.deepEqual((await owner.query('SELECT archived,composition,receipt FROM codeworks.deployments WHERE operation_id=$1',[rollout])).rows[0],{archived:true,composition,receipt});
      assert.deepEqual((await owner.query('SELECT archived,status,step,request FROM codeworks.operations WHERE id=$1',[operation])).rows[0],archived);
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.codeworks_migrations')).rows[0].count,7);
    }finally{
      await owner.query('DROP SCHEMA IF EXISTS codeworks CASCADE; DROP TABLE IF EXISTS public.codeworks_migrations');
      await owner.end();
    }
  });
  });
});
