// ABOUTME: Проверяет отмену и повтор очистки через реальный Temporal, PostgreSQL, Git и отдельный Qdrant.
// ABOUTME: Собственная очередь и созданные workflow не затрагивают рабочие процессы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error('FINALIZATION_TIMEOUT');}

test('cancelled workspace cleanup retries a lost index response and replays history',{skip:!configured||!process.env.CODEWORKS_INDEX_QDRANT||!process.env.CODEWORKS_TEMPORAL_ADDRESS||!process.env.CODEWORKS_TEMPORAL_NAMESPACE,timeout:240000},async t=>{
  const f=await setup();let connection,native,client;const ids=new Set();
  t.after(async()=>{for(const id of ids)await client.workflow.getHandle(id).terminate('isolated fixture cleanup').catch(()=>{});await native?.close();await connection?.close();await f.close();});
  const project=await f.project();
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'finalization-fixture','temporal')",[project.id]);
  const settings=project.workspace_root+'/index-runtime.json',configFile=project.workspace_root+'/index-config.json';
  await writeFile(settings,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'}}));
  await writeFile(configFile,JSON.stringify({engine:'/opt/socraticode/node_modules/socraticode/dist/index.js',socraticodeConfig:settings,sources:{}}));
  const index=createCodeIndex(f.app,{configFile});let lostResponse=false;
  const faultIndex={...index,remove:async(...args)=>{await index.remove(...args);if(!lostResponse){lostResponse=true;throw Error('FIXTURE_LOST_INDEX_RESPONSE');}}};
  const address=process.env.CODEWORKS_TEMPORAL_ADDRESS,namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue='codeworks-finalization-'+randomUUID();
  connection=await Connection.connect({address,connectTimeout:'5 seconds'});client=new Client({connection,namespace});
  native=await NativeConnection.connect({address});
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
  const worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[project.repo_path],codeIndex:faultIndex}),maxConcurrentActivityTaskExecutions:4});
  await worker.runUntil(async()=>{
    const write={project_id:project.id,workspace_key:'cancel-finalization',request_key:'cancel-finalization',session_id:'fixture-session',turn_id:'fixture-turn',tool_use_id:'fixture-tool',tool_name:'apply_patch',payload_sha256:'a'.repeat(64),targets:['hello.txt']};
    const prepared=await f.h.call('write.begin',write,'codex');
    const workflow=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[prepared.operation_id])).rows[0].workflow_id;ids.add(workflow);
    await deliverCommands(f.app,client,{taskQueue});
    const status=async id=>(await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[id])).rows[0]?.status;
    await until(async()=>await status(prepared.operation_id)==='succeeded');
    await f.h.call('write.stop',{project_id:project.id,session_id:write.session_id,turn_id:write.turn_id,event:'Stop'},'codex');
    const cancel=await f.h.call('workspace.cancel',{project_id:project.id,workspace_id:prepared.workspace_id,request_key:'cancel-finalization-request',reason:'fixture cancellation'},'codex');
    await deliverCommands(f.app,client,{taskQueue});
    await until(async()=>await status(cancel.operation_id)==='succeeded');
    await until(async()=>(await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0]?.removed_at);
    assert.equal(lostResponse,true);
    const obligation=(await f.app.query('SELECT * FROM codeworks.cleanup_obligations WHERE workspace_id=$1',[prepared.workspace_id])).rows[0];
    assert.equal(obligation.state,'done');assert.equal(obligation.outcome,'cancelled');
    assert.equal((await f.app.query('SELECT lifecycle FROM codeworks.workflow_registry WHERE workflow_id=$1',[workflow])).rows[0].lifecycle,'removed');
    const history=await client.workflow.getHandle(workflow).fetchHistory();
    assert.ok(history.events.some(event=>event.activityTaskScheduledEventAttributes?.activityType?.name==='advanceCleanupObligation'));
    await Worker.runReplayHistory({workflowBundle:bundle},history,workflow);
  });
});
