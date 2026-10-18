// ABOUTME: Проверяет atomic journal на собственной реальной PG fixture.
// ABOUTME: Нужен отдельный URL тестовой БД; чужие БД тест не очищает.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {postgresStore} from '../dist/postgres.js';
import {createOperations,V1_LIMITS} from '../dist/operations.js';
import {MODEL} from '../dist/core.js';
const url=process.env.PROVIDERS_TEST_PG_URL;
const request=()=>({operationId:randomUUID(),ownerId:'pg-fixture-'+randomUUID(),provider:'typesafe',model:MODEL,state:['synthetic',{x:1}],questions:{check:{type:'noul',instructions:'synthetic'}},deadlineAt:new Date(Date.now()+30000).toISOString()});
const result=()=>({model:MODEL,answers:{check:{type:'noul',noul:.5}}});
test('real PG: migrations, atomic duplicate/conflict, durable crash recovery, TTL, cancel and exclusive runtime',{skip:!url},async t=>{
 assert.equal(new URL(url).pathname,'/providers_v1_test','only owned fixture database');
 const store=postgresStore(url),other=postgresStore(url);t.after(()=>other.close());t.after(()=>store.close());
 await store.migrate();await store.migrate();await store.exclusive(()=>{});await assert.rejects(other.exclusive(()=>{}),/ALREADY_RUNNING/);
 let calls=0;const ops=createOperations(store,async r=>{assert.equal((await store.find(r.ownerId,r.operationId,Date.now())).phase,'dispatching');calls++;return result();}),r=request();
 const copies=await Promise.all(Array.from({length:8},()=>ops.invoke(r)));assert.ok(copies.every(x=>x.operationId===r.operationId));await ops.idle();assert.equal(calls,1);
 await assert.rejects(ops.invoke({...r,state:'conflict'}),e=>e.code==='IDEMPOTENCY_CONFLICT');assert.equal((await ops.get(r.ownerId,r.operationId)).phase,'succeeded');
 const first=await store.find(r.ownerId,r.operationId,Date.now()),a={...first,operationId:randomUUID(),inputHash:'a'.repeat(64),phase:'accepted',result:null,finishedAt:null,resultExpiresAt:null},b={...a,operationId:randomUUID(),inputHash:'b'.repeat(64)};
 const competing=await Promise.all([store.accept(a),other.accept(a)]);assert.equal(competing.filter(x=>x.inserted).length,1);await store.accept(b);
 assert.equal(await store.claim(b.ownerId,b.operationId,b.inputHash),true);
 await store.finish(b.ownerId,b.operationId,'succeeded',{invalid:'late'},null,Date.now(),'c'.repeat(64));assert.equal((await store.find(b.ownerId,b.operationId,Date.now())).phase,'dispatching');assert.equal(await other.claim(b.ownerId,b.operationId,b.inputHash),false);
 await store.recover(Date.now());assert.equal((await store.find(a.ownerId,a.operationId,Date.now())).phase,'cancelled');assert.equal((await store.find(b.ownerId,b.operationId,Date.now())).phase,'outcome_unknown');
 const restarted=createOperations(store,async()=>{throw Error('cannot retry');});assert.equal((await restarted.invoke(r)).phase,'succeeded');
 const c={...a,operationId:randomUUID()},d={...a,operationId:randomUUID()};await store.accept(c);await store.cancel(c.ownerId,c.operationId,Date.now());assert.equal(await store.claim(c.ownerId,c.operationId,c.inputHash),false);await store.accept(d);assert.equal(await store.claim(d.ownerId,d.operationId,d.inputHash),true);assert.equal((await store.cancel(d.ownerId,d.operationId,Date.now())).phase,'dispatching');
 await store.sweep(first.resultExpiresAt);const expired=await store.find(r.ownerId,r.operationId,first.resultExpiresAt);assert.equal(expired.result,null);assert.equal(expired.phase,'succeeded');
 await store.sweep(first.keyExpiresAt);assert.equal(await store.find(r.ownerId,r.operationId,first.keyExpiresAt),null);
 const sql=new pg.Client({connectionString:url});await sql.connect();try {const role=await sql.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');assert.deepEqual(role.rows[0],{rolsuper:false,rolcreatedb:false,rolcreaterole:false});}finally{await sql.end();}
});
