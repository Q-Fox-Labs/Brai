// ABOUTME: Проверяет изменение маршрута до удаления под настоящим PostgreSQL execution guard.
// ABOUTME: После начала очистки новый маршрут запрещён, история прежнего решения сохраняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,configured} from './fixture.mjs';

test('route replacement is fenced, preserves history and stops after destruction begins',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const prepared=await f.prepare({project_id:project.id,workspace_key:'route-change',request_key:'prepare-route'});
  await f.worker(project,prepared.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
  const workflow='codeworks/fixture/'+project.id+'/workspace/'+w.id;
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[project.id]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[workflow,project.id,w.id]);
  const cancel={project_id:project.id,workspace_id:w.id,request_key:'cancel-route',reason:'fixture'};
  const first=await f.h.call('workspace.cancel',cancel,'codex');
  const transfer={project_id:project.id,workspace_id:w.id,request_key:'transfer-route',evidence:{destination:{repo_path:project.repo_path,commit_sha:w.base_sha},source_base:w.base_sha,source_head:w.base_sha,files:[{status:'M',source_path:'hello.txt',destination_path:'hello.txt',source_blob:w.base_sha,destination_blob:w.base_sha}]}};
  const held=await f.owner.connect();
  try{
    await held.query('BEGIN');await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['execution:workspace:'+w.id]);
    await assert.rejects(f.h.call('workspace.transfer',transfer,'codex'),{code:'BUSY'});
    await held.query('ROLLBACK');
  }finally{held.release();}
  const second=await f.h.call('workspace.transfer',transfer,'codex');
  const row=(await f.app.query('SELECT * FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[w.id])).rows[0];
  assert.equal(row.source_operation_id,second.operation_id);assert.equal(row.outcome,'transferred');assert.equal(Number(row.epoch),2);
  assert.deepEqual(row.evidence.route_history,[{operation_id:first.operation_id,outcome:'cancelled'}]);
  assert.equal((await f.app.query('SELECT state FROM codeworks.commands WHERE operation_id=$1',[first.operation_id])).rows[0].state,'done');
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending',step='remote' WHERE id=$1",[row.id]);
  await assert.rejects(f.h.call('workspace.cancel',{...cancel,request_key:'too-late'},'codex'),{code:'CLEANUP_ALREADY_STARTED'});
  const retained=(await f.app.query('SELECT outcome,source_operation_id,evidence FROM codeworks.cleanup_obligations WHERE id=$1',[row.id])).rows[0];
  assert.equal(retained.source_operation_id,second.operation_id);assert.deepEqual(retained.evidence.route_history,row.evidence.route_history);
});
