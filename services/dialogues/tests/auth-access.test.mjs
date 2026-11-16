// ABOUTME: Проверяет прямую авторизацию Диалогов без сокета Hermes.
// ABOUTME: Отказы и неизвестные ответы закрывают доступ без повторов.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAuthAccess} from '../dist/auth-access.js';
const principal={userId:'u',profileId:'p'};
const transport=value=>({request:async(subject,data)=>{assert.equal(subject,'bound');assert.equal(Buffer.from(data).toString(),'{}');return {data:Buffer.from(JSON.stringify(value))};}});
test('principal выдан только привязанному пользователю',async()=>{
 await createAuthAccess(transport({...principal,allowed:true}),'bound',principal)();
 await assert.rejects(createAuthAccess(transport({...principal,allowed:false}),'bound',principal)(),/PERSONAL_AUTH_DENIED/);
 for(const value of [{...principal,userId:'other',allowed:true},{...principal,allowed:'yes'},{}])await assert.rejects(createAuthAccess(transport(value),'bound',principal)(),/PERSONAL_AUTH_UNAVAILABLE/);
});
test('ошибка NATS и service headers не превращаются в отказ прав',async()=>{
 for(const nc of [{request:async()=>{throw new Error('offline');}},{request:async()=>({headers:{get:()=> '503'},data:Buffer.from('{}')})}])await assert.rejects(createAuthAccess(nc,'bound',principal)(),/PERSONAL_AUTH_UNAVAILABLE/);
});
test('HTTP различает недоступность Auth и запрет',async()=>{
 const {startMcp}=await import('../dist/mcp.js');
 let code='PERSONAL_AUTH_UNAVAILABLE';
 const cfg={host:'127.0.0.1',port:0,owner:'owner',hosts:['localhost'],origins:['http://localhost'],token:'a'.repeat(40),personal:{userId:'u',profileId:'p',authorize:async()=>{throw new Error(code);}}};
 const mcp=await startMcp({},cfg);
 const headers={authorization:'Bearer '+cfg.token,'x-brai-user-id':'u','x-brai-profile-id':'p'};
 try{
  assert.equal((await fetch(mcp.url,{method:'POST',headers})).status,503);
  code='PERSONAL_AUTH_DENIED';
  assert.equal((await fetch(mcp.url,{method:'POST',headers})).status,403);
  assert.equal((await fetch(mcp.url,{method:'POST',headers:{...headers,authorization:'Bearer invalid'}})).status,401);
 }finally{await mcp.close();}
});
