// ABOUTME: Проверяет native start, replay/reset и Continue-As-New repair на настоящих Temporal и PostgreSQL.
// ABOUTME: Использует только собственный UUID task queue и roots; общие службы не останавливает.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {runOperation} from '../../src/worker.mjs';
import {createNativeRepairPorts,repairWorkflow} from '../../src/workflow-repair.mjs';
import {authorizeCommand} from '../../src/lifecycle.mjs';
import {withExecutionContext} from '../../src/execution-context.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(work,signal){const deadline=Date.now()+90000;for(;;){signal.throwIfAborted();if(await work())return;assert.ok(Date.now()<deadline,'native repair fixture timeout');await pause(100);}}
test('native missing root and retained terminal history repair preserve operation identity and fence across CAN',{skip:!configured||process.env.CODEWORKS_TEMPORAL_TEST!=='1',timeout:240000},async t=>{
 const f=await setup();let worker,run,workflowId,ports,connection,native,client;
 t.after(async()=>{
  if(workflowId&&client)await client.workflow.getHandle(workflowId).terminate('isolated native repair fixture cleanup').catch(()=>{});
  if(worker?.getState()==='RUNNING')worker.shutdown();
  await run?.catch(()=>{});await ports?.close();await native?.close();await connection?.close();await f.close();
 });
 const p=await f.project({codeIndexDisabled:true});
 const address=process.env.CODEWORKS_TEMPORAL_ADDRESS??'127.0.0.1:7233',namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE??'brai',taskQueue='codeworks-repair-'+randomUUID(),bundlePath=fileURLToPath(new URL('../../dist/workflows.js',import.meta.url));
 connection=await Connection.connect({address,connectTimeout:'5 seconds'});native=await NativeConnection.connect({address});client=new Client({connection,namespace});
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'repair-native','temporal')",[p.id]);
 const area=await f.prepare({project_id:p.id,workspace_key:'native-repair',request_key:'prepare-native-repair'});
 workflowId=(await f.app.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1',[area.workspace_id])).rows[0].workflow_id;
 const executions=new Map();
 const activities=createActivities(f.app,{allowedRepositories:[p.repo_path],adapters:createActivityGit(),execute:async(...args)=>{executions.set(args[1],(executions.get(args[1])??0)+1);return runOperation(...args);}});
 worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:{codePath:bundlePath},activities,maxConcurrentActivityTaskExecutions:2,shutdownGraceTime:'1 second',shutdownForceTime:'5 seconds'});
 run=worker.run();run.catch(()=>{});
 ports=await createNativeRepairPorts({address,namespace,taskQueue,bundlePath,allowedRepositories:[p.repo_path],continueAfter:2});
 // AIDEV-NOTE: Test fixture substitutes only local owner admission, all Temporal and ledger ports remain native.
 ports.assertOwner=async()=>{};
 const initial={workflow_id:workflowId,expected_generation:1,request_key:'missing-root'};
 const first=await repairWorkflow(f.app,p.id,initial,ports);assert.equal(first.generation,2);assert.equal(first.plan.action,'restart');
 assert.equal((await repairWorkflow(f.app,p.id,initial,ports)).duplicate,true);
 await until(async()=>((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[area.operation_id])).rows[0]?.status)==='succeeded',t.signal);
 assert.equal((await f.app.query('SELECT count(*) FROM codeworks.operations WHERE workspace_id=$1',[area.workspace_id])).rows[0].count,'1');
 await until(async()=>{
  const d=await client.workflow.getHandle(workflowId).describe(),r=(await f.app.query('SELECT execution_run_id FROM codeworks.workflow_registry WHERE workflow_id=$1',[workflowId])).rows[0];
  return d.runId!==first.run_id&&r.execution_run_id===d.runId;
 },t.signal);
 const before=await client.workflow.getHandle(workflowId).describe();
 await client.workflow.getHandle(workflowId).terminate('isolated retained history repair');
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[area.workspace_id])).rows[0];
 const sync=await f.h.call('sync',{project_id:p.id,workspace_id:w.id,commit_sha:w.base_sha,request_key:'sync-same-business-id'},'codex');
 const reset=await repairWorkflow(f.app,p.id,{workflow_id:workflowId,expected_generation:2,request_key:'terminal-reset'},ports);
 assert.equal(reset.plan.action,'reset');assert.equal(reset.generation,2);assert.notEqual(reset.run_id,before.runId);
 await until(async()=>['succeeded','failed'].includes((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[sync.operation_id])).rows[0]?.status),t.signal);
 assert.equal(executions.get(sync.operation_id),1,'reset resumes the admitted command once');
 assert.equal((await f.app.query('SELECT count(*) FROM codeworks.operations WHERE workspace_id=$1',[w.id])).rows[0].count,'2');
 const db=await f.app.connect();try{
  await assert.rejects(withExecutionContext({workflowRunId:before.runId},()=>authorizeCommand(db,sync.operation_id,workflowId,2)),{code:'FORBIDDEN'});
  await assert.rejects(withExecutionContext({workflowRunId:first.run_id},()=>authorizeCommand(db,sync.operation_id,workflowId,1)),{code:'FORBIDDEN'});
 }finally{db.release();}
 await until(async()=>{const d=await client.workflow.getHandle(workflowId).describe(),r=(await f.app.query('SELECT execution_run_id FROM codeworks.workflow_registry WHERE workflow_id=$1',[workflowId])).rows[0];return d.runId!==reset.run_id&&r.execution_run_id===d.runId;},t.signal);
});
