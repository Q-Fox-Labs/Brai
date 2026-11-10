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

test('new MCP client receives the full protocol during initialize',async()=>{
 const gate=createGate(),hosts=[],principal={ownerId:'fixture',actorId:'fixture',source:'codex',reviewer:false};
 const runtime=await startMcp({host:'127.0.0.1',port:0,allowedHosts:hosts,allowedOrigins:[],principalsFile:'/unused',maxConnections:4},gate,async()=>principal,async()=>({}));
 hosts.push(new URL(runtime.url).host);
 const client=new Client({name:'instruction-fixture',version:'1.0.0'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url)));
  assert.equal(client.getInstructions(),agentInstructions);
  assert.ok(client.getInstructions().includes('request_id'));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['bug_hunt_report','bug_hunt_get','bug_hunt_list']);
 }finally{await client.close();await runtime.close();gate.stop();await gate.drain();}
});
