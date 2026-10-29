// ABOUTME: Проверяет настоящий вложенный native apply_patch Pre/Post с disposable PG и Temporal.
// ABOUTME: Требует отдельный pinned upstream test harness и не использует пользовательские журналы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,realpath,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {command} from '../../src/git.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {listNotices,canonicalHash} from '../../src/write-notice.mjs';

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

test('actual ordinary rewrite reaches required guard and Post with effective workspace cwd',{timeout:900000},async t=>{
 assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL and Temporal required');
 assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO_ROOT??''),'/tmp/codeworks-codex-v0164/codex-rs');assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO??''),'/tmp/codeworks-cargo/bin/rustup');
 const f=await setup();let connection,native,client,handle;
 t.after(async()=>{if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});await native?.close();await connection?.close();await f.close();});
 const project=await f.project({codeIndexDisabled:true}),prepared=await f.prepare({project_id:project.id,workspace_key:'native-cwd',request_key:'native-cwd'});await f.worker(project,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],spool=project.workspace_root+'/spool';await mkdir(spool,{mode:0o700});
 const configFile=project.workspace_root+'/native-bridge.json';await writeFile(configFile,JSON.stringify({project,spool}),{mode:0o600});
 const bridge=fileURLToPath(new URL('./native-completion-bridge.mjs',import.meta.url)),wrapper=project.workspace_root+'/bridge',quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(wrapper,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(bridge)+'\n',{mode:0o700});
 const result=await command(process.env.CODEWORKS_NATIVE_CARGO,['test','--locked','--offline','-j2','-p','codex-core','--test','all','ordinary_rewrite_precedes_required_guard_and_preserves_exec_workdir','--','--nocapture'],{cwd:process.env.CODEWORKS_NATIVE_CARGO_ROOT,allowFailure:true,timeout:780000,env:{CODEWORKS_NATIVE_BRIDGE:wrapper,CODEWORKS_NATIVE_WORKDIR:w.path,CODEWORKS_NATIVE_FIXTURE_CONFIG:configFile}});
 assert.equal(result.code,0,'pinned native cwd fixture failed: '+result.stderr.slice(-4000));
 const calls=(await f.app.query("SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash'",[project.id])).rows;assert.equal(calls.length,1);const call=calls[0];
 const input={command:'node --test missing-codeworks-fixture.mjs 2>&1',cwd:w.path,cwd_unavailable:false};
 assert.equal(call.original_input_sha256,canonicalHash(input));assert.equal(call.completion_input_sha256,canonicalHash(input));assert.equal(call.state,'in_flight');
 const receipt=(await f.app.query('SELECT state,notification FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0];
 assert.equal(receipt.state,'pending');assert.equal(receipt.notification.tool_use_id,call.tool_use_id);assert.equal(receipt.notification.session_id,call.session_id);assert.equal(receipt.notification.turn_id,call.turn_id);assert.equal(receipt.notification.canonical_input_sha256,canonicalHash(input));assert.equal(listNotices(spool,{projectId:project.id}).length,0);
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'native-cwd','temporal')",[project.id]);
 const id=`codeworks/native-cwd/${project.id}/reconciler`,taskQueue='native-cwd-'+randomUUID();
 connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),makeWorker=()=>Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[project.repo_path],completionSpoolDirectory:spool})});
 await (await makeWorker()).runUntil(async()=>{handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:id,taskQueue,args:[{projectId:project.id}]});await until(async()=>(await f.app.query('SELECT state FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0]?.state==='done');});
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[call.id])).rows[0].state,'finished');
 const blocked=await command(process.env.CODEWORKS_NATIVE_CARGO,['test','--locked','--offline','-j2','-p','codex-core','--test','all','ordinary_rewrite_precedes_required_guard_and_preserves_exec_workdir','--','--nocapture'],{cwd:process.env.CODEWORKS_NATIVE_CARGO_ROOT,allowFailure:true,timeout:780000,env:{CODEWORKS_NATIVE_BRIDGE:wrapper,CODEWORKS_NATIVE_WORKDIR:w.path,CODEWORKS_NATIVE_FIXTURE_CONFIG:configFile,CODEWORKS_NATIVE_GUARD_BLOCK:'1'}});
 assert.equal(blocked.code,0,'pinned native guard-denial fixture failed: '+blocked.stderr.slice(-4000));
 const fences=(await f.app.query('SELECT * FROM codeworks.write_call_fences WHERE project_id=$1',[project.id])).rows;assert.equal(fences.length,1);const fence=fences[0];
 const deniedInput={command:'node --test missing-codeworks-fixture.mjs &',cwd:w.path,cwd_unavailable:false};
 assert.equal(fence.tool_name,'Bash');assert.match(fence.tool_use_id,/^exec-/);assert.equal(fence.original_input_sha256,canonicalHash(deniedInput));
 await assert.rejects(f.h.call('write.begin',{project_id:project.id,workspace_id:w.id,workspace_key:w.workspace_key,kind:w.kind,session_id:fence.session_id,turn_id:fence.turn_id,tool_use_id:fence.tool_use_id,tool_name:'Bash',payload_sha256:'a'.repeat(64),original_input_sha256:canonicalHash(deniedInput),targets:['.'],request_key:'late-native-denied'},'codex'),{code:'CONFLICT'});
 assert.equal((await f.app.query("SELECT count(*)::int AS n FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash'",[project.id])).rows[0].n,1,'denied invocation never created writer');assert.equal(listNotices(spool,{projectId:project.id}).length,0);
 const activation=(await f.app.query('SELECT activation_state FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].activation_state,marker=project.workspace_root+'/guard-marker';
 const interrupted=await command(process.env.CODEWORKS_NATIVE_CARGO,['test','--locked','--offline','-j2','-p','codex-core','--test','all','required_guard_cancel_after_admit_reports_effective_not_started','--','--nocapture'],{cwd:process.env.CODEWORKS_NATIVE_CARGO_ROOT,allowFailure:true,timeout:780000,env:{CODEWORKS_NATIVE_BRIDGE:wrapper,CODEWORKS_NATIVE_WORKDIR:w.path,CODEWORKS_NATIVE_FIXTURE_CONFIG:configFile,CODEWORKS_NATIVE_GUARD_MARKER:marker}});
 assert.equal(interrupted.code,0,'pinned native interrupted guard fixture failed: '+interrupted.stderr.slice(-4000));
 const admitted=(await f.app.query("SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash' AND id<>$2",[project.id,call.id])).rows;assert.equal(admitted.length,1);const late=admitted[0];assert.equal(late.state,'in_flight');
 const interruptedReceipt=(await f.app.query('SELECT state,notification FROM codeworks.write_completions WHERE write_call_id=$1',[late.id])).rows[0];
 assert.equal(interruptedReceipt.state,'pending');assert.equal(interruptedReceipt.notification.execution_status,'not_started');assert.equal(interruptedReceipt.notification.outcome,'error');assert.equal(interruptedReceipt.notification.tool_use_id,late.tool_use_id);assert.equal(interruptedReceipt.notification.canonical_input_sha256,late.original_input_sha256);
 await (await makeWorker()).runUntil(async()=>{await until(async()=>(await f.app.query('SELECT state FROM codeworks.write_completions WHERE write_call_id=$1',[late.id])).rows[0]?.state==='done');});
 const ended=(await f.app.query('SELECT state,tool_result FROM codeworks.write_calls WHERE id=$1',[late.id])).rows[0];assert.equal(ended.state,'finished');assert.equal(ended.tool_result.changed,false);assert.equal(ended.tool_result.outcome,'error');
 await assert.rejects(f.h.call('write.admit',{project_id:project.id,write_call_id:late.id,rewritten_sha256:late.rewritten_sha256,completion_input_sha256:late.completion_input_sha256},'codex'),{code:'CONFLICT'});
 assert.equal((await f.app.query('SELECT activation_state FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].activation_state,activation);
});

test('actual deferred exit delivers End once without polling and denies missing observer',{timeout:900000},async t=>{
 assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL and Temporal required');
 assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO_ROOT??''),'/tmp/codeworks-codex-v0164/codex-rs');assert.equal(await realpath(process.env.CODEWORKS_NATIVE_CARGO??''),'/tmp/codeworks-cargo/bin/rustup');
 const f=await setup();let connection,native,client,handle;
 t.after(async()=>{if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});await native?.close();await connection?.close();await f.close();});
 const project=await f.project({codeIndexDisabled:true}),prepared=await f.prepare({project_id:project.id,workspace_key:'native-end',request_key:'native-end'});await f.worker(project,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],spool=project.workspace_root+'/spool';await mkdir(spool,{mode:0o700});
 const configFile=project.workspace_root+'/native-bridge.json';await writeFile(configFile,JSON.stringify({project,spool}),{mode:0o600});
 const bridge=fileURLToPath(new URL('./native-completion-bridge.mjs',import.meta.url)),wrapper=project.workspace_root+'/bridge',quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await writeFile(wrapper,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(bridge)+'\n',{mode:0o700});
 const marker=project.workspace_root+'/early-post';
 const invoke=async(filter,extra={})=>command(process.env.CODEWORKS_NATIVE_CARGO,['test','--locked','--offline','-j2','-p','codex-core','--test','all',filter,'--','--nocapture'],{cwd:process.env.CODEWORKS_NATIVE_CARGO_ROOT,allowFailure:true,timeout:780000,env:{CODEWORKS_NATIVE_BRIDGE:wrapper,CODEWORKS_NATIVE_WORKDIR:w.path,CODEWORKS_NATIVE_FIXTURE_CONFIG:configFile,...extra}});
 const result=await invoke('native_tool_execution_end_deferred_exit_without_poll',{CODEWORKS_NATIVE_POST_MARKER:marker});assert.equal(result.code,0,'native deferred End fixture failed: '+result.stderr.slice(-4000));await assert.rejects(access(marker),{code:'ENOENT'});
 const calls=(await f.app.query("SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash'",[project.id])).rows;assert.equal(calls.length,1);const call=calls[0];assert.equal(call.state,'in_flight');
 assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0].n,0,'End stays in the durable spool before reconciler');
 const notices=listNotices(spool,{projectId:project.id});assert.equal(notices.length,1);assert.equal(notices[0].notice.request.tool_use_id,call.tool_use_id);assert.equal(notices[0].notice.request.outcome,'error');assert.equal(notices[0].notice.request.execution_status,'completed');assert.equal(notices[0].notice.request.canonical_input_sha256,call.completion_input_sha256);
 const polled=await invoke('native_tool_execution_end_once_with_concurrent_poll',{CODEWORKS_NATIVE_POST_MARKER:marker});assert.equal(polled.code,0,'native concurrent poll fixture failed: '+polled.stderr.slice(-4000));await access(marker);
 const afterPoll=(await f.app.query("SELECT * FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash' AND id<>$2",[project.id,call.id])).rows;assert.equal(afterPoll.length,1);const polledCall=afterPoll[0];assert.equal(polledCall.state,'in_flight');
 const both=listNotices(spool,{projectId:project.id});assert.equal(both.length,2);assert.ok(both.some(entry=>entry.notice.request.tool_use_id===polledCall.tool_use_id&&entry.notice.request.outcome==='error'&&entry.notice.request.canonical_input_sha256===polledCall.completion_input_sha256));
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'native-end','temporal')",[project.id]);
 const id=`codeworks/native-end/${project.id}/reconciler`,taskQueue='native-end-'+randomUUID();connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),worker=await Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[project.repo_path],completionSpoolDirectory:spool})});
 await worker.runUntil(async()=>{handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:id,taskQueue,args:[{projectId:project.id}]});await until(async()=>(await f.app.query("SELECT count(*)::int AS n FROM codeworks.write_completions WHERE write_call_id=ANY($1::uuid[]) AND state='done'",[[call.id,polledCall.id]])).rows[0].n===2);});
 const finished=(await f.app.query('SELECT state,tool_result FROM codeworks.write_calls WHERE id=ANY($1::uuid[])',[[call.id,polledCall.id]])).rows;assert.equal(finished.length,2);assert.ok(finished.every(row=>row.state==='finished'&&row.tool_result.outcome==='error'));assert.equal(listNotices(spool,{projectId:project.id}).length,0);
 const denied=await invoke('native_tool_execution_end_missing_observer_denies');assert.equal(denied.code,0,'native missing observer fixture failed: '+denied.stderr.slice(-4000));
 assert.equal((await f.app.query("SELECT count(*)::int AS n FROM codeworks.write_calls WHERE project_id=$1 AND tool_name='Bash'",[project.id])).rows[0].n,2,'unavailable observer cannot admit writer');
 assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.write_call_fences WHERE project_id=$1',[project.id])).rows[0].n,1,'not-started Post fences late admission');
});
