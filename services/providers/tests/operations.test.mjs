// ABOUTME: Проверяет durable lifecycle через управляемые storage/model ports.
// ABOUTME: Не обращается к сети, ключам или платным моделям.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperations,V1_LIMITS,canonical,checkAnswer} from '../dist/operations.js';
import {Failure,MODEL} from '../dist/core.js';
import {liteLLMConfig,listModels} from '../dist/catalog.js';
import {readFileSync} from 'node:fs';
import {v1Validator} from '../dist/v1-schema.js';
const input=()=>({operationId:randomUUID(),ownerId:'fixture',provider:'typesafe',model:MODEL,state:{synthetic:['x',1]},questions:{check:{type:'noul',instructions:'synthetic'}},deadlineAt:new Date(Date.now()+30000).toISOString()});
const answer=()=>({model:MODEL,answers:{check:{type:'noul',noul:.3141592653589793}}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function memory(){const rows=new Map(),key=(o,id)=>JSON.stringify([o,id]);const copy=v=>v?structuredClone(v):null;return {
 rows,
 async find(o,id,now){const r=rows.get(key(o,id));return r&&r.keyExpiresAt>now?copy(r):null;},
 async accept(op){const k=key(op.ownerId,op.operationId),old=rows.get(k);if(old)return {operation:copy(old),inserted:false};rows.set(k,copy(op));return {operation:copy(op),inserted:true};},
 async claim(o,id){const r=rows.get(key(o,id));if(r?.phase!=='accepted'||r.cancelRequested)return false;r.phase='dispatching';return true;},
 async finish(o,id,phase,result,errorCode,now){const r=rows.get(key(o,id));if(!r||!['accepted','dispatching'].includes(r.phase))return;Object.assign(r,{phase,result,errorCode,finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs});},
 async cancel(o,id,now){const r=rows.get(key(o,id));if(!r||r.keyExpiresAt<=now)return null;r.cancelRequested=true;if(r.phase==='accepted')Object.assign(r,{phase:'cancelled',errorCode:'CANCELLED',finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs});return copy(r);},
 async recover(now){for(const r of rows.values())if(['accepted','dispatching'].includes(r.phase))Object.assign(r,{phase:r.phase==='accepted'?'cancelled':'outcome_unknown',finishedAt:now,resultExpiresAt:now+V1_LIMITS.resultTtlMs,errorCode:'OUTCOME_UNKNOWN'});},
 async sweep(now){for(const [k,r]of rows){if(r.keyExpiresAt<=now)rows.delete(k);else if(r.resultExpiresAt<=now)r.result=null;}}
};}
test('catalog is the exact source for public capabilities and checked-in LiteLLM config',()=>{
 assert.equal(readFileSync(new URL('../litellm.yaml',import.meta.url),'utf8'),liteLLMConfig());assert.deepEqual(listModels()[0].capabilities,['decide']);assert.equal(v1Validator('modelsListResponse')({version:'v',models:listModels()}),true);
});
test('concurrent canonical duplicate and conflict: one durable dispatch; owner scope',async()=>{
 const store=memory();let calls=0;const ops=createOperations(store,async r=>{calls++;assert.equal((await store.find(r.ownerId,r.operationId,Date.now())).phase,'dispatching');return answer();});
 const r=input(),other={...r,state:{synthetic:['x',1]}};
 const accepted=await Promise.all(Array.from({length:8},(_,i)=>ops.invoke(i%2?r:other)));assert.ok(accepted.every(x=>x.operationId===r.operationId));
 await assert.rejects(ops.invoke({...r,state:'different'}),e=>e.code==='IDEMPOTENCY_CONFLICT');await ops.idle();assert.equal(calls,1);
 const final=await ops.get(r.ownerId,r.operationId);assert.equal(final.phase,'succeeded');assert.equal(final.result.usage,null);assert.equal(v1Validator('operation')(final),true);
 await assert.rejects(ops.get('other',r.operationId),e=>e.code==='NOT_FOUND');await assert.rejects(ops.cancel('other',r.operationId),e=>e.code==='NOT_FOUND');
});
test('replay precedes changed catalogue and expired deadline; preserves stored result',async()=>{
 const store=memory(),r=input(),ops=createOperations(store,async()=>answer());await ops.invoke(r);await ops.idle();
 const replay=createOperations(store,async()=>{throw Error('must not call');},{now:()=>Date.now()+60000,lookupModel:()=>{throw Error('must not read');}});
 assert.equal((await replay.invoke(r)).phase,'succeeded');await assert.rejects(replay.invoke({...r,state:'changed'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('capacity2 and no waiting queue: overload before send, control still reads and cancels',async()=>{
 const store=memory();let calls=0;const releases=[];const ops=createOperations(store,()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(answer())));});
 const a=input(),b=input();await Promise.all([ops.invoke(a),ops.invoke(b)]);await tick();assert.equal(calls,2);
 await assert.rejects(ops.invoke(input()),e=>e.code==='OVERLOADED'&&e.outcome==='not_sent');assert.deepEqual(ops.status(),{ready:true,active:2,capacity:2,waiting:0});
 assert.equal((await ops.get(a.ownerId,a.operationId)).phase,'dispatching');assert.equal((await ops.cancel(a.ownerId,a.operationId)).billingMayContinue,true);
 releases.forEach(f=>f());await ops.idle();assert.equal((await ops.get(a.ownerId,a.operationId)).phase,'outcome_unknown');assert.equal(calls,2);
});
test('cancel before dispatch prevents port call; post-dispatch requests abort only',async()=>{
 let calls=0;const ops=createOperations(memory(),async()=>{calls++;return answer();});const r=input();await ops.invoke(r);const cancel=await ops.cancel(r.ownerId,r.operationId);assert.equal(cancel.phase,'cancelled');assert.equal(cancel.billingMayContinue,false);await ops.idle();assert.equal(calls,0);
});
test('restart both crash windows: accepted cancels, dispatch journal unknown, no replay dispatch',async()=>{
 const store=memory(),ops=createOperations(store,async()=>answer()),a=input(),b=input();await ops.invoke(a);await ops.invoke(b);
 // Own scheduled work finishes before simulating a separate process crash image.
 await ops.idle();const rows=[...store.rows.values()];rows[0].phase='accepted';rows[1].phase='dispatching';rows.forEach(r=>r.result=null);
 await store.recover(Date.now());let calls=0;const restarted=createOperations(store,async()=>{calls++;return answer();});
 assert.equal((await restarted.invoke(a)).phase,'cancelled');assert.equal((await restarted.invoke(b)).phase,'outcome_unknown');assert.equal(calls,0);
});
test('24h result expires, seven day key remains; key expiry permits explicit fresh acceptance',async()=>{
 let now=Date.now(),calls=0;const store=memory(),ops=createOperations(store,async()=>{calls++;return answer();},{now:()=>now}),r=input();await ops.invoke(r);await ops.idle();
 now+=V1_LIMITS.resultTtlMs;await store.sweep(now);const old=await ops.invoke(r);assert.equal(old.resultExpired,true);assert.equal(old.result,null);assert.equal(calls,1);
 now+=V1_LIMITS.keyTtlMs;await store.sweep(now);await assert.rejects(ops.get(r.ownerId,r.operationId),e=>e.code==='NOT_FOUND');const fresh={...r,deadlineAt:new Date(now+30000).toISOString()};await ops.invoke(fresh);await ops.idle();assert.equal(calls,2);
});
test('bounded input depth/bytes and unsupported route fail before model',async()=>{
 const ops=createOperations(memory(),async()=>{throw Error('no send');});
 let deep={};for(let i=0;i<34;i++)deep={deep};
 for(const r of [{...input(),state:deep},{...input(),state:'x'.repeat(65536)},{...input(),unknown:true},{...input(),state:{value:Infinity}},{...input(),state:{value:'\u0000'}}])await assert.rejects(ops.invoke(r),e=>e.code==='INVALID_REQUEST');
 await assert.rejects(ops.invoke({...input(),model:'unknown'}),e=>e.code==='MODEL_NOT_ALLOWED');assert.equal(ops.status().active,0);
});
test('choice/score distributions, legend, confidence survive; malformed upstream and wrong model never fallback',async()=>{
 const r=input();r.questions={department:{type:'choice',instructions:'synthetic',criteria:{one:'x',two:null}},level:{type:'score',instructions:'synthetic',criteria:['low','high']}};
 const value={model:MODEL,answers:{department:{type:'choice',choice:'one',probabilities:{one:.87654321,two:.12345679},confidence:.7654321},level:{type:'score',score:.12345679,probabilities:{0:.87654321,1:.12345679},legend:{0:'low',1:'high'},confidence:.7654321}},usage:{input_tokens:13,output_tokens:7}};
 let calls=0;const ops=createOperations(memory(),async()=>{calls++;return value;});await ops.invoke(r);await ops.idle();const done=await ops.get(r.ownerId,r.operationId);assert.deepEqual(done.result.answers,value.answers);assert.equal(calls,1);
 for(const bad of [{...value,model:'jev-latest'},{...value,answers:{...value.answers,level:{...value.answers.level,probabilities:{0:.9,1:.9}}}},{...value,answers:{...value.answers,department:{...value.answers.department,choice:'missing'}}}])assert.throws(()=>checkAnswer(r,bad),e=>e.code==='UPSTREAM_PROTOCOL');
 const fail=createOperations(memory(),async()=>{throw new Failure('UPSTREAM_ACCESS','failed');}),bad=input();await fail.invoke(bad);await fail.idle();assert.equal((await fail.invoke(bad)).phase,'failed');
});
test('result persistence failure after possible send never initiates another model call',async()=>{
 const store=memory(),save=store.finish;let first=true,calls=0;store.finish=async(...args)=>{if(first){first=false;throw Error('db lost after send');}return save(...args);};
 const ops=createOperations(store,async()=>{calls++;return answer();}),r=input();await ops.invoke(r);await ops.idle();assert.equal((await ops.invoke(r)).phase,'outcome_unknown');assert.equal(calls,1);
});

test('duplicate admission itself is bounded at eight waiting callers',async()=>{
 const store=memory(),find=store.find;let release;const gate=new Promise(resolve=>release=resolve);store.find=async(...args)=>{await gate;return find(...args);};
 let calls=0;const ops=createOperations(store,async()=>{calls++;return answer();}),r=input();const eight=Array.from({length:8},()=>ops.invoke(r));
 await assert.rejects(ops.invoke(r),e=>e.code==='OVERLOADED');assert.equal(ops.status().active,0);release();await Promise.all(eight);await ops.idle();assert.equal(calls,1);
});
