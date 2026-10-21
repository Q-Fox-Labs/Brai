// ABOUTME: Проверяет допуск native thread/turn и запрет повторной подписи tool call.
// ABOUTME: Дочерняя identity появляется только из события активного родителя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdmission} from '../codex.mjs';

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
