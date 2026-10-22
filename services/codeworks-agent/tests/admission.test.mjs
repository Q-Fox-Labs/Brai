// ABOUTME: Проверяет допуск native thread/turn и запрет повторной подписи tool call.
// ABOUTME: Дочерняя identity появляется только из события активного родителя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdmission,decodeNativeFrame,forwardNativeFrame} from '../codex.mjs';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';


test('native admission fences unknown, completed and replayed calls while admitting actual child lifecycle',()=>{
  const a=createAdmission(),tool=(threadId,turnId,id)=>({id,params:{threadId,turnId}});
  assert.throws(()=>a.expect('unknown'),/NOT_ADMITTED/);
  a.thread('parent');a.expect('parent');
  a.observe({method:'turn/started',params:{threadId:'parent',turn:{id:'p1'}}});
  assert.throws(()=>a.tool(tool('other','p1',1)),/NOT_ADMITTED/);
  assert.throws(()=>a.tool(tool('parent','wrong',1)),/NOT_ADMITTED/);
  a.tool(tool('parent','p1',1));assert.throws(()=>a.tool(tool('parent','p1',1)),/NOT_ADMITTED/);
  assert.throws(()=>a.observe({method:'item/started',params:{threadId:'other',turnId:'p1',item:{type:'subAgentActivity',agentThreadId:'forged'}}}),/NOT_ADMITTED/);
  a.observe({method:'item/started',params:{threadId:'parent',turnId:'p1',item:{type:'subAgentActivity',agentThreadId:'child'}}});
  a.observe({method:'turn/started',params:{threadId:'child',turn:{id:'c1'}}});a.tool(tool('child','c1',2));
  a.observe({method:'turn/completed',params:{threadId:'child',turn:{id:'c1'}}});
  assert.throws(()=>a.tool(tool('child','c1',3)),/NOT_ADMITTED/);
  a.observe({method:'turn/completed',params:{threadId:'parent',turn:{id:'p1'}}});
  assert.throws(()=>a.tool(tool('parent','p1',4)),/NOT_ADMITTED/);
});

test('CLI main runs through immutable OCI symlinks and fails closed without managed configuration',async()=>{
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {fileURLToPath}=await import('node:url');
 const root=await mkdtemp(tmpdir()+'/cw-entry-');
 try{for(const name of ['codex','hermes']){
  const alias=root+'/'+name+'.mjs';await symlink(fileURLToPath(new URL('../'+name+'.mjs',import.meta.url)),alias);
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('CODEWORKS_'))delete env[key];
  const result=spawnSync(process.execPath,[alias],{env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/Codeworks .* adapter failed/);
 }}finally{await rm(root,{recursive:true,force:true});}
});

test('private Hermes port separates exact advertised owner calls from trusted plugin capability',async()=>{
 const {PassThrough,Duplex}=await import('node:stream');const {once}=await import('node:events');
 const {serveOwnerBridge}=await import('../hermes.mjs');
 const input=new PassThrough(),output=new PassThrough(),server=Duplex.from({readable:input,writable:output});
 const calls=[];let replies='';output.on('data',chunk=>{replies+=chunk;});
 const stop=serveOwnerBridge(server,{tools:[{name:'elements_graph_get'}],call:async(name,args)=>{calls.push([name,args]);return {elements:[]};}},async request=>({trusted:JSON.parse(request).method}),'private-cap');
 async function send(request){replies='';input.write(JSON.stringify({id:'1'.repeat(32),...request})+'\n');while(!replies.endsWith('\n'))await new Promise(r=>setTimeout(r,1));const {id,...reply}=JSON.parse(replies);assert.equal(id,'1'.repeat(32));return reply;}
 assert.deepEqual(await send({channel:'owner',name:'elements_graph_get',args:{}}),{result:{elements:[]}});
 assert.equal((await send({channel:'owner',name:'actions.complete',args:{}})).error,'PRIVATE_CALL_REJECTED');
 assert.equal((await send({channel:'owner',name:'elements_graph_get',args:{},capability:'private-cap'})).error,'PRIVATE_CALL_REJECTED');
 assert.equal((await send({channel:'trusted',capability:'forged',request:{method:'actions.complete'}})).error,'PRIVATE_CALL_REJECTED');
 assert.deepEqual(await send({channel:'trusted',capability:'private-cap',request:{method:'actions.read'}}),{result:{trusted:'actions.read'}});
 assert.deepEqual(calls,[['elements_graph_get',{}]]);stop();
});

test('Hermes bootstrap consumes private data and authorizes only exact canonical plugin code',async()=>{
 const {execFileSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 assert.match(execFileSync('python3',['-B',fileURLToPath(new URL('./hermes-private.py',import.meta.url))],{encoding:'utf8',timeout:15000}),/PASS private Hermes/);
});

test('18MB native catalogue and following notification cross actual text WebSocket in order',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'codeworks-native-frames-')),socket=path.join(root,'rpc.sock');
  const server=createServer(),wss=new WebSocketServer({server});let client,peer;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
    const connected=once(wss,'connection');client=new WebSocket('ws+unix://'+socket+':/');
    [peer]=await connected;await once(client,'open');client._socket.pause();
    const messages=[];const completed=new Promise((resolve,reject)=>{
      client.on('error',reject);client.on('message',(bytes,binary)=>{messages.push({frame:JSON.parse(bytes),binary});if(messages.length===2)resolve();});
    });
    const catalogue={id:1,result:{catalogue:'x'.repeat(18438186)}};
    assert.equal(decodeNativeFrame(JSON.stringify(catalogue)).result.catalogue.length,18438186);
    assert.equal(forwardNativeFrame(peer,catalogue),true);
    assert(peer.bufferedAmount>2*1024*1024,'real slow-client backlog exceeds the old 2MiB disconnect threshold');
    assert.equal(forwardNativeFrame(peer,{method:'thread/started',params:{}}),true);
    client._socket.resume();await completed;
    assert.deepEqual(messages.map(m=>[m.frame.id??m.frame.method,m.binary]),[[1,false],['thread/started',false]]);
    assert.equal(messages[0].frame.result.catalogue.length,18438186);
  } finally {
    client?.terminate();peer?.terminate();await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
  }
});

test('native output over 32MiB and pending total over 34MiB remain rejected',()=>{
  const oversized=JSON.stringify({result:'x'.repeat(32*1024*1024)});
  assert.throws(()=>decodeNativeFrame(oversized),/CODEX_NATIVE_OUTPUT_LIMIT/);
  let sent=0,terminated=0,encoded=0;
  const peer={readyState:1,bufferedAmount:0,send(){sent++;},terminate(){terminated++;}};
  assert.equal(forwardNativeFrame(peer,{toJSON(){encoded++;return {result:'x'.repeat(32*1024*1024)};}}),false);
  assert.equal(encoded,1);assert.equal(sent,0);assert.equal(terminated,1);
  peer.bufferedAmount=34*1024*1024-10;
  assert.equal(forwardNativeFrame(peer,{method:'thread/started',params:{}}),false);
  assert.equal(sent,0);assert.equal(terminated,2);
  peer.bufferedAmount=0;
  assert.equal(forwardNativeFrame(peer,{result:'within limit'}),true);assert.equal(sent,1);
});
