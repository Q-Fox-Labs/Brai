// ABOUTME: Проверяет root-owned native receipt, реальный importer и очистку только disposable области.
// ABOUTME: Фикстура запускает собственные foreground процессы и не использует пользовательские журналы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setup,configured} from './fixture.mjs';
import {createGit,gitResourcesAbsent} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {advanceCleanup} from '../../src/cleanup-coordinator.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';
import {attestNativeCompletion,importNativeCompletion,verifyCompletionReceipt} from '../../src/write-completion.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function execute(command,cwd){
  const child=spawn('/bin/bash',['-lc',command],{cwd,stdio:'ignore'}),pid=child.pid;
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.signal,null);assert.equal(result.code,0);return String(pid);
}

test('root receipt attestation imports each completed call once and cleanup reaches zero',{timeout:120000},async t=>{
  assert.equal(process.getuid(),0,'receipt fixture must run as root through isolated Ansible');
  assert.ok(configured,'explicit disposable PostgreSQL is required');
  const f=await setup();t.after(()=>f.close());
  const receiptRoot=await mkdtemp('/var/lib/brai-dev/codeworks-completion-fixture-');t.after(()=>rm(receiptRoot,{recursive:true,force:true}));
  const p=await f.project({codeIndexDisabled:true});
  const prepared=await f.prepare({project_id:p.id,workspace_key:'receipt-recovery',request_key:'receipt-recovery'});await f.worker(p,prepared.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0],owner='fixture/'+randomUUID();
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[owner,p.id,w.id]);
  const session='receipt-session',turn='receipt-turn',calls=[],events=[];
  for(const [tool,cmd] of [['native-one','git status --short'],['native-two','cat hello.txt']]){
    const payload={tool_name:'Bash',tool_input:{command:cmd},cwd:p.repo_path,project_id:p.id,workspace_id:w.id};
    const request={project_id:p.id,workspace_id:w.id,workspace_key:w.workspace_key,session_id:session,turn_id:turn,tool_use_id:tool,tool_name:'Bash',payload_sha256:hash(JSON.stringify(payload)),targets:['.'],request_key:'receipt-'+tool};
    const admitted=await f.h.call('write.begin',request,'codex');await f.h.call('write.admit',{project_id:p.id,write_call_id:admitted.write_call_id,rewritten_sha256:hash(JSON.stringify({command:cmd}))},'codex');
    const pid=await execute(cmd,w.path);
    events.push({timestamp:new Date(Date.now()+1000).toISOString(),type:'event_msg',payload:{type:'item_completed',thread_id:session,turn_id:turn,item:{id:tool,type:'CommandExecution',source:'unified_exec_startup',status:'completed',exit_code:0,process_id:pid,command:['/bin/bash','-lc',cmd],cwd:pathToFileURL(w.path).href}}});
    calls.push((await f.app.query('SELECT * FROM codeworks.write_calls WHERE id=$1',[admitted.write_call_id])).rows[0]);
  }
  const source=receiptRoot+'/native.jsonl';await writeFile(source,[{type:'session_meta',payload:{id:session,cwd:p.repo_path}},...events].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  const receipts=[];
  for(const [i,call] of calls.entries()){
    const receipt=await attestNativeCompletion({sourcePath:source,call,project:p,workspace:w}),file=receiptRoot+'/receipt-'+i+'.json';
    await writeFile(file,JSON.stringify(receipt),{mode:0o600});assert.equal((await verifyCompletionReceipt(file)).write_call_id,call.id);receipts.push({receipt,file});
  }
  await f.owner.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing' WHERE workspace_id=$1",[w.id]);
  const obligation=(await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch) VALUES($1,$2,$3,$4,'cancelled',$5,1) RETURNING *",[randomUUID(),p.id,w.id,'workspace:'+w.id,owner])).rows[0];
  const db=await f.app.connect();try{assert.equal((await advanceCleanup(db,obligation,p,w,{git:createGit(),codeIndex:createCodeIndex(f.app)})).blocker,'WRITER_OUTCOME_UNKNOWN');}finally{db.release();}
  const forged=receiptRoot+'/forged.json';await writeFile(forged,JSON.stringify({...receipts[0].receipt,write_call_id:calls[1].id}),{mode:0o600});
  const options={allowedRepositories:[p.repo_path],git:createGit()};
  await assert.rejects(importNativeCompletion(f.app,forged,options),/WRITE_CALL_MISMATCH|NATIVE_COMPLETION_UNVERIFIED/);
  await writeFile(forged,JSON.stringify({...receipts[0].receipt,payload_sha256:'f'.repeat(64)}),{mode:0o600});
  await assert.rejects(importNativeCompletion(f.app,forged,options),/WRITE_CALL_MISMATCH|NATIVE_COMPLETION_UNVERIFIED/);
  const first=await importNativeCompletion(f.app,receipts[0].file,options);assert.deepEqual(await importNativeCompletion(f.app,receipts[0].file,options),first);
  let row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation.id])).rows[0];assert.deepEqual(row,{state:'waiting_decision',blocker:'WRITER_OUTCOME_UNKNOWN'});
  await importNativeCompletion(f.app,receipts[1].file,options);row=(await f.app.query('SELECT state,blocker FROM codeworks.cleanup_obligations WHERE id=$1',[obligation.id])).rows[0];assert.deepEqual(row,{state:'pending',blocker:null});
  const adapters=createActivityGit(),index=createCodeIndex(f.app);let result;
  for(let i=0;i<8;i++){result=await runCleanupObligation(f.app,obligation.id,owner,{...adapters,codeIndex:index,allowedRepositories:[p.repo_path]});assert.notEqual(result?.state,'waiting_decision',JSON.stringify(result));if(result?.state==='done')break;}
  assert.equal(result.state,'done');assert.ok(gitResourcesAbsent(await createGit().inspectResources(p,w)));await assert.rejects(access(w.path));
  assert.ok((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].removed_at);
});
