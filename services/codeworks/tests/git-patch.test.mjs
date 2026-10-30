// ABOUTME: Проверяет фактическую запись git apply после изменения только каталога.
// ABOUTME: Использует disposable Git и не пишет в рабочие области пользователя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {gitPatch} from '../src/git-patch.mjs';
import {runHook,foregroundCommand,writePaths} from '../src/hook.mjs';
const diff='diff --git a/src/a.txt b/src/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.txt\n@@ -0,0 +1 @@\n+hello';
const command=root=>`git -C '${root}' apply --whitespace=nowarn <<'PATCH'\n${diff}\nPATCH\n`;
test('first literal git patch prepares one area and writes only the redirected checkout',async t=>{
  const root=mkdtempSync('/tmp/cw-git-writer-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=root+'/source',tree=root+'/tree',spool=root+'/spool';for(const d of [source,tree,spool])mkdirSync(d,{mode:0o700});
  for(const d of [source,tree])assert.equal(spawnSync('git',['init',d]).status,0);
  const calls=[],input={command:command(source)};
  const result=await runHook({hook_event_name:'PreToolUse',tool_name:'Bash',session_id:'s',turn_id:'t',tool_use_id:'u',cwd:source,tool_input:input},{config:{native_file_writes:false,completion_spool:spool,projects:[{id:'p',repo_path:source,workspace_root:root+'/areas'}]},env:{CODEWORKS_EXECUTOR_ID:'codex'},connect:async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='write.begin')return {workspace_id:'w',operation_id:'o',write_call_id:'c',path:tree};if(method==='status')return {workspace:{preparation_state:'ready'}};return {};},close(){}})});
  assert.equal(result.hookSpecificOutput.permissionDecision,'allow');
  assert.deepEqual(calls.map(c=>c.method),['write.begin','status','write.admit']);
  const actual=result.hookSpecificOutput.updatedInput.command;assert.equal(actual,command(tree));
  assert.equal(spawnSync('/bin/bash',['-lc',actual],{encoding:'utf8'}).status,0);
  assert.equal(readFileSync(tree+'/src/a.txt','utf8'),'hello\n');assert.throws(()=>readFileSync(source+'/src/a.txt'));
  assert.equal(foregroundCommand(actual),true);assert.deepEqual(writePaths({tool_name:'Bash',tool_input:{command:actual},cwd:source}),[tree+'/src/a.txt']);
});
test('ambiguous shell or escaping patch is never admitted as a literal git patch',()=>{
  for(const cmd of [command('/tmp/source')+'touch /tmp/else',command('/tmp/source').replace('git -C','git --unsafe-paths -C'),command('/tmp/source').replaceAll('src/a.txt','../escape'),command('/tmp/source').replace('100644','120000'),command('/tmp/source').replace("<<'PATCH'",'<<PATCH')])assert.equal(gitPatch(cmd),null);
});
test('unsupported native first edit creates no area and admits no unknown writer',async()=>{
  const connect=()=>assert.fail('unsupported native call contacted backend');
  const result=await runHook({hook_event_name:'PreToolUse',tool_name:'apply_patch',session_id:'s',turn_id:'t',tool_use_id:'nested',cwd:'/test/source',tool_input:{command:'*** Begin Patch\n*** Add File: src/a\n+x\n*** End Patch'}},{config:{native_file_writes:false,projects:[{id:'p',repo_path:'/test/source',workspace_root:'/test/areas'}]},connect});
  assert.equal(result.hookSpecificOutput.permissionDecision,'deny');assert.match(result.hookSpecificOutput.additionalContext,/WORKSPACE_WRITE_TRANSPORT_REQUIRED/);
});

test('unsupported git apply cannot silently write to the source checkout',async()=>{
  for(const cmd of [command('/test/source')+'touch /tmp/else',command('/test/source').replaceAll('src/a.txt','../escape'),'git apply --unsafe-paths /tmp/unknown.patch']){
    const result=await runHook({hook_event_name:'PreToolUse',tool_name:'Bash',session_id:'s',turn_id:'t',tool_use_id:'u',cwd:'/test/source',tool_input:{command:cmd}},{config:{native_file_writes:false,projects:[{id:'p',repo_path:'/test/source',workspace_root:'/test/areas'}]},connect:()=>assert.fail('unsupported patch contacted backend')});
    assert.equal(result.hookSpecificOutput.permissionDecision,'deny');
  }
});
