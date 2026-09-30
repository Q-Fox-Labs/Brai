// ABOUTME: Проверяет прикладные переходы и порядок побочных эффектов через простые порты.
// ABOUTME: PostgreSQL и NATS проверяются отдельно настоящим интеграционным стендом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../dist/domain.js';
import { handleDelivery } from '../dist/flow.js';
const ids={eventId:'00000000-0000-4000-8000-000000000001',timerId:'00000000-0000-4000-8000-000000000002'};
const command={commandId:'00000000-0000-4000-8000-000000000003',expectedVersion:0};
test('START, STOP и старый STOP используют один активный интервал',()=>{
 const start=decide('brai.timer.v1.command.start',command,{version:0,active:null},'2026-01-01T00:00:00.000Z',ids);
 assert.deepEqual(start.state,{version:1,active:{timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.000Z'}});
 const wrong=decide('brai.timer.v1.command.stop',{...command,expectedVersion:1,timerId:command.commandId},start.state,'2026-01-01T00:00:02.125Z',ids);
 assert.equal(wrong.event.error.code,'TIMER_NOT_ACTIVE');assert.deepEqual(wrong.state,start.state);
 const stop=decide('brai.timer.v1.command.stop',{...command,expectedVersion:1,timerId:ids.timerId},start.state,'2026-01-01T00:00:02.125Z',ids);
 assert.equal(stop.event.interval.durationMs,2125);assert.equal(stop.event.interval.timerId,ids.timerId);assert.deepEqual(stop.state,{version:2,active:null});
 const stale=decide('brai.timer.v1.command.start',command,stop.state,'2026-01-01T00:00:03.000Z',ids);
 assert.equal(stale.event.error.code,'VERSION_CONFLICT');
});
test('PubAck предшествует ACK; ошибка любого порта оставляет команду без ACK',async()=>{
 const order=[];const saved={subject:'x',event:{eventId:ids.eventId},duplicate:false};
 await handleDelivery({subject:'x',data:new Uint8Array(),key:'s:1'},{save:async()=>{order.push('commit');return saved;},publish:async()=>{order.push('PubAck');},ack:()=>order.push('ACK')});
 assert.deepEqual(order,['commit','PubAck','ACK']);
 await assert.rejects(handleDelivery({subject:'x',data:new Uint8Array(),key:'s:2'},{save:async()=>saved,publish:async()=>{throw new Error('offline');},ack:()=>assert.fail('ACK on failed PubAck')}));
});
