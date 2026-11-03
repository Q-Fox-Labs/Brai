// ABOUTME: Проверяет root-owned native receipt, реальный importer и очистку только disposable области.
// ABOUTME: Фикстура запускает собственные foreground процессы и не использует пользовательские журналы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker,bundleWorkflowCode} from '@temporalio/worker';
import {setup,configured} from './fixture.mjs';
import {createGit,gitResourcesAbsent} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {advanceCleanup} from '../../src/cleanup-coordinator.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';
import {attestNativeCompletion,importNativeCompletion,verifyCompletionReceipt} from '../../src/write-completion.mjs';
import {runHook} from '../../src/hook.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {processProjectCompletions} from '../../src/completion-inbox.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function execute(command,cwd){
  const child=spawn('/bin/bash',['-lc',command],{cwd,stdio:'ignore'}),pid=child.pid;
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.signal,null);assert.equal(result.code,0);return String(pid);
}

test('foreground rm Post and root receipt recover completed calls and Temporal cleanup',{timeout:180000},async t=>{
  assert.equal(process.getuid(),0,'receipt fixture must run as root through isolated Ansible');
  assert.ok(configured&&process.env.CODEWORKS_TEMPORAL_ADDRESS&&process.env.CODEWORKS_TEMPORAL_NAMESPACE,'explicit disposable PostgreSQL and Temporal are required');
  const f=await setup();t.after(()=>f.close());
  const receiptRoot=await mkdtemp('/var/lib/brai-dev/codeworks-completion-fixture-');t.after(()=>rm(receiptRoot,{recursive:true,force:true}));
  const p=await f.project({codeIndexDisabled:true});
  const prepared=await f.prepare({project_id:p.id,workspace_key:'receipt-recovery',request_key:'receipt-recovery'});await f.worker(p,prepared.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],owner='fixture/'+randomUUID();
  const release=randomUUID(),evidence=randomUUID();
  await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','succeeded','done','{}')",[release,p.id,w.id]);
  await f.owner.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'dev',$3,$4)",[evidence,p.id,w.base_sha,'https://fixture.invalid/'+evidence]);
  await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'succeeded',$5)",[randomUUID(),w.id,release,w.base_sha,{primary:{merged:true,target:'dev',merge_sha:w.base_sha,deployment_evidence_id:evidence}}]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[owner,p.id,w.id]);
  const session=randomUUID(),nativeThread=randomUUID(),turn='receipt-turn',calls=[],events=[];
  const postDir=w.path+'/post-temp';await mkdir(postDir);await writeFile(postDir+'/data','temporary');
  const postCommand='rm -rf -- '+postDir,postPayload={tool_name:'Bash',tool_input:{command:postCommand},cwd:p.repo_path,project_id:p.id,workspace_id:w.id};
  const postRequest={project_id:p.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:session,turn_id:turn,tool_use_id:'normal-post',tool_name:'Bash',payload_sha256:hash(JSON.stringify(postPayload)),targets:['.'],request_key:'normal-post'};
  const postCall=await f.h.call('write.begin',postRequest,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:postCall.write_call_id,rewritten_sha256:hash(JSON.stringify({command:postCommand}))},'codex');
  await execute(postCommand,w.path);await assert.rejects(access(postDir),{code:'ENOENT'});
  const spool=receiptRoot+'/spool';await mkdir(spool,{mode:0o700});
  const invoked=[];await runHook({hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:postCommand},cwd:w.path,tool_response:'',session_id:session,turn_id:turn,tool_use_id:'normal-post'},{config:{projects:[p],completion_spool:spool},env:{CODEWORKS_EXECUTOR_ID:'codex'},connect:async()=>({call:async(method,args)=>{invoked.push(method);return f.h.call(method,args,'codex');},close:async()=>{}})});
  assert.deepEqual(invoked,['write.finish']);assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[postCall.write_call_id])).rows[0].state,'in_flight');
  await processProjectCompletions(f.app,p.id,{allowedRepositories:[p.repo_path]});assert.equal((await f.app.query('SELECT state FROM codeworks.write_calls WHERE id=$1',[postCall.write_call_id])).rows[0].state,'finished');
  for(const [tool,name] of [['native-one','lost-one'],['native-two','lost-two']]){
    const dir=w.path+'/'+name;await mkdir(dir);await writeFile(dir+'/data','temporary');const cmd='rm -rf -- '+dir;
    const payload={tool_name:'Bash',tool_input:{command:cmd},cwd:p.repo_path,project_id:p.id,workspace_id:w.id};
    const request={project_id:p.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:session,turn_id:turn,tool_use_id:tool,tool_name:'Bash',payload_sha256:hash(JSON.stringify(payload)),targets:['.'],request_key:'receipt-'+tool};
    const admitted=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:admitted.write_call_id,rewritten_sha256:hash(JSON.stringify({command:cmd}))},'codex');
    const pid=await execute(cmd,w.path);await assert.rejects(access(dir),{code:'ENOENT'});
    events.push({timestamp:new Date(Date.now()+1000).toISOString(),type:'event_msg',payload:{type:'item_completed',thread_id:nativeThread,turn_id:turn,item:{id:tool,type:'CommandExecution',source:'unified_exec_startup',status:'completed',exit_code:0,process_id:pid,command:['/bin/bash','-lc',cmd],cwd:pathToFileURL(w.path).href}}});
    calls.push((await f.app.query('SELECT * FROM codeworks.write_calls WHERE id=$1',[admitted.write_call_id])).rows[0]);
  }
  const meta={type:'session_meta',payload:{id:nativeThread,parent_thread_id:session,cwd:p.repo_path,source:{subagent:{thread_spawn:{parent_thread_id:session,depth:1,agent_path:'/root/fixture'}}}}};
  const source=receiptRoot+'/native.jsonl';await writeFile(source,[meta,...events].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  const invalid=receiptRoot+'/invalid.jsonl',unrelated=structuredClone(meta),conflicting=structuredClone(meta);
  unrelated.payload.parent_thread_id=randomUUID();unrelated.payload.source.subagent.thread_spawn.parent_thread_id=unrelated.payload.parent_thread_id;
  await writeFile(invalid,[unrelated,...events].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  await assert.rejects(attestNativeCompletion({sourcePath:invalid,call:calls[0],project:p,workspace:w}),/NATIVE_COMPLETION_UNVERIFIED/);
  conflicting.payload.source.subagent.thread_spawn.parent_thread_id=randomUUID();
  await writeFile(invalid,[conflicting,...events].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  await assert.rejects(attestNativeCompletion({sourcePath:invalid,call:calls[0],project:p,workspace:w}),/NATIVE_COMPLETION_UNVERIFIED/);
  const receipts=[];
  for(const [i,call] of calls.entries()){
    const receipt=await attestNativeCompletion({sourcePath:source,call,project:p,workspace:w}),file=receiptRoot+'/receipt-'+i+'.json';
    assert.equal(receipt.native_thread_id,nativeThread);assert.equal(receipt.parent_thread_id,session);assert.equal(receipt.lineage_sha256,hash(JSON.stringify(meta)+'\n'));
    await writeFile(file,JSON.stringify(receipt),{mode:0o600});assert.equal((await verifyCompletionReceipt(file)).write_call_id,call.id);receipts.push({receipt,file});
  }
  await f.owner.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing' WHERE workspace_id=$1",[w.id]);
  const obligation=(await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'released',$5,1) RETURNING *",[randomUUID(),p.id,w.id,'workspace:'+w.id,owner])).rows[0];
  const db=await f.app.connect();try{assert.equal((await advanceCleanup(db,obligation,p,w,{git:createGit(),codeIndex:createCodeIndex(f.app)})).blocker,'WRITER_OUTCOME_UNKNOWN');}finally{db.release();}
  const address=process.env.CODEWORKS_TEMPORAL_ADDRESS,namespace=process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue='completion-receipt-'+randomUUID();
  const connection=await Connection.connect({address,connectTimeout:'5 seconds'}),native=await NativeConnection.connect({address}),client=new Client({connection,namespace});let handle;
  t.after(async()=>{await handle?.terminate('fixture finished').catch(()=>{});await native.close();await connection.close();});
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))}),adapters=createActivityGit(),index=createCodeIndex(f.app);
  const worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:bundle,activities:createActivities(f.app,{allowedRepositories:[p.repo_path],adapters,codeIndex:index}),maxConcurrentActivityTaskExecutions:4});
  await worker.runUntil(async()=>{
    handle=await client.workflow.start('codeworksWorkspace',{workflowId:owner,taskQueue,args:[{generation:1,position:0}]});
    const started=Date.now()+15000;for(;;){const history=await handle.fetchHistory(),waiting=(await f.app.query("SELECT 1 FROM codeworks.workflow_registry WHERE workflow_id=$1 AND executor_state='waiting'",[owner])).rowCount;if(waiting&&history.events.some(event=>event.activityTaskScheduledEventAttributes?.activityType?.name==='finishWorkflow'))break;if(Date.now()>started)throw Error('WORKFLOW_START_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,100));}
    const forged=receiptRoot+'/forged.json';await writeFile(forged,JSON.stringify({...receipts[0].receipt,write_call_id:calls[1].id}),{mode:0o600});
    const options={allowedRepositories:[p.repo_path],git:createGit()};
    await assert.rejects(importNativeCompletion(f.app,forged,options),/WRITE_CALL_MISMATCH|NATIVE_COMPLETION_UNVERIFIED/);
    await writeFile(forged,JSON.stringify({...receipts[0].receipt,payload_sha256:'f'.repeat(64)}),{mode:0o600});
    await assert.rejects(importNativeCompletion(f.app,forged,options),/WRITE_CALL_MISMATCH|NATIVE_COMPLETION_UNVERIFIED/);
    const first=await importNativeCompletion(f.app,receipts[0].file,options);assert.deepEqual(await importNativeCompletion(f.app,receipts[0].file,options),first);
    let row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation.id])).rows[0];assert.deepEqual(row,{state:'waiting_decision',blocker:'WRITER_OUTCOME_UNKNOWN'});
    await importNativeCompletion(f.app,receipts[1].file,options);row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation.id])).rows[0];assert.deepEqual(row,{state:'pending',blocker:null});
    const end=Date.now()+90000;for(;;){const row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation.id])).rows[0];if(row.state==='done')break;if(row.state==='waiting_decision')throw Error('CLEANUP_BLOCKED '+JSON.stringify(row));if(Date.now()>end)throw Error('CLEANUP_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,100));}
    const history=await handle.fetchHistory();assert.ok(history.events.some(event=>event.activityTaskScheduledEventAttributes?.activityType?.name==='advanceCleanupObligation'));
  });
  const releaseAfter=(await f.app.query('SELECT state,requested_sha,details FROM codeworks.releases WHERE operation_id=$1',[release])).rows[0];assert.equal(releaseAfter.state,'succeeded');assert.equal(releaseAfter.requested_sha,w.base_sha);assert.equal(releaseAfter.details.primary.deployment_evidence_id,evidence);
  assert.ok(gitResourcesAbsent(await createGit().inspectResources(p,w)));await assert.rejects(access(w.path));
  assert.ok((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].removed_at);
});
