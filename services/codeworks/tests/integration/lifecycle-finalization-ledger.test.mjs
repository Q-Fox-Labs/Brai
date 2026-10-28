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

test('reconciler adopts a completed root only after acquiring its execution guard',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const prepared=await f.prepare({project_id:project.id,workspace_key:'adoption-test',request_key:'adoption-test'});await f.worker(project,prepared.operation_id);
  const old='fixture/'+randomUUID(),owner='fixture-reconciler',id=randomUUID(),workspace=prepared.workspace_id;
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle) VALUES($1,$2,$3,'temporal','completed','cancelled')",[old,project.id,workspace]);
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch,state,step) VALUES($1,$2,$3,$4,'cancelled',$5,7,'retry','worktree')",[id,project.id,workspace,'workspace:'+workspace,old]);
  const held=await f.owner.connect();
  try{
    await held.query('BEGIN');await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['execution:workspace:'+workspace]);
    await reconcileProjectLedger(f.app,project.id,owner);
    const unchanged=(await f.app.query('SELECT owner_workflow_id,epoch FROM codeworks.cleanup_obligations WHERE id=$1',[id])).rows[0];
    assert.equal(unchanged.owner_workflow_id,old);assert.equal(Number(unchanged.epoch),7);
    await held.query('ROLLBACK');
  }finally{held.release();}
  await reconcileProjectLedger(f.app,project.id,owner);
  const adopted=(await f.app.query('SELECT owner_workflow_id,epoch,state,step FROM codeworks.cleanup_obligations WHERE id=$1',[id])).rows[0];
  assert.equal(adopted.owner_workflow_id,owner);assert.equal(Number(adopted.epoch),8);assert.equal(adopted.state,'retry');assert.equal(adopted.step,'worktree');
});

test('adoption cursor reaches later obligations when the first 32 guards are held',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());const project=await f.project(),items=[];
  for(let i=0;i<33;i++){
    const workspace=randomUUID(),id=randomUUID(),workflow='fixture/'+workspace,key='adopt-'+i;
    await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,preparation_state) VALUES($1,$2,$3,'feature','refs/heads/dev',$4,$5,$6,$7,'ready')",[workspace,project.id,key,'a'.repeat(40),'feature/'+key,project.workspace_root+'/'+workspace,randomUUID()]);
    await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle) VALUES($1,$2,$3,'temporal','completed','cancelled')",[workflow,project.id,workspace]);
    await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch,state) VALUES($1,$2,$3,$4,'cancelled',$5,7,'retry')",[id,project.id,workspace,'workspace:'+workspace,workflow]);
    items.push({id,workspace,workflow});
  }
  items.sort((a,b)=>a.id.localeCompare(b.id));const held=await f.owner.connect();
  try{
    await held.query('BEGIN');
    for(const item of items.slice(0,32))await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['execution:workspace:'+item.workspace]);
    const first=await reconcileProjectLedger(f.app,project.id,'fixture-reconciler',{cursor:null});
    assert.equal(first.hasMore,true);assert.equal(first.nextCursor,items[31].id);
    const next=await reconcileProjectLedger(f.app,project.id,'fixture-reconciler',{cursor:first.nextCursor});
    assert.equal(next.id,items[32].id);assert.equal(next.hasMore,false);
    const rows=(await f.app.query('SELECT id,owner_workflow_id,epoch FROM codeworks.cleanup_obligations WHERE project_id=$1 ORDER BY id',[project.id])).rows;
    assert.ok(rows.slice(0,32).every((row,i)=>row.owner_workflow_id===items[i].workflow&&Number(row.epoch)===7));
    assert.equal(rows[32].owner_workflow_id,'fixture-reconciler');assert.equal(Number(rows[32].epoch),8);
    await held.query('ROLLBACK');
  }finally{held.release();}
});
