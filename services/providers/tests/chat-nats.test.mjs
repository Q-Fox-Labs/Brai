// ABOUTME: Проверяет chat через настоящие изолированные NATS и PostgreSQL.
// ABOUTME: Модель synthetic; Core NATS gap восстанавливается полным durable get.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connect} from 'nats';
import {postgresStore} from '../dist/postgres.js';
import {createOperations} from '../dist/operations.js';
import {registerProvidersV1} from '../dist/nats-v1.js';
import {CHAT_MODEL,createChatAssembler} from '../dist/chat.js';
const pg=process.env.PROVIDERS_TEST_PG_URL,nats=process.env.PROVIDERS_TEST_NATS_URL;
test('real NATS/PG: subscribe before invoke, two tools, missing final/gap get, owner/connection and replay', {skip:!pg||!nats},async t=>{
 const store=postgresStore(pg);await store.migrate();await store.exclusive(()=>{throw Error('lost lock');});t.after(()=>store.close());
 const nc=await connect({servers:nats,reconnect:false,timeout:3000});t.after(()=>nc.close());let calls=0;
 const ops=createOperations(store,async()=>{throw Error('no decide');},{chatPort:async(r,m,_signal,emit)=>{
  calls++;assert.equal((await store.find(r.ownerId,r.operationId,Date.now())).phase,'dispatching');const a=createChatAssembler(r,emit);
  const chunk=(delta,finish_reason=null)=>({model:CHAT_MODEL,choices:[{index:0,delta,finish_reason}]});
  if(calls===1){a.push(chunk({content:'prelude',tool_calls:[{index:0,id:'a',type:'function',function:{name:'first',arguments:'{"value":1}'}},{index:1,id:'b',type:'function',function:{name:'second',arguments:'{"value":2}'}}]}));a.push(chunk({},'tool_calls'));}
  else{assert.deepEqual(m.slice(-2).map(v=>v.tool_call_id),['a','b']);a.push(chunk({content:'done'}));a.push(chunk({},'stop'));}return a.finish();
 }});
 const service=await registerProvidersV1(nc,ops);t.after(()=>service.stop());
 const connectionId='chat_'+randomUUID().replaceAll('-',''),ownerId='chat-fixture-'+randomUUID(),streamInbox='_INBOX.'+connectionId+'.synthetic';
 const tool=name=>({type:'function',function:{name,parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}});
 const r={operationId:randomUUID(),ownerId,connectionId,provider:'openrouter',model:CHAT_MODEL,deadlineAt:new Date(Date.now()+90000).toISOString(),streamInbox,messages:[{role:'user',content:'synthetic'}],tools:[tool('first'),tool('second')],maxTokens:64,toolChoice:'auto'};
 const sub=nc.subscribe(streamInbox);await nc.flush();const call=async(name,body)=>{const m=await nc.request('brai.providers.v1.'+name,JSON.stringify(body),{timeout:4000});assert.equal(m.headers?.get('Nats-Service-Error')??'','');return m.json();};
 assert.equal((await call('invoke.chat',r)).phase,'accepted');await ops.idle();await nc.flush();const key={ownerId,operationId:r.operationId};
 let final,sequence=0,ready=0;for await(const msg of sub){const e=msg.json();assert.equal(e.sequence,++sequence);if(e.type==='tool_call.ready')ready++;if(e.type==='completed'){final=e;break;}}
 sub.unsubscribe();assert.equal(ready,2);assert.ok(final);const result=await call('operations.get',key);assert.equal(result.phase,'succeeded');assert.equal(result.result.toolCalls.length,2);assert.equal((await call('invoke.chat',{...r,streamInbox:'_INBOX.'+connectionId+'.reconnected'})).phase,'succeeded');assert.equal(calls,1);
 // Drop events deliberately: the durable result is still complete and no new compute happens.
 const next={...r,operationId:randomUUID(),messages:[],continuation:{operationId:r.operationId},toolResults:[{id:'a',content:'1'},{id:'b',content:'2'}]};await call('invoke.chat',next);await ops.idle();assert.equal((await call('operations.get',{ownerId,operationId:next.operationId})).result.text,'done');assert.equal(calls,2);
 const wrong=await nc.request('brai.providers.v1.invoke.chat',JSON.stringify({...next,operationId:randomUUID(),connectionId:'other',streamInbox:'_INBOX.other.synthetic'}));assert.equal(wrong.headers.get('Nats-Service-Error'),'INVALID_CONTINUATION');
 const unsafe=await nc.request('brai.providers.v1.invoke.chat',JSON.stringify({...r,operationId:randomUUID(),streamInbox:'_INBOX.other.synthetic'}));assert.equal(unsafe.headers.get('Nats-Service-Error'),'INVALID_REQUEST');
});
