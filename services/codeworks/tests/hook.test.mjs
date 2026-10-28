// ABOUTME: Проверяет маршрутизацию native записи через hook Codeworks.
// ABOUTME: Подменяет backend и не запускает пользовательские сессии Codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runHook,writePaths} from '../src/hook.mjs';
const config={projects:[{id:'demo',repo_path:'/test/main',documentation_paths:['docs'],excluded_paths:['tmp']}]};
const env={CODEWORKS_WORKSPACE_KEY:'task'};
const patch=text=>({hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',cwd:'/test/main',tool_input:{command:text}});
const valid='*** Begin Patch\n*** Add File: src/a\n+hello\n*** End Patch';
function fixture(ready=true){const calls=[];return {calls,options:{config,env,polls:1,wait:async()=>{},connect:async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='write.begin')return {workspace_id:'w',operation_id:'o',write_call_id:'c',path:'/test/tree'};if(method==='status')return {workspace:{preparation_state:ready?'ready':'intent'}};return {};},close:async()=>{}})}};}
test('native patch is rewritten only after ready and admitted',async()=>{const f=fixture();const result=await runHook(patch(valid),f.options);assert.equal(result.hookSpecificOutput.permissionDecision,'allow');assert.equal(result.hookSpecificOutput.updatedInput.command,valid.replace('src/a','/test/tree/src/a'));assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.admit']);assert.deepEqual(f.calls[0].args.targets,['src/a']);});
test('timeout denies without admitting',async()=>{const f=fixture(false);const r=await runHook(patch(valid),f.options);assert.equal(r.hookSpecificOutput.permissionDecision,'deny');assert.match(r.hookSpecificOutput.additionalContext,/PREPARE_PENDING/);assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.stop']);});
test('mixed owners and shell do not create a workspace',async()=>{for(const event of [patch(valid.replace('*** End Patch','*** Add File: /outside/admin/a\n+x\n*** End Patch')),{...patch(valid),tool_name:'Bash',tool_input:{command:'touch src/a'}}]){const f=fixture();assert.equal((await runHook(event,f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);}});
test('missing key or identifiers deny without creating',async()=>{const f=fixture();f.options.env={};assert.equal((await runHook(patch(valid),f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);});
test('reads and Admin targets do not connect',async()=>{const f=fixture();assert.deepEqual(await runHook(patch(valid.replace('src/a','/outside/admin/a')),f.options),{});assert.equal(f.calls.length,0);});
test('post and stop report only safe outcome',async()=>{const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_response:{error:'private'}},f.options);assert.deepEqual(f.calls[0],{method:'write.finish',args:{project_id:'demo',session_id:'s',turn_id:'t',tool_use_id:'u',outcome:'error'}});await runHook({...patch(valid),hook_event_name:'Stop'},f.options);assert.equal(f.calls[1].method,'write.stop');});

const bash = command => ({tool_name:'Bash',cwd:'/test/main',tool_input:{command}});
test('simple shell targets and heredoc bodies retain parser coverage',()=>{
  for (const command of ["echo 'hello' > src/a",'touch src/a','rm -f src/a','cp /outside/a src/a',"sed -i 's/a/b/' src/a",'printf test | tee src/a','rtk proxy rm src/a']) assert.deepEqual(writePaths(bash(command)),['/test/main/src/a']);
  for (const marker of ['PY',"'PY'",'"PY"']) assert.deepEqual(writePaths(bash(`python3 - <<${marker}\ntouch src/body\nPY\n`)),[]);
  assert.deepEqual(writePaths(bash("touch src/before; cat <<'FIRST' <<-SECOND > src/output\nrm src/body1\nFIRST\n\ttee src/body2\n\tSECOND\ntouch src/after")),['/test/main/src/before','/test/main/src/output','/test/main/src/after']);
  assert.deepEqual(writePaths(bash("cat <<''\n> src/body\n\ntouch src/after")),['/test/main/src/after']);
  assert.deepEqual(writePaths(bash("cat <<< '<h1>stdin</h1>' > src/output")),['/test/main/src/output']);
  for (const command of ["cat <<'EOF'\n> src/body",'cat <<$MARKER\n> src/body\n$MARKER','cat <<\n> src/body']) assert.deepEqual(writePaths(bash(command)),[]);
});
test('existing native and shell write use the registered workspace',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const cfg={projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:'c'};return {};},close:async()=>{}});
 for(const event of [{...patch(valid),cwd:root},{...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:'python3 script.py'}}]) {
  const response=await runHook(event,{config:cfg,env,connect});assert.equal(response.hookSpecificOutput.permissionDecision,'allow');
  assert.equal(calls.at(-2).method,'write.begin');assert.equal(calls.at(-2).args.workspace_id,id);assert.equal(calls.at(-1).method,'write.admit');
 }
 const before=calls.length;await runHook({...patch(valid),cwd:root,tool_name:'Bash',hook_event_name:'PostToolUse',tool_response:{}},{config:cfg,env,connect});assert.equal(calls.length,before);
});
test('lost begin reply stops by native call identity',async()=>{
 const f=fixture();const calls=[];f.options.connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='write.begin')throw Error('lost');return {};},close:async()=>{}});
 assert.equal((await runHook(patch(valid),f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(calls[1].method,'write.stop');assert.equal(calls[1].args.tool_use_id,'u');
});
