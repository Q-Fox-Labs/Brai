// ABOUTME: Проверяет ремонт очистки и защиту закреплённых refs через явные подставные порты.
// ABOUTME: Не подключается к PostgreSQL, Temporal и действующим областям Codeworks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {resumeCleanup,cleanupEvidenceDigest} from '../src/cleanup-resume.mjs';
import {canonical} from '../src/contracts.mjs';
import {withExecutionContext} from '../src/execution-context.mjs';
import {classifyCleanupArchiveError} from '../src/cleanup-archive.mjs';

const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function fixture({released=false}={}){
  const workspace={id:'00000000-0000-4000-8000-000000000001',project_id:'p',branch:'feature/task',path:'/fixture/workspaces/task',base_sha:'a'.repeat(40),kind:'feature',ownership_token:'owner'};
  const expected={branch:{ref:'refs/heads/feature/task',oid:'b'.repeat(40)},remote:{ref:'refs/heads/feature/task',oid:null,known:true},tracking:{ref:'refs/remotes/origin/feature/task',oid:null},ownership:{ref:'refs/codeworks/ownership/'+workspace.id,oid:'c'.repeat(40),matches:true},worktree:{path:workspace.path,pathExists:true,registered:true,head:'b'.repeat(40),dirty:false,owned:true,lock:'codeworks:owner'}};
  const archive={path:'/fixture/archive.bundle',sha256:'d'.repeat(64)};
  const base={manifestVersion:1,reviewed:true,project_id:'p',common_dir:'/fixture/git',workspace_id:workspace.id,protected_task_ids:[],branch:expected.branch,remote:expected.remote,tracking:expected.tracking,ownership:expected.ownership,worktree:expected.worktree,disposition:{type:'archived',archive}};
  const manifest={...base,manifest_sha256:hash(base)};
  let item={id:'00000000-0000-4000-8000-000000000002',project_id:'p',workspace_id:workspace.id,subject_key:'workspace:'+workspace.id,epoch:4,owner_workflow_id:'codeworks/fixture/p/reconciler',outcome:released?'released':'cancelled',state:'waiting_decision',step:'worktree',expected:structuredClone(expected),evidence:released?{}:{manifest,archive,archive_authorized:true},blocker:released?'OWNERSHIP_CONFLICT':'ARCHIVE_UNVERIFIED'};
  const registry={workflow_id:'codeworks/fixture/p/workspace/'+workspace.id,project_id:'p',owner:'temporal',state:'draining',lifecycle:'closing'};
  const project={id:'p',repo_path:'/fixture',common_dir:'/fixture/git'},operations=new Map(),requests=new Map(),queries=[];
  let inspections=0,proofs=0,cleanupWrites=0,busy=false;
  const current=structuredClone(expected),db=new EventEmitter();
  db.release=()=>{};
  db.query=async(sql,args=[])=>{
    queries.push(sql);
    if(sql.startsWith('SELECT config'))return {rows:[{config:project}]};
    if(sql.startsWith('SELECT r.payload_sha256')){const r=requests.get(args[2]);return {rows:r?[{...operations.get(r.id),payload_sha256:r.digest}]:[]};}
    if(sql.startsWith('INSERT INTO codeworks.operations')){operations.set(args[0],{id:args[0],kind:'repair',status:'running',request:JSON.parse(args[3])});return {rowCount:1};}
    if(sql.startsWith('INSERT INTO codeworks.requests')){requests.set(args[2],{digest:args[3],id:args[4]});return {rowCount:1};}
    if(sql.startsWith('UPDATE codeworks.operations SET status=$2')){Object.assign(operations.get(args[0]),{status:args[1],result:JSON.parse(args[3])});return {rowCount:1};}
    if(sql.startsWith("UPDATE codeworks.operations SET status='running'")){operations.get(args[0]).status='running';return {rowCount:1};}
    if(sql.startsWith('SELECT pg_try_advisory_xact_lock'))return {rows:[{acquired:!busy}]};
    if(sql.startsWith('SELECT * FROM codeworks.workspaces'))return {rows:[workspace]};
    if(sql.startsWith('SELECT * FROM codeworks.workflow_registry'))return {rows:[registry]};
    if(sql.startsWith('SELECT * FROM codeworks.execution_control'))return {rows:[{owner:'temporal',instance_id:'fixture',mutations_paused:false}]};
    if(sql.startsWith('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[structuredClone(item)]};
    if(sql.startsWith('SELECT 1 FROM codeworks.write_calls'))return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT * FROM codeworks.releases'))return {rows:[{requested_sha:expected.branch.oid,details:{primary:{merged:true,target:'dev',merge_sha:'e'.repeat(40),deployment_evidence_id:'proof'}}}]};
    if(sql.startsWith('SELECT 1 FROM codeworks.deployment_evidence'))return {rowCount:1};
    if(sql.startsWith('UPDATE codeworks.cleanup_obligations')){cleanupWrites++;if(item.epoch!==args[1]||item.owner_workflow_id!==args[2])return {rows:[]};item={...item,state:'pending',epoch:item.epoch+1,blocker:null};return {rows:[structuredClone(item)]};}
    if(['BEGIN','COMMIT','ROLLBACK','SAVEPOINT cleanup_resume_validation','ROLLBACK TO SAVEPOINT cleanup_resume_validation'].includes(sql)||sql.startsWith('SELECT pg_advisory_xact_lock')||sql.startsWith('SET LOCAL'))return {rows:[]};
    throw Error('Unexpected query: '+sql);
  };
  const ports={allowedRepositories:['/fixture'],git:{inspectResources:async()=>{inspections++;return structuredClone(current);},cleanupStep:async()=>assert.fail('resume deleted Git resources')},codeIndex:{inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}}),remove:async()=>assert.fail('resume removed index')},verifyArchive:async()=>{proofs++;}};
  return {pool:{connect:async()=>db},ports,workspace,registry,current,operations,queries,item:()=>item,changeItem:fields=>Object.assign(item,fields),setBusy:value=>{busy=value;},inspections:()=>inspections,proofs:()=>proofs,cleanupWrites:()=>cleanupWrites,request:()=>({obligation_id:item.id,expected_epoch:item.epoch,evidence_sha256:cleanupEvidenceDigest(item),request_key:'repair-key'})};
}

test('resume сохраняет refs, manifest и шаг, меняет только допуск и durable repair result',async()=>{
  const f=fixture(),before=structuredClone(f.item()),request=f.request();
  const result=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(result.status,'succeeded');assert.equal(result.resumed,true);assert.equal(result.epoch,5);
  assert.deepEqual(f.item().expected,before.expected);assert.deepEqual(f.item().evidence,before.evidence);assert.equal(f.item().step,before.step);
  assert.equal(f.proofs(),1);assert.equal(f.cleanupWrites(),1);
  const locks=f.queries.filter(sql=>sql.includes('FOR UPDATE')&&!sql.includes('FOR UPDATE OF o'));
  assert.match(locks[0],/workspaces/);assert.match(locks[1],/workflow_registry/);assert.match(locks[2],/cleanup_obligations/);
  const operation=f.operations.get(result.operation_id);assert.equal(operation.kind,'repair');assert.equal(operation.status,'succeeded');
  // Потерянный ответ после commit не требует новой проверки или новой эпохи.
  f.ports.verifyArchive=async()=>assert.fail('terminal duplicate rechecked proof');
  f.changeItem({epoch:9});
  const duplicate=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.deepEqual(duplicate,{...result,duplicate:true});assert.equal(f.cleanupWrites(),1);
});

test('однократная EIO продолжает тот же request key и repair ID без удаления',async()=>{
  const f=fixture(),request=f.request();let once=true;
  f.ports.verifyArchive=async()=>{if(once){once=false;throw Object.assign(Error('read failed'),{code:'EIO'});}};
  const failed=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(failed.status,'awaiting_reconciliation');assert.equal(failed.blocker,'TECHNICAL_RETRY');assert.equal(f.item().epoch,4);assert.equal(f.cleanupWrites(),0);
  const fixed=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(fixed.status,'succeeded');assert.equal(fixed.operation_id,failed.operation_id);assert.equal(fixed.duplicate,false);assert.equal(f.item().epoch,5);assert.equal(f.operations.size,1);
});

test('недоказанный архив остаётся terminal отказом и не повышает epoch',async()=>{
  const f=fixture(),request=f.request();f.ports.verifyArchive=async()=>{throw Error('ARCHIVE_UNVERIFIED');};
  const result=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(result.status,'failed');assert.equal(result.blocker,'ARCHIVE_UNVERIFIED');assert.equal(result.resumed,false);assert.equal(f.item().state,'waiting_decision');assert.equal(f.cleanupWrites(),0);
  f.ports.verifyArchive=async()=>assert.fail('terminal failed duplicate rechecked');
  assert.equal((await resumeCleanup(f.pool,'p',request,f.ports)).duplicate,true);
});

test('подмена epoch, refs, владельца, identity и старого evidence отклоняется',async()=>{
  for(const mutate of [
    (f,r)=>{r.expected_epoch++;},
    f=>{f.current.branch.oid='f'.repeat(40);},
    f=>{f.changeItem({owner_workflow_id:'another-owner'});},
    f=>{f.workspace.ownership_token='changed';f.current.ownership.matches=false;},
    f=>{f.registry.lifecycle='active';},
    f=>{f.workspace.path='/other';},
    f=>{f.item().expected.branch.oid='f'.repeat(40);},
    f=>{f.item().evidence.manifest.disposition.archive.sha256='f'.repeat(64);}
  ]){
    const f=fixture(),request=f.request();mutate(f,request);
    const result=await resumeCleanup(f.pool,'p',request,f.ports);
    assert.equal(result.status,'failed');assert.equal(result.resumed,false);assert.equal(f.cleanupWrites(),0);assert.equal(f.item().epoch,4);
  }
});

test('same-key payload conflict не создаёт вторую операцию',async()=>{
  const f=fixture(),request=f.request();await resumeCleanup(f.pool,'p',request,f.ports);
  await assert.rejects(resumeCleanup(f.pool,'p',{...request,expected_epoch:5},f.ports),/REQUEST_KEY_CONFLICT/);assert.equal(f.operations.size,1);
});

test('занятый execution guard откладывает тот же ремонт до освобождения',async()=>{
  const f=fixture(),request=f.request();f.setBusy(true);
  const blocked=await resumeCleanup(f.pool,'p',request,f.ports);assert.equal(blocked.status,'awaiting_reconciliation');assert.equal(f.inspections(),0);
  f.setBusy(false);const result=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(result.operation_id,blocked.operation_id);assert.equal(result.resumed,true);
});

test('released cleanup без archive manifest восстанавливается только по прежнему release proof',async()=>{
  const f=fixture({released:true}),request=f.request();
  const result=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(result.resumed,true);assert.equal(f.proofs(),0);assert.equal(f.item().outcome,'released');assert.deepEqual(f.item().evidence,{});
});

test('отмена Activity не сохраняется как отказ доказательства и не обновляет obligation',async()=>{
  const f=fixture(),controller=new AbortController(),reason=Error('cancelled'),request=f.request();
  f.ports.verifyArchive=async()=>{controller.abort(reason);throw reason;};
  await assert.rejects(withExecutionContext({signal:controller.signal},()=>resumeCleanup(f.pool,'p',request,f.ports)),error=>error===reason);
  assert.equal(f.cleanupWrites(),0);
});

test('классификация отделяет invalid proof, инфраструктуру и отмену',()=>{
  assert.equal(classifyCleanupArchiveError(Error('ARCHIVE_UNVERIFIED')),'decision');
  for(const code of ['EIO','EMFILE','ENOSPC','ETIMEDOUT','GIT_FAILED'])assert.equal(classifyCleanupArchiveError(Object.assign(Error('backend'),{code})),'retry');
  for(const message of ['CLEANUP_FENCE_LOST','BRANCH_LIVE_TASK','unexpected bug'])assert.equal(classifyCleanupArchiveError(Error(message)),'propagate');
  assert.equal(classifyCleanupArchiveError(new DOMException('cancelled','AbortError')),'propagate');
});

test('чужой индекс блокирует repair, неполный backend повторяет прежний intent',async()=>{
  const f=fixture({released:true}),request=f.request();
  f.ports.codeIndex.inspect=async()=>({complete:false});
  const unavailable=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(unavailable.status,'awaiting_reconciliation');assert.equal(f.cleanupWrites(),0);
  f.ports.codeIndex.inspect=async()=>({complete:true,owner:{present:true,tokenMatches:false,pathMatches:true},resources:{collections:['foreign'],metadataPoints:[]}});
  const foreign=await resumeCleanup(f.pool,'p',request,f.ports);
  assert.equal(foreign.operation_id,unavailable.operation_id);assert.equal(foreign.status,'failed');assert.equal(foreign.blocker,'INDEX_OWNERSHIP_CONFLICT');assert.equal(f.cleanupWrites(),0);
});

test('retained проверяет прежнюю голову и точный remote DEV при повторе',async()=>{
  for(const valid of [true,false]){
    const f=fixture(),expected=f.item().expected,target='e'.repeat(40);
    f.changeItem({outcome:'released',evidence:{verified_disposition:{type:'retained',target:'dev',target_sha:target,refs:{branch:expected.branch.oid,remote:expected.remote.oid,worktree:expected.worktree.head}}}});
    f.ports.flowGit={remote:async()=>valid?target:'f'.repeat(40),ancestor:async()=>true};
    const result=await resumeCleanup(f.pool,'p',f.request(),f.ports);
    assert.equal(result.resumed,valid);assert.equal(f.cleanupWrites(),valid?1:0);assert.equal(f.proofs(),0);
  }
});
