// ABOUTME: Проверяет durable привязку нескольких native записей к одной сессии в PostgreSQL и Git.
// ABOUTME: Воспроизводит потерю ответа до и после prepare без использования рабочих областей.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,configured} from './fixture.mjs';
import {createWriteAdmission} from '../../src/write-admission.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createGit} from '../../src/git.mjs';
import {createStore} from '../../src/storage.mjs';
import {createHandlers} from '../../src/domain.mjs';

const input=(p,session,tool,target)=>({project_id:p.id,session_id:session,turn_id:'turn',tool_use_id:tool,tool_name:'apply_patch',payload_sha256:(tool==='first'?'a':'b').repeat(64),targets:[target],request_key:session+'-'+tool});
test('concurrent keyless writes share one area, retry identity and reject ambiguous or closing areas',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project();
  const first=input(p,'same-session','first','src/one.js'),second=input(p,'same-session','second','src/two.js');
  const [a,b]=await Promise.all([f.h.call('write.begin',first,'codex'),f.h.call('write.begin',second,'codex')]);
  assert.equal(a.workspace_id,b.workspace_id);assert.equal(a.workspace_key,b.workspace_key);assert.deepEqual(await f.h.call('write.begin',first,'codex'),a);
  assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workspaces WHERE project_id=$1',[p.id])).rows[0].n,1);
  const other=await f.h.call('write.begin',{...input(p,'other-session','first','other.js'),workspace_key:'other-area'},'codex');
  await f.h.call('write.begin',{...input(p,'same-session','third','third.js'),workspace_id:other.workspace_id},'codex');
  await assert.rejects(f.h.call('write.begin',input(p,'same-session','fourth','four.js'),'codex'),{code:'CONFLICT'});
  const closing=await f.h.call('write.begin',input(p,'closing-session','first','closing.js'),'codex');
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle) VALUES($1,$2,$3,'temporal','draining','closing')",['fixture/closing',p.id,closing.workspace_id]);
  await assert.rejects(f.h.call('write.begin',input(p,'closing-session','second','later.js'),'codex'),{code:'CONFLICT'});
});

test('lost prepare attachment is recovered and removed area is never reused',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project();
  const original=input(p,'lost-attachment','first','src/old.js'),old=await f.h.call('write.begin',original,'codex');
  await f.worker(p,old.operation_id);
  await f.owner.query('UPDATE codeworks.write_calls SET workspace_id=NULL,operation_id=NULL WHERE id=$1',[old.write_call_id]);
  const workspace=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[old.workspace_id])).rows[0],adapters=createActivityGit();
  const snapshot=await adapters.git.inspectResources(p,workspace);
  for(const step of ['remote','worktree','local_refs'])await adapters.git.cleanupStep(p,workspace,snapshot,step);
  await f.owner.query('UPDATE codeworks.workspaces SET removed_at=now() WHERE id=$1',[old.workspace_id]);
  const next=await f.h.call('write.begin',input(p,'lost-attachment','second','src/new.js'),'codex');
  assert.notEqual(next.workspace_id,old.workspace_id);assert.notEqual(next.workspace_key,old.workspace_key);
  const attached=(await f.app.query('SELECT workspace_id,operation_id FROM codeworks.write_calls WHERE id=$1',[old.write_call_id])).rows[0];
  assert.equal(attached.workspace_id,old.workspace_id);assert.equal(attached.operation_id,old.operation_id);
  await assert.rejects(f.h.call('write.begin',original,'codex'),{code:'CONFLICT'});
});

test('stale unbound call without prepare is retired and does not reserve its key',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project();
  const old=input(p,'lost-before-prepare','first','src/old.js');
  const api=createWriteAdmission(f.app,{prepare:async()=>{throw Error('FIXTURE_LOST_BEFORE_PREPARE');},workspace:async()=>null,inspect:async()=>null});
  await assert.rejects(api.begin(old,'codex'),/FIXTURE_LOST_BEFORE_PREPARE/);
  await f.owner.query("UPDATE codeworks.write_calls SET created_at=now()-interval '3 minutes' WHERE project_id=$1 AND session_id=$2",[p.id,old.session_id]);
  const next=await f.h.call('write.begin',input(p,old.session_id,'second','src/new.js'),'codex');
  const row=(await f.app.query('SELECT state,workspace_key FROM codeworks.write_calls WHERE project_id=$1 AND session_id=$2 AND tool_use_id=$3',[p.id,old.session_id,old.tool_use_id])).rows[0];
  assert.equal(row.state,'denied_pending');assert.notEqual(row.workspace_key,next.workspace_key);
  await assert.rejects(f.h.call('write.begin',old,'codex'),{code:'CONFLICT'});
});

test('stale marker wins against delayed private prepare without admitting the old call',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const p=await f.project(),git=createGit();
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const slow=createHandlers(createStore(f.app),{...git,readBase:async(...args)=>{enter();await gate;return git.readBase(...args);}},{allowedRepositories:[p.repo_path]});
  const old=input(p,'stale-race','first','src/old.js');
  const waiting=slow.call('write.begin',old,'codex');waiting.catch(()=>{});
  try{
    await entered;
    await f.owner.query("UPDATE codeworks.write_calls SET created_at=now()-interval '3 minutes' WHERE project_id=$1 AND session_id=$2",[p.id,old.session_id]);
    const fresh=await f.h.call('write.begin',input(p,old.session_id,'second','src/new.js'),'codex');
    release();await assert.rejects(waiting,{code:'WORKSPACE_WRITE_REQUIRED'});
    assert.ok(fresh.workspace_id);
    assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.requests WHERE project_id=$1 AND idempotency_key=$2',[p.id,old.request_key])).rows[0].n,0);
    const row=(await f.app.query('SELECT state,workspace_id FROM codeworks.write_calls WHERE project_id=$1 AND session_id=$2 AND tool_use_id=$3',[p.id,old.session_id,old.tool_use_id])).rows[0];
    assert.equal(row.state,'denied_pending');assert.equal(row.workspace_id,null);
  }finally{release();await waiting.catch(()=>{});}
});
