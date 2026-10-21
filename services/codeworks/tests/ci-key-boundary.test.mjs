// ABOUTME: Проверяет, что native и broker commands не читают скрытый CI private key.
// ABOUTME: Opt-in boundary test использует только временные файлы, fake contract и локальный bwrap.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgentHost, socketCall} from '../src/agent-host.mjs';
import {sandboxArgs} from '../src/agent-sandbox.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const enabled=process.env.CODEWORKS_TEST_KEY_BOUNDARY==='1';

test('CI key stays unreadable to native and broker commands under the same UID',{skip:!enabled,timeout:30000},async t=>{
  // Unix-domain socket paths are limited; keep this isolated fixture short.
  const parent=mkdtempSync(path.join(projectRoot,'tmp/kb-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const repository=path.join(parent,'repo'),workspaceBase=path.join(parent,'workspaces'),workspace=path.join(workspaceBase,'feature');
  const privateDirectory=path.join(parent,'private'),stateRoot=path.join(projectRoot,'tmp','s'+randomBytes(2).toString('hex')),keyPath=path.join(privateDirectory,'identity.pem');
  for(const directory of [repository,workspaceBase,workspace,privateDirectory,stateRoot,path.join(repository,'.git'),path.join(workspace,'.git'),path.join(repository,'node_modules'),path.join(workspace,'node_modules')])mkdirSync(directory,{recursive:true});
  t.after(()=>rmSync(stateRoot,{recursive:true,force:true}));
  writeFileSync(keyPath,'synthetic-private-key-marker-must-never-be-read\n',{mode:0o600});
  const uid=String(process.getuid());
  const shell=['/bin/sh','-c','test ! -r "$1/identity.pem" && test "$(id -u)" = "$2"','boundary',privateDirectory,uid];

  const native=spawnSync('/usr/bin/bwrap',[
    ...sandboxArgs({cwd:repository,hidden:[privateDirectory]}),...shell,
  ],{encoding:'utf8',timeout:15000});
  assert.equal(native.error,undefined,'native bwrap command must start');
  assert.equal(native.status,0,'native shell must not read identity.pem and must retain the owner UID');
  assert.equal(native.stdout,'','native boundary check must not print file contents');

  const project={id:'project-1',repo_path:repository,workspace_root:workspaceBase,allowed_paths:['.'],excluded_paths:[],documentation_paths:[]};
  let writerSession;
  const contract=async(method,args,executor)=>{
    if(method==='project.get')return {project};
    if(method==='prepare-write') {
      writerSession=args.session_id;
      return {operation_id:'operation-1',workspace_id:'workspace-1'};
    }
    if(method==='operation-status')return {operation:{id:args.operation_id,status:'succeeded'}};
    if(method==='status')return {workspace:{
      id:args.workspace_id,path:workspace,preparation_state:'ready',
      writer:{state:'active',executor_id:executor,session_id:writerSession,epoch:1},
    }};
    throw Error(`Unexpected fake contract method: ${method}`);
  };
  const hostErrors=[];
  const host=await createAgentHost({
    state_root:stateRoot,hidden_paths:[privateDirectory],projects:[project.id],adapter_project_id:project.id,
    executors:{codex:{},hermes:{}},require_immutable:false,bwrap:'/usr/bin/bwrap',command_timeout_ms:15000,onError:error=>hostErrors.push(error.message),
  },contract);
  try {
    const control=request=>socketCall(path.join(stateRoot,'control.sock'),request);
    let session;
    try{session=await control({action:'open',project_id:project.id,executor_id:'codex'});}catch(error){throw Error(`${error.message}: ${hostErrors.join('; ')}`);}
    const call=request=>socketCall(session.socket,request);
    const read=await call({action:'command',mode:'read',argv:shell});
    assert.equal(read.exit_code,0,'read_command must hide the key and preserve the owner UID');
    assert.equal(read.stdout,'','read_command must not print file contents');

    await assert.rejects(call({action:'read',path:keyPath}),/PATH_DENIED/,'absolute filetool access to the key must be denied');

    const write=await call({action:'command',mode:'write',argv:shell});
    assert.equal(write.exit_code,0,`write_command must hide the key and preserve the owner UID: ${write.stderr}`);
    assert.equal(write.stdout,'','write_command must not print file contents');
    assert.equal(write.root,workspace);
  } finally {await host.close();}
});
