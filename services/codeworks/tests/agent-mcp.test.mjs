// ABOUTME: Проверяет native MCP identity, подпись и отказоустойчивость Codeworks adapter без БД и продукта.
// ABOUTME: Использует настоящий SDK transport; fake host не исполняет команды и не создаёт рабочие области.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createAgentMcpServer} from '../src/agent-mcp.mjs';

const first='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const session='33333333-3333-4333-8333-333333333333';
const descriptor={socket:'/private/adapter.sock',key:'ab'.repeat(32)};

async function fixture(t,call){
  const server=createAgentMcpServer({controlSocket:'/private/control.sock',call});
  const client=new Client({name:'native-codex-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  t.after(async()=>{await client.close();await server.close();});
  return client;
}
const invoke=(client,args={action:'status'},meta={threadId:first,sessionId:session})=>client.callTool({name:'codeworks',arguments:args,...(meta===undefined?{}:{_meta:meta})});
const failure=(result,code)=>{assert.equal(result.isError,true);assert.match(result.content[0].text,new RegExp('^'+code+':'));};

test('publishes existing file/patch/command schema without identity arguments',async t=>{
  const client=await fixture(t,async()=>assert.fail('listing must not contact host'));
  const {tools}=await client.listTools();
  assert.deepEqual(tools,[JSON.parse(await readFile(new URL('../src/agent-tools.json',import.meta.url),'utf8'))]);
  assert.equal(tools[0].inputSchema.additionalProperties,false);
  for(const key of ['threadId','sessionId','native_session_id','controlSocket'])assert.equal(tools[0].inputSchema.properties[key],undefined);
});

test('signs native threadId, preserves arguments, and ignores native process sessionId',async t=>{
  const calls=[];
  const client=await fixture(t,async(socket,request)=>{
    calls.push({socket,request});
    if(socket==='/private/control.sock')return descriptor;
    assert.equal(request.signature,createHmac('sha256',Buffer.from(descriptor.key,'hex')).update(request.payload).digest('hex'));
    return {root:'/own/workspace',workspace:null};
  });
  const args={action:'read',path:'services/codeworks/CONTRACT.md'};
  const result=await invoke(client,args);
  assert.deepEqual(result.structuredContent,{root:'/own/workspace',workspace:null});
  assert.deepEqual(calls[0],{socket:'/private/control.sock',request:{action:'adapter',executor_id:'codex'}});
  assert.deepEqual(JSON.parse(calls[1].request.payload),{native_session_id:first,request:args});
  assert.equal(JSON.stringify(result).includes(descriptor.key),false);
});

test('rejects missing, non-string and malformed native identity before host lookup',async t=>{
  const client=await fixture(t,async()=>assert.fail('invalid identity reached host'));
  for(const meta of [{},{sessionId:session},{threadId:null},{threadId:1},{threadId:[]},{threadId:'../other'},{threadId:first+'x'},{threadId:first.toUpperCase().replace('1111','AAAA')}]){
    failure(await invoke(client,{action:'status'},meta),'NATIVE_THREAD_ID_REQUIRED');
  }
  failure(await client.callTool({name:'codeworks',arguments:{action:'status'}}),'NATIVE_THREAD_ID_REQUIRED');
});

test('model arguments cannot supply thread/session/socket identity',async t=>{
  const client=await fixture(t,async()=>assert.fail('untrusted arguments reached host'));
  for(const key of ['threadId','sessionId','native_session_id','executor_id','controlSocket','_meta']){
    failure(await invoke(client,{action:'status',[key]:second}),'INVALID_ARGUMENT');
  }
  failure(await invoke(client,{}),'INVALID_ARGUMENT');
  failure(await client.callTool({name:'unknown',arguments:{action:'status'},_meta:{threadId:first}}),'INVALID_ARGUMENT');
});

test('concurrent threads sharing one MCP server retain independent metadata',async t=>{
  const pending=new Map();
  let both;
  const arrived=new Promise(resolve=>{both=resolve;});
  const client=await fixture(t,async(socket,request)=>{
    if(socket==='/private/control.sock')return descriptor;
    const payload=JSON.parse(request.payload);
    const response=new Promise(resolve=>pending.set(payload.native_session_id,()=>resolve({thread:payload.native_session_id,path:payload.request.path})));
    if(pending.size===2)both();
    return response;
  });
  const a=invoke(client,{action:'read',path:'a'},{threadId:first,sessionId:session});
  const b=invoke(client,{action:'read',path:'b'},{threadId:second,sessionId:session});
  await arrived;
  pending.get(second)();pending.get(first)();
  assert.deepEqual((await a).structuredContent,{thread:first,path:'a'});
  assert.deepEqual((await b).structuredContent,{thread:second,path:'b'});
});

test('host failure preserves fencing without retries or credential leakage',async t=>{
  let calls=0;
  const client=await fixture(t,async socket=>{
    calls++;
    if(socket==='/private/control.sock')return descriptor;
    throw new Error('WRITER_FENCED');
  });
  failure(await invoke(client,{action:'batch',operations:[{op:'write',path:'x',content:'x'}]}),'WRITER_FENCED');
  assert.equal(calls,2);
  const unavailable=await fixture(t,async()=>{throw new Error('secret '+descriptor.key);});
  const result=await invoke(unavailable);
  failure(result,'CODEWORKS_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes(descriptor.key),false);
  const denied=await fixture(t,async()=>{throw Object.assign(new Error('private path'),{code:'EACCES'});});
  failure(await invoke(denied),'CODEWORKS_ACCESS_DENIED');
});

test('invalid host descriptor fails closed before sending arguments',async t=>{
  let calls=0;
  const client=await fixture(t,async()=>{calls++;return {socket:'relative',key:'bad'};});
  failure(await invoke(client),'ADAPTER_DESCRIPTOR_INVALID');assert.equal(calls,1);
  assert.throws(()=>createAgentMcpServer(),/CODEWORKS_CONTROL_SOCKET_REQUIRED/);
});

test('stdio executable uses each native call identity through real Unix host transport',async t=>{
  await mkdir('tmp',{recursive:true});
  const directory=await mkdtemp(resolve('tmp/mcp-'));
  const controlSocket=directory+'/c',adapterSocket=directory+'/a';
  const received=[];
  async function listen(socket,respond){
    const server=createServer(stream=>{
      let text='';
      stream.on('data',chunk=>{text+=chunk;});
      stream.on('end',()=>{
        try{stream.end(JSON.stringify(respond(JSON.parse(text)))+'\n');}
        catch{stream.end(JSON.stringify({error:'FAKE_HOST_FAILED'})+'\n');}
      });
    });
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(socket,done);});
    t.after(()=>new Promise(done=>server.close(done)));
  }
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await listen(controlSocket,request=>{
    assert.deepEqual(request,{action:'adapter',executor_id:'codex'});
    return {...descriptor,socket:adapterSocket};
  });
  await listen(adapterSocket,envelope=>{
    assert.equal(envelope.signature,createHmac('sha256',Buffer.from(descriptor.key,'hex')).update(envelope.payload).digest('hex'));
    const payload=JSON.parse(envelope.payload);received.push(payload);
    if(payload.request.action==='batch')return {error:'private host error '+descriptor.key};
    return {thread:payload.native_session_id};
  });
  const client=new Client({name:'native-stdio-test',version:'1.0.0'});
  const transport=new StdioClientTransport({
    command:process.execPath,args:[fileURLToPath(new URL('../src/agent-mcp.mjs',import.meta.url))],
    env:{CODEWORKS_CONTROL_SOCKET:controlSocket,CODEX_THREAD_ID:second},stderr:'pipe'
  });
  t.after(()=>client.close());
  await client.connect(transport);
  assert.equal((await invoke(client)).structuredContent.thread,first);
  assert.equal((await invoke(client,{action:'status'},{threadId:second,sessionId:session})).structuredContent.thread,second);
  failure(await client.callTool({name:'codeworks',arguments:{action:'status'}}),'NATIVE_THREAD_ID_REQUIRED');
  const error=await invoke(client,{action:'batch',operations:[{op:'write',path:'x',content:'x'}]});
  failure(error,'CODEWORKS_UNAVAILABLE');assert.equal(JSON.stringify(error).includes(descriptor.key),false);
  assert.deepEqual(received.map(row=>row.native_session_id),[first,second,first]);
});
