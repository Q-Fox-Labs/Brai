// ABOUTME: Проверяет durable release/API и новую миграцию на настоящей disposable PostgreSQL и Git.
// ABOUTME: GitHub — явный double; source/target commits реальны, installed evidence создаёт только test verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configured,setup} from './fixture.mjs';
import {command,createGit} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {runOperation} from '../../src/worker.mjs';
import {recordDeployment} from '../../src/deployment-evidence.mjs';
import {createStore} from '../../src/storage.mjs';
const required_checks=[{name:'trusted-code',app_id:42}];
const good=sha=>[{name:'trusted-code',app_id:42,sha,status:'completed',conclusion:'success'}];
test('durable Git flow on PostgreSQL and real Git',{skip:!configured,timeout:120000},async t=>{
  const flowGit=createFlowGit({localRemote:true,requireLock:()=>{}}),git=createGit({flowGit});
  const f=await setup({git});t.after(()=>f.close());
  const op=async(p,id)=>(await f.h.call('operation-status',{project_id:p.id,operation_id:id},'codex')).operation;
  const area=async id=>(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[id])).rows[0];
  const evidence=(p,target,commit_sha)=>recordDeployment(f.app,{project_id:p.id,target,commit_sha,evidence_url:'https://fixture.invalid/'+commit_sha},{allowedRepositories:[p.repo_path]});
  for(const kind of ['feature','promotion','hotfix'])await t.test(kind+' durable route/check/installed gates survive recovery',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks}});
    let base=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
    const args={project_id:p.id,idempotency_key:'prepare',workspace_key:'route',kind,session_id:'s'};
    if(kind==='hotfix'){
      await assert.rejects(f.h.call('prepare-write',args,'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
      const first=await evidence(p,'prod',base);assert.deepEqual(await evidence(p,'prod',base),first);
      await writeFile(path.join(p.repo_path,'unreleased'),'future dev\n');await command('git',['-C',p.repo_path,'add','.']);await command('git',['-C',p.repo_path,'commit','-m','Future dev']);await command('git',['-C',p.repo_path,'push','origin','dev']);
    }
    if(kind==='promotion'){
      await writeFile(path.join(p.repo_path,'approved'),'verified dev change\n');await command('git',['-C',p.repo_path,'add','.']);await command('git',['-C',p.repo_path,'commit','-m','Approved dev']);await command('git',['-C',p.repo_path,'push','origin','dev']);
      base=(await command('git',['-C',p.repo_path,'rev-parse','HEAD'])).stdout;
      const proof=await evidence(p,'dev',base);args.commit_sha=base;args.evidence_id=proof.id;
      await writeFile(path.join(p.repo_path,'later'),'unverified later dev\n');await command('git',['-C',p.repo_path,'add','.']);await command('git',['-C',p.repo_path,'commit','-m','Later dev']);await command('git',['-C',p.repo_path,'push','origin','dev']);
    }
    const prepared=await f.h.call('prepare-write',args,'codex');await f.worker(p,prepared.operation_id);
    assert.equal((await op(p,prepared.operation_id)).status,'succeeded');const w=await area(prepared.workspace_id);
    if(kind!=='promotion'){
      await writeFile(path.join(w.path,'fix'),'fix\n');await command('git',['-C',w.path,'add','fix']);await command('git',['-C',w.path,'commit','-m','Fix']);
    }
    const head=(await git.inspect(p,w)).head;
    const request={project_id:p.id,idempotency_key:'release',workspace_id:w.id,session_id:'s',expected_epoch:1,target:kind==='feature'?'dev':'prod',commit_sha:head};
    const accepted=await f.h.call('request-release',request,'codex');assert.deepEqual(await f.h.call('request-release',request,'codex'),accepted);
    await assert.rejects(f.h.call('request-release',{...request,idempotency_key:'duplicate'},'codex'),{code:'CONFLICT'});
    assert.equal((await op(p,accepted.operation_id)).status,'pending');
    const checks=new Map(),prs=[];let createCount=0;
    const github={
      find:async(_,leg)=>prs.find(pr=>pr.head.ref===leg.branch&&pr.base.ref===leg.target)??null,
      create:async(_,leg,body)=>{createCount++;const pr={number:prs.length+1,body,html_url:'https://github.com/fixture/repository/pull/'+(prs.length+1),state:'open',merged:false,head:{sha:leg.head,ref:leg.branch,repo:{full_name:p.github.repository}},base:{ref:leg.target,repo:{full_name:p.github.repository}}};prs.push(pr);return pr;},
      get:async(_,n)=>{
        const pr=prs[n-1],details=(await op(p,accepted.operation_id)).result.details;
        const leg=Object.values(details).find(l=>l.pr_number===n);
        if(leg?.merge_sha&&await flowGit.verifyMerge(p,leg)){pr.merged=true;pr.state='closed';pr.merge_commit_sha=leg.merge_sha;}
        return pr;
      },
      checks:async(_,sha)=>checks.get(sha)??[],
    };
    const run=extra=>runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github,...extra});
    // Потерянный ответ create после реального сохранения intent в PostgreSQL.
    let crashed=false;
    await assert.rejects(run({checkpoint:async point=>{if(point==='after-pr_attempted'&&!crashed){crashed=true;throw Object.assign(new Error('crash'),{code:'TEST_INTERRUPTION'});}}}),{code:'TEST_INTERRUPTION'});
    assert.equal((await op(p,accepted.operation_id)).status,'running');await run();
    let state=await op(p,accepted.operation_id);assert.equal(state.status,'awaiting_ci');assert.equal(createCount,1);
    // Recovery scanner включает незавершённые release операции, но не claim installed.
    await f.app.query("UPDATE codeworks.operations SET updated_at=now()-interval '31 seconds' WHERE id=$1",[accepted.operation_id]);
    assert.ok((await createStore(f.app).pending(16)).some(row=>row.id===accepted.operation_id));
    checks.set(head,good(head));
    await assert.rejects(run({checkpoint:async point=>{if(point==='after-merge_push_attempted')throw Object.assign(new Error('crash'),{code:'TEST_INTERRUPTION'});}}),{code:'TEST_INTERRUPTION'});
    await run();state=await op(p,accepted.operation_id);
    assert.equal(state.step,'MERGE_CHECKS_REQUIRED');assert.equal(state.status,'awaiting_ci');
    const merged=state.result.details.primary.merge_sha;assert.notEqual(merged,head);assert.equal(await flowGit.remote(p,kind==='feature'?'dev':'main'),merged);
    checks.set(head,good(head));await run();assert.equal((await op(p,accepted.operation_id)).step,'MERGE_CHECKS_REQUIRED');
    checks.set(merged,good(merged));await run();assert.equal((await op(p,accepted.operation_id)).status,'awaiting_deployment');
    await evidence(p,kind==='feature'?'dev':'prod',merged);await run();
    if(kind==='hotfix'){
      state=await op(p,accepted.operation_id);assert.equal(state.status,'awaiting_ci');assert.ok(state.result.details.backport);
      checks.set(state.result.details.backport.merge_sha,good(state.result.details.backport.merge_sha));await run();
      assert.equal((await op(p,accepted.operation_id)).status,'awaiting_deployment');
      await evidence(p,'dev',state.result.details.backport.merge_sha);await run();
    }
    state=await op(p,accepted.operation_id);assert.equal(state.status,'succeeded');assert.equal(state.step,'VERIFIED_RELEASE_COMPLETED');
    if(kind!=='feature')assert.equal((await command('git',['-C',p.repo_path,'ls-tree','--name-only',merged])).stdout.includes(kind==='hotfix'?'unreleased':'later'),false);
    assert.equal((await git.inspect(p,w)).head,head);assert.equal(createCount,kind==='hotfix'?2:1);
  });
  await t.test('no-op release fails safely without changing workspace readiness',async()=>{
    const p=await f.project({github:{repository:'fixture/repository',required_checks}});
    const prepared=await f.h.call('prepare-write',{project_id:p.id,idempotency_key:'noop-prepare',workspace_key:'noop',kind:'feature',session_id:'s'},'codex');await f.worker(p,prepared.operation_id);
    const w=await area(prepared.workspace_id);
    const accepted=await f.h.call('request-release',{project_id:p.id,idempotency_key:'noop-release',workspace_id:w.id,session_id:'s',expected_epoch:1,target:'dev',commit_sha:w.base_sha},'codex');
    await runOperation(f.app,accepted.operation_id,git,{allowedRepositories:[p.repo_path],flowGit,github:{}});
    const failed=await op(p,accepted.operation_id);assert.equal(failed.status,'failed');assert.equal(failed.result.state,'failed');assert.equal(failed.error.code,'CONFLICT');assert.equal((await area(w.id)).preparation_state,'ready');
  });
  await t.test('retrying an old trusted deployment report cannot replace the current installed version',async()=>{
    const p=await f.project(),a='a'.repeat(40),b='b'.repeat(40);
    const before=await evidence(p,'prod',a),current=await evidence(p,'prod',b);
    assert.deepEqual(await evidence(p,'prod',a),before);
    await assert.rejects(recordDeployment(f.app,{project_id:p.id,target:'prod',commit_sha:'c'.repeat(40),evidence_url:'https://fixture.invalid/'+a},{allowedRepositories:[p.repo_path]}),/DEPLOYMENT_REPORT_CONFLICT/);
    const latest=(await f.app.query('SELECT id,commit_sha FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[p.id,'prod'])).rows[0];
    assert.equal(latest.id,current.id);assert.equal(latest.commit_sha,b);
  });
  await t.test('untrusted evidence caller and invalid reports fail before owner writes',async()=>{
    await assert.rejects(recordDeployment({}, {project_id:'p',target:'prod',commit_sha:'a'.repeat(40),evidence_url:'https://fixture.invalid',executor_id:'agent'}),/INVALID_DEPLOYMENT_REPORT/);
  });
});
