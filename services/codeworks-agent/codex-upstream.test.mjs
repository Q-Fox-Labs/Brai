// ABOUTME: Проверяет reuse, cold start и отказ gateway при потере общего daemon.
// ABOUTME: Использует только собственные Unix socket fixtures без моделей и проектных writers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {nativeUpstreamExists,universalMain} from './codex.mjs';

test('Only absent/refused upstream permits spawn admission; access, loop and timeout fail closed',async()=>{
 for(const code of ['ENOENT','ECONNREFUSED','EACCES','ELOOP','ETIMEDOUT','EPERM']) {
  let destroyed=false;
  const connect=()=>{const socket=new EventEmitter();socket.setTimeout=()=>{};socket.destroy=()=>{destroyed=true;};queueMicrotask(()=>socket.emit('error',Object.assign(new Error(code),{code})));return socket;};
  if(['ENOENT','ECONNREFUSED'].includes(code))assert.equal(await nativeUpstreamExists('/fixture',{connect}),false);
  else await assert.rejects(nativeUpstreamExists('/fixture',{connect}),{code});
  assert.equal(destroyed,true);
 }
 const connect=()=>{const socket=new EventEmitter();socket.setTimeout=(_ms,callback)=>queueMicrotask(callback);socket.destroy=()=>{};return socket;};
 await assert.rejects(nativeUpstreamExists('/fixture',{connect}),/NATIVE_UPSTREAM_PROBE_TIMEOUT/);
});

test('Live upstream is reused across client reconnects and survives gateway stop',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-reuse-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');
 const native=createServer(),wss=new WebSocketServer({server:native});let proxy;
 wss.on('connection',ws=>ws.on('message',data=>{const frame=JSON.parse(data);if(frame.id!==undefined)ws.send(JSON.stringify({id:frame.id,result:{ok:true}}));}));
 await new Promise(resolve=>native.listen(upstream,resolve));
 try {
  // If reuse spawned even once, the invalid executable would fail startup.
  proxy=await universalMain({listen,upstream,upstreamReuseExisting:true,upstreamCommand:['/does-not-exist'],roots:['/srv/projects/brai-dev']});
  for(let n=0;n<2;n++) {
   const ws=new WebSocket('ws+unix://'+listen+':/');await once(ws,'open');const reply=once(ws,'message');ws.send(JSON.stringify({id:n,method:'thread/list',params:{}}));assert.deepEqual(JSON.parse((await reply)[0]),{id:n,result:{ok:true}});ws.close();await once(ws,'close');
  }
  assert.equal(proxy.server.listening,true);await proxy.stop();
  assert.equal(await nativeUpstreamExists(upstream),true);
 }finally{await proxy?.stop();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>native.close(resolve));await rm(dir,{recursive:true,force:true});}
});

for(const refused of [false,true])test(`Reuse mode ${refused?'refused':'absent'} socket cold starts exactly one owned upstream and reaps it on stop`,async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-reuse-cold-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');let proxy;
 const code="const fs=require('node:fs');fs.appendFileSync(process.argv[2],'spawn\\n');fs.rmSync(process.argv[1],{force:true});require('node:http').createServer().listen(process.argv[1]);";
 const marker=path.join(dir,'spawns');
 try {
  if(refused)execFileSync('/usr/bin/python3',['-c','import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()',upstream]);
  proxy=await universalMain({listen,upstream,upstreamReuseExisting:true,upstreamCommand:[process.execPath,'-e',code,upstream,marker],roots:[]});
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(marker,'utf8'),'spawn\n');
  await proxy.stop();assert.equal(await nativeUpstreamExists(upstream),false);
 }finally{await proxy?.stop();await rm(dir,{recursive:true,force:true});}
});

test('Lost reused daemon closes gateway with failure instead of retaining an active 502 listener',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-reuse-loss-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');
 const native=createServer(),wss=new WebSocketServer({server:native});let proxy;const previous=process.exitCode;
 wss.on('connection',ws=>ws.on('message',data=>{const frame=JSON.parse(data);if(frame.id!==undefined)ws.send(JSON.stringify({id:frame.id,result:{ok:true}}));}));
 await new Promise(resolve=>native.listen(upstream,resolve));
 try {
  proxy=await universalMain({listen,upstream,upstreamReuseExisting:true,upstreamCommand:['/does-not-exist'],roots:[]});
  const closed=once(proxy.server,'close');for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>native.close(resolve));await closed;
  assert.equal(proxy.server.listening,false);assert.equal(process.exitCode,1);
 }finally{process.exitCode=previous;await proxy?.stop();for(const ws of wss.clients)ws.terminate();wss.close();if(native.listening)await new Promise(resolve=>native.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('Real symlink loop fails before any upstream command can execute',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-reuse-loop-')),upstream=path.join(dir,'loop');
 try {await symlink(upstream,upstream);await assert.rejects(universalMain({listen:path.join(dir,'proxy'),upstream,upstreamReuseExisting:true,upstreamCommand:['/does-not-exist']}),{code:'ELOOP'});}
 finally{await rm(dir,{recursive:true,force:true});}
});


test('Uninitialized/unresponsive monitor fails closed without spawning',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cw-monitor-timeout-')),upstream=path.join(dir,'up.sock'),listen=path.join(dir,'proxy.sock');
 const native=createServer(),wss=new WebSocketServer({server:native});
 await new Promise(resolve=>native.listen(upstream,resolve));
 try {await assert.rejects(universalMain({listen,upstream,upstreamReuseExisting:true,upstreamCommand:['/does-not-exist'],roots:[]}),/NATIVE_UPSTREAM_MONITOR_TIMEOUT/);}
 finally{for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>native.close(resolve));await rm(dir,{recursive:true,force:true});}
});
