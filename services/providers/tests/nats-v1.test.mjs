// ABOUTME: Проверяет реальный NATS Services v1 с изолированным PG journal.
// ABOUTME: Inference управляемый; внешняя модель и секреты не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'nats';
import {randomUUID} from 'node:crypto';
import {registerProvidersV1} from '../dist/nats-v1.js';
import {createOperations} from '../dist/operations.js';
import {postgresStore} from '../dist/postgres.js';
import {MODEL} from '../dist/core.js';
test('real NATS+PG: v1 schemas, catalogue, owner scope and safe errors',{skip:!process.env.PROVIDERS_TEST_NATS_URL||!process.env.PROVIDERS_TEST_PG_URL},async t=>{
 const store=postgresStore(process.env.PROVIDERS_TEST_PG_URL);t.after(()=>store.close());await store.migrate();
 const nc=await connect({servers:process.env.PROVIDERS_TEST_NATS_URL,reconnect:false});t.after(()=>nc.close());let calls=0;
 const ops=createOperations(store,async()=>{calls++;return {model:MODEL,answers:{check:{type:'noul',noul:.5}}};});
 const service=await registerProvidersV1(nc,ops);t.after(()=>service.stop());
 const call=async(name,input)=>nc.request('brai.providers.v1.'+name,JSON.stringify(input),{timeout:2000});
 const input={operationId:randomUUID(),ownerId:'nats-v1-fixture',provider:'typesafe',model:MODEL,state:['synthetic'],questions:{check:{type:'noul',instructions:'synthetic'}},deadlineAt:new Date(Date.now()+30000).toISOString()};
 assert.equal((await call('models.list',{})).json().models[0].model,MODEL);assert.deepEqual((await call('models.get',{provider:'typesafe',model:MODEL})).json().capabilities,['decide']);
 const reply=await call('invoke.decide',input);assert.equal(reply.headers?.get('Nats-Service-Error')??'', '');assert.equal(reply.json().phase,'accepted');await ops.idle();
 const key={ownerId:input.ownerId,operationId:input.operationId};assert.equal((await call('operations.get',key)).json().phase,'succeeded');assert.equal((await call('invoke.decide',input)).json().phase,'succeeded');assert.equal(calls,1);
 const wrong=await call('operations.get',{...key,ownerId:'other'});assert.equal(wrong.headers.get('Nats-Service-Error'),'NOT_FOUND');
 for(const [name,body] of [['invoke.decide',{...input,state:'conflict'}],['status',{unexpected:1}],['models.list',{ownerId:'extra'}]]){const error=await call(name,body);assert.equal(error.headers.get('Nats-Service-Error-Code'),'500');assert.equal(error.json().outcome,'not_sent');}
 const status=(await call('status',{})).json();assert.equal(status.capacity,2);assert.equal(status.waiting,0);
 assert.equal((await call('operations.cancel',key)).json().cancelRequested,true);
 const original=ops.get;const waiting=[];ops.get=(...args)=>new Promise(resolve=>waiting.push(()=>resolve(original(...args))));
 const eight=Array.from({length:8},()=>call('operations.get',key));
 while(waiting.length<8)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal((await call('status',{})).headers.get('Nats-Service-Error'),'OVERLOADED');waiting.forEach(f=>f());await Promise.all(eight);ops.get=original;
 const info=(await nc.request('$SRV.INFO.brai_providers_v1','',{timeout:2000})).json();assert.equal(info.endpoints.length,6);
});
