// ABOUTME: Проверяет сумму всей истории и транзакционную границу чтения snapshot.
// ABOUTME: Подменяет только Pool; реальный SQL и конкурентные переходы проверяет integration стенд.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createStore } from '../dist/storage.js';

function fixture(total = '33000') {
 const calls = [];
 let transaction = false, released = false;
 const rows = Array.from({length:55}, (_,n) => ({timer_id:randomUUID(),started_at:new Date(2026,0,1,0,0,n),stopped_at:new Date(2026,0,1,0,0,n,600),duration_ms:'600'})).reverse();
 const activeId = randomUUID();
 const client = {
  async query(sql, params) {
   calls.push(sql);
   if (sql.startsWith('BEGIN')) { assert.match(sql,/ISOLATION LEVEL REPEATABLE READ READ ONLY/); transaction = true; return {rows:[]}; }
   assert.ok(transaction,'every snapshot read stays in the same transaction');
   if (sql === 'COMMIT' || sql === 'ROLLBACK') { transaction = false; return {rows:[]}; }
   if (sql.includes('transaction_timestamp')) return {rows:[{now:new Date('2026-01-01T00:01:00.000Z')}]};
   assert.equal(params[0],'user-a');
   if (sql.includes('SUM(duration_ms)')) {
    assert.match(sql,/WHERE user_id=\$1 AND stopped_at IS NOT NULL/);
    assert.doesNotMatch(sql,/LIMIT|started_at\s*[<>]/);
    return {rows:[{total}]};
   }
   if (sql.includes('FROM timer.state')) return {rows:[{version:'111',active_timer_id:activeId,started_at:new Date('2026-01-01T00:00:59.000Z')}]};
   if (sql.includes('FROM timer.intervals')) return {rows:rows.slice(0,params[3])};
   assert.fail(`unexpected query ${sql}`);
  },
  release() {released = true;},
 };
 const store = createStore({connect:async()=>client});
 return {store,calls,activeId,isReleased:()=>released};
}

test('snapshot returns all 55 completed durations although recent history contains only 50 and timer is active',async()=>{
 const f=fixture();const snapshot=await f.store.snapshot('user-a');
 assert.equal(snapshot.totalCompletedMs,55*600);assert.equal(snapshot.recentCompleted.length,50);assert.ok(snapshot.nextCursor);
 assert.equal(snapshot.active.timerId,f.activeId);assert.equal(snapshot.version,111);
 assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(f.calls.at(-1),'COMMIT');assert.ok(f.isReleased());
});

test('snapshot rejects an unsafe integer sum and rolls back instead of returning rounded milliseconds',async()=>{
 const f=fixture('9007199254740993');await assert.rejects(f.store.snapshot('user-a'),/DURATION_EXHAUSTED/);
 assert.equal(f.calls.at(-1),'ROLLBACK');assert.ok(f.isReleased());
});

test('snapshot owner schema accepts a full total and earlier v2 DTO but rejects fractional or negative sums',async()=>{
 const ajv=new Ajv({strict:false});addFormats(ajv);
 for(const name of ['common','messages'])ajv.addSchema(JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`,import.meta.url),'utf8')));
 const validate=ajv.compile({$ref:'https://brai.invalid/contracts/timer/v2/messages.schema.json#/definitions/SnapshotResponse'});
 const snapshot=await fixture().store.snapshot('user-a');assert.ok(validate(snapshot),JSON.stringify(validate.errors));
 const {totalCompletedMs,...legacy}=snapshot;assert.ok(validate(legacy));
 assert.equal(validate({...snapshot,totalCompletedMs:-1}),false);assert.equal(validate({...snapshot,totalCompletedMs:1.5}),false);
});
