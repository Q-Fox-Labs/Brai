// ABOUTME: Проверяет три Git маршрута на настоящих изолированных bare repositories.
// ABOUTME: GitHub здесь явный test double; реальный GitHub PR проверяется отдельно без искусственного CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';
import {createGitHub} from '../src/github.mjs';
import {advanceRelease,checksPassed} from '../src/release.mjs';
import {validate,methods} from '../src/contracts.mjs';
import {createHandlers} from '../src/domain.mjs';
const required=[{name:'code',app_id:42}];
const check=(sha,extra={})=>({name:'code',app_id:42,sha,status:'completed',conclusion:'success',...extra});
async function fixture(t,kind='feature') {
  const tmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(path.join(tmp,'git-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bare=path.join(root,'origin.git'),repo=path.join(root,'repo');
  await command('git',['init','--bare','--initial-branch=dev',bare]);
  await command('git',['clone',bare,repo]);
  const g=(...args)=>command('git',['-C',repo,...args]);
  await writeFile(path.join(repo,'common'),'base\n');await g('add','.');await g('commit','-m','Initial');
  const base=(await g('rev-parse','HEAD')).stdout;await g('branch','main');await g('push','origin','dev','main');
  await writeFile(path.join(repo,'unreleased'),'not in production\n');await g('add','.');await g('commit','-m','Unreleased dev');
  const dev=(await g('rev-parse','HEAD')).stdout;await g('push','origin','dev');
  const id=randomUUID(),headBase=kind==='hotfix'?base:dev,branch=(kind==='promotion'?'release':kind)+'/codeworks-'+id;
  await g('checkout','-b',branch,headBase);
  if(kind!=='promotion'){await writeFile(path.join(repo,'fix'),'change\n');await g('add','.');await g('commit','-m','Change');}
  const head=(await g('rev-parse','HEAD')).stdout;
  const project={id:'p',repo_path:repo,github:{repository:'fixture/repository',required_checks:required}};
  const workspace={id,kind,branch,base_sha:headBase};
  const operation={id:randomUUID(),created_at:'2026-10-21T10:00:00.000Z'};
  let release={requested_sha:head,details:{}};const saved=[],proofs=new Map([['prod',{id:randomUUID(),commit_sha:base}]]),checks=new Map();
  const git=createFlowGit({localRemote:true,requireLock:()=>{}});
  const prs=[];let creations=0;
  const gh={
    async find(_,leg){return prs.find(p=>p.head.ref===leg.branch&&p.base.ref===leg.target)??null;},
    async create(_,leg,body){creations++;const pr={number:prs.length+1,html_url:'https://github.com/fixture/repository/pull/'+(prs.length+1),state:'open',merged:false,body,head:{sha:leg.head,ref:leg.branch,repo:{full_name:project.github.repository}},base:{ref:leg.target,repo:{full_name:project.github.repository}}};prs.push(pr);return pr;},
    async get(_,number){const pr=prs.find(p=>p.number===number);const leg=Object.values(release.details).find(l=>l.pr_number===number);if(leg?.merge_sha&&await git.verifyMerge(project,leg)){pr.merged=true;pr.state='closed';pr.merge_commit_sha=leg.merge_sha;}return pr;},
    async checks(_,sha){return checks.get(sha)??[];},
  };
  const deps={git,github:gh,inspect:async()=>({head,dirty:false}),save:async details=>{saved.push(structuredClone(details));release.details=structuredClone(details);},evidence:async(target,sha)=>{const p=proofs.get(target);return p&&(!sha||p.commit_sha===sha)?p:null;}};
  async function advance(extra={}){
    // Новый объект имитирует чтение durable JSON после рестарта процесса.
    release=structuredClone(release);
    return advanceRelease({project,workspace,operation,release},{...deps,...extra});
  }
  const good=sha=>checks.set(sha,[check(sha)]);
  const installed=(target,sha)=>proofs.set(target,{id:randomUUID(),commit_sha:sha});
  return {root,bare,repo,g,base,dev,head,branch,project,workspace,operation,git,gh,proofs,checks,saved,prs,advance,good,installed,get release(){return release;},get creations(){return creations;}};
}
test('checks fail closed on absence, pending, failure, skipped, wrong SHA/app and duplicates',()=>{
  const sha='a'.repeat(40);assert.equal(checksPassed(required,[check(sha)],sha),true);
  for(const rows of [[],[check(sha,{status:'queued'})],[check(sha,{conclusion:'failure'})],[check(sha,{conclusion:'skipped'})],[check('b'.repeat(40))],[check(sha,{app_id:7})],[check(sha),check(sha)]])assert.equal(checksPassed(required,rows,sha),false);
  assert.equal(checksPassed([],[],sha),false);
});
for(const kind of ['feature','promotion','hotfix'])test(kind+' follows exact route; merge waits final CI and trusted installed evidence',async t=>{
  const f=await fixture(t,kind);
  assert.deepEqual(await f.advance(),{status:'awaiting_ci',reason:'HEAD_CHECKS_REQUIRED'});
  assert.equal(f.prs.length,1);assert.equal(f.release.details.primary.head,f.head);
  const target=kind==='feature'?'dev':'main';assert.equal(await f.git.remote(f.project,target),kind==='feature'?f.dev:f.base);
  if(kind==='hotfix')assert.equal((await f.g('ls-tree','--name-only',f.head)).stdout.includes('unreleased'),false);
  f.good(f.head);assert.equal((await f.advance()).reason,'MERGE_CHECKS_REQUIRED');
  const merged=f.release.details.primary.merge_sha;assert.equal(await f.git.remote(f.project,target),merged);
  f.good(merged);assert.equal((await f.advance()).status,'awaiting_deployment');
  assert.equal((await f.advance()).status,'awaiting_deployment');
  f.installed(target==='main'?'prod':'dev',f.head);assert.equal((await f.advance()).status,'awaiting_deployment');
  f.installed(target==='main'?'prod':'dev',merged);
  if(kind==='hotfix'){
    assert.equal((await f.advance()).reason,'MERGE_CHECKS_REQUIRED');
    assert.equal(f.prs.length,2);const back=f.release.details.backport;assert.equal(back.target,'dev');
    f.good(back.merge_sha);assert.equal((await f.advance()).status,'awaiting_deployment');
    f.installed('dev',back.merge_sha);
  }
  assert.equal((await f.advance()).status,'succeeded');assert.equal(f.creations,kind==='hotfix'?2:1);
  assert.equal((await f.g('symbolic-ref','--short','HEAD')).stdout,f.branch);
});
test('lost create response reconciles existing PR, never creates duplicate; unknown result remains waiting',async t=>{
  const f=await fixture(t);let lose=true;
  const github={...f.gh,create:async(...args)=>{const pr=await f.gh.create(...args);if(lose){lose=false;throw new Error('response lost');}return pr;}};
  await assert.rejects(f.advance({github}),/response lost/);
  assert.equal(f.saved.at(-1).primary.pr_attempted,true);
  assert.equal((await f.advance({github})).status,'awaiting_ci');assert.equal(f.creations,1);
  const other=await fixture(t);const bad={...other.gh,create:async()=>{throw new Error('connection lost before outcome known');}};
  await assert.rejects(other.advance({github:bad}));assert.equal((await other.advance({github:bad})).status,'awaiting_reconciliation');assert.equal(other.creations,0);
});
test('lost branch and merge push responses recover actual refs and exact PR merge',async t=>{
  for(const loseBranch of [true,false]){
    const f=await fixture(t);f.good(f.head);let lost=false;
    const git={...f.git,push:async(p,branch,sha)=>{await f.git.push(p,branch,sha);if(!lost&&(loseBranch?branch===f.branch:branch==='dev')){lost=true;throw new Error('push response lost');}}};
    await assert.rejects(f.advance({git}),/push response lost/);
    const last=f.saved.at(-1).primary;assert.equal(loseBranch?last.push_attempted:last.merge_push_attempted,true);
    assert.equal((await f.advance({git})).reason,'MERGE_CHECKS_REQUIRED');
    assert.equal(f.creations,1);assert.equal(await f.git.remote(f.project,'dev'),f.release.details.primary.merge_sha);
  }
});
test('target advancing while head checks wait invalidates frozen intent and preserves foreign commit',async t=>{
  const f=await fixture(t);await f.advance();
  await f.g('checkout','dev');await writeFile(path.join(f.repo,'foreign'),'keep\n');await f.g('add','.');await f.g('commit','-m','Foreign dev');await f.g('push','origin','dev');
  const newer=(await f.g('rev-parse','HEAD')).stdout;f.good(f.head);
  await assert.rejects(f.advance(),{code:'TARGET_CHANGED'});assert.equal(await f.git.remote(f.project,'dev'),newer);assert.equal(await readFile(path.join(f.repo,'foreign'),'utf8'),'keep\n');
});
test('bare repo race between last read and push rejects divergent target without losing it',async t=>{
  const f=await fixture(t);f.good(f.head);let raced=false,newer;
  const git={...f.git,push:async(p,b,h)=>{
    if(b==='dev'&&!raced){raced=true;await f.g('checkout','dev');await writeFile(path.join(f.repo,'raced'),'keep\n');await f.g('add','.');await f.g('commit','-m','Concurrent target');newer=(await f.g('rev-parse','HEAD')).stdout;await f.g('push','origin','dev');}
    return f.git.push(p,b,h);
  }};
  await assert.rejects(f.advance({git}),{code:'GIT_FAILED'});assert.equal(await f.git.remote(f.project,'dev'),newer);
  await assert.rejects(f.advance({git}),{code:'TARGET_CHANGED'});assert.equal(await f.git.remote(f.project,'dev'),newer);
});
test('merge conflict changes no target and preserves feature branch',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.repo,'common'),'feature conflict\n');await f.g('add','.');await f.g('commit','-m','Feature conflict');
  const head=(await f.g('rev-parse','HEAD')).stdout;
  await f.g('checkout','dev');await writeFile(path.join(f.repo,'common'),'dev conflict\n');await f.g('add','.');await f.g('commit','-m','Dev conflict');await f.g('push','origin','dev');
  const target=(await f.g('rev-parse','HEAD')).stdout;f.release.requested_sha=head;f.good(head);
  await assert.rejects(f.advance({inspect:async()=>({head,dirty:false})}),{code:'MERGE_CONFLICT'});
  assert.equal(await f.git.remote(f.project,'dev'),target);assert.equal(await f.git.remote(f.project,f.branch),head);
});
test('hotfix rejects stale installed base and importing unreleased dev merge',async t=>{
  const f=await fixture(t,'hotfix');f.proofs.clear();await assert.rejects(f.advance(),{code:'PRODUCTION_BASE_MISMATCH'});
  await f.g('merge','--no-edit',f.dev);const head=(await f.g('rev-parse','HEAD')).stdout;
  await assert.rejects(f.git.validateHead(f.project,f.workspace,head),{code:'CONFLICT'});
});
test('hotfix rejects linear dev ancestry and descendants even with a stale local dev ref',async t=>{
  for(const extraCommit of [false,true])await t.test(extraCommit?'dev plus another fix':'fast-forward dev',async t=>{
    const f=await fixture(t,'hotfix');
    await f.g('reset','--hard',f.base);await f.g('merge','--ff-only',f.dev);
    if(extraCommit){await writeFile(path.join(f.repo,'another-fix'),'fix\n');await f.g('add','.');await f.g('commit','-m','Fix after dev import');}
    const head=(await f.g('rev-parse','HEAD')).stdout;
    await f.g('update-ref','refs/remotes/origin/dev',f.base);
    f.release.requested_sha=head;f.good(head);
    await assert.rejects(f.advance({inspect:async()=>({head,dirty:false})}),{code:'CONFLICT'});
    assert.equal(await f.git.remote(f.project,'main'),f.base);
    assert.equal(await f.git.remote(f.project,f.branch),null);assert.equal(f.creations,0);
  });
});
test('hotfix refreshes dev ancestry after candidate preparation before main publication',async t=>{
  const f=await fixture(t,'hotfix');f.good(f.head);
  const git={...f.git,candidate:async(...args)=>{
    const candidate=await f.git.candidate(...args);
    await f.g('checkout','dev');await f.g('merge','--no-edit',f.head);await f.g('push','origin','dev');
    return candidate;
  }};
  await assert.rejects(f.advance({git}),{code:'CONFLICT'});
  assert.equal(await f.git.remote(f.project,'main'),f.base);
  assert.equal(f.release.details.primary.merge_push_attempted,undefined);
});
test('hotfix reconciles a lost main push before considering a subsequent dev backport',async t=>{
  const f=await fixture(t,'hotfix');f.good(f.head);let lost=false;
  const git={...f.git,push:async(p,b,head)=>{
    await f.git.push(p,b,head);
    if(b==='main'&&!lost){lost=true;throw Error('main response lost');}
  }};
  await assert.rejects(f.advance({git}),/main response lost/);
  await f.g('checkout','dev');await f.g('merge','--no-edit',f.head);await f.g('push','origin','dev');
  assert.equal((await f.advance({git})).reason,'MERGE_CHECKS_REQUIRED');
  assert.equal(f.release.details.primary.merged,true);assert.equal(f.creations,1);
});
test('promotion remains pinned while later dev advances',async t=>{
  const f=await fixture(t,'promotion');await f.advance();
  await f.g('checkout','dev');await writeFile(path.join(f.repo,'later'),'not approved\n');await f.g('add','.');await f.g('commit','-m','Later dev');await f.g('push','origin','dev');
  f.good(f.head);assert.equal((await f.advance()).reason,'MERGE_CHECKS_REQUIRED');
  const merge=f.release.details.primary.merge_sha;assert.equal((await f.g('ls-tree','--name-only',merge)).stdout.includes('later'),false);assert.equal(f.release.details.primary.head,f.dev);
});
test('ownership and exact PR checks reject changed head/repository and closed PR',async t=>{
  for(const alter of [p=>p.head.sha='f'.repeat(40),p=>p.head.repo.full_name='foreign/repository',p=>p.body='foreign',p=>p.state='closed']){
    const f=await fixture(t);await f.advance();alter(f.prs[0]);f.good(f.head);await assert.rejects(f.advance(),{code:'CONFLICT'});
    assert.equal(await f.git.remote(f.project,'dev'),f.dev);
  }
});
test('final fresh PR read revalidates every pinned identity before target mutation',async t=>{
  const changes={
    target:p=>p.base.ref='main',source:p=>p.head.ref='feature/codeworks-'+randomUUID(),
    head:p=>p.head.sha='f'.repeat(40),headRepository:p=>p.head.repo.full_name='foreign/repository',
    baseRepository:p=>p.base.repo.full_name='foreign/repository',ownership:p=>p.body='foreign',
    number:p=>p.number++,closed:p=>p.state='closed',merged:p=>p.merged=true,
  };
  for(const [name,alter] of Object.entries(changes))await t.test(name,async t=>{
    const f=await fixture(t);f.good(f.head);let gets=0;
    const github={...f.gh,get:async(...args)=>{
      const pr=structuredClone(await f.gh.get(...args));if(++gets===1)alter(pr);return pr;
    }};
    await assert.rejects(f.advance({github}),{code:'CONFLICT'});
    assert.equal(gets,1);assert.equal(await f.git.remote(f.project,'dev'),f.dev);
    assert.equal(f.release.details.primary.merge_push_attempted,undefined);
  });
});
test('production proof has no agent/NATS method and promotion requires exact recorded dev evidence',async()=>{
  assert.equal(methods.some(m=>/evidence|deployment/.test(m)),false);
  const id=randomUUID(),proof=randomUUID(),sha='a'.repeat(40);
  const args={project_id:'p',workspace_key:'promotion',idempotency_key:'p',kind:'promotion',session_id:'s',commit_sha:sha,evidence_id:proof};
  validate('prepare-write',args);assert.throws(()=>validate('prepare-write',{...args,evidence_id:undefined}));
  const project={id:'p',repo_path:'/repo',workspace_root:'/areas',executors:['codex'],git_flow:{}};
  const db={project:async()=>project,request:async()=>null,workspaceByKey:async()=>null,evidenceById:async()=>({id:proof,target:'dev',commit_sha:'b'.repeat(40)})};
  const store={transaction:async(_,fn)=>fn(db),read:async(_,fn)=>fn(db)};
  await assert.rejects(createHandlers(store,{}, {allowedRepositories:['/repo']}).call('prepare-write',args,'codex'),{code:'VERIFIED_DEV_REQUIRED'});
});
test('GitHub adapter preserves exact query SHA, app identity and lost API error boundary',async()=>{
  const calls=[],sha='c'.repeat(40),p={github:{repository:'fixture/repository'}};
  const gh=createGitHub({run:async(exe,args,options)=>{calls.push({exe,args,options});return {stdout:JSON.stringify({total_count:1,check_runs:[{name:'code',app:{id:42},head_sha:sha,status:'completed',conclusion:'success'}]})};}});
  assert.deepEqual(await gh.checks(p,sha),[check(sha)]);assert.equal(calls[0].args.at(-1),'repos/fixture/repository/commits/'+sha+'/check-runs?per_page=100&filter=latest');
  const failed=createGitHub({run:async()=>{throw new Error('private stderr');}});await assert.rejects(failed.checks(p,sha),{code:'GITHUB_UNAVAILABLE',message:'GitHub response unavailable; reconcile the recorded intent.'});
});
test('failed/pending/wrong-SHA checks block target mutation through the actual release port',async t=>{
  const f=await fixture(t);await f.advance();
  for(const rows of [[check(f.head,{conclusion:'failure'})],[check(f.head,{status:'in_progress',conclusion:null})],[check('d'.repeat(40))]]){
    f.checks.set(f.head,rows);assert.equal((await f.advance()).status,'awaiting_ci');assert.equal(await f.git.remote(f.project,'dev'),f.dev);
  }
});
test('reusing promotion workspace with a different pinned SHA or evidence is rejected',async()=>{
  const id=randomUUID(),evidence_id=randomUUID(),base='a'.repeat(40);
  const w={id,kind:'promotion',base_sha:base,base_ref:'verified-dev:'+evidence_id,writer:{executor_id:'codex',session_id:'s',epoch:1,state:'active'}};
  const db={project:async()=>({repo_path:'/repo',executors:['codex']}),request:async()=>null,workspaceByKey:async()=>w};
  const store={read:async(_,fn)=>fn(db),transaction:async(_,fn)=>fn(db)};
  const h=createHandlers(store,{}, {allowedRepositories:['/repo']});
  await assert.rejects(h.call('prepare-write',{project_id:'p',workspace_key:'p',idempotency_key:'changed',kind:'promotion',session_id:'s',commit_sha:'b'.repeat(40),evidence_id},'codex'),{code:'CONFLICT'});
});
