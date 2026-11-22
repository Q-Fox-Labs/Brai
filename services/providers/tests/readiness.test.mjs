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
