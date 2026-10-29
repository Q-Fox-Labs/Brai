// ABOUTME: Проверяет маршрутизацию native записи через hook Codeworks.
// ABOUTME: Подменяет backend и не запускает пользовательские сессии Codex.
import test, {after} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {listNotices,rawHash,canonicalHash} from '../src/write-notice.mjs';
import assert from 'node:assert/strict';
import {runHook,writePaths,foregroundCommand,readHookJSON} from '../src/hook.mjs';
import {validate} from '../src/contracts.mjs';
const spool=mkdtempSync('/tmp/cw-hook-spool-');
after(()=>rmSync(spool,{recursive:true,force:true}));
const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/main',documentation_paths:['docs'],excluded_paths:['tmp']}]};
const env={CODEWORKS_WORKSPACE_KEY:'task',CODEWORKS_EXECUTOR_ID:'codex'};
const patch=text=>({hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',cwd:'/test/main',tool_input:{command:text}});
const valid='*** Begin Patch\n*** Add File: src/a\n+hello\n*** End Patch';
function fixture(ready=true){const calls=[];return {calls,options:{config,env,polls:1,wait:async()=>{},connect:async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='write.begin')return {workspace_id:'w',operation_id:'o',write_call_id:'c',path:'/test/tree'};if(method==='status')return {workspace:{preparation_state:ready?'ready':'intent'}};if(method==='write.finish')return {state:'finished'};return {};},close:async()=>{}})}};}
test('native patch is rewritten only after ready and admitted',async()=>{const f=fixture();const result=await runHook(patch(valid),f.options);assert.equal(result.hookSpecificOutput.permissionDecision,'allow');assert.equal(result.hookSpecificOutput.updatedInput.command,valid.replace('src/a','/test/tree/src/a'));assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.admit']);assert.deepEqual(f.calls[0].args.targets,['src/a']);});
test('timeout denies without admitting',async()=>{const f=fixture(false);const r=await runHook(patch(valid),f.options);assert.equal(r.hookSpecificOutput.permissionDecision,'deny');assert.match(r.hookSpecificOutput.additionalContext,/PREPARE_PENDING/);assert.deepEqual(f.calls.map(x=>x.method),['write.begin','status','write.stop']);});
test('mixed owners and shell do not create a workspace',async()=>{for(const event of [patch(valid.replace('*** End Patch','*** Add File: /outside/admin/a\n+x\n*** End Patch')),{...patch(valid),tool_name:'Bash',tool_input:{command:'touch src/a'}}]){const f=fixture();assert.equal((await runHook(event,f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);}});
test('missing key uses actual write, missing identifiers deny',async()=>{const f=fixture();f.options.env={CODEWORKS_EXECUTOR_ID:'codex'};assert.equal((await runHook(patch(valid),f.options)).hookSpecificOutput.permissionDecision,'allow');assert.equal(f.calls[0].method,'write.begin');assert.equal('workspace_key' in f.calls[0].args,false);f.calls.length=0;assert.equal((await runHook({...patch(valid),session_id:undefined},f.options)).hookSpecificOutput.permissionDecision,'deny');assert.equal(f.calls.length,0);});
test('reads and Admin targets do not connect',async()=>{const f=fixture();assert.deepEqual(await runHook(patch(valid.replace('src/a','/outside/admin/a')),f.options),{});assert.equal(f.calls.length,0);});
test('post and stop report only safe outcome',async()=>{const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_response:{error:'private'}},f.options);assert.deepEqual(f.calls[0],{method:'write.finish',args:{project_id:'demo',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',input_sha256:rawHash(patch(valid).tool_input),canonical_input_sha256:canonicalHash(patch(valid).tool_input),outcome:'error',execution_status:'completed'}});await runHook({...patch(valid),hook_event_name:'Stop'},f.options);assert.equal(f.calls[1].method,'write.stop');});

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
 const cfg={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:'c'};return {};},close:async()=>{}});
 for(const event of [{...patch(valid),cwd:root},{...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:'node --test tests/a'}}]) {
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
 const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('read-only call connects');
 for(const cmd of ['git status','git status --short','git diff --stat','git diff --check','git show 0123456789abcdef:services/codeworks/src/hook.mjs','git log --format=%H','git rev-parse HEAD','ls','ls -la src','pwd','cat src/a','rg -n word src','rg --files']) assert.deepEqual(await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:cmd}},{config,env,connect}),{});
});
test('shell operators and unsafe flags are never classified as read-only',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push(method);if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:'c'};return {};},close(){}});
 for(const cmd of ['git status; touch x','rg --pre evil word','git status --exec=evil']) {const result=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:cmd}},{config,env,connect});assert.equal(result.hookSpecificOutput.permissionDecision,'deny');assert.match(result.hookSpecificOutput.additionalContext,/WRITER_COMPLETION_UNSUPPORTED/);assert.equal(calls.length,0);}
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
 for(const [command,response] of [['git add -A; touch x',{exit_code:0}],['git -c core.hooksPath=/tmp commit -m x',{exit_code:0}],['git push origin feature/test',{session_id:12}],['git add -A',{session_id:1}]]) {
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
test('native Bash Post completion does not infer state from stdout',async()=>{const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:'session id: 1; still running'},f.options);assert.equal(f.calls[0]?.method,'write.finish');});

test('safe backend failures keep their reason without exposing details',async()=>{
 for(const code of ['FORBIDDEN','CLEANUP_ALREADY_STARTED','CONFLICT','WRITE_CALL_MISMATCH','INVALID_ARGUMENT','INTERNAL']) {
  const f=fixture();f.options.connect=async()=>({call:async(method)=>{if(method==='write.begin')throw Object.assign(new Error('secret private stderr'),{code});return {};},close(){}});
  const out=await runHook(patch(valid),f.options);assert.match(out.hookSpecificOutput.additionalContext,new RegExp(code));assert.doesNotMatch(JSON.stringify(out),/PREPARE_PENDING|secret private stderr/);
 }
});

test('native Bash text Post finishes foreground call without parsing stdout',async()=>{
 const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:'✔ tests/a (50ms)\nℹ pass 1'},f.options);assert.equal(f.calls[0].method,'write.finish');assert.equal(f.calls[0].args.outcome,'success');
 for(const response of [{session_id:2},{status:'running'}]) {const g=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a'},tool_response:response},g.options);assert.equal(g.calls.length,0);}
 const g=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a',run_in_background:true},tool_response:'running'},g.options);assert.equal(g.calls.length,0);
});
test('existing shell call validates against real owner schema with whole-tree target',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const cfg={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};if(method==='write.finish')return {state:'finished'};return {};},close(){}});
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
 for(const response of [{session_id:123},{status:'running'}]) {const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'node --test tests/a > /tmp/a 2>&1'},tool_response:response},f.options);assert.equal(f.calls.length,0);}
});

test('actual component publication commands admit and complete with literal redirected log',async()=>{
 const id='e67896b4-42f9-4ff8-b673-303dabab9253',root='/var/lib/brai-dev/codeworks/workspaces/'+id;
 const cfg={completion_spool:spool,projects:[{id:'demo',repo_path:'/srv/projects/brai-dev',workspace_root:'/var/lib/brai-dev/codeworks/workspaces'}]};
 for(const suffix of ['','-eb77']) {
  const calls=[];const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};if(method==='write.finish')return {state:'finished'};return {};},close(){}});
  const command='node services/codeworks/components/cli.mjs run codeworks > '+root+'/tmp/codeworks-temporal/final-publication-check'+suffix+'.log 2>&1';
  const event={...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command}};
  assert.equal((await runHook(event,{config:cfg,env,connect})).hookSpecificOutput.permissionDecision,'allow');
  await runHook({...event,hook_event_name:'PostToolUse',tool_response:'completed'},{config:cfg,env,connect});assert.equal(calls.at(-1).method,'write.finish');
 }
});

test('owner verifier uses the same conservative foreground classifier',()=>{
 assert.equal(foregroundCommand('node services/codeworks/components/cli.mjs run codeworks > tmp/out.log 2>&1'),true);
 for(const command of ['node --test tests/a &','node script.mjs > tmp/out','node --test tests/a > $(evil)','nohup node --test tests/a']) assert.equal(foregroundCommand(command),false,command);
});

test('literal two-file cp completes while dynamic, multi-source and background variants remain protected',async()=>{
 for(const command of ['cp services/codeworks/src/example.mjs services/codeworks/tests/example.mjs','cp -- services/codeworks/src/example.mjs services/codeworks/tests/example.mjs']) {
  assert.equal(foregroundCommand(command),true);
  const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command},tool_response:{exit_code:0}},f.options);assert.equal(f.calls[0]?.method,'write.finish');
 }
 for(const command of ['cp a b c','cp -r a b','cp a b &','cp $(evil) b','cp a "$DEST"','cp a b; python3 x','cp -- -r b']) assert.equal(foregroundCommand(command),false,command);
 const f=fixture();await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'cp a b'},tool_response:{session_id:23}},f.options);assert.equal(f.calls.length,0);
});

test('literal rm inside workspace is admitted and its native terminal Post finishes',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};if(method==='write.finish')return {state:'finished'};return {};},close(){}});
 const event={...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:'rm -rf -- '+root+'/tmp/disposable'}};
 assert.equal((await runHook(event,{config,env,connect})).hookSpecificOutput.permissionDecision,'allow');assert.deepEqual(calls.map(c=>c.method),['status','write.begin','write.admit']);
 await runHook({...event,hook_event_name:'PostToolUse',tool_response:{exit_code:0}},{config,env,connect});assert.equal(calls.at(-1).method,'write.finish');
});
test('unfinishable or explicit background work is denied before contacting Codeworks',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id;
 const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('unsupported write must not connect');
 for(const input of [{command:'python3 script.py'}, {command:'rm --no-preserve-root -rf tmp/a'}, {command:'rm -rf "$DEST"'}, {command:'rm -rf tmp/a &'}, {command:'rm -rf tmp/a',run_in_background:true}, {command:'rm -rf tmp/a',background:true}]) {
  const r=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:input},{config,env,connect});assert.equal(r.hookSpecificOutput.permissionDecision,'deny');assert.match(r.hookSpecificOutput.additionalContext,/WRITER_COMPLETION_UNSUPPORTED/);
 }
 const r=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:'rm -rf -- /outside/disposable'}},{config,env,connect});assert.equal(r.hookSpecificOutput.permissionDecision,'deny');
});

test('read-only foreground or background inspection never creates a writer',async()=>{
 const root='/test/areas/00000000-0000-4000-8000-000000000001',config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('read-only inspection must not contact Codeworks');
 for(const input of [{command:'git status',async:true},{command:'git diff --stat',run_in_background:true},{command:'pwd',background:true}]) assert.deepEqual(await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:input},{config,env,connect}),{});
});
test('unsupported Git flags and potential execution or output paths are denied before API',async()=>{
 const root='/test/areas/00000000-0000-4000-8000-000000000001',config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('unsupported inspection must not contact Codeworks');
 for(const command of ['git diff --output=tmp/out','git diff --ext-diff','git diff --textconv','git -c diff.external=evil diff --stat','git log --output=tmp/out','git show --ext-diff 0123456789abcdef:path','git rev-parse --output=tmp/out','git status; touch file']) {
  const r=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command}},{config,env,connect});assert.equal(r.hookSpecificOutput.permissionDecision,'deny',command);
 }
});

test('unquoted tilde expansion denies rm and cp before writer admission',async()=>{
 const root='/test/areas/00000000-0000-4000-8000-000000000001',config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=()=>assert.fail('tilde expansion must not contact Codeworks');
 for(const command of ['rm -rf -- ~/x','rm -rf -- ~+/x','rm -rf -- ~-/x','rm -rf -- ~user/x','cp ~/a tmp/b']) {
  const result=await runHook({...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command}},{config,env,connect});
  assert.equal(result.hookSpecificOutput.permissionDecision,'deny',command);assert.match(result.hookSpecificOutput.additionalContext,/WRITER_COMPLETION_UNSUPPORTED/);
 }
});
test('quoted tilde is literal and keeps workspace ownership',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id,calls=[];
 const config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas'}]};
 const connect=async()=>({call:async(method,args)=>{calls.push({method,args});if(method==='status')return {workspace:{id,path:root,workspace_key:'task',kind:'feature',preparation_state:'ready'}};validate(method,args);if(method==='write.begin')return {workspace_id:id,path:root,write_call_id:id};if(method==='write.finish')return {state:'finished'};return {};},close(){}});
 const event={...patch(valid),cwd:root,tool_name:'Bash',tool_input:{command:"rm -rf -- '~/x'"}};
 assert.equal((await runHook(event,{config,env,connect})).hookSpecificOutput.permissionDecision,'allow');
 assert.deepEqual(calls.find(c=>c.method==='write.begin').args.targets,['~/x']);
});

test('Post persists metadata before a failed network delivery and never stores contents',async()=>{
 const isolated=mkdtempSync('/tmp/cw-post-test-');try{
  const calls=[];const f=fixture();f.options.config={...config,completion_spool:isolated};
  f.options.connect=async()=>({call:async(method,args)=>{calls.push(method);assert.equal(listNotices(isolated,{projectId:'demo'}).length,1);throw Error('network secret');},close(){}});
  const input={command:'*** Begin Patch\n*** Add File: secret-name\n+private-content\n*** End Patch'};
  const event={...patch(valid),tool_input:input,hook_event_name:'PostToolUse',tool_response:{output:'secret-output'}};
  const result=await runHook(event,f.options);assert.match(result.systemMessage,/POST_DELIVERY_PENDING/);assert.deepEqual(calls,['write.finish']);
  const record=listNotices(isolated,{projectId:'demo'})[0].notice;assert.doesNotMatch(JSON.stringify(record),/private-content|secret-output|secret-name/);assert.equal(record.request.canonical_input_sha256,canonicalHash(input));
 }finally{rmSync(isolated,{recursive:true,force:true});}
});
test('missing spool denies only protected writes before begin',async()=>{
 const f=fixture();f.options.config={...config,completion_spool:'/not-present'};
 const result=await runHook(patch(valid),f.options);assert.equal(result.hookSpecificOutput.permissionDecision,'deny');assert.match(result.hookSpecificOutput.additionalContext,/POST_DELIVERY_UNAVAILABLE/);assert.equal(f.calls.length,0);
 assert.deepEqual(await runHook({...patch(valid),tool_name:'Read',tool_input:{file_path:'src/a'}},f.options),{});
});
test('NOT_FOUND retains notice for reconciliation; confirmed pending removes it',async()=>{
 for(const mode of ['missing','pending']){
  const isolated=mkdtempSync('/tmp/cw-post-test-');try{
   const f=fixture();f.options.config={...config,completion_spool:isolated};f.options.connect=async()=>({call:async()=>{if(mode==='missing')throw Object.assign(Error('absent'),{code:'NOT_FOUND'});return {state:'pending'};},close(){}});
   const result=await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_response:{}},f.options);
   if(mode==='missing'){assert.match(result.systemMessage,/POST_DELIVERY_UNMATCHED/);assert.equal(listNotices(isolated,{projectId:'demo'}).length,1);}else{assert.deepEqual(result,{});assert.deepEqual(listNotices(isolated,{projectId:'demo'}),[]);}
  }finally{rmSync(isolated,{recursive:true,force:true});}
 }
});

test('hook reader accepts large events but explicitly rejects oversized input',async()=>{
 const value={hook_event_name:'PostToolUse',tool_response:'x'.repeat(70000)};
 assert.deepEqual(await readHookJSON([JSON.stringify(value)]),{...value,tool_response:''});
 await assert.rejects(readHookJSON([' '.repeat(16*1024*1024+1)]),/HOOK_INPUT_INVALID_OR_OVERSIZED/);
});

test('stream reader validates UTF-8, JSON escapes, duplicate keys and grammar',async()=>{
 const input=Buffer.from(JSON.stringify({hook_event_name:'PostToolUse',session_id:'сессия',tool_input:{command:'строка\nя'},tool_response:{isError:true,error:'bad',output:'xx',exit_code:1}}));
 async function* pieces(){for(let i=0;i<input.length;i+=3)yield input.subarray(i,i+3);}
 const r=await readHookJSON(pieces());assert.equal(r.session_id,'сессия');assert.equal(r.tool_input.command,'строка\nя');assert.deepEqual(r.tool_response,{isError:true,error:'bad',exit_code:1});
 for(const bad of ['{"a":1,"a":2}','{"a":[1,]}','{"a":true false}','{"a":"bad\\q"}','{"a":01}','['.repeat(65)+'0'+']'.repeat(65)])await assert.rejects(readHookJSON([bad]),/HOOK_INPUT_INVALID_OR_OVERSIZED/);
 await assert.rejects(readHookJSON([Buffer.from([0xff])]),/HOOK_INPUT_INVALID_OR_OVERSIZED/);
});
test('huge chunked native Post output is discarded while input identity is retained',async()=>{
 const input={command:'node --test tests/a'},meta={hook_event_name:'PostToolUse',tool_name:'Bash',session_id:'session',turn_id:'turn',tool_use_id:'call',tool_input:input};
 async function* pieces(){yield Buffer.from(JSON.stringify(meta).slice(0,-1)+',"tool_response":"');for(let i=0;i<257;i++)yield Buffer.alloc(65536,120);yield Buffer.from('"}');}
 const event=await readHookJSON(pieces());assert.equal(event.tool_response,'');assert.deepEqual(event.tool_input,input);
 const isolated=mkdtempSync('/tmp/cw-large-post-');try{const f=fixture();f.options.config={...config,completion_spool:isolated};f.options.connect=async()=>{throw Error('offline');};const result=await runHook({...event,cwd:'/test/main'},f.options);assert.match(result.systemMessage,/POST_DELIVERY_PENDING/);const stored=listNotices(isolated,{projectId:'demo'})[0].notice;assert.equal(stored.request.input_sha256,rawHash(input));assert.equal(stored.request.canonical_input_sha256,canonicalHash(input));assert.doesNotMatch(JSON.stringify(stored),/xxxxxxxx/);}finally{rmSync(isolated,{recursive:true,force:true});}
});

test('docs-only and excluded Post create no notice or connection',async()=>{
 const f=fixture();f.options.config={...config,projects:[{...config.projects[0],workspace_root:'/test/areas'}]};f.options.connect=()=>assert.fail('untracked documentation must not connect');
 for(const name of ['docs/allowed.md','tmp/a']) assert.deepEqual(await runHook({...patch(valid.replace('src/a',name)),hook_event_name:'PostToolUse',tool_response:'ok'},f.options),{});
});
test('docs inside admitted workspace still deliver Post',async()=>{
 const id='00000000-0000-4000-8000-000000000001',root='/test/areas/'+id;
 const f=fixture();f.options.config={completion_spool:spool,projects:[{id:'demo',repo_path:'/test/main',workspace_root:'/test/areas',documentation_paths:['docs']}]};
 const e={...patch(valid.replace('src/a',root+'/docs/allowed.md')),hook_event_name:'PostToolUse',tool_response:'ok'};
 await runHook(e,f.options);assert.equal(f.calls[0]?.method,'write.finish');
});


test('large skipped response object keeps bounded memory and parses escaped keys',async()=>{
 const meta={hook_event_name:'PostToolUse',tool_name:'Bash',session_id:'сессия',turn_id:'t',tool_use_id:'u',tool_input:{command:'node --test tests/a'}};
 async function* chunks(){yield Buffer.from(JSON.stringify(meta).slice(0,-1)+',"tool_response":{');for(let i=0;i<18000;i++)yield Buffer.from(JSON.stringify('key'+i+'я')+':"'+ 'x'.repeat(1000)+'",');yield Buffer.from('"isError":false}}');}
 const event=await readHookJSON(chunks());assert.equal(event.session_id,'сессия');assert.deepEqual(event.tool_response,{isError:false});assert.deepEqual(event.tool_input,meta.tool_input);
});

test('input size bound denies before begin and after path rewrite before admit',async()=>{
 const limit=8*1024*1024;const base=patch(valid);
 let oversized={...base,tool_input:{command:valid+'я'.repeat(limit/2)}};let f=fixture();let out=await runHook(oversized,f.options);assert.match(out.hookSpecificOutput.additionalContext,/HOOK_INPUT_TOO_LARGE/);assert.equal(f.calls.length,0);
 const prefix='*** Begin Patch\n*** Add File: src/a\n+',suffix='\n*** End Patch';
 let event=patch(prefix+suffix);const padding=limit-Buffer.byteLength(JSON.stringify(event))-4;event=patch(prefix+'x'.repeat(padding)+suffix);f=fixture();out=await runHook(event,f.options);assert.match(out.hookSpecificOutput.additionalContext,/HOOK_INPUT_TOO_LARGE/);assert.deepEqual(f.calls.map(c=>c.method),['write.begin','status','write.stop']);
});


test('millions of distinct skipped response keys fit a bounded heap',()=>{
 const reader=new URL('../src/hook.mjs',import.meta.url).href;
 const script=`import {readHookJSON} from ${JSON.stringify(reader)};async function* input(){yield '{"tool_response":{';for(let i=0;i<1200000;i++)yield (i?',':'')+JSON.stringify('ключ'+i)+':0';yield '}}';}const x=await readHookJSON(input());if(Object.keys(x.tool_response).length)process.exit(3);`;
 const child=spawnSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script],{encoding:'utf8',timeout:60000});assert.equal(child.status,0,child.stderr);
});


test('typed not_started preserves native identity and never infers from text',async()=>{
 const pre=fixture();await runHook(patch(valid),pre.options);assert.equal(pre.calls[0].args.original_input_sha256,canonicalHash(patch(valid).tool_input));
 for(const response of [{execution_status:'not_started',isError:true,terminal:true},{execution_status:'not_started',isError:true},{execution_status:'not_started',terminal:true},'not_started']) {
  const f=fixture(),event={...patch(valid),hook_event_name:'PostToolUse',tool_response:response};const decoded=await readHookJSON([JSON.stringify(event)]);const result=await runHook(decoded,f.options);if(response?.execution_status==='not_started' && (response.isError!==true||response.terminal!==true)){assert.match(result.systemMessage,/POST_DELIVERY_UNAVAILABLE/);assert.equal(f.calls.length,0);continue;}const request=f.calls[0].args;assert.equal(request.canonical_input_sha256,canonicalHash(event.tool_input));assert.equal(request.execution_status,response?.terminal===true&&response?.isError===true?'not_started':'completed');
 }
});


test('durable not_started fence acknowledges only a valid exact receipt',async()=>{
 for(const mode of ['fenced','bad-receipt','missing','normal']){
  const isolated=mkdtempSync('/tmp/cw-fence-');try{const f=fixture();f.options.config={...config,completion_spool:isolated};f.options.connect=async()=>({call:async()=>{if(mode==='missing')throw Object.assign(Error('absent'),{code:'NOT_FOUND'});return {state:'not_started',write_call_id:null,receipt_sha256:mode==='bad-receipt'?'bad':'a'.repeat(64)};},close(){}});
  const tool_response=mode==='normal'?{}:{execution_status:'not_started',isError:true,terminal:true};const result=await runHook({...patch(valid),hook_event_name:'PostToolUse',tool_response},f.options);
  if(mode==='fenced'){assert.deepEqual(result,{});assert.equal(listNotices(isolated,{projectId:'demo'}).length,0);}else{assert.match(result.systemMessage,mode==='missing'?/POST_DELIVERY_UNMATCHED/:/POST_DELIVERY_PENDING/);assert.equal(listNotices(isolated,{projectId:'demo'}).length,1);}
  }finally{rmSync(isolated,{recursive:true,force:true});}
 }
});
