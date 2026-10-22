// ABOUTME: Проверяет независимость readonly inspect от host и bounds private port.
// ABOUTME: Child process заменён транспортным портом; реальные namespace mounts проверяет isolated acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm,unlink,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {socketCall} from '../codeworks/src/agent-host.mjs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadonlyInspector,validateInspect,createNativePort,startInspectSocket} from './codex-inspect.mjs';
const identity='11111111-1111-4111-8111-111111111111';
test('Inspect rejects foreign fields, cwd, missing identity, argv overflow and NUL',()=>{
  for(const request of [
    {action:'inspect',native_session_id:identity,argv:['cat'],cwd:'/'},
    {action:'inspect',native_session_id:'other',argv:['cat']},
    {action:'inspect',native_session_id:identity,argv:[]},
    {action:'inspect',native_session_id:identity,argv:Array(129).fill('a')},
    {action:'inspect',native_session_id:identity,argv:['bad\0arg']},
  ])assert.throws(()=>validateInspect(request));
});
async function fixture(output='ok') {
  const root=await mkdtemp(path.join(tmpdir(),'cw-inspect-'));
  await writeFile(path.join(root,'.env'),'private');
  const descriptor={project:{repo_path:root,workspace_root:root+'/workspaces',excluded_paths:['.git','node_modules','.env']},state_root:'/state',hidden_paths:['/home/agent','/etc/brai-dev']};
  let invocation;
  const inspect=createReadonlyInspector({descriptor,controlSocket:'/fixed/control',call:async()=>{throw new Error('CORE_DOWN');},
    execute(executable,args,options) {
      invocation={executable,args,options};
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      let closed=false;const close=code=>{if(!closed){closed=true;child.emit('close',code);}};
      child.kill=()=>{setImmediate(()=>close(null));return true;};
      setImmediate(()=>{child.stdout.write(output);close(0);});return child;
    }});
  return {root,inspect,invocation:()=>invocation,close:()=>rm(root,{recursive:true,force:true})};
}
test('Core outage still runs diagnostics against labelled readonly source with secret mask and no network',async()=>{
  const f=await fixture();
  try {
    const result=await f.inspect({action:'inspect',native_session_id:identity,argv:['unknown-command','argument']});
    assert.equal(result.stdout,'ok');assert.equal(result.root,f.root);assert.equal(result.source_fallback,true);
    const run=f.invocation();assert.equal(run.executable,'/usr/bin/bwrap');
    assert.ok(run.args.includes('--unshare-net'));assert.ok(run.args.includes('--ro-bind'));
    assert.equal(run.args.includes('--bind'),false);
    assert.ok(run.args.includes('/dev/null'));assert.ok(run.args.includes(path.join(f.root,'.env')));
    assert.deepEqual(run.options.stdio,['ignore','pipe','pipe']);
    assert.deepEqual(run.args.slice(-2),['unknown-command','argument']);
  }finally{await f.close();}
});
test('Even escaped output fits the one MiB response budget',async()=>{
  const f=await fixture('\0'.repeat(300000));
  try {
    const result=await f.inspect({action:'inspect',native_session_id:identity,argv:['unknown']});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=1024*1024);
    assert.ok(result.stdout.length<300000);
  }finally{await f.close();}
});

test('Stable native port reconnects after core socket inode rotation without retrying a failed call',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'cw-port-')),control=path.join(dir,'control.sock'),adapter=path.join(dir,'adapter.sock'),port=path.join(dir,'proxy.sock');
 let requests=0;const payload=JSON.stringify({native_session_id:identity,request:{action:'status'}}),envelope={payload,signature:'a'.repeat(64)};
 async function endpoint(file,handler){
  const server=createServer({allowHalfOpen:true},stream=>{let data='';stream.on('data',chunk=>data+=chunk);stream.on('end',()=>{stream.end(JSON.stringify(handler(JSON.parse(data)))+'\n');});stream.on('error',()=>{});});
  await new Promise(resolve=>server.listen(file,resolve));return async()=>{await new Promise(resolve=>server.close(resolve));await unlink(file).catch(()=>{});};
 }
 let stopControl,stopAdapter,stopPort;
 try {
  stopControl=await endpoint(control,()=>({socket:adapter,key:'b'.repeat(64)}));
  stopAdapter=await endpoint(adapter,request=>{requests++;return {generation:1,thread:JSON.parse(request.payload).native_session_id};});
  stopPort=await startInspectSocket(port,createNativePort({controlSocket:control,adapterSocket:adapter,inspect:async request=>{validateInspect(request);return {stdout:'source diagnostic',source_fallback:true};}}));
  const inode=(await stat(port)).ino;
  assert.equal((await socketCall(port,{action:'adapter',executor_id:'codex'})).socket,'/run/codeworks.sock');
  assert.deepEqual(await socketCall(port,envelope),{generation:1,thread:identity});
  await stopAdapter();stopAdapter=undefined;await stopControl();stopControl=undefined;
  await assert.rejects(socketCall(port,envelope));assert.equal(requests,1);
  assert.equal((await socketCall(port,{action:'inspect',native_session_id:identity,argv:['pwd']})).source_fallback,true);
  stopControl=await endpoint(control,()=>({socket:adapter,key:'c'.repeat(64)}));
  stopAdapter=await endpoint(adapter,request=>{requests++;return {generation:2,thread:JSON.parse(request.payload).native_session_id};});
  assert.equal((await socketCall(port,{action:'adapter',executor_id:'codex'})).key,'c'.repeat(64));
  assert.deepEqual(await socketCall(port,envelope),{generation:2,thread:identity});
  assert.equal((await stat(port)).ino,inode);assert.equal(requests,2);
  await assert.rejects(socketCall(port,{action:'adapter',executor_id:'hermes'}),/NATIVE_PORT_REQUEST_INVALID/);
  await assert.rejects(socketCall(port,{payload,signature:'invalid'}),/NATIVE_PORT_REQUEST_INVALID/);
 }finally{await stopPort?.();await stopAdapter?.();await stopControl?.();await rm(dir,{recursive:true,force:true});}
});
