// ABOUTME: Проверяет инструкции при MCP initialize и предел незавершённых сокетов.
// ABOUTME: Использует собственный ephemeral loopback listener без БД и NATS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
import {startMcp,agentInstructions} from '../dist/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGate} from '../dist/load.js';
test('MCP bounds incomplete HTTP sockets before authentication',async()=>{
 const gate=createGate();let authenticated=0;const sockets=[];
 const runtime=await startMcp({host:'127.0.0.1',port:0,allowedHosts:['127.0.0.1'],allowedOrigins:[],principalsFile:'/unused',maxConnections:2},gate,async()=>{authenticated++;throw Error('unused');},async()=>({}));
 try{
  const port=new URL(runtime.url).port;
  for(let i=0;i<10;i++){const socket=createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});sockets.push(socket);}
  await new Promise(r=>setTimeout(r,100));
  const count=await new Promise((resolve,reject)=>runtime.http.getConnections((e,n)=>e?reject(e):resolve(n)));
  assert.ok(count>0&&count<=2,'Incomplete connections must consume at most configured socket limit');assert.equal(authenticated,0);
 }finally{for(const socket of sockets)socket.destroy();await runtime.close();gate.stop();await gate.drain();}
});

test('new MCP client receives a short reminder and loads help only on demand',async()=>{
 const gate=createGate(),hosts=[],principal={ownerId:'fixture',actorId:'fixture',source:'codex',reviewer:false};
 let effects=0;
 const runtime=await startMcp({host:'127.0.0.1',port:0,allowedHosts:hosts,allowedOrigins:[],principalsFile:'/unused',maxConnections:4},gate,async()=>principal,async()=>{effects++;return {};});
 hosts.push(new URL(runtime.url).host);
 const client=new Client({name:'instruction-fixture',version:'1.0.0'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url)));
  assert.equal(client.getInstructions(),agentInstructions);
  assert.ok(client.getInstructions().length<150);
  assert.ok(client.getInstructions().includes('bug_hunt_help'));
  const guide=await client.callTool({name:'bug_hunt_help',arguments:{}});
  assert.ok(guide.content[0].text.includes('request_id'));
  assert.ok(guide.content[0].text.includes('Пример входа'));
  assert.ok(guide.content[0].text.length>client.getInstructions().length);
  const invalid=await client.callTool({name:'bug_hunt_help',arguments:{owner_id:'forged'}});
  assert.equal(invalid.isError,true);assert.equal(effects,0);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['bug_hunt_help','bug_hunt_report','bug_hunt_get','bug_hunt_list']);
 }finally{await client.close();await runtime.close();gate.stop();await gate.drain();}
});

test('diagnostic writes are visible and callable only for the designated MCP identity',async()=>{
 const gate=createGate(),hosts=[];
 const identities={ordinary:'codex:ordinary',investigator:'codex:investigator'};
 const runtime=await startMcp({host:'127.0.0.1',port:0,allowedHosts:hosts,allowedOrigins:[],principalsFile:'/unused',maxConnections:4,investigators:['codex:investigator']},gate,
  async header=>({ownerId:'fixture',actorId:identities[header.split(' ')[1]],source:'codex',reviewer:false}),async()=>({}),undefined,undefined,
  async (operation,principal)=>({operation,actor:principal.actorId}));
 hosts.push(new URL(runtime.url).host);
 try {
  for(const identity of Object.keys(identities)) {
   const client=new Client({name:identity,version:'1.0.0'});
   try {
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url),{requestInit:{headers:{authorization:'Bearer '+identity}}}));
    const visible=(await client.listTools()).tools.some(tool=>tool.name==='bug_hunt_investigation_claim');
    const result=await client.callTool({name:'bug_hunt_investigation_claim',arguments:{request_id:'ac886e81-cc92-4ad0-b3e5-9eeda5bf72d2'}});
    if(identity==='investigator') {
     assert.equal(visible,true);
     assert.deepEqual(result.structuredContent,{operation:'claim',actor:'codex:investigator'});
    } else {
     assert.equal(visible,false);
     assert.equal(result.isError,true);
    }
   } finally {await client.close();}
  }
 } finally {await runtime.close();gate.stop();await gate.drain();}
});
