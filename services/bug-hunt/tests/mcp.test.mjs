// ABOUTME: Проверяет предел сокетов до HTTP заголовков и аутентификации.
// ABOUTME: Использует собственный ephemeral loopback listener без БД и NATS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
import {startMcp} from '../dist/mcp.js';
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
