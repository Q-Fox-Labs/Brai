// ABOUTME: Проверяет wakeup очистки при подтверждении последнего писателя на реальной PostgreSQL.
// ABOUTME: Детерминированно воспроизводит гонку наблюдения писателя с поздним завершением.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {createGit} from '../../src/git.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {advanceCleanup} from '../../src/cleanup-coordinator.mjs';
import {processProjectCompletions} from '../../src/completion-inbox.mjs';

async function fixture(f,key,count){
  const project=await f.project({codeIndexDisabled:true});
  const area=await f.prepare({project_id:project.id,workspace_key:key,request_key:'prepare-'+key});await f.worker(project,area.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[area.workspace_id])).rows[0],owner='fixture/'+randomUUID();
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[owner,project.id,w.id]);
  const calls=[];
  for(let i=0;i<count;i++){
    const request={project_id:project.id,workspace_id:w.id,workspace_key:key,session_id:'session-'+i,turn_id:'turn',tool_use_id:'tool',tool_name:'apply_patch',payload_sha256:'a'.repeat(64),targets:['hello.txt'],request_key:'write-'+i};
    const call=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:project.id,write_call_id:call.write_call_id,rewritten_sha256:'b'.repeat(64)},'codex');calls.push(request);
  }
  await f.owner.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing' WHERE workspace_id=$1",[w.id]);
  const obligation=(await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled',$5,7) RETURNING *",[randomUUID(),project.id,w.id,'workspace:'+w.id,owner])).rows[0];
  const finish=async request=>{await f.h.call('write.finish',{project_id:project.id,session_id:request.session_id,turn_id:request.turn_id,tool_use_id:request.tool_use_id,tool_name:'apply_patch',input_sha256:'b'.repeat(64),canonical_input_sha256:'b'.repeat(64),outcome:'success'},'codex');await processProjectCompletions(f.app,project.id,{allowedRepositories:[project.repo_path]});};
  const advance=async checkpoint=>{const db=await f.app.connect();try{return await advanceCleanup(db,obligation,project,w,{git:createGit(),codeIndex:createCodeIndex(f.app),checkpoint});}finally{db.release();}};
  return {project,w,owner,obligation,calls,finish,advance};
}

test('only last confirmed writer wakes its blocked cleanup; other blockers stay unchanged',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');const f=await setup();t.after(()=>f.close());
  const a=await fixture(f,'two-writers',2),blocked=await a.advance(async()=>{});
  assert.equal(blocked.blocker,'WRITER_OUTCOME_UNKNOWN');
  await a.finish(a.calls[0]);let row=(await f.app.query('SELECT state,blocker,epoch,owner_workflow_id FROM codeworks.cleanup_obligations WHERE id=$1',[a.obligation.id])).rows[0];
  assert.equal(row.state,'waiting_decision');assert.equal(row.blocker,'WRITER_OUTCOME_UNKNOWN');
  await a.finish(a.calls[1]);row=(await f.app.query('SELECT state,blocker,epoch,owner_workflow_id FROM codeworks.cleanup_obligations WHERE id=$1',[a.obligation.id])).rows[0];
  assert.equal(row.state,'pending');assert.equal(row.blocker,null);assert.equal(Number(row.epoch),7);assert.equal(row.owner_workflow_id,a.owner);
  const b=await fixture(f,'other-blocker',1);
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='waiting_decision',blocker='INDEX_UNAVAILABLE' WHERE id=$1",[b.obligation.id]);
  await b.finish(b.calls[0]);row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[b.obligation.id])).rows[0];
  assert.deepEqual(row,{state:'waiting_decision',blocker:'INDEX_UNAVAILABLE'});
});

test('writer finishing after observation does not leave a stale cleanup blocker',{timeout:120000},async t=>{
  assert.ok(configured,'explicit disposable PostgreSQL is required');const f=await setup();t.after(()=>f.close());
  const a=await fixture(f,'writer-race',1);let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const running=a.advance(async step=>{if(step==='writer-observed'){enter();await gate;}});running.catch(()=>{});
  try{
    await entered;await a.finish(a.calls[0]);release();const result=await running;
    assert.equal(result.state,'pending');assert.equal(result.blocker,null);
    const row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[a.obligation.id])).rows[0];
    assert.deepEqual(row,{state:'pending',blocker:null});
  }finally{release();await running.catch(()=>{});}
});
