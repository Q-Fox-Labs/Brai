// ABOUTME: Проверяет whitelist и ограниченный независимый observer без model calls.
// ABOUTME: Отказы side channels и произвольный upstream payload не попадают в факты.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {safeFact,alertFor,historySender,createObservation,OBSERVATION_LIMITS as L} from '../dist/observation.js';
const op=()=>({ownerId:'synthetic-owner',operationId:randomUUID(),createdAt:1000,finishedAt:2000,phase:'outcome_unknown',route:{provider:'typesafe',model:'jev-1.13.0'},errorCode:'SECRET upstream body https://unsafe',result:{prompt:'PRIVATE',tools:[{name:'PRIVATE',arguments:'PRIVATE',result:'PRIVATE'}],outputs:[{url:'https://unsafe',bytes:'PRIVATE'}],usage:{inputTokens:4,output_tokens:5,cost:12,secret:'PRIVATE',total_tokens:-1}}});
test('safe facts whitelist, stable identity, unknown usage/cost and private owner scope',()=>{
 const raw=op(),fact=safeFact(raw),serialized=JSON.stringify(fact);
 assert.equal(fact.scope_type,'user');assert.equal(fact.scope_id,raw.ownerId);assert.equal(fact.object_id,raw.operationId);assert.equal(fact.type_id,1201);assert.equal(fact.actor_id,null);
 assert.deepEqual(fact.data.usage,{inputTokens:4,outputTokens:5});assert.equal(fact.data.cost,null);assert.equal(fact.data.errorClass,'unknown');assert.ok(!/PRIVATE|SECRET|unsafe|https|tools|outputs|arguments/.test(serialized));
 assert.deepEqual(safeFact(raw),fact);assert.notEqual(safeFact({...raw,ownerId:'other'}).id,fact.id);
 assert.equal(safeFact({...raw,result:null}).data.usage,null);assert.equal(safeFact({...raw,phase:'cancelled'}).type_id,1202);
 assert.equal(alertFor({...fact,data:{...fact.data,phase:'succeeded'}}),null);assert.equal(alertFor(fact).scope_id,raw.ownerId);
});
test('History has no waiting queue, bounds active requests, rejects safely and recovers',async()=>{
 const pending=[];let fail=false;
 const history=historySender({isClosed:()=>false,request:(s,p,o)=>{assert.equal(s,'brai.history.v1.append.service_providers');assert.equal(o.timeout,L.timeoutMs);return new Promise((resolve,reject)=>pending.push(()=>fail?reject(Error('PRIVATE')):resolve({headers:{get:()=>''}})));}});
 const fact=safeFact(op());for(let i=0;i<20;i++)history.send(fact);
 assert.equal(history.status().active,8);assert.equal(history.status().dropped,12);fail=true;pending.splice(0).forEach(f=>f());await new Promise(setImmediate);
 assert.equal(history.status().active,0);assert.equal(history.status().failed,8);assert.equal(history.status().state,'unavailable');
 fail=false;history.send(fact);pending.splice(0).forEach(f=>f());await new Promise(setImmediate);assert.equal(history.status().state,'ready');
});
test('observer outage does not publish recursive alerts; failed PubAck leaves same event',async()=>{
 const event=alertFor(safeFact(op()));let stored=[event],calls=0,offline=true;
 const store={collectObservations:async()=>({facts:[],dropped:0,expired:0,outboxSize:stored.length,episodes:1}),pendingAlerts:async()=>stored,ackAlert:async id=>{assert.equal(id,event.id);stored=[];}};
 const history=historySender({isClosed:()=>true,request:()=>assert.fail()});
 const observation=createObservation(store,history,async e=>{assert.deepEqual(e,event);calls++;if(offline)throw Error('PRIVATE');});
 await observation.tick();assert.equal(stored.length,1);assert.equal(observation.status().metrics.publishFailed,1);offline=false;await observation.tick();assert.equal(stored.length,0);assert.equal(calls,2);
 store.collectObservations=async()=>{throw Error('PRIVATE')};await observation.tick();assert.equal(calls,2);assert.equal(observation.status().dependencies.storage,'unavailable');assert.ok(!JSON.stringify(observation.status()).includes('PRIVATE'));
 observation.stop();await observation.tick();assert.equal(calls,2);
});
