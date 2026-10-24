// ABOUTME: Проверяет durable release/API и новую миграцию на настоящей disposable PostgreSQL и Git.
// ABOUTME: GitHub — явный double; source/target commits реальны, installed evidence создаёт только test verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {configured,setup} from './fixture.mjs';
import {fixtureLifecycle,fixtureTimeout} from './fixture-lifecycle.mjs';
import {command as runCommand,createGit} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {runOperation} from '../../src/worker.mjs';
import {recordDeployment} from '../../src/deployment-evidence.mjs';
import {createStore} from '../../src/storage.mjs';
const required_checks=[{name:'Codeworks components',app_id:42}];
const ci={check_name:'Codeworks components',app_id:42,workflow_sha256:'a'.repeat(64),recipe_sha256:'b'.repeat(64)};
const good=sha=>[{name:'Codeworks components',app_id:42,sha,status:'completed',conclusion:'success',ci_verified:true,ci_evidence:{head_sha:sha,run_id:'123',attempt:1,workflow:'.github/workflows/codeworks.yml',recipe:ci.recipe_sha256,composition_digest:'sha256:'+'c'.repeat(64),composition_reference:'ghcr.io/fixture/repository-components/release@sha256:'+'c'.repeat(64),url:'https://github.com/fixture/repository/actions/runs/123'}}];
test('durable Git flow on PostgreSQL and real Git',{skip:!configured,timeout:fixtureTimeout(process.env.CODEWORKS_TEST_TIMEOUT_MS)},async t=>{
  const own=fixtureLifecycle(t.signal);let fixture;
  // Timeout отменяет node:test wrapper, а cleanup ждёт настоящие setup/body/worker promises.
  t.after(()=>own.close(async()=>{if(fixture)await fixture.close();}));
  return own.run(async()=>{
  const command=own.guard(runCommand);
  const flowGit=createFlowGit({run:command,localRemote:true,requireLock:()=>{}}),git=own.port(createGit({flowGit}));
  fixture=await setup({git,command});
  const f={...fixture,project:own.guard(fixture.project),worker:own.guard(fixture.worker),h:own.port(fixture.h),app:{query:own.guard(fixture.app.query.bind(fixture.app)),connect:fixture.app.connect.bind(fixture.app)}};
  const subtest=(name,body)=>{t.signal.throwIfAborted();return t.test(name,()=>own.run(body));};
  const op=async(p,id)=>(await f.h.call('status',{project_id:p.id,operation_id:id},'codex')).operation;
  const area=async id=>(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[id])).rows[0];
  // AIDEV-NOTE: Cleanup использует настоящий flock/worker, но разрешает только fixture-local origin через DI.
  const cleanupWorker=own.guard(async(p,id)=>{
    const script=`import {Pool} from 'pg';
      import {runOperation} from '${new URL('../../src/worker.mjs',import.meta.url).href}';
      import {createGit} from '${new URL('../../src/git.mjs',import.meta.url).href}';
      import {createFlowGit} from '${new URL('../../src/git-flow.mjs',import.meta.url).href}';
      const flowGit=createFlowGit({localRemote:true}),pool=new Pool({connectionString:process.env.CODEWORKS_DATABASE_URL});
      try {await runOperation(pool,process.argv[2],createGit({flowGit}),{flowGit,allowedRepositories:[process.argv[1]]});}
      finally {await pool.end();}`;
    await command('/bin/sh',['-c','exec 3>"$1" || exit 74; flock -x 3 || exit $?; export CODEWORKS_LOCK_HELD=1; exec "$2" --input-type=module -e "$3" "$4" "$5"',
      'cleanup-fixture',path.join(p.common_dir,'codeworks.lock'),process.execPath,script,p.repo_path,id],{env:{CODEWORKS_DATABASE_URL:f.config.app_url}});
  });

  const evidence=own.guard((p,target,commit_sha)=>recordDeployment(f.app,{project_id:p.id,target,commit_sha,evidence_url:'https://fixture.invalid/'+commit_sha},{allowedRepositories:[p.repo_path]}));
  for(const kind of ['feature','hotfix'])await subtest(kind+' durable route/check/installed gates survive recovery',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks,ci}});
    const base=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    const args={project_id:p.id,request_key:'prepare',workspace_key:'route',kind};
    if(kind==='hotfix'){
      await assert.rejects(f.h.call('prepare',args,'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
      const first=await evidence(p,'prod',base);assert.deepEqual(await evidence(p,'prod',base),first);
      await writeFile(path.join(p.repo_path,'unreleased'),'future dev\n');await command('git',['-C',p.repo_path,'add','.']);await command('git',['-C',p.repo_path,'commit','-m','Future dev']);await command('git',['-C',p.repo_path,'push','origin','dev']);
    }
    const prepared=await f.h.call('prepare',args,'codex');await f.worker(p,prepared.operation_id);
    assert.equal((await op(p,prepared.operation_id)).status,'succeeded');const w=await area(prepared.workspace_id);
    await writeFile(path.join(w.path,'fix'),'fix\n');await command('git',['-C',w.path,'add','fix']);await command('git',['-C',w.path,'commit','-m','Fix']);
    const head=(await git.inspect(p,w)).head;
    const request={project_id:p.id,request_key:'release',workspace_id:w.id,commit_sha:head};
    const accepted=await f.h.call('release',request,'codex');assert.deepEqual(await f.h.call('release',request,'codex'),accepted);
    await assert.rejects(f.h.call('release',{...request,request_key:'duplicate'},'codex'),{code:'CONFLICT'});
    assert.equal((await op(p,accepted.operation_id)).status,'pending');
    const checks=new Map(),prs=[];let createCount=0;
    const github={
      find:async(_,leg)=>prs.find(pr=>pr.head.ref===leg.branch&&pr.base.ref===leg.target)??null,
      create:async(_,leg,body)=>{createCount++;const pr={number:prs.length+1,body,html_url:'https://github.com/fixture/repository/pull/'+(prs.length+1),state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}};prs.push(pr);return pr;},
      get:async(_,n)=>{
        const pr=prs[n-1],details=(await f.app.query('SELECT details FROM codeworks.releases WHERE operation_id=$1',[accepted.operation_id])).rows[0].details;
        const leg=Object.values(details).find(l=>l.pr_number===n);
        if(leg?.merge_sha&&await flowGit.verifyMerge(p,leg)){pr.merged=true;pr.state='closed';pr.merge_commit_sha=leg.merge_sha;}
        return pr;
      },
      checks:async(_,sha)=>checks.get(sha)??[],
    };
    const run=own.guard(extra=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github,...extra}));
    // Потерянный ответ create после реального сохранения intent в PostgreSQL.
    let crashed=false;
    await assert.rejects(run({checkpoint:async point=>{if(point==='after-pr_attempted'&&!crashed){crashed=true;throw Object.assign(new Error('crash'),{code:'TEST_INTERRUPTION'});}}}),{code:'TEST_INTERRUPTION'});
    assert.equal((await op(p,accepted.operation_id)).status,'running');await run();
    let state=await op(p,accepted.operation_id);assert.equal(state.status,'awaiting_ci');assert.equal(createCount,1);
    // Recovery scanner включает незавершённые release операции, но не claim installed.
    await f.app.query("UPDATE codeworks.operations SET updated_at=now()-interval '31 seconds' WHERE id=$1",[accepted.operation_id]);
    assert.ok((await createStore(f.app).pending(16)).some(row=>row.id===accepted.operation_id));
    checks.set(head,good(head));
    let mergeInterrupted=false;
    try{await run({checkpoint:async point=>{if(point==='after-merge_push_attempted')throw Object.assign(new Error('crash'),{code:'TEST_INTERRUPTION'});}});}catch(error){assert.equal(error.code,'TEST_INTERRUPTION');mergeInterrupted=true;}
    assert.ok(mergeInterrupted,JSON.stringify(await op(p,accepted.operation_id)));
    await run();state=await op(p,accepted.operation_id);
    assert.equal(state.step,'MERGE_CHECKS_REQUIRED');assert.equal(state.status,'awaiting_ci');
    const merged=state.result.details.primary.merge_sha;assert.notEqual(merged,head);assert.equal(await flowGit.remote(p,kind==='feature'?'dev':'main'),merged);
    checks.set(head,good(head));await run();assert.equal((await op(p,accepted.operation_id)).step,'MERGE_CHECKS_REQUIRED');
    checks.set(merged,good(merged));await run();assert.equal((await op(p,accepted.operation_id)).status,'awaiting_deployment');
    await evidence(p,kind==='feature'?'dev':'prod',merged);
    if(kind==='hotfix'){
      await run();
      assert.equal((await f.app.query("SELECT id FROM codeworks.operations WHERE workspace_id=$1 AND kind='cleanup'",[w.id])).rowCount,0);
      state=await op(p,accepted.operation_id);assert.equal(state.status,'awaiting_ci');assert.ok(state.result.details.backport);
      checks.set(state.result.details.backport.merge_sha,good(state.result.details.backport.merge_sha));await run();
      assert.equal((await op(p,accepted.operation_id)).status,'awaiting_deployment');
      await evidence(p,'dev',state.result.details.backport.merge_sha);
    }
    // Сбой до COMMIT не оставляет ни успешный выпуск, ни отдельное намерение очистки.
    await assert.rejects(run({checkpoint:async point=>{if(point==='before-release-completed')throw Object.assign(new Error('crash'),{code:'TEST_INTERRUPTION'});}}),{code:'TEST_INTERRUPTION'});
    assert.equal((await f.app.query("SELECT id FROM codeworks.operations WHERE workspace_id=$1 AND kind='cleanup'",[w.id])).rowCount,0);
    await run();
    state=await op(p,accepted.operation_id);assert.equal(state.status,'succeeded');assert.equal(state.step,'VERIFIED_RELEASE_COMPLETED');assert.equal(state.result.details.primary.head_ci.head_sha,head);assert.equal(state.result.details.primary.merge_ci.head_sha,merged);
    if(kind==='hotfix')assert.equal((await command('git',['-C',p.repo_path,'ls-tree','--name-only',merged])).stdout.includes('unreleased'),false);
    assert.equal((await git.inspect(p,w)).head,head);assert.equal(createCount,kind==='hotfix'?2:1);
    assert.equal('cleanup' in state.result.details,false);
    const automatic=state.result.cleanup_operation_id;assert.ok(automatic);
    await run();
    assert.equal((await f.app.query("SELECT id FROM codeworks.operations WHERE workspace_id=$1 AND kind='cleanup'",[w.id])).rowCount,1);
    assert.ok((await createStore(f.app).pending(100)).some(row=>row.id===automatic));
    if(kind==='feature'){
      await cleanupWorker(p,automatic);
      assert.equal((await op(p,automatic)).status,'succeeded');assert.ok((await area(w.id)).removed_at);
      await assert.rejects(lstat(w.path),{code:'ENOENT'});
      assert.notEqual((await command('git',['-C',p.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
      assert.equal(await flowGit.remote(p,w.branch),null);
      assert.equal((await op(p,accepted.operation_id)).status,'succeeded');
      await assert.rejects(f.h.call('prepare',args,'codex'),{code:'CONFLICT'});
      return;
    }
    const cleanup=async key=>{
      const a=await f.h.call('cleanup',{project_id:p.id,workspace_id:w.id,request_key:key},'hermes');
      await cleanupWorker(p,a.operation_id);
      const status=await f.h.call('status',{project_id:p.id,operation_id:a.operation_id},'hermes');
      return {accepted:a,operation:status.operation,status};
    };
    await writeFile(path.join(w.path,'untracked'),'keep dirty\n');
    await cleanupWorker(p,automatic);
    const dirty=await op(p,automatic);assert.equal(dirty.status,'failed');assert.equal(dirty.error.code,'CONFLICT');
    assert.equal((await op(p,accepted.operation_id)).status,'succeeded');
    assert.equal((await lstat(w.path)).isDirectory(),true);await rm(path.join(w.path,'untracked'));
    await writeFile(path.join(w.path,'unmerged'),'keep new commit\n');await command('git',['-C',w.path,'add','unmerged']);await command('git',['-C',w.path,'commit','-m','Unmerged fixture change']);
    const unmerged=await cleanup('unmerged-cleanup');assert.equal(unmerged.operation.status,'failed');assert.equal(unmerged.operation.error.code,'CONFLICT');
    await command('git',['-C',w.path,'reset','--hard',head]);
    await command('git',['-C',p.repo_path,'worktree','unlock',w.path]);await command('git',['-C',p.repo_path,'worktree','lock','--reason','foreign',w.path]);
    const foreign=await cleanup('foreign-cleanup');assert.equal(foreign.operation.status,'failed');assert.equal(foreign.operation.error.code,'OWNERSHIP_CONFLICT');
    assert.equal(foreign.status.git,null);assert.equal(foreign.status.inspection_error.code,'OWNERSHIP_CONFLICT');
    assert.equal((await lstat(w.path)).isDirectory(),true);
    await command('git',['-C',p.repo_path,'worktree','unlock',w.path]);await command('git',['-C',p.repo_path,'worktree','lock','--reason','codeworks:'+w.ownership_token,w.path]);
    const releaseRow=(await f.app.query('SELECT id,details FROM codeworks.releases WHERE operation_id=$1',[accepted.operation_id])).rows[0];
    const incomplete=structuredClone(releaseRow.details);incomplete[kind==='hotfix'?'backport':'primary'].merged=false;
    await f.app.query('UPDATE codeworks.releases SET details=$2 WHERE id=$1',[releaseRow.id,incomplete]);
    const missingLeg=await cleanup('incomplete-cleanup');assert.equal(missingLeg.operation.status,'failed');assert.equal(missingLeg.operation.error.code,'CONFLICT');
    await f.app.query('UPDATE codeworks.releases SET details=$2 WHERE id=$1',[releaseRow.id,releaseRow.details]);
    await f.app.query('UPDATE codeworks.operations SET archived=true WHERE id=$1',[accepted.operation_id]);
    await assert.rejects(f.h.call('cleanup',{project_id:p.id,workspace_id:w.id,request_key:'archived-cleanup'},'codex'),{code:'CONFLICT'});
    await f.app.query('UPDATE codeworks.operations SET archived=false WHERE id=$1',[accepted.operation_id]);
    const removed=await cleanup('clean-cleanup');assert.equal(removed.operation.status,'succeeded');assert.deepEqual(removed.operation.result,{removed:true});
    assert.ok((await area(w.id)).removed_at);await assert.rejects(lstat(w.path),{code:'ENOENT'});
    assert.notEqual((await command('git',['-C',p.repo_path,'show-ref','--verify','refs/heads/'+w.branch],{allowFailure:true})).code,0);
    assert.equal(await flowGit.remote(p,w.branch),null);
    assert.deepEqual(await f.h.call('cleanup',{project_id:p.id,workspace_id:w.id,request_key:'clean-cleanup'},'hermes'),removed.accepted);
    assert.deepEqual(await f.h.call('release',request,'codex'),accepted);
    assert.equal((await f.h.call('status',{project_id:p.id,workspace_id:w.id},'codex')).git,null);
  });
  await subtest('sync recovers a lost push response and publishes one PR without merging or deploying',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks,ci}});
    const prepared=await f.h.call('prepare',{project_id:p.id,request_key:'prepare',workspace_key:'sync'},'codex');await f.worker(p,prepared.operation_id);
    const w=await area(prepared.workspace_id),target=await flowGit.remote(p,'dev');
    await writeFile(path.join(w.path,'sync'),'working change\n');await command('git',['-C',w.path,'add','sync']);await command('git',['-C',w.path,'commit','-m','Working change']);
    const head=(await git.inspect(p,w)).head,request={project_id:p.id,workspace_id:w.id,commit_sha:head,request_key:'sync'};
    const accepted=await f.h.call('sync',request,'codex'),prs=[];
    let creates=0,pushes=0;
    const github={
      find:async()=>prs[0]??null,
      create:async(_,leg,body)=>{creates++;const pr={number:1,body,html_url:'https://github.com/fixture/repository/pull/1',state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}};prs.push(pr);return pr;},
      checks:async()=>assert.fail('sync must not request CI or deploy'),
    };
    const publishing={...flowGit,push:async(...args)=>{pushes++;return flowGit.push(...args);}};
    const run=own.guard(extra=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit:publishing,github,...extra}));
    await assert.rejects(run({checkpoint:async point=>{if(point==='after-sync-push')throw Object.assign(new Error('lost response'),{code:'TEST_INTERRUPTION'});}}),{code:'TEST_INTERRUPTION'});
    assert.equal((await op(p,accepted.operation_id)).status,'running');await run();
    assert.equal((await op(p,accepted.operation_id)).status,'succeeded');assert.equal(creates,1);assert.equal(pushes,1);
    assert.equal(await flowGit.remote(p,w.branch),head);assert.equal(await flowGit.remote(p,'dev'),target);assert.equal(prs[0].merged,false);
    assert.equal((await f.app.query('SELECT count(*)::int AS count FROM codeworks.releases WHERE workspace_id=$1',[w.id])).rows[0].count,0);
    assert.equal((await f.app.query('SELECT count(*)::int AS count FROM codeworks.deployments WHERE project_id=$1',[p.id])).rows[0].count,0);
    assert.deepEqual(await f.h.call('sync',request,'codex'),accepted);await run();assert.equal(pushes,1);assert.equal(creates,1);
  });
  for(const mutation of ['dirty','changed-head'])await subtest('release rejects '+mutation+' after durable admission',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks,ci}});
    const prepared=await f.h.call('prepare',{project_id:p.id,request_key:'prepare',workspace_key:'changed'},'codex');await f.worker(p,prepared.operation_id);
    const w=await area(prepared.workspace_id),head=(await git.inspect(p,w)).head,target=await flowGit.remote(p,'dev');
    const accepted=await f.h.call('release',{project_id:p.id,request_key:'release',workspace_id:w.id,commit_sha:head},'codex');
    await writeFile(path.join(w.path,'changed'),'preserve changed bytes\n');
    if(mutation==='changed-head'){await command('git',['-C',w.path,'add','changed']);await command('git',['-C',w.path,'commit','-m','Changed after admission']);}
    await own.run(()=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github:{find:()=>assert.fail('changed release must stop before GitHub')}}));
    const failed=await op(p,accepted.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'CONFLICT');
    assert.equal(await flowGit.remote(p,'dev'),target);assert.equal(await flowGit.remote(p,w.branch),null);
    assert.equal((await lstat(path.join(w.path,'changed'))).isFile(),true);
  });
  await subtest('a changed target fails the pinned release rather than merging a different base',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks,ci}});
    const prepared=await f.h.call('prepare',{project_id:p.id,request_key:'prepare',workspace_key:'target-race'},'codex');await f.worker(p,prepared.operation_id);
    const w=await area(prepared.workspace_id);
    await writeFile(path.join(w.path,'feature'),'feature\n');await command('git',['-C',w.path,'add','feature']);await command('git',['-C',w.path,'commit','-m','Feature']);
    const head=(await git.inspect(p,w)).head,accepted=await f.h.call('release',{project_id:p.id,workspace_id:w.id,commit_sha:head,request_key:'release'},'codex');
    let pr,checks=[];
    const github={find:async()=>pr??null,create:async(_,leg,body)=>pr={number:1,body,html_url:'https://github.com/fixture/repository/pull/1',state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}},get:async()=>pr,checks:async()=>checks};
    const run=own.guard(()=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github}));
    await run();assert.equal((await op(p,accepted.operation_id)).status,'awaiting_ci');
    await writeFile(path.join(p.repo_path,'concurrent'),'other release\n');await command('git',['-C',p.repo_path,'add','concurrent']);await command('git',['-C',p.repo_path,'commit','-m','Concurrent target']);await command('git',['-C',p.repo_path,'push','origin','dev']);
    const changed=await flowGit.remote(p,'dev');checks=good(head);await run();
    const failed=await op(p,accepted.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'TARGET_CHANGED');assert.equal(await flowGit.remote(p,'dev'),changed);assert.equal(pr.merged,false);
  });
  await subtest('no-op release fails safely without changing workspace readiness',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks,ci}});
    const prepared=await f.h.call('prepare',{project_id:p.id,request_key:'noop-prepare',workspace_key:'noop',kind:'feature'},'codex');await f.worker(p,prepared.operation_id);
    const w=await area(prepared.workspace_id);
    const accepted=await f.h.call('release',{project_id:p.id,request_key:'noop-release',workspace_id:w.id,commit_sha:w.base_sha},'codex');
    await own.run(()=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github:{}}));
    const failed=await op(p,accepted.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'CONFLICT');assert.equal((await area(w.id)).preparation_state,'ready');
  });
  await subtest('retrying an old trusted deployment report cannot replace the current installed version',async()=>{
    const p=await f.project(),a='a'.repeat(40),b='b'.repeat(40);
    const before=await evidence(p,'prod',a),current=await evidence(p,'prod',b);
    assert.deepEqual(await evidence(p,'prod',a),before);
    await assert.rejects(recordDeployment(f.app,{project_id:p.id,target:'prod',commit_sha:'c'.repeat(40),evidence_url:'https://fixture.invalid/'+a},{allowedRepositories:[p.repo_path]}),/DEPLOYMENT_REPORT_CONFLICT/);
    const latest=(await f.app.query('SELECT id,commit_sha FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[p.id,'prod'])).rows[0];
    assert.equal(latest.id,current.id);assert.equal(latest.commit_sha,b);
  });
  await subtest('untrusted evidence caller and invalid reports fail before owner writes',async()=>{
    await assert.rejects(recordDeployment({}, {project_id:'p',target:'prod',commit_sha:'a'.repeat(40),evidence_url:'https://fixture.invalid',executor_id:'agent'}),/INVALID_DEPLOYMENT_REPORT/);
  });
  });
});
