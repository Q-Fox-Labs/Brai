// ABOUTME: Проверяет operator repair с настоящим ledger PostgreSQL и изолированными Temporal портами.
// ABOUTME: Business operation IDs сохраняются; чужой writer, tombstone и неполный proof запрещают новый run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runCleanupObligation} from '../../src/worker.mjs';
import {setup,configured} from './fixture.mjs';
import {repairWorkflow} from '../../src/workflow-repair.mjs';
import {authorizeCommand} from '../../src/lifecycle.mjs';
import {withExecutionContext} from '../../src/execution-context.mjs';

test('repair journals reset/restart once and fences old executor without duplicate business intent',{skip:!configured,timeout:120000},async t=>{
 const f=await setup();t.after(()=>f.close());
 async function fixture(key,status){
  const p=await f.project({codeIndexDisabled:true});
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'repair-fixture','temporal')",[p.id]);
  const area=await f.prepare({project_id:p.id,workspace_key:key,request_key:'prepare-'+key});
  const registry=(await f.app.query('SELECT * FROM codeworks.workflow_registry WHERE workspace_id=$1',[area.workspace_id])).rows[0];
  const request={workflow_id:registry.workflow_id,expected_generation:1,request_key:'repair-'+key};
  const effects=new Map();let attempts=0,lose=false;
  const ports={allowedRepositories:[p.repo_path],assertOwner:async()=>{},inspectExternal:async()=>({complete:true,checkpoint:'same-op'}),
    inspectTemporal:async()=>status==='NOT_FOUND'?{status,authenticNotFound:true}:{status,runId:'old-run',history:{events:[{eventId:'7',workflowTaskCompletedEventAttributes:{}}]}},
    replay:async()=>({verified:true}),historyDigest:()=> 'a'.repeat(64),
    start:async input=>{attempts++;if(!effects.has(input.requestId))effects.set(input.requestId,{runId:'new-run'});if(lose){lose=false;throw Error('LOST_RESPONSE');}return effects.get(input.requestId);},
    reset:async input=>{attempts++;assert.equal(input.runId,'old-run');assert.equal(input.eventId,'7');if(!effects.has(input.requestId))effects.set(input.requestId,{runId:'reset-run'});return effects.get(input.requestId);},
  };
  return {p,area,registry,request,ports,effects,attempts:()=>attempts,lose:()=>{lose=true;}};
 }
 await t.test('authentic NotFound restarts prior operation with next generation and resumes lost result',async()=>{
  const a=await fixture('missing','NOT_FOUND');a.lose();
  await assert.rejects(repairWorkflow(f.app,a.p.id,a.request,a.ports),/LOST_RESPONSE/);
  const result=await repairWorkflow(f.app,a.p.id,a.request,a.ports);
  assert.equal(result.generation,2);assert.equal(a.effects.size,1);
  const again=await repairWorkflow(f.app,a.p.id,a.request,a.ports);assert.equal(again.duplicate,true);assert.equal(a.attempts(),2);
  assert.equal((await f.app.query('SELECT count(*) FROM codeworks.operations WHERE workspace_id=$1',[a.area.workspace_id])).rows[0].count,'1');
  const c=(await f.app.query('SELECT * FROM codeworks.commands WHERE operation_id=$1',[a.area.operation_id])).rows[0];
  assert.equal(Number(c.generation),2);assert.equal(c.operation_id,a.area.operation_id);
  const db=await f.app.connect();try{
   await assert.rejects(withExecutionContext({workflowRunId:'old-run'},()=>authorizeCommand(db,a.area.operation_id,a.registry.workflow_id,1)),{code:'FORBIDDEN'});
   await assert.rejects(withExecutionContext({workflowRunId:'foreign'},()=>authorizeCommand(db,a.area.operation_id,a.registry.workflow_id,2)),{code:'FORBIDDEN'});
   await withExecutionContext({workflowRunId:'new-run'},()=>authorizeCommand(db,a.area.operation_id,a.registry.workflow_id,2));
  }finally{db.release();}
 });
 await t.test('retained failed execution resets after replay and keeps generation',async()=>{
  const a=await fixture('failed','FAILED'),r=await repairWorkflow(f.app,a.p.id,a.request,a.ports);
  assert.equal(r.generation,1);assert.equal(r.plan.action,'reset');assert.equal(a.effects.size,1);
  assert.equal((await repairWorkflow(f.app,a.p.id,a.request,a.ports)).duplicate,true);assert.equal(a.attempts(),1);
  const obligation=randomUUID();let external=0;
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id) VALUES($1,$2,$3,$4,'unused',$5)",[obligation,a.p.id,a.area.workspace_id,'workspace:'+a.area.workspace_id,a.registry.workflow_id]);
  await assert.rejects(withExecutionContext({workflowRunId:'old-run'},()=>runCleanupObligation(f.app,obligation,a.registry.workflow_id,{allowedRepositories:[a.p.repo_path],git:{inspectResources:async()=>{external++;return {};}}})),{code:'FORBIDDEN'});
  assert.equal(external,0,'old finalization Activity is refused after acquiring the execution guard');
 });
 await t.test('completed ledger, live foreign writer, invalid NotFound and incomplete external proof refuse effect',async()=>{
  for(const reason of ['completed','writer','notfound','external','running']){
   const a=await fixture(reason,reason==='running'?'RUNNING':'NOT_FOUND');
   if(reason==='completed')await f.owner.query("UPDATE codeworks.workflow_registry SET state='completed',completed_at=now() WHERE workflow_id=$1",[a.registry.workflow_id]);
   if(reason==='writer')await f.owner.query("UPDATE codeworks.write_calls SET state='uncertain',admitted_at=now(),rewritten_sha256=$2 WHERE workspace_id=$1",[a.area.workspace_id,'b'.repeat(64)]);
   if(reason==='notfound')a.ports.inspectTemporal=async()=>({status:'NOT_FOUND'});
   if(reason==='external')a.ports.inspectExternal=async()=>({complete:false});
   await assert.rejects(repairWorkflow(f.app,a.p.id,a.request,a.ports));assert.equal(a.effects.size,0);
  }
 });
});
