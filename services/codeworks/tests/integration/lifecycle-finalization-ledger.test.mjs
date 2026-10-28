// ABOUTME: Проверяет сроки и постраничное восстановление cleanup на реальной disposable PostgreSQL.
// ABOUTME: Тестовые записи не указывают на существующие Git и index ресурсы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {reconcileProjectLedger} from '../../src/reconciler.mjs';

test('unused cleanup honors five minute delay, immediate stop and scans more than 100 candidates',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const create=async(key,{age=false,stopped=false,uncertain=false}={})=>{
    const id=randomUUID(),workflow='fixture/'+id,call=randomUUID();
    await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,preparation_state,activation_state) VALUES($1,$2,$3,'feature','refs/heads/dev',$4,$5,$6,$7,'ready','awaiting_first_write')",[id,project.id,key,'a'.repeat(40),'feature/'+key,project.workspace_root+'/'+id,randomUUID()]);
    await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[workflow,project.id,id]);
    await f.owner.query("INSERT INTO codeworks.write_calls(id,project_id,workspace_id,executor_id,session_id,turn_id,tool_use_id,tool_name,workspace_key,kind,request_key,payload_sha256,targets,state,tool_result,updated_at) VALUES($1,$2,$3,'codex',$4,'turn','tool','apply_patch',$4,'feature',$4,$5,'[]',$6,$7::jsonb,now()-$8::interval)",[call,project.id,id,key,'a'.repeat(64),uncertain?'uncertain':'denied_pending',JSON.stringify(stopped?{stop_event:'Stop'}:{}),age?'6 minutes':'0 minutes']);
    return id;
  };
  const recent=await create('recent');
  const stopped=await create('stopped',{stopped:true});
  const uncertain=await create('uncertain',{age:true,uncertain:true});
  for(let i=0;i<105;i++)await create('old-'+i,{age:true});
  const scan=()=>reconcileProjectLedger(f.app,project.id,'fixture-reconciler');
  for(let i=0;i<5;i++)await scan();
  let rows=(await f.owner.query('SELECT workspace_id,outcome FROM codeworks.cleanup_obligations WHERE project_id=$1',[project.id])).rows;
  assert.equal(rows.length,106);assert.ok(rows.some(row=>row.workspace_id===stopped));
  assert.ok(!rows.some(row=>row.workspace_id===recent||row.workspace_id===uncertain));
  assert.ok(rows.every(row=>row.outcome==='unused'));
  await f.owner.query("UPDATE codeworks.write_calls SET updated_at=now()-interval '6 minutes' WHERE workspace_id=$1",[recent]);
  await scan();rows=(await f.owner.query('SELECT workspace_id FROM codeworks.cleanup_obligations WHERE project_id=$1',[project.id])).rows;
  assert.equal(rows.length,107);assert.ok(rows.some(row=>row.workspace_id===recent));
  assert.ok(!rows.some(row=>row.workspace_id===uncertain));
});
