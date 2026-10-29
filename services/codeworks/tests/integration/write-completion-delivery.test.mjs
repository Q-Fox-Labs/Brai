// ABOUTME: Проверяет durable native Post через реальные PostgreSQL и Temporal с остановками и повтором.
// ABOUTME: Использует только disposable область, локальный spool и синтетическое тестовое событие.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {createGit,command} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {processProjectCompletions} from '../../src/completion-inbox.mjs';
import {rawHash,canonicalHash,listNotices} from '../../src/write-notice.mjs';
import {runHook} from '../../src/hook.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(100);}throw Error('COMPLETION_DELIVERY_TIMEOUT');}

test('durable Post survives inspect outage and lost ack, then Temporal retries without another user turn',{timeout:240000},async t=>{
 assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'disposable PostgreSQL and Temporal required');
 const f=await setup();let connection,native,client,handle;t.after(async()=>{if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});await native?.close();await connection?.close();await f.close();});
 const p=await f.project({codeIndexDisabled:true}),prepared=await f.prepare({project_id:p.id,workspace_key:'delivery',request_key:'prepare-delivery'});await f.worker(p,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],root='fixture/'+randomUUID();
 await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[root,p.id,w.id]);
 const spool=p.workspace_root+'/completion-spool';await mkdir(spool,{mode:0o700});
 const create=async(tool,input,turn='turn',original=input)=>{
  const request={project_id:p.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:'delivery-session',turn_id:turn,tool_use_id:tool,tool_name:'apply_patch',payload_sha256:rawHash({tool_name:'apply_patch',tool_input:original,cwd:p.repo_path,project_id:p.id,workspace_id:w.id}),targets:['hello.txt'],request_key:'request-'+tool};
  const call=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:call.write_call_id,rewritten_sha256:rawHash(input),completion_input_sha256:canonicalHash(input)},'codex');
  const finish={project_id:p.id,session_id:request.session_id,turn_id:request.turn_id,tool_use_id:tool,tool_name:'apply_patch',input_sha256:rawHash(input),canonical_input_sha256:canonicalHash(input),outcome:'error'};
  return {request,id:call.write_call_id,input,finish};
 };
 const a=await create('inspect-failure',{command:'*** Begin Patch\n*** Update File: '+w.path+'/hello.txt\n@@\n-missing\n+replacement\n*** End Patch'});
 const b=await create('nested-post',{command:'*** Begin Patch\n*** Update File: '+w.path+'/hello.txt\n@@\n-not-present\n+replacement\n*** End Patch'},'turn',{command:'*** Begin Patch\n*** Update File: '+p.repo_path+'/hello.txt\n@@\n-not-present\n+replacement\n*** End Patch'});
 const active=await create('still-active',{command:'*** Begin Patch\n*** Update File: '+w.path+'/hello.txt\n@@\n-another\n+value\n*** End Patch'},'active-turn');
 await f.owner.query("UPDATE codeworks.workflow_registry SET state='completed',lifecycle='closing' WHERE workflow_id=$1",[root]);
 const obligation=randomUUID();await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,state,blocker,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled','waiting_decision','WRITER_OUTCOME_UNKNOWN',$5,1)",[obligation,p.id,w.id,'workspace:'+w.id,root]);
 await f.h.call('write.stop',{project_id:p.id,session_id:a.request.session_id,turn_id:a.request.turn_id,event:'Stop'},'codex');
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[active.id])).rows[0].state,'in_flight','Stop cannot alter another active turn');
 let inspected=0;const actual=createGit(),faulty={...actual,inspect:async()=>{inspected++;throw Error('fixture transient Git failure');}};
 const handler=createHandlers(createStore(f.app),faulty,{allowedRepositories:[p.repo_path]});
 const received=await handler.call('write.finish',a.finish,'codex');assert.equal(received.state,'pending');assert.equal(inspected,0,'receive commits before Git inspect');
 assert.equal((await handler.call('write.finish',a.finish,'codex')).state,'pending');
 await assert.rejects(handler.call('write.finish',{...a.finish,input_sha256:'f'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
 await assert.rejects(handler.call('write.finish',{...a.finish,canonical_input_sha256:'f'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
 await assert.rejects(handler.call('write.finish',{...a.finish,tool_name:'Bash'},'codex'),{code:'WRITE_CALL_MISMATCH'});
 await processProjectCompletions(f.app,p.id,{allowedRepositories:[p.repo_path],git:faulty});
 let receipt=(await f.app.query('SELECT state,attempts,error FROM codeworks.write_completions WHERE write_call_id=$1',[a.id])).rows[0];assert.equal(receipt.state,'pending');assert.equal(Number(receipt.attempts),1);assert.equal(receipt.error,'TECHNICAL_RETRY');assert.equal(inspected,1);
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[a.id])).rows[0].state,'uncertain');
 const post={hook_event_name:'PostToolUse',tool_name:'apply_patch',tool_input:b.input,cwd:w.path,session_id:b.request.session_id,turn_id:b.request.turn_id,tool_use_id:b.request.tool_use_id,tool_response:{isError:true,terminal:true,error:'apply_patch verification failed'}};
 const hook=await runHook(post,{config:{projects:[p],completion_spool:spool},env:{CODEWORKS_EXECUTOR_ID:'codex'},connect:async()=>{throw Error('NATS_UNAVAILABLE');}});
 assert.match(hook.systemMessage,/POST_DELIVERY_PENDING/);assert.equal(listNotices(spool,{projectId:p.id}).length,1);
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'completion-fixture','temporal')",[p.id]);
 const inboxURL=new URL('../../src/completion-inbox.mjs',import.meta.url),sourceURL=new URL('../../src/git.mjs',import.meta.url);
 const childCode=`import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import {processProjectCompletions} from ${JSON.stringify(inboxURL.href)};const {Pool}=createRequire(${JSON.stringify(sourceURL.href)})('pg');const c=JSON.parse(await readFile(process.env.CODEWORKS_TEST_CONFIG_FILE,'utf8'));const pool=new Pool({connectionString:c.app_url});await processProjectCompletions(pool,process.argv[1],{allowedRepositories:[process.argv[2]],spoolDirectory:process.argv[3],ack:()=>process.exit(86)});process.exit(87);`;
 const crashed=await command(process.execPath,['--input-type=module','-e',childCode,p.id,p.repo_path,spool],{allowFailure:true,timeout:15000});assert.equal(crashed.code,86,'process exited after inbox commit before ack');
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_completions WHERE write_call_id=$1',[b.id])).rows[0].state,'pending');assert.equal(listNotices(spool,{projectId:p.id}).length,1);
 await f.owner.query("UPDATE codeworks.write_completions SET next_attempt_at=now()-interval '1 second' WHERE write_call_id=$1",[a.id]);
 const id=`codeworks/completion-fixture/${p.id}/reconciler`,queue='completion-delivery-'+randomUUID();
 connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),adapters=createActivityGit(),index=createCodeIndex(f.app);
 const makeWorker=()=>Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue:queue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[p.repo_path],adapters,codeIndex:index,completionSpoolDirectory:spool})});
 await (await makeWorker()).runUntil(async()=>{
  handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:id,taskQueue:queue,args:[{projectId:p.id}]});
  await until(async()=>(await f.app.query("SELECT count(*)::int AS n FROM codeworks.write_completions WHERE write_call_id=ANY($1::uuid[]) AND state='done'",[[a.id,b.id]])).rows[0].n===2);
 });
 assert.equal((await f.h.call('write.finish',a.finish,'codex')).state,'finished','exact replay is idempotent after processing');
 assert.equal(listNotices(spool,{projectId:p.id}).length,0);assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[active.id])).rows[0].state,'in_flight');
 assert.deepEqual((await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation])).rows[0],{state:'waiting_decision',blocker:'WRITER_OUTCOME_UNKNOWN'});
 assert.equal((await f.h.call('write.finish',active.finish,'codex')).state,'pending');
 await (await makeWorker()).runUntil(async()=>{
  await until(async()=>(await f.app.query('SELECT state FROM codeworks.write_completions WHERE write_call_id=$1',[active.id])).rows[0]?.state==='done');
  await until(async()=>(await f.app.query('SELECT state FROM codeworks.cleanup_obligations WHERE id=$1',[obligation])).rows[0]?.state==='done');
  const history=await handle.fetchHistory();assert.ok(history.events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='reconcileProject'));
 });
});
