// ABOUTME: Проверяет durable native Post через реальные PostgreSQL и Temporal с остановками и повтором.
// ABOUTME: Использует только disposable область, локальный spool и синтетическое тестовое событие.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,chmod,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
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
import {reconcileProjectLedger} from '../../src/reconciler.mjs';
import {rawHash,canonicalHash,listNotices} from '../../src/write-notice.mjs';
import {runHook} from '../../src/hook.mjs';
import {importNativeCompletion,validateCompletionReceipt} from '../../src/write-completion.mjs';
import {executorProof} from '../../src/executor-completion.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('late generic Bash Post after a synthetic terminal API proof leaves no pending delivery',{timeout:120000},async t=>{
 assert.ok(configured,'explicit disposable PostgreSQL required');const f=await setup();t.after(()=>f.close());const p=await f.project({codeIndexDisabled:true});
 const prepared=await f.prepare({project_id:p.id,workspace_key:'late-bash',request_key:'late-prepare'});await f.worker(p,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],input={command:'git add -A'};
 const request={project_id:p.id,workspace_id:w.id,session_id:'late-session',turn_id:'late-turn',tool_use_id:'late-tool',tool_name:'Bash',payload_sha256:rawHash(input),targets:['.'],request_key:'late-write'};
 const result=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:result.write_call_id,rewritten_sha256:rawHash(input),completion_input_sha256:canonicalHash(input)},'codex');
 const call=(await f.app.query('SELECT * FROM codeworks.write_calls WHERE id=$1',[result.write_call_id])).rows[0];
 const proof=executorProof(call,{turnId:request.turn_id,item:{id:request.tool_use_id,type:'commandExecution',status:'failed',exitCode:1}});
 await importNativeCompletion(f.app,null,{allowedRepositories:[p.repo_path],verifyReceipt:async()=>proof});
 const notice={project_id:p.id,session_id:request.session_id,turn_id:request.turn_id,tool_use_id:request.tool_use_id,tool_name:'Bash',input_sha256:rawHash(input),canonical_input_sha256:canonicalHash(input),outcome:'success'};
 assert.equal((await f.h.call('write.finish',notice,'codex')).state,'finished');
 assert.equal((await f.app.query('SELECT tool_result FROM codeworks.write_calls WHERE id=$1',[call.id])).rows[0].tool_result.outcome,'error');
 assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.write_completions WHERE write_call_id=$1',[call.id])).rows[0].n,0);
 await assert.rejects(f.h.call('write.finish',{...notice,canonical_input_sha256:'f'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
});
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
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),baseAdapters=createActivityGit(),index=createCodeIndex(f.app);let slowPasses=0;
 const adapters={...baseAdapters,git:{...baseAdapters.git,inspect:async(...args)=>{if(!slowPasses++){await sleep(11000);}return baseAdapters.git.inspect(...args);}}};
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
  const history=await handle.fetchHistory();assert.ok(history.events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='reconcileProject'));assert.ok(slowPasses>0,'real inspect exceeded heartbeat timeout');assert.ok(!history.events.some(e=>e.activityTaskTimedOutEventAttributes),'slow completion reconciliation remains heartbeating');
 });
});

test('not-started fences late begin and completes only the exact failed invocation',{timeout:120000},async t=>{
 assert.ok(configured,'explicit disposable PostgreSQL required');const f=await setup();t.after(()=>f.close());const p=await f.project({codeIndexDisabled:true});
 const original={command:'*** Begin Patch\n*** Update File: hello.txt\n@@\n-missing\n+value\n*** End Patch'},rewritten={command:original.command.replace('hello.txt','other/hello.txt')};
 const req=tool=>({project_id:p.id,workspace_key:'not-started',session_id:'s-'+tool,turn_id:'turn',tool_use_id:tool,tool_name:'apply_patch',payload_sha256:'a'.repeat(64),original_input_sha256:canonicalHash(original),targets:['hello.txt'],request_key:'request-'+tool});
 const post=r=>({project_id:p.id,session_id:r.session_id,turn_id:r.turn_id,tool_use_id:r.tool_use_id,tool_name:r.tool_name,input_sha256:rawHash(original),canonical_input_sha256:canonicalHash(original),execution_status:'not_started',outcome:'error'});
 const absent=req('post-first'),notice=post(absent);
 await assert.rejects(f.h.call('write.finish',{...notice,execution_status:'completed'},'codex'),{code:'NOT_FOUND'});
 const fenced=await f.h.call('write.finish',notice,'codex');assert.equal(fenced.state,'not_started');assert.equal(fenced.write_call_id,null);assert.match(fenced.receipt_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(await f.h.call('write.finish',notice,'codex'),fenced);
 await assert.rejects(f.h.call('write.finish',{...notice,canonical_input_sha256:'f'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
 await assert.rejects(f.h.call('write.begin',absent,'codex'),{code:'CONFLICT'});
 assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.workspaces WHERE project_id=$1',[p.id])).rows[0].n,0,'late begin creates no area');
 const initial=await f.prepare({project_id:p.id,workspace_key:'not-started',request_key:'prepared'});await f.worker(p,initial.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[initial.workspace_id])).rows[0],activation=w.activation_state;let inspected=0;
 const git={...createGit(),inspect:async()=>{inspected++;throw Error('unexpected inspection');}},opts={allowedRepositories:[p.repo_path],git};
 for(const phase of ['preparing','denied_pending','in_flight']){
  const r={...req(phase),workspace_id:w.id};const call=await f.h.call('write.begin',r,'codex');
  if(phase==='denied_pending')await f.h.call('write.stop',{project_id:p.id,session_id:r.session_id,turn_id:r.turn_id,event:'Stop'},'codex');
  if(phase==='in_flight'){
   await f.h.call('write.admit',{project_id:p.id,write_call_id:call.write_call_id,rewritten_sha256:rawHash(rewritten),completion_input_sha256:canonicalHash(rewritten)},'codex');
   await assert.rejects(f.h.call('write.finish',{...post(r),execution_status:'completed'},'codex'),{code:'WRITE_CALL_MISMATCH'});
  }
  assert.equal((await f.h.call('write.finish',post(r),'codex')).state,'pending');
  if(phase==='preparing'){
   const [processed,admit]=await Promise.allSettled([processProjectCompletions(f.app,p.id,opts),f.h.call('write.admit',{project_id:p.id,write_call_id:call.write_call_id,rewritten_sha256:rawHash(rewritten),completion_input_sha256:canonicalHash(rewritten)},'codex')]);
   assert.equal(processed.status,'fulfilled');if(admit.status==='rejected')assert.equal(admit.reason.code,'CONFLICT');else assert.equal(admit.value.state,'in_flight');
  }else await processProjectCompletions(f.app,p.id,opts);
  const row=(await f.app.query('SELECT state,tool_result FROM codeworks.write_calls WHERE id=$1',[call.write_call_id])).rows[0];assert.equal(row.state,'finished');assert.equal(row.tool_result.changed,false);assert.equal(row.tool_result.outcome,'error');
  await assert.rejects(f.h.call('write.admit',{project_id:p.id,write_call_id:call.write_call_id,rewritten_sha256:rawHash(rewritten),completion_input_sha256:canonicalHash(rewritten)},'codex'),{code:'CONFLICT'});
 }
 assert.equal(inspected,0,'not-started does not inspect Git');assert.equal((await f.app.query('SELECT activation_state FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].activation_state,activation);
 // Prepare committed while its caller lost the association: ledger reconciliation binds it before completion processing.
 const lost=req('lost-association'),callId=randomUUID(),operation=randomUUID();
 await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','prepare','failed','fixture',$4)",[operation,p.id,w.id,{workspace_key:'not-started',kind:'feature'}]);
 await f.owner.query("INSERT INTO codeworks.requests(project_id,executor_id,idempotency_key,payload_sha256,operation_id) VALUES($1,'codex',$2,$3,$4)",[p.id,lost.request_key,'a'.repeat(64),operation]);
 await f.owner.query("INSERT INTO codeworks.write_calls(id,project_id,executor_id,session_id,turn_id,tool_use_id,tool_name,payload_sha256,original_input_sha256,targets,workspace_key,kind,request_key,state) VALUES($1,$2,'codex',$3,$4,$5,'apply_patch',$6,$7,'[\"hello.txt\"]','not-started','feature',$8,'preparing')",[callId,p.id,lost.session_id,lost.turn_id,lost.tool_use_id,'a'.repeat(64),lost.original_input_sha256,lost.request_key]);
 assert.equal((await f.h.call('write.finish',post(lost),'codex')).state,'pending');await reconcileProjectLedger(f.app,p.id,'fixture-reconciler');
 const bound=(await f.app.query('SELECT workspace_id,operation_id FROM codeworks.write_calls WHERE id=$1',[callId])).rows[0];assert.equal(bound.workspace_id,w.id);assert.equal(bound.operation_id,operation);
 await processProjectCompletions(f.app,p.id,opts);assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[callId])).rows[0].state,'finished');assert.equal(inspected,0);
});

test('synthetic owner-reviewed receipt v2 uses the guarded PG importer without finishing another writer',{timeout:120000},async t=>{
 assert.ok(configured,'explicit disposable PostgreSQL required');const f=await setup();t.after(()=>f.close());
 const p=await f.project({codeIndexDisabled:true}),prepared=await f.prepare({project_id:p.id,workspace_key:'operator-v2',request_key:'operator-v2'});await f.worker(p,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],owner='fixture/'+randomUUID();
 await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[owner,p.id,w.id]);
 const create=async(tool)=>{
  const r={project_id:p.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:'review-session',turn_id:'turn',tool_use_id:tool,tool_name:'apply_patch',payload_sha256:rawHash('payload-'+tool),targets:['hello.txt'],request_key:'review-'+tool};
  const call=await f.h.call('write.begin',r,'codex');const rewritten=rawHash('updated-'+tool);await f.h.call('write.admit',{project_id:p.id,write_call_id:call.write_call_id,rewritten_sha256:rewritten},'codex');return {...r,id:call.write_call_id,rewritten};
 };
 const reviewed=await create('reviewed'),other=await create('still-running'),startup=await create('startup-failure');
 await f.owner.query("UPDATE codeworks.write_calls SET tool_name='Bash' WHERE id=$1",[startup.id]);
 await writeFile(w.path+'/hello.txt','partial fixture change\n');
 await f.owner.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing' WHERE workspace_id=$1",[w.id]);
 const obligation=randomUUID();await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,state,blocker,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled','waiting_decision','WRITER_OUTCOME_UNKNOWN',$5,1)",[obligation,p.id,w.id,'workspace:'+w.id,owner]);
 await sleep(10); // PostgreSQL хранит время допуска точнее, чем JavaScript Date.
 const receipt={version:2,provenance:'operator_reviewed_nested_patch',outcome:'error',reviewer:'owner',reviewed_at:new Date().toISOString(),write_call_id:reviewed.id,project_id:p.id,workspace_id:w.id,executor_id:'codex',session_id:reviewed.session_id,turn_id:reviewed.turn_id,tool_use_id:reviewed.tool_use_id,tool_name:'apply_patch',payload_sha256:reviewed.payload_sha256,rewritten_sha256:reviewed.rewritten,outer_tool_use_id:'fixture-outer',review_manifest_sha256:'1'.repeat(64),source_prefix_sha256:'2'.repeat(64),source_prefix_bytes:128,input_line_sha256:'3'.repeat(64),output_line_sha256:'4'.repeat(64)};
 // Подмена verifier ограничена синтетической фикстурой; production проверяет root-владение файла.
 const verified=value=>async()=>({...validateCompletionReceipt(value),receipt_sha256:rawHash(value)}),opts={allowedRepositories:[p.repo_path],git:createGit()};
 await assert.rejects(importNativeCompletion(f.app,'fixture',{...opts,verifyReceipt:verified({...receipt,payload_sha256:'f'.repeat(64)})}),/WRITE_CALL_MISMATCH/);
 const startupReceipt={...receipt,provenance:'operator_reviewed_process_start_failure',tool_name:'Bash',write_call_id:startup.id,tool_use_id:startup.tool_use_id,payload_sha256:startup.payload_sha256,rewritten_sha256:startup.rewritten};
 assert.equal((await importNativeCompletion(f.app,'fixture',{...opts,verifyReceipt:verified(startupReceipt)})).state,'finished');
 assert.equal((await f.app.query('SELECT tool_result FROM codeworks.write_calls WHERE id=$1',[startup.id])).rows[0].tool_result.operator_completion.provenance,'operator_reviewed_process_start_failure');
 assert.equal((await f.h.call('write.finish',{project_id:p.id,session_id:startup.session_id,turn_id:startup.turn_id,tool_use_id:startup.tool_use_id,tool_name:'Bash',input_sha256:startup.rewritten,canonical_input_sha256:startup.rewritten,outcome:'success'},'codex')).state,'finished','late generic Post cannot override reviewed startup failure');
 const first=await importNativeCompletion(f.app,'fixture',{...opts,verifyReceipt:verified(receipt)});assert.equal(first.state,'finished');assert.equal(first.changed,true);
 assert.deepEqual(await importNativeCompletion(f.app,'fixture',{...opts,verifyReceipt:verified(receipt)}),first);
 const reviewedRow=(await f.app.query('SELECT state,tool_result FROM codeworks.write_calls WHERE id=$1',[reviewed.id])).rows[0];assert.equal(reviewedRow.state,'finished');assert.equal(reviewedRow.tool_result.outcome,'error');assert.equal(reviewedRow.tool_result.operator_completion.provenance,'operator_reviewed_nested_patch');assert.equal('exit_code' in reviewedRow.tool_result.operator_completion,false);
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[other.id])).rows[0].state,'in_flight');assert.deepEqual((await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation])).rows[0],{state:'waiting_decision',blocker:'WRITER_OUTCOME_UNKNOWN'});
 const finish={project_id:p.id,session_id:other.session_id,turn_id:other.turn_id,tool_use_id:other.tool_use_id,tool_name:other.tool_name,input_sha256:other.rewritten,canonical_input_sha256:other.rewritten,outcome:'success'};
 await f.h.call('write.finish',finish,'codex');await processProjectCompletions(f.app,p.id,{allowedRepositories:[p.repo_path]});
 assert.deepEqual((await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation])).rows[0],{state:'pending',blocker:null});
});


test('Temporal recovers active synchronized nested writers across pages and batches, preserving a live writer',{timeout:180000},async t=>{
 assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'disposable PostgreSQL and Temporal required');
 const f=await setup();let connection,native,client,handle;const previousSocket=process.env.CODEWORKS_EXECUTOR_SOCKET;
 const server=createServer(),sockets=new WebSocketServer({server});
 t.after(async()=>{if(previousSocket===undefined)delete process.env.CODEWORKS_EXECUTOR_SOCKET;else process.env.CODEWORKS_EXECUTOR_SOCKET=previousSocket;if(handle)await client.workflow.getHandle(handle.workflowId).terminate('fixture finished').catch(()=>{});for(const ws of sockets.clients)ws.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));await native?.close();await connection?.close();await f.close();});
 const p=await f.project({codeIndexDisabled:true}),prepared=await f.prepare({project_id:p.id,workspace_key:'active-nested',request_key:'active-nested'});await f.worker(p,prepared.operation_id);
 const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
 const calls=[];
 for(let n=0;n<10;n++){
  const request={project_id:p.id,workspace_id:w.id,session_id:'root-session',executor_thread_id:'00000000-0000-4000-8000-000000000002',turn_id:'lost-turn',tool_use_id:'writer-'+n,tool_name:'Bash',payload_sha256:rawHash('payload-'+n),targets:['hello.txt'],request_key:'nested-'+n};
  const result=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:result.write_call_id,rewritten_sha256:rawHash('input-'+n)},'codex');calls.push(result.write_call_id);
 }
 await writeFile(w.path+'/hello.txt','committed fixture work\n');await command('git',['-C',w.path,'add','hello.txt']);await command('git',['-C',w.path,'commit','-m','Synthetic active work']);
 const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout;
 await f.owner.query("UPDATE codeworks.workspaces SET activation_state='active' WHERE id=$1",[w.id]);
 const root='fixture/'+randomUUID();await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,last_stage) VALUES($1,$2,$3,'temporal','SYNCHRONIZED')",[root,p.id,w.id]);
 await f.h.call('write.stop',{project_id:p.id,session_id:'root-session',turn_id:'lost-turn',event:'SubagentStop'},'codex');
 await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'nested-fixture','temporal')",[p.id]);
 // AIDEV-NOTE: AF_UNIX требует короткий путь; fixture удаляет только собственный временный socket.
 const directory=await mkdtemp('/tmp/cw-nested-');t.after(()=>rm(directory,{recursive:true,force:true}));const socket=directory+'/api.sock';await new Promise(r=>server.listen(socket,r));await chmod(socket,0o600);process.env.CODEWORKS_EXECUTOR_SOCKET=socket;
 let pageCount=0;
 sockets.on('connection',ws=>ws.on('message',bytes=>{
  const m=JSON.parse(String(bytes));if(m.id===undefined)return;let result={};
  if(m.method==='thread/read'){const child=m.params.threadId==='00000000-0000-4000-8000-000000000002';result={thread:{id:m.params.threadId,parentThreadId:child?'child':'root-session',source:{subAgent:{thread_spawn:{parent_thread_id:child?'child':'root-session',depth:child?2:1}}}}};}
  if(m.method==='thread/turns/list'){pageCount++;result=m.params.cursor?{data:[{id:'lost-turn',items:calls.map((_,n)=>({id:'writer-'+n,type:'commandExecution',status:n===9?'inProgress':'completed',exitCode:n===9?null:0}))}],nextCursor:null}:{data:[{id:'new-turn',items:[]}],nextCursor:'old-page'};}
  ws.send(JSON.stringify({id:m.id,result}));
 }));
 const id=`codeworks/nested-fixture/${p.id}/reconciler`,queue='nested-writers-'+randomUUID();
 connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'});client=new Client({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});native=await NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
 const worker=await Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue:queue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[p.repo_path],completionSpoolDirectory:null})});
 await worker.runUntil(async()=>{
  handle=await client.workflow.start('codeworksProjectReconciler',{workflowId:id,taskQueue:queue,args:[{projectId:p.id}]});
  await until(async()=>(await f.app.query("SELECT count(*)::int AS n FROM codeworks.write_calls WHERE id=ANY($1::uuid[]) AND state='finished'",[calls])).rows[0].n===9,150000);
 });
 assert.ok(pageCount>=20,'cursor and bounded batches must progress automatically');
 assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[calls[9]])).rows[0].state,'uncertain');
 const status=await f.h.call('lifecycle.status',{project_id:p.id,workspace_id:w.id},'codex');assert.equal(status.workflow.blocked_reason,'WRITER_OUTCOME_UNKNOWN');assert.equal(status.task_status,'active');assert.equal(status.cleanup,null);
 assert.equal((await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout,head);assert.equal((await command('git',['-C',w.path,'status','--porcelain'])).stdout,'');
 assert.ok((await handle.fetchHistory()).events.some(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='reconcileProject'));
});
