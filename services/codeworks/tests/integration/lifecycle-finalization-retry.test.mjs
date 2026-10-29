// ABOUTME: Проверяет durable backoff и восстановление команды после нескольких технических раундов.
// ABOUTME: Использует реальную тестовую PostgreSQL и сохраняет исходные identity и запрос.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {createActivities} from '../../src/temporal.mjs';

test('four exhausted retry rounds keep one command and resume automatically',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const prepared=await f.prepare({project_id:project.id,workspace_key:'retry-rounds',request_key:'prepare-retry-rounds'});
  await f.worker(project,prepared.operation_id);
  const workspace=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
  const workflow='fixture/'+randomUUID(),operation=randomUUID();
  const request={project_id:project.id,workspace_id:workspace.id,request_key:'sync-retry',commit_sha:workspace.base_sha};
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[workflow,project.id,workspace.id]);
  await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','sync','running','execute',$4)",[operation,project.id,workspace.id,request]);
  await f.owner.query("INSERT INTO codeworks.commands(operation_id,workflow_id,sequence,generation,kind,admitted_request,requested_sha) VALUES($1,$2,1,1,'sync',$3,$4)",[operation,workflow,request,workspace.base_sha]);
  const activities=createActivities(f.app,{allowedRepositories:[project.repo_path],identity:()=>workflow,adapters:{git:{}},codeIndex:{},execute:async()=>{await f.app.query("UPDATE codeworks.operations SET status='succeeded',step='done' WHERE id=$1",[operation]);}});
  for(let round=1;round<=4;round++){
    await activities.requireReconciliation(operation,1);
    const row=(await f.app.query('SELECT * FROM codeworks.commands WHERE operation_id=$1',[operation])).rows[0];
    assert.equal(row.state,'pending');assert.equal(row.technical_attempts,round);assert.ok(new Date(row.retry_at)>new Date());
    assert.equal(row.workflow_id,workflow);assert.equal(row.requested_sha,workspace.base_sha);assert.deepEqual(row.admitted_request,request);
    assert.equal((await activities.loadCommands(1)).commands.length,0);
    await f.owner.query("UPDATE codeworks.commands SET retry_at=now()-interval '1 second' WHERE operation_id=$1",[operation]);
    assert.equal((await activities.loadCommands(1)).commands[0].operation_id,operation);
  }
  await activities.synchronizeBranch(operation,1);
  const final=(await f.app.query('SELECT state,technical_attempts FROM codeworks.commands WHERE operation_id=$1',[operation])).rows[0];
  assert.equal(final.state,'done');assert.equal(final.technical_attempts,0);
  assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[operation])).rows[0].status,'succeeded');
});
