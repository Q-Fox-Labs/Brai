// ABOUTME: Проверяет маршрутизацию native записи через hook Codeworks.
// ABOUTME: Подменяет backend и не запускает пользовательские сессии Codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runHook,writePaths} from '../src/hook.mjs';
import {validate} from '../src/contracts.mjs';
const config={projects:[{id:'demo',repo_path:'/test/main',documentation_paths:['docs'],excluded_paths:['tmp']}]};
const env={CODEWORKS_WORKSPACE_KEY:'task'};
const patch=text=>({hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',cwd:'/test/main',tool_input:{command:text}});
const valid='*** Begin Patch\n*** Add File: src/a\n+hello\n*** End Patch';
function fixture(ready=true){const calls=[];return {calls,options:{config,env,polls:1,wait:async()=>{},connect:async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='write.begin')return {workspace_id:'w',operation_id:'o',write_call_id:'c',path:'/test/tree'};if(method==='status')return {workspace:{preparation_state:ready?'ready':'intent'}};return {};},close:async()=>{}})}};}
test('native patch is rewritten only after ready and admitted',async()=>{const f=fixture();const result=await runHook(patch(valid),f.options);assert.equal(result.hookSpecificOutput.permissionDecision,'allow');assert.equal(result.hookSpecificOutput.updatedInput.command,valid.replace('src/a','/test/tree/src/a'));assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.admit']);assert.deepEqual(f.calls[0].args.targets,['src/a']);});
test('timeout denies without admitting',async()=>{const f=fixture(false);const r=await runHook(patch(valid),f.options);assert.equal(r.hookSpecificOutput.permissionDecision,'deny');assert.match(r.hookSpecificOutput.additionalContext,/PREPARE_PENDING/);assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.stop']);});
test('mixed owners and shell do not create a workspace',async()=>{for(const event of [patch(valid.replace('*** End Patch','*** Add File: /outside/admin/a\n+x\n*** End Patch')),{...patch(valid),tool_name:'Bash',tool_input:{command:'touch src/a'}}]){const f=fixture();assert.equal((await runHook(event,f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);}});
test('missing key uses actual write, missing identifiers deny',async()=>{const f=fixture();f.options.env={};assert.equal((await runHook(patch(valid),f.options)).hookSpecificOutput.permissionDecision,'allow');assert.equal(f.calls[0].method,'write.begin');assert.equal('workspace_key' in f.calls[0].args,false);f.calls.length=0;assert.equal((await runHook({...patch(valid),session_id:undefined},f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);});
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

test('strict read-only commands in a worktree do not admit a writer',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id;
 const config={projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('read-only call connects');
 for(const cmd of ['git status','git status --short','cat src/a','rg -n word src','rg --files']) assert.deepEqual(await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:cmd}},{config,env,connect}),{});
});
test('shell operators and unsafe flags are never classified as read-only',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const config={projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push(method);if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:'c'};return {};},close(){}});
 for(const cmd of ['git status; touch x','cat a > x','rg --pre evil word','git status --exec=evil']) {await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:cmd}},{config,env,connect});assert.equal(calls.at(-1),'write.admit');}
});

test('new calls get distinct request keys and retries preserve the same key',async()=>{
 const f=fixture();await runHook(patch(valid),f.options);const first=f.calls.find(c=>c.method==='write.begin').args.request_key;
 f.calls.length=0;await runHook(patch(valid),f.options);assert.equal(f.calls.find(c=>c.method==='write.begin').args.request_key,first);
 f.calls.length=0;await runHook({...patch(valid),tool_use_id:'next'},f.options);assert.notEqual(f.calls.find(c=>c.method==='write.begin').args.request_key,first);
});
test('only completed ordinary Git shell calls finish writer accounting',async()=>{
 for(const command of ['git add -A','git commit -m "message"','git push origin feature/test']) {
  for(const response of [{exit_code:0},'Process exited with code 1\nOutput:\nfailed']) {
   const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:response},f.options);
   assert.equal(f.calls[0].method,'write.finish');assert.equal(f.calls[0].args.outcome,'success');
  }
 }
 for(const [command,response] of [['git add -A; touch x',{exit_code:0}],['git -c core.hooksPath=/tmp commit -m x',{exit_code:0}],['git push origin feature/test',{session_id:12}],['git add -A','Process running, session ID 1']]) {
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:response},f.options);assert.equal(f.calls.length,0);
 }
});

test('unreadable target fails closed before contacting Codeworks',async()=>{const f=fixture();f.options.resolveTarget=()=>{throw Object.assign(new Error('private path'),{code:'EACCES'});};const result=await runHook(patch(valid),f.options);assert.equal(result.hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(result),/private path/);});

test('foreground checks and read-only pipelines finish but background and opaque commands stay protected',async()=>{
 for(const command of ['node --test services/codeworks/tests/hook.test.mjs','node services/codeworks/components/cli.mjs build codeworks','node services/codeworks/components/cli.mjs check codeworks','node services/codeworks/components/cli.mjs package codeworks','node services/codeworks/components/cli.mjs run codeworks','rg -n pattern src | head -n 10','sed -n 1,20p src/file && git status --short']) {
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:'Chunk ID: test\nWall time: 1\nProcess exited with code 0\nOutput:\n'},f.options);assert.equal(f.calls[0]?.method,'write.finish',command);
 }
 for(const command of ['node --test tests/a &','nohup node --test tests/a','node script.mjs','node -e evil','node services/codeworks/components/cli.mjs run codeworks &','rg word src | sh','sed -n 1w/tmp/out src/file']) {
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:{exit_code:0}},f.options);assert.equal(f.calls.length,0,command);
 }
});
test('output text cannot impersonate native completion',async()=>{const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:'Process running\nOutput:\nProcess exited with code 0'},f.options);assert.equal(f.calls.length,0);});

test('safe backend failures keep their reason without exposing details',async()=>{
 for(const code of ['FORBIDDEN','CLEANUP_ALREADY_STARTED','CONFLICT','WRITE_CALL_MISMATCH','INVALID_ARGUMENT','INTERNAL']) {
  const f=fixture();f.options.connect=async()=>({call:async(method)=>{if(method==='write.begin')throw Object.assign(new Error('secret private stderr'),{code});return {};},close(){}});
  const out=await runHook(patch(valid),f.options);assert.match(out.hookSpecificOutput.additionalContext,new RegExp(code));assert.doesNotMatch(JSON.stringify(out),/PREPARE_PENDING|secret private stderr/);
 }
});

test('native Bash text Post finishes foreground call without parsing stdout',async()=>{
 const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:'✔ tests/a (50ms)\nℹ pass 1'},f.options);assert.equal(f.calls[0].method,'write.finish');assert.equal(f.calls[0].args.outcome,'success');
 for(const response of ['Process running with session ID 2',{session_id:2},{status:'running'}]) {const g=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:response},g.options);assert.equal(g.calls.length,0);}
 const g=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a',run_in_background:true},tool_response:'running'},g.options);assert.equal(g.calls.length,0);
});
test('existing shell call validates against real owner schema with whole-tree target',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const cfg={projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};return {};},close(){}});
 const r=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:'node --test tests/a'}},{config:cfg,env,connect});assert.equal(r.hookSpecificOutput.permissionDecision,'allow');assert.deepEqual(calls.find(x=>x.method==='write.begin').args.targets,['.']);
});
test('native end-of-file marker survives rewrite byte for byte',async()=>{
 const f=fixture(),command='*** Begin Patch\n*** Update File: src/a\n@@\n-old\n+new\n*** End of File\n*** End Patch';const r=await runHook(patch(command),f.options);assert.equal(r.hookSpecificOutput.permissionDecision,'allow');assert.equal(r.hookSpecificOutput.updatedInput.command,command.replace('src/a','/test/tree/src/a'));
});

test('literal foreground redirects accept terminal Post without accepting background or opaque shell',async()=>{
 for(const command of ['node --test tests/a > /tmp/tests.log 2>&1','node --test tests/a 2> /tmp/error.log','node services/codeworks/components/cli.mjs package codeworks >> /tmp/package.log 2>&1','node --test tests/a > /tmp/test.log && node services/codeworks/components/cli.mjs check codeworks 2>> /tmp/check.log']) {
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:'completed'},f.options);assert.equal(f.calls[0]?.method,'write.finish',command);
 }
 for(const command of ['node --test tests/a > /tmp/a &','node --test tests/a > $(evil)','node --test tests/a > /tmp/a 2>&1 &','node script.mjs > /tmp/a','node --test tests/a &> /tmp/a','node --test tests/a 2>&3','node --test tests/a > /tmp/a; nohup node other.mjs','node --test tests/a > /tmp/a 2>&1; disown']) {
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:'completed'},f.options);assert.equal(f.calls.length,0,command);
 }
 for(const response of [{session_id:123},'Process running with session ID 12']) {const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a > /tmp/a 2>&1'},tool_response:response},f.options);assert.equal(f.calls.length,0);}
});

test('actual component publication commands admit and complete with literal redirected log',async()=>{
 const id='e67896b4-42f9-4ff8-b673-303dabab9253',root='/var/lib/brai-dev/codeworks/workspaces/'+id;
 const cfg={projects:[{id:'demo',repo_path:'/srv/projects/brai-dev',workspace_root:'/var/lib/brai-dev/codeworks/workspaces'}]};
 for(const suffix of ['','-eb77']) {
  const calls=[];const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};return {};},close(){}});
  const command='node services/codeworks/components/cli.mjs run codeworks > '+root+'/tmp/codeworks-temporal/final-publication-check'+suffix+'.log 2>&1';
  const event={...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command}};
  assert.equal((await runHook(event,{config:cfg,env,connect})).hookSpecificOutput.permissionDecision,'allow');
  await runHook({...event,hook_event_name:'PostToolUse',tool_response:'completed'},{config:cfg,env,connect});assert.equal(calls.at(-1).method,'write.finish');
 }
});
