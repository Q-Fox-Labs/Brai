// ABOUTME: Проверяет закрытый операторский DTO активации без транспорта и БД.
// ABOUTME: Область и полномочия выводятся только из доверенного operator subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeProcessing,processingOperations} from '../dist/processing-api.js';
const input={request_id:'synthetic-activate',generation:'gemma2-next',expected_active_generation:'gemma2-symmetric-v1',reason:'Accepted synthetic coverage'};
test('activation rejects injected model/owner metadata before calling store',async()=>{
 let calls=0;const store={activateGeneration:async()=>{calls++;return {};}};
 assert.ok(processingOperations.includes('activate-generation'));
 for(const value of [{...input,owner_id:'foreign'},{...input,selector:{modelId:'different'}},{...input,generation:'../path'},{...input,expected_active_generation:null},{...input,reason:''},{...input,reason:'\ud800'}]){
  await assert.rejects(invokeProcessing(store,'activate-generation',value),e=>e.code==='INVALID_ARGUMENT');
 }
 assert.equal(calls,0);
});
test('trusted activation validates the complete idempotent receipt',async()=>{
 const result={generation:input.generation,previous_generation:input.expected_active_generation,activation_revision:1,total_reports:3,indexed_reports:3,replayed:false};
 const store={activateGeneration:async(principal,value)=>{
  assert.equal(principal.reviewer,true);assert.equal(principal.actorId,'nats:operator');assert.equal(principal.ownerId,'operator');assert.deepEqual(value,input);return result;
 }};
 assert.deepEqual(await invokeProcessing(store,'activate-generation',input),result);
 await assert.rejects(invokeProcessing({activateGeneration:async()=>({...result,secret:'never expose'})},'activate-generation',input),e=>e.code==='INTERNAL'&&e.outcome==='unknown');
});
