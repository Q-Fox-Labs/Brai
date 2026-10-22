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
function fixture({cwd='/admin',loaded=[],resolvePath=async p=>p.replace('/alias','/repo/brai').replace('/workspace-alias','/state/workspaces')}={}) {
  const frames=[],admin=[],brai=[];let adminSend,braiSend;
  const router=createNativeRouter({roots:['/repo/brai'],workspaceRoots:['/state/workspaces'],attachmentRoot:'/home/test/.codex/attachments',visualizationRoot:'/home/test/.codex/visualizations',send:f=>frames.push(f),resolvePath,
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

test('Protected managed workspaces reject direct fs and every native execution family before a Brai thread',async()=>{
  const f=fixture();await init(f);
  const requests=[
    ['fs/writeFile',{path:'/state/workspaces/own/package.json',dataBase64:'e30='}],
    ['fs/createDirectory',{path:'/workspace-alias/own/new'}],
    ['fs/remove',{path:'/state/workspaces/foreign/source'}],
    ['fs/copy',{sourcePath:'/admin/a',destinationPath:'/workspace-alias/own/a'}],
    ['command/exec',{cwd:'/state/workspaces/own',command:['unclassified']}],
    ['process/spawn',{cwd:'/workspace-alias/own',command:['unclassified'],processHandle:'p'}],
  ];
  for(let i=0;i<requests.length;i++){const [method,params]=requests[i];await f.router.receive({id:20+i,method,params});}
  assert.equal(f.frames.filter(x=>x.error).length,requests.length);
  assert.equal(f.admin.filter(x=>requests.some(([method])=>method===x.method)).length,0);
  await f.router.close();
});
test('A Brai connection fails closed on all unthreaded writer families even for outside or missing paths',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:2,method:'thread/read',params:{threadId:'existing'}});
  const methods=['fs/writeFile','fs/remove','fs/copy','fs/futureWriter','command/exec','command/exec/write','command/exec/terminate','command/exec/resize','process/spawn','process/writeStdin','process/kill','process/resizePty','process/futureWriter'];
  for(let i=0;i<methods.length;i++)await f.router.receive({id:30+i,method:methods[i],params:{path:'/admin/file',cwd:'/admin',processHandle:'p',processId:'p'}});
  assert.equal(f.frames.filter(x=>x.error).length,methods.length);
  assert.equal(f.admin.filter(x=>methods.includes(x.method)).length,0);
  await f.router.receive({id:90,method:'fs/readFile',params:{path:'/state/workspaces/own/package.json'}});
  assert.equal(f.admin.at(-1).method,'fs/readFile');await f.router.close();
});
test('Admin-only native fs, command and process protocol remains unchanged',async()=>{
  const f=fixture();await init(f);
  const methods=['fs/writeFile','fs/copy','command/exec','command/exec/write','process/spawn','process/writeStdin'];
  for(let i=0;i<methods.length;i++) {
    const frame={id:50+i,method:methods[i],params:{path:'/admin/file',sourcePath:'/admin/a',destinationPath:'/admin/b',cwd:'/admin',command:['opaque'],processId:'c',processHandle:'p'}};
    await f.router.receive(frame);assert.deepEqual(f.admin.at(-1),frame);
  }
  assert.equal(f.frames.some(x=>x.error),false);await f.router.close();
});

test('Managed workspace cwd and persisted threads use the same guarded Brai route',async()=>{
  for(const cwd of ['/state/workspaces/own','/workspace-alias/own']) {
    const f=fixture({cwd});await init(f);
    await f.router.receive({id:100,method:'thread/start',params:{cwd}});
    assert.equal(f.brai.at(-1).method,'thread/start');
    assert.equal(f.admin.some(x=>x.method==='thread/start'),false);
    await f.router.receive({id:101,method:'thread/resume',params:{threadId:'workspace-thread'}});
    assert.equal(f.brai.at(-1).method,'thread/resume');
    assert.equal(f.admin.some(x=>x.method==='thread/resume'),false);await f.router.close();
  }
});

test('Thread settings preserve model UI while clamping every native writer permission',()=>{
  const out=enforceBrai({method:'thread/settings/update',params:{threadId:'t',cwd:'/foreign',approvalPolicy:'on-request',sandboxPolicy:{type:'dangerFullAccess'},permissions:'full',runtimeWorkspaceRoots:['/'],config:{x:1},model:'gpt-6.1-sol',effort:'high',disabledPluginIds:[]}},options);
  assert.equal(out.params.cwd,options.cwd);assert.equal(out.params.approvalPolicy,'never');
  assert.deepEqual(out.params.sandboxPolicy,{type:'readOnly'});
  for(const key of ['permissions','runtimeWorkspaceRoots','config'])assert.equal(out.params[key],undefined);
  assert.equal(out.params.model,'gpt-6.1-sol');assert.equal(out.params.effort,'high');assert.deepEqual(out.params.disabledPluginIds,[]);
  const turn={method:'turn/settings/update',params:{threadId:'t',turnId:'u',model:'gpt-6.1-sol',effort:'high'}};
  assert.deepEqual(enforceBrai(turn,options),turn);
});
test('Brai cannot invoke native thread shells, manual execution approval or new unreviewed thread controls',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  for(const method of ['thread/shellCommand','thread/approveGuardianDeniedAction','thread/futureWriter'])await f.router.receive({id:110,method,params:{threadId:'existing',command:'opaque'}});
  assert.equal(f.frames.filter(x=>x.error).length,3);assert.equal(f.brai.length,0);await f.router.close();
  const admin=fixture();await init(admin);
  const frame={id:120,method:'thread/shellCommand',params:{threadId:'admin-thread',command:'opaque'}};
  await admin.router.receive(frame);assert.deepEqual(admin.admin.at(-1),frame);await admin.router.close();
});

const uploadRoot='/home/test/.codex/attachments';
const uploadId='47b45722-225e-4f03-8f4d-5131a0f78f8b';
test('Desktop attachment lifecycle remains available after Brai and Admin chats share a connection',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:200,method:'thread/read',params:{threadId:'existing'}});
  await f.router.receive({id:201,method:'thread/start',params:{cwd:'/admin'}});
  const directory=uploadRoot+'/'+uploadId,file=directory+'/image.png';
  const requests=[
    ['fs/createDirectory',{path:directory,recursive:true}],
    ['fs/writeFile',{path:file,dataBase64:'aW1hZ2U='}],
    ['fs/copy',{sourcePath:'/tmp/image.png',destinationPath:directory+'/copy.png'}],
    ['fs/writeFile',{path:uploadRoot+'/pasted-text-attachments.json',dataBase64:'e30='}],
    ['fs/remove',{path:file,force:true}],
    ['fs/remove',{path:directory,recursive:true,force:true}],
  ];
  for(let i=0;i<requests.length;i++) {
    const [method,params]=requests[i],frame={id:210+i,method,params};
    await f.router.receive(frame);assert.deepEqual(f.admin.at(-1),frame);
  }
  assert.equal(f.frames.some(x=>x.error),false);await f.router.close();
});
test('Attachment exception cannot change config, project files, other environments or unreviewed filesystem methods',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:230,method:'thread/read',params:{threadId:'existing'}});
  const directory=uploadRoot+'/'+uploadId;
  const requests=[
    ['fs/writeFile',{path:'/home/test/.codex/config.toml'}],
    ['fs/writeFile',{path:directory+'/../../config.toml'}],
    ['fs/createDirectory',{path:uploadRoot}],
    ['fs/writeFile',{path:uploadRoot+'/arbitrary.json'}],
    ['fs/remove',{path:uploadRoot,recursive:true}],
    ['fs/remove',{path:uploadRoot+'/pasted-text-attachments.json'}],
    ['fs/writeFile',{path:directory+'/nested/file'}],
    ['fs/writeFile',{path:uploadRoot+'-sibling/'+uploadId+'/image.png'}],
    ['fs/createDirectory',{path:uploadRoot+'/not-a-uuid'}],
    ['fs/writeFile',{path:directory+'/image.png',environmentId:'foreign'}],
    ['fs/futureWriter',{path:directory+'/image.png'}],
    ['fs/copy',{sourcePath:'/repo/brai/file',destinationPath:directory+'/image.png'}],
    ['command/exec',{cwd:directory,command:['anything']}],
  ];
  for(let i=0;i<requests.length;i++) {
    const [method,params]=requests[i],frame={id:240+i,method,params};await f.router.receive(frame);
    assert.ok(f.frames.find(x=>x.id===frame.id)?.error,method+' must remain denied');
    assert.equal(f.admin.some(x=>x.id===frame.id),false);
  }
  await f.router.close();
});
test('Attachment writes reject symlinked roots, directories and files',async()=>{
  for(const redirected of [uploadRoot,uploadRoot+'/'+uploadId,uploadRoot+'/'+uploadId+'/image.png']) {
    const f=fixture({cwd:'/repo/brai',resolvePath:async value=>value===redirected||value.startsWith(redirected+'/')?value.replace(redirected,'/outside'):value});
    await init(f);await f.router.receive({id:270,method:'thread/read',params:{threadId:'existing'}});
    await f.router.receive({id:271,method:'fs/writeFile',params:{path:uploadRoot+'/'+uploadId+'/image.png'}});
    assert.equal(f.frames.at(-1).error.message,'BRAI_UNTHREADED_WRITE_DENIED');await f.router.close();
  }
});

const visualRoot='/home/test/.codex/visualizations';
const visualDirectory=visualRoot+'/2026/10/22/01a1648d-670b-7e10-a5b0-cae034ec76b1';
test('Desktop text submit can create its visualization directory on a mixed connection',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:300,method:'thread/read',params:{threadId:'existing'}});
  const frame={id:301,method:'fs/createDirectory',params:{path:visualDirectory,recursive:true}};
  await f.router.receive(frame);assert.deepEqual(f.admin.at(-1),frame);
  assert.equal(f.frames.some(x=>x.error),false);await f.router.close();
});
test('Visualization preparation admits no file writer, deletion, foreign environment or malformed path',async()=>{
  const f=fixture({cwd:'/repo/brai'});await init(f);
  await f.router.receive({id:310,method:'thread/read',params:{threadId:'existing'}});
  const cases=[
    ['fs/createDirectory',{path:visualRoot}],
    ['fs/createDirectory',{path:visualRoot+'/2026/10/22'}],
    ['fs/createDirectory',{path:visualDirectory+'/nested'}],
    ['fs/createDirectory',{path:visualDirectory,environmentId:'foreign'}],
    ['fs/createDirectory',{path:visualRoot+'/2026/99/22/01a1648d-670b-7e10-a5b0-cae034ec76b1'}],
    ['fs/createDirectory',{path:visualRoot+'/2026/10/22/not-a-thread'}],
    ['fs/createDirectory',{path:visualRoot+'-sibling/2026/10/22/01a1648d-670b-7e10-a5b0-cae034ec76b1'}],
    ['fs/writeFile',{path:visualDirectory+'/file.html'}],
    ['fs/remove',{path:visualDirectory,recursive:true}],
    ['fs/futureWriter',{path:visualDirectory}],
    ['command/exec',{cwd:visualDirectory,command:['opaque']}],
  ];
  for(let i=0;i<cases.length;i++){
    const [method,params]=cases[i],frame={id:320+i,method,params};await f.router.receive(frame);
    assert.ok(f.frames.find(x=>x.id===frame.id)?.error);assert.equal(f.admin.some(x=>x.id===frame.id),false);
  }
  await f.router.close();
});
test('Visualization preparation rejects symlinked root, date parents and directory',async()=>{
  for(const redirected of [visualRoot,visualRoot+'/2026',visualDirectory]){
    const f=fixture({cwd:'/repo/brai',resolvePath:async value=>value===redirected||value.startsWith(redirected+'/')?value.replace(redirected,'/outside'):value});
    await init(f);await f.router.receive({id:350,method:'thread/read',params:{threadId:'existing'}});
    await f.router.receive({id:351,method:'fs/createDirectory',params:{path:visualDirectory,recursive:true}});
    assert.equal(f.frames.at(-1).error.message,'BRAI_UNTHREADED_WRITE_DENIED');await f.router.close();
  }
});
