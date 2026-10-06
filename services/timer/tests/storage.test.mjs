// ABOUTME: Проверяет сумму всей истории и транзакционную границу чтения snapshot.
// ABOUTME: Подменяет только Pool; реальный SQL и конкурентные переходы проверяет integration стенд.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createStore } from '../dist/storage.js';

function fixture(total = '33000', historyRevision = 2) {
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
   if (sql.includes('FROM timer.sys_challenge')) return {rows:[{start_date:'2026-10-04',end_date_exclusive:'2026-11-01',time_zone:'Europe/Moscow',days:28,daily_target_ms:'28800000',target_ms:'806400000'}]};
   assert.equal(params[0],'user-a');
   if (sql.includes('SUM(duration_ms)')) {
    assert.match(sql,/WHERE user_id=\$1 AND stopped_at IS NOT NULL AND deleted_at IS NULL/);
    assert.doesNotMatch(sql,/LIMIT|started_at\s*[<>]/);
    return {rows:[{total}]};
   }
   if (sql.includes('FROM timer.state')) return {rows:[{version:'111',history_revision:String(historyRevision),active_timer_id:activeId,started_at:new Date('2026-01-01T00:00:59.000Z')}]};
   if (sql.includes('FROM timer.intervals')) return {rows:sql.includes('LIMIT')?rows.slice(0,params[3]):rows};
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

test('history cursor carries owner revision, accepts legacy only at revision zero, and rejects stale pages',async()=>{
 const itemId='00000000-0000-4000-8000-000000000001',stamp='2026-01-01T00:00:00.000Z';
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const stale=fixture('33000',2);
 await assert.rejects(stale.store.history('user-a',10,encode(['user-a',1,stamp,itemId])),/HISTORY_CHANGED/);
 await assert.rejects(stale.store.history('user-a',10,encode(['user-a',1,'not-a-date',itemId])),/INVALID_ARGUMENT/);
 await assert.rejects(stale.store.history('user-a',10,encode(['user-a',-1,stamp,itemId])),/INVALID_ARGUMENT/);
 assert.equal(stale.calls.at(-1),'ROLLBACK');
 const valid=fixture('33000',2),result=await valid.store.history('user-a',10,encode(['user-a',2,stamp,itemId]));
 assert.equal(result.historyRevision,2);assert.equal(valid.calls.at(-1),'COMMIT');
 const legacy=fixture('33000',0);
 assert.equal((await legacy.store.history('user-a',10,encode(['user-a',stamp,itemId]))).historyRevision,0);
 await assert.rejects(stale.store.history('user-a',10,encode(['user-a',stamp,itemId])),/HISTORY_CHANGED/);
});


test('statistics reads every completed live row and challenge config from one owner snapshot',async()=>{
 const f=fixture(),result=await f.store.statistics('user-a');
 assert.equal(result.totalCompletedMs,55*600);assert.equal(result.version,111);
 assert.equal(result.challenge.daily.length,28);assert.equal(result.challenge.completedMs,0);
 assert.equal(result.daily.find(day=>day.date==='2026-01-01').completedMs,33000);
 assert.equal(f.calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(f.calls.at(-1),'COMMIT');assert.ok(f.isReleased());
 const intervalsSQL=f.calls.find(sql=>sql.includes('FROM timer.intervals'));
 assert.match(intervalsSQL,/user_id=\$1 AND stopped_at IS NOT NULL AND deleted_at IS NULL/);
 assert.doesNotMatch(intervalsSQL,/LIMIT/);
});
