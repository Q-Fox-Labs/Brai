// ABOUTME: Проверяет реальный Unix HTTP/WS transport без моделей и без native writers.
// ABOUTME: Backend fixtures проверяют маршруты, daemon HTTP и shutdown websocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {universalMain} from './codex.mjs';

test('Universal Unix listener preserves HTTP, Admin WS and daemon shutdown; Brai stays lazy',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-universal-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');
 const native=createServer((req,res)=>{res.writeHead(207,{'x-native':'yes'});res.end(req.method+' '+req.url);});
 const wss=new WebSocketServer({noServer:true});native.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{ws.on('message',data=>{if(req.url==='/daemon/shutdown')ws.send(data.toString());else {const frame=JSON.parse(data);if(frame.id!==undefined)ws.send(JSON.stringify({id:frame.id,result:{native:frame.method}}));}});}));
 await new Promise(resolve=>native.listen(upstream,resolve));let spawned=0;
 const proxy=await universalMain({listen,upstream,roots:['/srv/projects/brai-dev']},{openBrai:()=>{spawned++;throw Error('UNEXPECTED_BRAI');}});
 try {
  const http=await new Promise((resolve,reject)=>{const req=request({socketPath:listen,path:'/unknown?q=1',method:'POST'},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({code:res.statusCode,header:res.headers['x-native'],body}));});req.on('error',reject);req.end();});
  assert.deepEqual(http,{code:207,header:'yes',body:'POST /unknown?q=1'});
  const admin=new WebSocket('ws+unix://'+listen+':/');await once(admin,'open');const message=once(admin,'message');admin.send(JSON.stringify({id:7,method:'thread/start',params:{cwd:'/srv/projects/admin'}}));assert.deepEqual(JSON.parse((await message)[0]),{id:7,result:{native:'thread/start'}});admin.close();await once(admin,'close');
  for(const route of ['/app-server','/rpc']) {
  const desktop=new WebSocket('ws+unix://'+listen+':'+route);await once(desktop,'open');
  const desktopReply=once(desktop,'message');desktop.send(JSON.stringify({id:8,method:'thread/list',params:{}}));
  assert.deepEqual(JSON.parse((await desktopReply)[0]),{id:8,result:{native:'thread/list'}});desktop.close();await once(desktop,'close');
  }
  const unknown=new WebSocket('ws+unix://'+listen+':/unregistered');
  const rejected=await new Promise((resolve,reject)=>{unknown.once('unexpected-response',(_req,response)=>{response.resume();resolve(response.statusCode);unknown.terminate();});unknown.once('open',()=>reject(Error('UNKNOWN_PATH_ACCEPTED')));unknown.on('error',()=>{});});
  assert.equal(rejected,404);
  const shutdown=new WebSocket('ws+unix://'+listen+':/daemon/shutdown');await once(shutdown,'open');const reply=once(shutdown,'message');shutdown.send('12345');assert.equal((await reply)[0].toString(),'12345');shutdown.close();await once(shutdown,'close');
  assert.equal(spawned,0);
 }finally{await proxy.stop();for(const client of wss.clients)client.terminate();wss.close();await new Promise(resolve=>native.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('Owned native upstream becomes ready before the listener accepts RPC and is reaped on stop',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-startup-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');
 const code="const http=require('node:http');setTimeout(()=>http.createServer((req,res)=>res.end('native-ready')).listen(process.argv[1]),150)";
 let proxy;
 try {
  proxy=await universalMain({listen,upstream,roots:['/srv/projects/brai-dev'],upstreamCommand:[process.execPath,'-e',code,upstream]});
  const body=await new Promise((resolve,reject)=>{request({socketPath:listen,path:'/'},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));}).on('error',reject).end();});
  assert.equal(body,'native-ready');
 }finally{await proxy?.stop();await rm(dir,{recursive:true,force:true});}
});
