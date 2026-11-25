// ABOUTME: Проверяет закрытую проверку готовности Providers при потере и восстановлении зависимости.
// ABOUTME: Не отправляет запросы модели и не требует внешних сервисов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatHttp} from '../dist/chat-http.js';
import {readiness} from '../dist/readiness.js';

test('readiness отражает состояние и требует действующий bearer',async t=>{
  let ready=false;
  const token='synthetic-token-with-at-least-32-characters';
  const server=createChatHttp({},[{token,ownerId:'synthetic-owner',connectionId:'synthetic'}],async()=>ready);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/internal/readiness`;
  assert.equal((await fetch(url)).status,401);
  let response=await fetch(url,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{ready:false});
  ready=true;
  response=await fetch(url,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ready:true});
});

test('readiness не занимает пользовательские слоты при полной нагрузке',async t=>{
  let release,entered=0,notify;
  const held=new Promise(resolve=>{release=resolve;});
  const full=new Promise(resolve=>{notify=resolve;});
  const ops={get:async()=>{entered++;if(entered===8)notify();await held;return {phase:'failed',operationId:'11111111-1111-4111-8111-111111111111',errorCode:'TEST',resultExpired:false};}};
  const token='synthetic-token-with-at-least-32-characters';
  const server=createChatHttp(ops,[{token,ownerId:'synthetic-owner',connectionId:'synthetic'}],async()=>true);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:`Bearer ${token}`};
  const requests=Array.from({length:8},()=>fetch(`${base}/v1/operations/11111111-1111-4111-8111-111111111111`,{headers}));
  await full;
  try{const result=await fetch(`${base}/internal/readiness`,{headers});assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:true});}
  finally{release();await Promise.all(requests);}
});

test('readiness reports unavailable if NATS disconnects while proxy readiness is pending',async t=>{
  let connected=true, release, notify;
  const pending=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{notify=resolve;});
  const check=readiness({connected:()=>connected,servicesReady:()=>true,storage:async()=>{},
    proxy:async()=>{notify();await pending;return true;}});
  const token='synthetic-token-with-at-least-32-characters';
  const server=createChatHttp({},[{token,ownerId:'synthetic-owner',connectionId:'synthetic'}],check);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=fetch(`http://127.0.0.1:${server.address().port}/internal/readiness`,
    {headers:{authorization:`Bearer ${token}`}});
  await entered;
  connected=false;
  release();
  const response=await request;
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{ready:false});
});

test('readiness reports unavailable if service readiness changes during dependency checks',async()=>{
  let serviceReady=true, release, notify;
  const pending=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{notify=resolve;});
  const check=readiness({connected:()=>true,servicesReady:()=>serviceReady,storage:async()=>{},
    proxy:async()=>{notify();await pending;return true;}});
  const result=check();
  await entered;
  serviceReady=false;
  release();
  assert.equal(await result,false);
});
