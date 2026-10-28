// ABOUTME: Проверяет durable допуск и фактическую первую запись на настоящих PostgreSQL и Git.
// ABOUTME: Использует только отдельную тестовую БД и случайные идентификаторы ресурсов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setup,configured} from './fixture.mjs';
import {createWriteAdmission} from '../../src/write-admission.mjs';
import {createGit} from '../../src/git.mjs';
import {createCodeIndex,indexIdentity} from '../../src/code-index.mjs';
import {advanceCleanup} from '../../src/cleanup-coordinator.mjs';
import {randomUUID} from 'node:crypto';

test('durable write admission waits for actual write and retains an uncertain missing PostToolUse', {skip:!configured||!process.env.CODEWORKS_INDEX_QDRANT,timeout:120000},async t=>{
  const f=await setup();t.after(()=>f.close());
  const project=await f.project();
  const base={project_id:project.id,workspace_key:'admission-test',session_id:'fixture-session',turn_id:'turn-one',tool_use_id:'tool-one',tool_name:'apply_patch',payload_sha256:'a'.repeat(64),targets:['hello.txt'],request_key:'write-one'};
  const call=await f.h.call('write.begin',base,'codex');
  await f.worker(project,call.operation_id);
  const getWorkspace=async()=>({project,workspace:(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[call.workspace_id])).rows[0]});
  const git=createGit();
  const api=createWriteAdmission(f.app,{prepare:async()=>{throw Error('UNEXPECTED_PREPARE');},workspace:getWorkspace,inspect:(p,w)=>git.inspect(p,w)});
  assert.equal((await api.begin(base,'codex')).write_call_id,call.write_call_id);
  await assert.rejects(api.begin({...base,payload_sha256:'b'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
  const w=(await getWorkspace()).workspace;
  assert.equal(w.activation_state,'awaiting_first_write');
  let invoked=false;
  const index=createCodeIndex(f.app,{invoke:async()=>{invoked=true;throw Error('INDEX_BEFORE_WRITE');}});
  await index.maintain(project,w);assert.equal(invoked,false);
  const response=await fetch(process.env.CODEWORKS_INDEX_QDRANT+'/collections');assert.equal(response.ok,true);
  const collections=(await response.json()).result.collections;
  assert.equal(collections.some(item=>item.name.includes(indexIdentity(w.path))),false);
  await api.admit({project_id:project.id,write_call_id:call.write_call_id,rewritten_sha256:'c'.repeat(64)},'codex');
  const stopped=await api.stop({project_id:project.id,session_id:base.session_id,turn_id:base.turn_id,event:'Stop'},'codex');
  assert.equal(stopped.uncertain,1);
  assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[call.write_call_id])).rows[0].state,'uncertain');
  assert.equal((await getWorkspace()).workspace.activation_state,'awaiting_first_write');
  const workflow='fixture/'+randomUUID(),id=randomUUID();
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,lifecycle) VALUES($1,$2,$3,'temporal','closing')",[workflow,project.id,w.id]);
  const obligation=(await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled',$5,1) RETURNING *",[id,project.id,w.id,'workspace:'+w.id,workflow])).rows[0];
  const db=await f.app.connect();
  try{
    const blocked=await advanceCleanup(db,obligation,project,w,{git,codeIndex:index});
    assert.equal(blocked.state,'waiting_decision');assert.equal(blocked.blocker,'WRITER_OUTCOME_UNKNOWN');
    assert.equal((await git.inspect(project,w)).head,w.base_sha);
  }finally{db.release();}
  await writeFile(w.path+'/hello.txt','actual write\n');
  const done=await api.finish({...base,outcome:'error'},'codex');
  assert.equal(done.changed,true);
  assert.deepEqual(await api.finish({...base,outcome:'error'},'codex'),done);
  assert.equal((await getWorkspace()).workspace.activation_state,'active');
});
