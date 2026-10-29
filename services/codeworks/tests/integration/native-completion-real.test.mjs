// ABOUTME: Проверяет настоящий вложенный native apply_patch Pre/Post с disposable PG и Temporal.
// ABOUTME: Требует отдельный pinned upstream test harness и не использует пользовательские журналы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {command} from '../../src/git.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {listNotices} from '../../src/write-notice.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('NATIVE_COMPLETION_TIMEOUT');}

test('actual nested native failure delivers exact rewritten Post to PG and Temporal',{timeout:900000},async t=>{
 assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL and Temporal required');
 assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO_ROOT??''),'/tmp/codeworks-codex-v0164/codex-rs');
 assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO??''),'/tmp/codeworks-cargo/bin/rustup');
 const f=await setup();let connection,native,client,handle;
 t.after(async()=>{if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});await native?.close();await connection?.close();await f.close();});
 const project=await f.project({codeIndexDisabled:true}),spool=project.workspace_root+'/spool';await mkdir(spool,{mode:0o700});
 const configFile=project.workspace_root+'/native-bridge.json';await writeFile(configFile,JSON.stringify({project,spool}),{mode:0o600});
 const bridge=fileURLToPath(new URL('./native-completion-bridge.mjs',import.meta.url)),wrapper=project.workspace_root+'/bridge';
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(wrapper,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(bridge)+'\n',{mode:0o700});
 const result=await command(process.env.CODEWORKS_NATIVE_CARGO,['test','--locked','--offline','-j2','-p','codex-core','--test','all','nested_apply_patch_verification_failure_runs_exact_post_once','--','--nocapture'],{
  cwd:process.env.CODEWORKS_NATIVE_CARGO_ROOT,allowFailure:true,timeout:780000,
  env:{CODEWORKS_NATIVE_BRIDGE:wrapper,CODEWORKS_NATIVE_PATCH_PATH:project.repo_path+'/missing-file.txt',CODEWORKS_NATIVE_FIXTURE_CONFIG:configFile}
 });
 assert.equal(result.code,0,'pinned native fixture failed: '+result.stderr.slice(-4000));
 const calls=(await f.app.query("SELECT id,session_id,turn_id,tool_use_id,tool_name,state,rewritten_sha256,completion_input_sha256 FROM codeworks.write_calls WHERE project_id=$1",[project.id])).rows;
 assert.equal(calls.length,1);const call=calls[0];assert.match(call.tool_use_id,/^exec-/);assert.equal(call.tool_name,'apply_patch');assert.equal(call.state,'in_flight');
 const receipt=(await f.app.query('SELECT state,notification FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0];
 assert.equal(receipt.state,'pending');assert.equal(receipt.notification.outcome,'error');assert.equal(receipt.notification.tool_use_id,call.tool_use_id);assert.equal(receipt.notification.session_id,call.session_id);assert.equal(receipt.notification.turn_id,call.turn_id);assert.equal(receipt.notification.input_sha256,call.rewritten_sha256);assert.equal(receipt.notification.canonical_input_sha256,call.completion_input_sha256);assert.equal(listNotices(spool,{projectId:project.id}).length,0);
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'native-fixture','temporal')",[project.id]);
 const id=`codeworks/native-fixture/${project.id}/reconciler`,taskQueue='native-completion-'+randomUUID();
 connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
 const worker=await Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[project.repo_path],completionSpoolDirectory:spool})});
 await worker.runUntil(async()=>{handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:id,taskQueue,args:[{projectId:project.id}]});await until(async()=>(await f.app.query('SELECT state FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0]?.state==='done');});
 const completed=(await f.app.query('SELECT state,tool_result FROM codeworks.write_calls WHERE id=$1',[call.id])).rows[0];assert.equal(completed.state,'finished');assert.equal(completed.tool_result.outcome,'error');
});
