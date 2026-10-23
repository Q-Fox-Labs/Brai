// ABOUTME: Проверяет owner-схемы и простое ядро подготовки, синхронизации и выпуска.
// ABOUTME: Использует явные порты без PostgreSQL, процессов агентов и проверки UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical,validate,expanded,methods,outputNames } from '../src/contracts.mjs';
import { createHandlers } from '../src/domain.mjs';
import { runNats } from '../src/nats.mjs';
import { Fault } from '../src/errors.mjs';
const id='0997203d-1266-4cf7-9668-d985b3eec801',sha='a'.repeat(40);
const prepare={project_id:'p',request_key:'prepare-task',workspace_key:'task'};
const scoped={project_id:'p',request_key:'publish-task',workspace_id:id,commit_sha:sha};

/** Порты ядра хранят только тестовые операции; Git мутации принадлежат отдельному worker. */
function fixture() {
  const project={id:'p',repo_path:'/repo',common_dir:'/repo/.git',workspace_root:'/areas',allowed_paths:['.'],excluded_paths:['.git','node_modules'],preparer_path:'/repo/.git/hooks/prepare',node_version:'24.22.1',platform:process.platform+'-'+process.arch,executors:['codex','hermes'],git_flow:{feature_base:'refs/remotes/origin/dev',hotfix_base:'refs/remotes/origin/main',feature_prefix:'feature/',hotfix_prefix:'hotfix/'},github:{repository:'fixture/repository',required_checks:[{name:'code',app_id:42}]}};
  const workspaces=new Map(),operations=new Map(),requests=new Map(),releases=[],failedDeployments=new Map();
  const created='2026-10-23T00:00:00.000Z';
  let current={head:sha,branch:'feature/test',dirty:false},successful=null,evidence=null,inspectionError=null;
  const db={
    project:async key=>key==='p'?project:null,
    workspace:async(_,key)=>workspaces.get(key),workspaceByKey:async(_,key)=>[...workspaces.values()].find(w=>w.workspace_key===key),
    workspaces:async()=>[...workspaces.values()],
    insertWorkspace:async w=>workspaces.set(w.id,{...w,element_id:null,preparation_state:'intent',legacy_writer:null,created_at:created,removed_at:null}),
    operation:async(_,key)=>operations.get(key),latestOperation:async key=>[...operations.values()].filter(o=>o.workspace_id===key).at(-1),
    latestPreparation:async key=>[...operations.values()].filter(o=>o.workspace_id===key&&o.kind==='prepare'&&!o.archived).at(-1),
    insertOperation:async o=>operations.set(o.id,{...o,actor_id:null,error:null,archived:false,created_at:created,updated_at:created}),
    request:async(_,executor,key)=>requests.get(executor+':'+key),
    insertRequest:async r=>{const o=operations.get(r.operation_id);requests.set(r.executor_id+':'+r.key,{payload_sha256:r.digest,operation_id:o.id,workspace_id:o.workspace_id,archived:o.archived});},
    activeRelease:async key=>[...operations.values()].find(o=>o.workspace_id===key&&o.kind==='release'&&!o.archived&&!['failed','succeeded'].includes(o.status)),
    successfulRelease:async()=>successful,currentEvidence:async()=>evidence,release:async r=>releases.push(r),
    latestRelease:async key=>releases.filter(r=>r.workspace_id===key).at(-1),failedDeployment:async key=>failedDeployments.get(key),
  };
  const store={read:async(_,work)=>work(db),transaction:async(_,work)=>work(db)};
  const git={readBase:async()=>sha,inspect:async()=>{if(inspectionError)throw inspectionError;return {...current};}};
  const h=createHandlers(store,git,{allowedRepositories:['/repo']});
  return {h,project,workspaces,operations,requests,releases,failedDeployments,set current(value){current=value;},set inspectionError(value){inspectionError=value;},set successful(value){successful=value;},set evidence(value){evidence=value;}};
}

test('owner API exposes only project administration and five lifecycle methods',()=>{
  assert.deepEqual(methods,['project.register','project.get','prepare','status','sync','release','cleanup']);
  assert.equal(canonical({b:1,a:{d:2,c:3}}),canonical({a:{c:3,d:2},b:1}));
  validate('prepare',prepare);validate('prepare',{...prepare,kind:'hotfix'});
  for(const method of ['sync','release'])validate(method,scoped);
  validate('cleanup',{project_id:'p',workspace_id:id,request_key:'cleanup-task'});
  for(const selector of [{},{workspace_id:id},{workspace_key:'task'},{operation_id:id}])validate('status',{project_id:'p',...selector});
  for(const method of methods)assert.equal(expanded(method).additionalProperties,false);
  for(const method of ['prepare-write','attach-or-transfer','request-release','operation-status','commit'])assert.throws(()=>validate(method,prepare),{code:'INVALID_ARGUMENT'});
});
test('lifecycle schemas reject writer controls, untrusted evidence and extra identity',()=>{
  for(const field of ['executor_id','session_id','expected_epoch','actor_id','element_id','attempt_id','writes_stopped','evidence_id','gate_token']){
    assert.throws(()=>validate('prepare',{...prepare,[field]:'forged'}),{code:'INVALID_ARGUMENT'});
    assert.throws(()=>validate('release',{...scoped,[field]:'forged'}),{code:'INVALID_ARGUMENT'});
  }
  assert.throws(()=>validate('prepare',{...prepare,kind:'promotion'}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>validate('prepare',{...prepare,idempotency_key:'legacy'}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>validate('release',{...scoped,target:'prod'}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>validate('cleanup',scoped),{code:'INVALID_ARGUMENT'});
  for(const commit_sha of ['', 'mutable-branch', 'A'.repeat(40)])assert.throws(()=>validate('sync',{...scoped,commit_sha}),{code:'INVALID_ARGUMENT'});
});
test('transport identity authorizes project access and registration',async()=>{
  const f=fixture();
  await assert.rejects(f.h.call('project.get',{project_id:'p'},'forged id'),{code:'FORBIDDEN'});
  await assert.rejects(f.h.call('status',{project_id:'p'},'foreign'),{code:'FORBIDDEN'});
  await assert.rejects(f.h.call('project.register',{project:f.project},'codex'),{code:'FORBIDDEN'});
});
test('prepare keeps one task workspace and operation across retries and executor changes',async()=>{
  const f=fixture(),first=await f.h.call('prepare',prepare,'codex');
  assert.match(first.path,/^\/areas\//);assert.equal(first.branch,'feature/task');
  assert.deepEqual(await f.h.call('prepare',{workspace_key:'task',request_key:'prepare-task',project_id:'p'},'codex'),first);
  assert.deepEqual(await f.h.call('prepare',{...prepare,request_key:'resume-task'},'hermes'),first);
  assert.equal(f.operations.size,1);assert.equal(f.workspaces.size,1);
  assert.equal(f.workspaces.get(first.workspace_id).legacy_writer,null);
  await assert.rejects(f.h.call('prepare',{...prepare,workspace_key:'other-task'},'codex'),{code:'CONFLICT'});
  await assert.rejects(f.h.call('prepare',{...prepare,request_key:'change-kind',kind:'hotfix'},'codex'),{code:'CONFLICT'});
});
test('failed preparation can retry the same workspace without reusing the failed operation',async()=>{
  const f=fixture(),first=await f.h.call('prepare',prepare,'codex');
  f.operations.get(first.operation_id).status='failed';
  const next=await f.h.call('prepare',{...prepare,request_key:'retry-task'},'hermes');
  assert.equal(next.workspace_id,first.workspace_id);assert.equal(next.path,first.path);assert.notEqual(next.operation_id,first.operation_id);
  assert.equal(f.workspaces.size,1);assert.equal(f.operations.size,2);
});
test('status finds task, workspace, operation or list without exposing historical writer fences',async()=>{
  const f=fixture(),accepted=await f.h.call('prepare',prepare,'codex'),w=f.workspaces.get(accepted.workspace_id);
  w.preparation_state='ready';w.legacy_writer={executor_id:'old',session_id:'retired',epoch:9,state:'active'};
  const byKey=await f.h.call('status',{project_id:'p',workspace_key:'task'},'hermes');
  assert.equal(byKey.workspace.id,w.id);assert.equal(byKey.git.head,sha);assert.equal(byKey.operation.id,accepted.operation_id);
  assert.equal('legacy_writer' in byKey.workspace,false);assert.equal('writer' in byKey.workspace,false);assert.equal('ownership_token' in byKey.workspace,false);
  assert.deepEqual(await f.h.call('status',{project_id:'p',workspace_id:w.id},'codex'),byKey);
  assert.deepEqual(await f.h.call('status',{project_id:'p',operation_id:accepted.operation_id},'codex'),byKey);
  assert.deepEqual(await f.h.call('status',{project_id:'p'},'codex'),{workspaces:[byKey.workspace]});
  w.removed_at='2026-10-23T01:00:00.000Z';assert.equal((await f.h.call('status',{project_id:'p',workspace_key:'task'},'codex')).git,null);
  await assert.rejects(f.h.call('prepare',prepare,'codex'),{code:'CONFLICT'});
  await assert.rejects(f.h.call('prepare',{...prepare,request_key:'finished-task'},'codex'),{code:'CONFLICT'});
});
test('status preserves durable failure when Git inspection fails and masks unexpected infrastructure details',async()=>{
  const f=fixture(),accepted=await f.h.call('prepare',prepare,'codex'),w=f.workspaces.get(accepted.workspace_id),operation=f.operations.get(accepted.operation_id);
  w.preparation_state='ready';operation.status='failed';operation.error=new Fault('CONFLICT','Recorded operation failure.').dto();
  f.inspectionError=new Fault('OWNERSHIP_CONFLICT');
  const request={project_id:'p',operation_id:accepted.operation_id};
  const failed=await f.h.call('status',request,'hermes');
  assert.equal(failed.workspace.id,w.id);assert.deepEqual(failed.operation,operation);assert.equal(failed.git,null);
  assert.deepEqual(failed.inspection_error,{code:'OWNERSHIP_CONFLICT',message:'OWNERSHIP_CONFLICT',retryable:false});
  f.inspectionError=new Error('private database credentials in stderr');
  const unexpected=await f.h.call('status',request,'hermes');
  assert.equal(unexpected.operation.id,operation.id);assert.equal(unexpected.git,null);
  assert.deepEqual(unexpected.inspection_error,{code:'INTERNAL',message:'INTERNAL',retryable:false});
  assert.equal(JSON.stringify(unexpected).includes('private database credentials'),false);
  f.inspectionError=null;
  const recovered=await f.h.call('status',request,'hermes');assert.equal(recovered.git.head,sha);assert.equal('inspection_error' in recovered,false);
});
test('status rejects an operation paired with a different task workspace',async()=>{
  const f=fixture(),first=await f.h.call('prepare',prepare,'codex');
  const second=await f.h.call('prepare',{project_id:'p',workspace_key:'second-task',request_key:'prepare-second'},'hermes');
  await assert.rejects(f.h.call('status',{project_id:'p',operation_id:first.operation_id,workspace_id:second.workspace_id},'codex'),{code:'CONFLICT'});
  const correct=await f.h.call('status',{project_id:'p',operation_id:first.operation_id,workspace_id:first.workspace_id},'codex');
  assert.equal(correct.operation.id,first.operation_id);assert.equal(correct.workspace.id,first.workspace_id);
});
test('sync records an exact clean commit without creating a release or Git mutation',async()=>{
  const f=fixture(),accepted=await f.h.call('prepare',prepare,'codex');f.workspaces.get(accepted.workspace_id).preparation_state='ready';
  const args={...scoped,workspace_id:accepted.workspace_id};
  const synced=await f.h.call('sync',args,'hermes');
  assert.equal(f.operations.get(synced.operation_id).kind,'sync');assert.equal(f.releases.length,0);
  assert.deepEqual(await f.h.call('sync',args,'hermes'),synced);
  for(const current of [{head:'b'.repeat(40),dirty:false},{head:sha,dirty:true}]){
    f.current=current;await assert.rejects(f.h.call('sync',{...args,request_key:'changed-sync'},'codex'),{code:'CONFLICT'});
    await assert.rejects(f.h.call('release',{...args,request_key:'changed-release'},'codex'),{code:'CONFLICT'});
  }
});
test('release records one pinned route without process or writer admission',async()=>{
  const f=fixture(),accepted=await f.h.call('prepare',prepare,'codex'),w=f.workspaces.get(accepted.workspace_id);w.preparation_state='ready';
  w.legacy_writer={executor_id:'old',session_id:'retired',epoch:9,state:'active'};
  const args={...scoped,workspace_id:w.id},released=await f.h.call('release',args,'hermes');
  assert.deepEqual(await f.h.call('release',args,'hermes'),released);
  assert.equal(f.releases.length,1);assert.equal(f.releases[0].requested_sha,sha);assert.equal(f.releases[0].target,'dev');
  await assert.rejects(f.h.call('release',{...args,request_key:'second-release'},'codex'),{code:'CONFLICT'});
  await assert.rejects(f.h.call('sync',{...args,request_key:'sync-during-release'},'codex'),{code:'CONFLICT'});
});
for(const kind of ['feature','hotfix'])test(kind+' installation retry needs a new release key and preserves completed Git legs',async()=>{
  const f=fixture();f.evidence={commit_sha:sha};
  const prepared=await f.h.call('prepare',{...prepare,kind},'codex'),w=f.workspaces.get(prepared.workspace_id);w.preparation_state='ready';
  const args={...scoped,workspace_id:w.id},first=await f.h.call('release',args,'codex'),previous=f.releases[0];
  const failedId='1997203d-1266-4cf7-9668-d985b3eec801',childId='2997203d-1266-4cf7-9668-d985b3eec801';
  const leg={head:sha,target:'dev',merge_sha:'b'.repeat(40),merged:true,deployment_operation_id:failedId,merge_ci:{run_id:'123',head_sha:'b'.repeat(40)}};
  previous.state='failed';previous.details={primary:kind==='feature'?leg:{...leg,target:'main',deployment_operation_id:'3997203d-1266-4cf7-9668-d985b3eec801',deployment_evidence_id:id}};
  if(kind==='hotfix')previous.details.backport=leg;
  f.operations.get(first.operation_id).status='failed';f.failedDeployments.set(failedId,{operation_id:failedId});
  const snapshot=structuredClone(previous),name=kind==='feature'?'primary':'backport';
  assert.deepEqual(await f.h.call('release',args,'codex'),first);assert.equal(f.releases.length,1);assert.deepEqual(previous,snapshot);
  const retried=await f.h.call('release',{...args,request_key:'retry-installation'},'hermes'),next=f.releases[1];
  assert.notEqual(retried.operation_id,first.operation_id);assert.equal(next.details[name].deployment_retry_of,failedId);
  assert.equal(next.details[name].merge_sha,leg.merge_sha);assert.equal(next.details[name].merged,true);assert.deepEqual(next.details[name].merge_ci,leg.merge_ci);
  if(kind==='hotfix'){assert.equal('deployment_retry_of' in next.details.primary,false);assert.equal(next.details.primary.deployment_evidence_id,id);}
  assert.deepEqual(previous,snapshot);
  assert.deepEqual(await f.h.call('release',{...args,request_key:'retry-installation'},'hermes'),retried);assert.equal(f.releases.length,2);
  f.operations.get(retried.operation_id).status='failed';next.state='failed';next.details[name].deployment_operation_id=childId;f.failedDeployments.set(childId,{operation_id:childId});
  assert.deepEqual(await f.h.call('release',{...args,request_key:'retry-installation'},'hermes'),retried);assert.equal(f.releases.length,2);
  await f.h.call('release',{...args,request_key:'retry-installation-again'},'codex');
  assert.equal(f.releases[2].details[name].deployment_retry_of,childId);assert.equal(f.releases.length,3);
});
test('new release does not inherit stale merge details without the same commit and a confirmed failed installation',async()=>{
  for(const changedCommit of [false,true]){
    const f=fixture(),prepared=await f.h.call('prepare',prepare,'codex');f.workspaces.get(prepared.workspace_id).preparation_state='ready';
    const args={...scoped,workspace_id:prepared.workspace_id},first=await f.h.call('release',args,'codex');
    f.operations.get(first.operation_id).status='failed';f.releases[0].state='failed';f.releases[0].details={primary:{merge_sha:sha,deployment_operation_id:id}};
    const head=changedCommit?'b'.repeat(40):sha;f.current={head,dirty:false};
    if(changedCommit)f.failedDeployments.set(id,{operation_id:id});
    await f.h.call('release',{...args,commit_sha:head,request_key:'new-release'},'hermes');assert.deepEqual(f.releases[1].details,{});
  }
});
test('cleanup needs successful release and archived request keys cannot re-enter the lifecycle',async()=>{
  const f=fixture(),accepted=await f.h.call('prepare',prepare,'codex');
  const args={project_id:'p',workspace_id:accepted.workspace_id,request_key:'cleanup-task'};
  await assert.rejects(f.h.call('cleanup',args,'codex'),{code:'CONFLICT'});
  f.successful={state:'succeeded'};
  const cleaned=await f.h.call('cleanup',args,'hermes');assert.equal(f.operations.get(cleaned.operation_id).kind,'cleanup');
  f.requests.get('codex:'+prepare.request_key).archived=true;
  await assert.rejects(f.h.call('prepare',prepare,'codex'),{code:'CONFLICT'});
});
test('hotfix preparation requires exact installed production base',async()=>{
  const f=fixture(),args={...prepare,kind:'hotfix'};
  await assert.rejects(f.h.call('prepare',args,'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
  f.evidence={commit_sha:'b'.repeat(40)};
  await assert.rejects(f.h.call('prepare',args,'codex'),{code:'PRODUCTION_BASE_MISMATCH'});
  f.evidence={commit_sha:sha};
  const accepted=await f.h.call('prepare',args,'codex');assert.equal(accepted.branch,'hotfix/'+args.workspace_key);
  f.workspaces.get(accepted.workspace_id).preparation_state='ready';
  await f.h.call('release',{...scoped,workspace_id:accepted.workspace_id},'hermes');assert.equal(f.releases[0].target,'prod');
});
test('NATS v2 endpoint supplies identity and returns structured parse errors',async()=>{
  const endpoints=new Map(),service={addEndpoint:(_,options)=>endpoints.set(options.subject,options),stop:async()=>{}};
  const nc={services:{add:async config=>{assert.equal(config.name,'service_codeworks');assert.equal(config.version,'2.0.0');return service;}}};
  const calls=[];
  await runNats(nc,{call:async(method,args,executor)=>{calls.push({method,args,executor});return {operation_id:id,workspace_id:id};}},['codex']);
  const ep=endpoints.get('brai.codeworks.v2.codex.prepare');let result;
  await ep.handler(null,{data:Buffer.from('{"executor_id":"hermes"}'),respond:value=>result=JSON.parse(value)});
  assert.equal(calls[0].executor,'codex');assert.equal(calls[0].method,'prepare');assert.equal(result.operation_id,id);
  await ep.handler(null,{data:Buffer.from('{'),respondError:(status,code,data)=>{assert.equal(status,400);assert.equal(code,'INVALID_ARGUMENT');assert.equal(JSON.parse(data).code,code);}});
  assert.equal(endpoints.size,methods.length);
});
test('AsyncAPI request/reply includes exactly the seven v2 methods and owner schemas',async()=>{
  const {readFile}=await import('node:fs/promises');
  const doc=JSON.parse(await readFile(new URL('../asyncapi.json',import.meta.url),'utf8'));
  assert.equal(doc.asyncapi,'3.1.0');assert.equal(Object.keys(doc.operations).length,methods.length);
  for(const method of methods){
    const key=method.replaceAll(/[.-]/g,'_');
    assert.equal(doc.channels[key].address,'brai.codeworks.v2.{executor}.'+method);
    assert.equal(doc.components.messages[key+'Request'].payload.$ref,'./schemas/api.schema.json#/definitions/'+method);
    assert.equal(doc.components.messages[key+'Response'].payload.$ref,'./schemas/api.schema.json#/definitions/'+outputNames[method]);
    assert.equal(doc.operations[key].reply.messages.length,2);
  }
});
test('durable release response preserves exact trusted CI identity and rejects agent proof fields',()=>{
  const proof={run_id:'123',attempt:1,head_sha:sha,workflow:'.github/workflows/codeworks.yml',recipe:'b'.repeat(64),composition_digest:'sha256:'+'c'.repeat(64),composition_reference:'ghcr.io/owner/repo-components/release@sha256:'+'c'.repeat(64),url:'https://github.com/owner/repo/actions/runs/123'};
  const leg={branch:'feature/codeworks-'+id,head:sha,target:'dev',target_sha:'d'.repeat(40),head_ci:proof,merge_ci:{...proof,head_sha:'e'.repeat(40)}};
  validate('gitReleaseResult',{release_id:id,state:'awaiting_deployment',details:{primary:leg}});
  assert.throws(()=>validate('releaseLeg',{...leg,head_ci:{...proof,agent_verified:true}}));
  assert.throws(()=>validate('releaseLeg',{...leg,head_ci:{...proof,composition_digest:'mutable-tag'}}));
});

test('new task names become readable branches and identifiers cannot name new tasks',async()=>{
  const f=fixture();
  for(const workspace_key of ['7701f83f-2488-4334-b3ec-306156eddff3','task-7701f83f-2488-4334-b3ec-306156eddff3','a'.repeat(40),'a'.repeat(65),'Uppercase','task/path','task--name']){
    await assert.rejects(f.h.call('prepare',{...prepare,workspace_key,request_key:'bad-'+workspace_key},'codex'),{code:'INVALID_ARGUMENT'});
  }
  assert.equal(f.workspaces.size,0);
  const area=await f.h.call('prepare',{...prepare,workspace_key:'codeworks-auto-cleanup'},'codex');
  assert.equal(area.branch,'feature/codeworks-auto-cleanup');
});
test('existing task with a legacy identifier resumes its original branch',async()=>{
  const f=fixture(),area=await f.h.call('prepare',prepare,'codex'),w=f.workspaces.get(area.workspace_id);
  w.workspace_key=w.id;w.branch='feature/codeworks-'+w.id;
  const resumed=await f.h.call('prepare',{...prepare,workspace_key:w.id,request_key:'resume-legacy'},'codex');
  assert.equal(resumed.branch,w.branch);assert.equal(resumed.workspace_id,w.id);
  assert.equal(f.workspaces.size,1);assert.equal(f.operations.size,1);
});
