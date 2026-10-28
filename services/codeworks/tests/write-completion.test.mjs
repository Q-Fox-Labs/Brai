// ABOUTME: Проверяет сопоставление подтверждённого native завершения с учтённым вызовом.
// ABOUTME: Использует синтетический журнал, не сохраняет команды в доказательствах и не меняет рабочие данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {attestNativeCompletion,verifyCompletionReceipt} from '../src/write-completion.mjs';
import {parseCompletionArgs} from '../src/operator.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-completion-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=root+'/journal.jsonl',cmd='git status',project={id:'fixture',repo_path:'/fixture/repo'},workspace={id:'workspace-id',path:'/fixture/worktree'},input={command:cmd};
 const call={id:'call-id',project_id:project.id,workspace_id:workspace.id,executor_id:'codex',session_id:'session-id',turn_id:'turn-id',tool_use_id:'exec-id',tool_name:'Bash',state:'in_flight',admitted_at:'2026-01-01T00:00:00Z',rewritten_sha256:hash(JSON.stringify(input)),payload_sha256:hash(JSON.stringify({tool_name:'Bash',tool_input:input,cwd:project.repo_path,project_id:project.id,workspace_id:workspace.id}))};
 const meta={type:'session_meta',payload:{id:call.session_id,cwd:project.repo_path}},item={type:'CommandExecution',id:call.tool_use_id,source:'unified_exec_startup',status:'completed',exit_code:0,process_id:'123',command:['/bin/bash','-lc',cmd],cwd:pathToFileURL(workspace.path).href},event={type:'event_msg',timestamp:'2026-01-01T00:01:00Z',payload:{type:'item_completed',thread_id:call.session_id,turn_id:call.turn_id,item}};
 const save=async(...events)=>writeFile(file,[meta,...events].map(x=>JSON.stringify(x)+'\n').join(''));await save(event);return {file,call,project,workspace,event,meta,save,root};
}
test('matches native event and both ledger digests without recording command or output',async t=>{
 const f=await fixture(t),result=await attestNativeCompletion({sourcePath:f.file,...f});assert.equal(result.write_call_id,f.call.id);assert.equal(result.exit_code,0);assert.equal(result.native_event_sha256,hash(JSON.stringify(f.event)+'\n'));assert.ok(!JSON.stringify(result).includes('git status'));
});
test('rejects altered command, cwd, turn, exit, background and duplicate events',async t=>{
 const f=await fixture(t),check=async event=>{await f.save(event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);};
 let e=structuredClone(f.event);e.payload.item.command[2]='printf altered';await check(e);
 e=structuredClone(f.event);e.payload.item.cwd='file:///elsewhere';await check(e);
 e=structuredClone(f.event);e.payload.turn_id='other';await check(e);
 e=structuredClone(f.event);e.payload.item.exit_code=null;await check(e);
 e=structuredClone(f.event);e.payload.item.command[2]='sleep 1 &';await check(e);
 await f.save(f.event,f.event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);
});
test('rejects unsupported session source and agent-owned receipt',async t=>{
 const f=await fixture(t);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f,call:{...f.call,payload_sha256:'0'.repeat(64)}}),/NATIVE_COMPLETION_UNVERIFIED/);
 await assert.rejects(verifyCompletionReceipt(f.file),/NATIVE_COMPLETION_UNVERIFIED/);
 assert.throws(()=>parseCompletionArgs(['write-completion-attest','--call','bad','--source','/a','--receipt','/b']),/INVALID_ARGUMENT/);
 assert.throws(()=>parseCompletionArgs(['write-completion-import','--receipt','/b','--trusted-uid','1002']),/INVALID_ARGUMENT/);
});

test('one-hop child lineage requires both parent proofs and exact native thread',async t=>{
 const f=await fixture(t),child='child-session';
 f.meta.payload.id=child;f.meta.payload.parent_thread_id=f.call.session_id;f.meta.payload.source={subagent:{thread_spawn:{parent_thread_id:f.call.session_id,depth:1}}};f.event.payload.thread_id=child;
 await f.save(f.event);const proof=await attestNativeCompletion({sourcePath:f.file,...f});assert.equal(proof.session_id,f.call.session_id);assert.equal(proof.native_thread_id,child);assert.equal(proof.parent_thread_id,f.call.session_id);assert.equal(proof.lineage_sha256,hash(JSON.stringify(f.meta)+'\n'));
 f.meta.payload.source.subagent.thread_spawn.parent_thread_id='other';await f.save(f.event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);
 f.meta.payload.source.subagent.thread_spawn.parent_thread_id=f.call.session_id;f.meta.payload.parent_thread_id='other';await f.save(f.event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);
 f.meta.payload.parent_thread_id=f.call.session_id;f.meta.payload.source.subagent.thread_spawn.depth=2;await f.save(f.event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);
 f.meta.payload.source.subagent.thread_spawn.depth=1;f.event.payload.thread_id='unrelated';await f.save(f.event);await assert.rejects(attestNativeCompletion({sourcePath:f.file,...f}),/NATIVE_COMPLETION_UNVERIFIED/);
});
