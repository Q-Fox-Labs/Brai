// ABOUTME: Проверяет выбор задач и независимый writer accounting на настоящей disposable PostgreSQL.
// ABOUTME: Синтетические API-вызовы дополняют отдельный штатный native hook цикл, рабочие чаты не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {configured,setup} from './fixture.mjs';
import {advanceCleanup} from '../../src/cleanup-coordinator.mjs';
import {createWriteAdmission} from '../../src/write-admission.mjs';

test('explicit new selection supersedes history, checks and late retries without losing writer protection',{skip:!configured},async()=>{
 const f=await setup();
 try{
  const p=await f.project({codeIndexDisabled:true}),session='selection-'+randomUUID(),requests=new Map();
  const begin=async(label,extra={})=>{
   const args=requests.get(label)??{project_id:p.id,session_id:session,turn_id:label,tool_use_id:label,tool_name:'Bash',payload_sha256:'a'.repeat(64),targets:['hello.txt'],request_key:randomUUID(),...extra};
   requests.set(label,args);return f.h.call('write.begin',args,'codex');
  };
  const previous=await begin('previous',{workspace_key:'previous-task'});
  const selected=await begin('new',{workspace_key:'creator-development'});
  assert.notEqual(previous.workspace_id,selected.workspace_id);assert.notEqual(previous.path,selected.path);assert.notEqual(previous.branch,selected.branch);
  assert.equal((await begin('continuation')).workspace_id,selected.workspace_id);
  await begin('foreign-check',{workspace_id:previous.workspace_id,select_workspace:false,targets:['.']});
  assert.equal((await begin('after-check')).workspace_id,selected.workspace_id);
  assert.equal((await begin('previous')).workspace_id,previous.workspace_id);
  assert.equal((await begin('after-old-retry')).workspace_id,selected.workspace_id);
  // Timestamp не задаёт порядок: старый begin мог начать транзакцию раньше ожидания session lock.
  await f.owner.query("UPDATE codeworks.write_calls SET created_at=now()+interval '1 day' WHERE project_id=$1 AND workspace_id=$2",[p.id,previous.workspace_id]);
  assert.equal((await begin('after-timestamp')).workspace_id,selected.workspace_id);
  const concurrent=await Promise.all([begin('parallel-one',{workspace_key:'parallel-one'}),begin('parallel-two',{workspace_key:'parallel-two'})]);
  const latest=(await f.app.query('SELECT workspace_id,selection_order FROM codeworks.write_calls WHERE project_id=$1 AND session_id=$2 AND select_workspace ORDER BY selection_order DESC LIMIT 1',[p.id,session])).rows[0];
  assert(concurrent.some(x=>x.workspace_id===latest.workspace_id));assert.equal((await begin('after-concurrent')).workspace_id,latest.workspace_id);
  // Настоящий guard учитывает check даже без права выбирать задачу.
  const prepared=(await f.app.query('SELECT operation_id FROM codeworks.write_calls WHERE id=$1',[previous.write_call_id])).rows[0];await f.worker(p,prepared.operation_id);
  const check=await begin('active-check',{workspace_id:previous.workspace_id,select_workspace:false,targets:['.']});
  await f.h.call('write.admit',{project_id:p.id,write_call_id:check.write_call_id,rewritten_sha256:'b'.repeat(64)},'codex');
  await f.h.call('write.stop',{project_id:p.id,session_id:session,turn_id:'active-check',event:'Stop'},'codex');
  assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[check.write_call_id])).rows[0].state,'uncertain');
  for(const turn_id of ['previous','foreign-check'])await f.h.call('write.stop',{project_id:p.id,session_id:session,turn_id,event:'Stop'},'codex');
  const obligation=(await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,source_operation_id,outcome,step,state,owner_workflow_id) VALUES($1,$2,$3,$4,$5,'cancelled','inspect','pending','selection-fixture') RETURNING *",[randomUUID(),p.id,previous.workspace_id,'selection:'+previous.workspace_id,prepared.operation_id])).rows[0];
  const workspace=(await f.owner.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[previous.workspace_id])).rows[0],db=await f.owner.connect();
  try{const cleanup=await advanceCleanup(db,obligation,p,workspace,{git:{inspectResources:()=>assert.fail('uncertain check allowed cleanup')}});assert.equal(cleanup.blocker,'WRITER_OUTCOME_UNKNOWN');assert.equal(cleanup.state,'waiting_decision');}finally{db.release();}
  assert.equal((await begin('after-uncertain-check')).workspace_id,latest.workspace_id);
  await assert.rejects(f.h.call('write.begin',{...requests.get('new'),select_workspace:false},'codex'),{code:'WRITE_CALL_MISMATCH'});
  await f.owner.query('UPDATE codeworks.write_calls SET selection_order=NULL WHERE id=$1',[previous.write_call_id]);
  assert.equal((await f.h.call('write.begin',{...requests.get('previous'),select_workspace:false},'codex')).workspace_id,previous.workspace_id);
  assert.equal((await begin('after-legacy-retry')).workspace_id,latest.workspace_id);
  const retired=await begin('retired',{workspace_key:'retired-selection'});
  await f.owner.query('UPDATE codeworks.workspaces SET removed_at=now() WHERE id=$1',[retired.workspace_id]);
  assert.notEqual((await begin('after-removal')).workspace_id,latest.workspace_id,'removal must not resurrect the former task');
  const failing=createWriteAdmission(f.app,{prepare:async()=>{throw Error('FIXTURE_PREPARE_FAILURE');},workspace:()=>assert.fail('unexpected existing workspace'),inspect:()=>assert.fail('unexpected inspection')});
  const denied={...requests.get('new'),workspace_key:'denied-selection',turn_id:'denied-selection',tool_use_id:'denied-selection',request_key:randomUUID()};
  await assert.rejects(failing.begin(denied,'codex'),/FIXTURE_PREPARE_FAILURE/);
  await f.h.call('write.stop',{project_id:p.id,session_id:session,turn_id:denied.turn_id,event:'Stop'},'codex');
  await assert.rejects(begin('after-denied'),{code:'CONFLICT'});
 }finally{await f.close();}
});
