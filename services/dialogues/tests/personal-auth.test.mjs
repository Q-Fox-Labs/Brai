// ABOUTME: Проверяет Unix-протокол служебной авторизации на синтетическом broker.
// ABOUTME: Подмена метаданных socket внедряется только в тесте транспорта.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createPersonalAuthorizer,verifyBrokerSocket} from '../dist/personal-auth.js';
test('служебная авторизация не передаёт owner и отвергает чужой/неполный ответ',async()=>{
 const dir=await mkdtemp('/tmp/dialogues-auth-'),path=join(dir,'broker.sock');
 let mode='ok';
 const server=createServer(socket=>socket.once('data',data=>{
  const req=JSON.parse(data.toString());
  assert.equal(req.method,'dialogues.authorize');assert.deepEqual(req.params,{});
  if(mode==='partial'){socket.end('{}');return;}
  socket.end(JSON.stringify({jsonrpc:'2.0',id:mode==='id'?'wrong':req.id,
   result:{userId:mode==='owner'?'b':'a',profileId:'p'}})+'\n');
 }));
 await new Promise(r=>server.listen(path,r));
 try{
  assert.throws(()=>verifyBrokerSocket(path),/UNSAFE_BROKER_SOCKET/);
  const check=createPersonalAuthorizer(path,{userId:'a',profileId:'p'},()=>{});
  await check();
  for(mode of ['owner','id','partial'])await assert.rejects(check(),/PERSONAL_AUTH_UNAVAILABLE/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
