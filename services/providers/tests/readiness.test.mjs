// ABOUTME: Проверяет закрытую проверку готовности Providers при потере и восстановлении зависимости.
// ABOUTME: Не отправляет запросы модели и не требует внешних сервисов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatHttp} from '../dist/chat-http.js';

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
