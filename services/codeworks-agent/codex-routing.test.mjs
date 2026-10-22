// ABOUTME: Проверяет ordinary route и запрет native writer overrides без модели и daemon.
// ABOUTME: Transport ports подставлены; проверки охватывают Admin passthrough и cold legacy admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRouter,enforceBrai,readonlyCatalogue} from './codex-routing.mjs';

const options={cwd:'/repo/brai',catalogue:'/etc/safe-models.json',mcpCommand:['node','/runtime/agent-mcp.mjs'],controlSocket:'/run/codeworks.sock'};
test('Brai overrides every startup writer surface and keeps native identity',()=>{
  const frame={id:1,method:'thread/resume',params:{threadId:'existing',cwd:'/evil',sandbox:'danger-full-access',permissions:'full',history:[{}],path:'/foreign',dynamicTools:[{name:'writer'}],config:{mcp_servers:{escape:{command:'sh'}}},developerInstructions:'use native writer'}};
  const out=enforceBrai(frame,options);
  assert.equal(out.params.threadId,'existing');assert.equal(out.params.cwd,options.cwd);
  assert.equal(out.params.sandbox,'read-only');assert.equal(out.params.approvalPolicy,'never');
  for(const key of ['permissions','history','path','dynamicTools'])assert.equal(out.params[key],undefined);
  assert.deepEqual(Object.keys(out.params.config.mcp_servers),['workspace']);
  assert.deepEqual(out.params.config.mcp_servers.workspace.omit_tools_from,['deferred','code_mode']);
  assert.equal(out.params.config.mcp_servers.workspace.default_tools_approval_mode,'approve');
  assert.equal(out.params.config['features.shell_tool'],false);
  assert.equal(out.params.developerInstructions,'use native writer');
  assert.equal(frame.params.permissions,'full');
});
test('Brai turn cannot restore native writes, permissions, remote environment or injected config',()=>{
  const out=enforceBrai({method:'turn/start',params:{threadId:'t',permissions:'all',sandboxPolicy:{type:'dangerFullAccess'},runtimeWorkspaceRoots:['/'],config:{foo:1},environments:[{}]}},options);
  assert.deepEqual(out.params.sandboxPolicy,{type:'readOnly'});assert.deepEqual(out.params.environments,[]);
  for(const key of ['permissions','runtimeWorkspaceRoots','config'])assert.equal(out.params[key],undefined);
});
test('Startup catalogue removes builtin patch, shell and code execution metadata',()=>{
  const original={models:[{slug:'selected',apply_patch_tool_type:'freeform',shell_type:'unified_exec',tool_mode:'code_mode_only'}]};
  const result=readonlyCatalogue(original);assert.equal(result.models[0].apply_patch_tool_type,null);
  assert.equal(result.models[0].shell_type,'disabled');assert.equal(result.models[0].tool_mode,'direct');
  assert.equal(original.models[0].apply_patch_tool_type,'freeform');
  assert.throws(()=>readonlyCatalogue({models:[]}));
});
function fixture({cwd='/admin',loaded=[]}={}) {
  const frames=[],admin=[],brai=[];let adminSend,braiSend;
  const router=createNativeRouter({roots:['/repo/brai'],send:f=>frames.push(f),resolvePath:async p=>p.replace('/alias','/repo/brai'),
    upstream:send=>{adminSend=send;return {receive(f){admin.push(f);if(f.method==='thread/read')send({id:f.id,result:{thread:{id:f.params.threadId,cwd}}});if(f.method==='thread/loaded/list')send({id:f.id,result:{data:loaded,nextCursor:null}});},close(){}}},
    brai:send=>{braiSend=send;return {receive(f){brai.push(f);if(f.method==='initialize')send({id:f.id,result:{userAgent:'native'}});if(f.method==='thread/start')send({id:f.id,result:{thread:{id:'new-brai',cwd:'/repo/brai'}}});},close(){}}}});
  return {router,frames,admin,brai,adminSend:()=>adminSend,braiSend:()=>braiSend};
}
async function init(f){await f.router.receive({id:1,method:'initialize',params:{clientInfo:{name:'ordinary'}}});await f.router.receive({method:'initialized'});}
test('Admin passes byte-equivalent decoded requests without starting Brai backend',async()=>{
  const f=fixture();await init(f);
  const input={id:2,method:'thread/start',params:{cwd:'/admin',config:{arbitrary:'preserve'},sandbox:'workspace-write'}};
  await f.router.receive(input);assert.deepEqual(f.admin.at(-1),input);assert.equal(f.brai.length,0);await f.router.close();
});
test('Canonical Brai cwd starts guarded route lazily, routes later thread calls',async()=>{
  const f=fixture();await init(f);await f.router.receive({id:2,method:'thread/start',params:{cwd:'/alias'}});
  assert.equal(f.brai.at(-1).method,'thread/start');
  await f.router.receive({id:3,method:'turn/start',params:{threadId:'new-brai',input:[]}});
  assert.equal(f.brai.at(-1).method,'turn/start');await f.router.close();
});
test('Unthreaded protected filesystem writes and native command are denied, read passes upstream',async()=>{
  const f=fixture();await init(f);
  for(const method of ['fs/writeFile','fs/remove','fs/createDirectory'])await f.router.receive({id:2,method,params:{path:'/alias/source'}});
  await f.router.receive({id:3,method:'command/exec',params:{cwd:'/repo/brai',command:['unknown','argument']}});
  assert.equal(f.frames.filter(x=>x.error).length,4);
  await f.router.receive({id:4,method:'fs/readFile',params:{path:'/repo/brai/source'}});
  assert.equal(f.admin.at(-1).method,'fs/readFile');await f.router.close();
});
test('Loaded legacy writer is never cold-copied or interrupted',async()=>{
  const f=fixture({cwd:'/repo/brai',loaded:['legacy']});await init(f);
  await f.router.receive({id:2,method:'thread/resume',params:{threadId:'legacy'}});
  assert.match(f.frames.at(-1).error.message,/RECONNECT_REQUIRED/);
  assert.equal(f.brai.length,0);assert.equal(f.admin.some(x=>x.method==='thread/unsubscribe'),false);await f.router.close();
});
test('Cold legacy resumes the same native id and Admin receives no resume',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:2,method:'thread/resume',params:{threadId:'legacy'}});
  assert.equal(f.brai.at(-1).params.threadId,'legacy');
  assert.equal(f.admin.some(x=>x.method==='thread/resume'),false);await f.router.close();
});
test('Server-request response returns to its owning backend even with equal native ids',async()=>{
  const f=fixture();await init(f);await f.router.receive({id:2,method:'thread/start',params:{cwd:'/repo/brai'}});
  f.adminSend()({id:10,method:'ask',params:{}});f.braiSend()({id:10,method:'ask',params:{}});
  const [a,b]=f.frames.slice(-2);assert.notEqual(a.id,b.id);
  await f.router.receive({id:b.id,result:{choice:'ok'}});assert.deepEqual(f.brai.at(-1),{id:10,result:{choice:'ok'}});
  await f.router.close();
});
