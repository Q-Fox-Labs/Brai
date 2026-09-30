// ABOUTME: Проверяет прикладные переходы и порядок побочных эффектов через простые порты.
// ABOUTME: PostgreSQL и NATS проверяются отдельно настоящим интеграционным стендом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../dist/domain.js';
import { parseCommand } from '../dist/schema.js';
import { handleDelivery } from '../dist/flow.js';
const ids={eventId:'00000000-0000-4000-8000-000000000001',timerId:'00000000-0000-4000-8000-000000000002'};
const command={commandId:'00000000-0000-4000-8000-000000000003',expectedVersion:0};
test('START, STOP и старый STOP используют один активный интервал',()=>{
 const start=decide('start',command,{version:0,active:null},'2026-01-01T00:00:00.000Z',ids);
 assert.deepEqual(start.state,{version:1,active:{timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.000Z'}});
 const wrong=decide('stop',{...command,expectedVersion:1,timerId:command.commandId},start.state,'2026-01-01T00:00:02.125Z',ids);
 assert.equal(wrong.event.error.code,'TIMER_NOT_ACTIVE');assert.deepEqual(wrong.state,start.state);
 const stop=decide('stop',{...command,expectedVersion:1,timerId:ids.timerId},start.state,'2026-01-01T00:00:02.125Z',ids);
 assert.equal(stop.event.interval.durationMs,2125);assert.equal(stop.event.interval.timerId,ids.timerId);assert.deepEqual(stop.state,{version:2,active:null});
 const stale=decide('start',command,stop.state,'2026-01-01T00:00:03.000Z',ids);
 assert.equal(stale.event.error.code,'VERSION_CONFLICT');
});
test('PubAck предшествует ACK; ошибка любого порта оставляет команду без ACK',async()=>{
 const order=[];const saved={subject:'x',event:{eventId:ids.eventId},duplicate:false};
 await handleDelivery({subject:'x',data:new Uint8Array(),key:'s:1'},{save:async()=>{order.push('commit');return saved;},publish:async()=>{order.push('PubAck');},ack:()=>order.push('ACK')});
 assert.deepEqual(order,['commit','PubAck','ACK']);
 await assert.rejects(handleDelivery({subject:'x',data:new Uint8Array(),key:'s:2'},{save:async()=>saved,publish:async()=>{throw new Error('offline');},ack:()=>assert.fail('ACK on failed PubAck')}));
});

test('FIFO намерений использует время нажатий без CAS и задержки обработки',()=>{
 const startedAt='2026-01-01T00:00:00.000Z',stoppedAt='2026-01-01T00:00:00.175Z';
 const start=decide('start',{commandId:command.commandId,timerId:ids.timerId,startedAt},{version:50,active:null},'2026-01-02T00:00:00.000Z',ids);
 assert.equal(start.state.active.startedAt,startedAt);
 const blocked=decide('start',{commandId:'other',timerId:'other',startedAt},start.state,startedAt,ids);
 assert.equal(blocked.event.error.code,'TIMER_ALREADY_ACTIVE');
 const invalid=decide('stop',{commandId:'before',timerId:ids.timerId,stoppedAt:'2025-12-31T00:00:00.000Z'},start.state,stoppedAt,ids);
 assert.equal(invalid.event.error.code,'INVALID_ARGUMENT');
 const stop=decide('stop',{commandId:'stop',timerId:ids.timerId,stoppedAt},start.state,'2026-01-02T00:00:00.000Z',ids);
 assert.equal(stop.event.interval.durationMs,175);assert.equal(stop.event.interval.stoppedAt,stoppedAt);
 const next=decide('start',{commandId:'next',timerId:'next',startedAt:stoppedAt},stop.state,stoppedAt,ids);
 assert.equal(next.state.active.timerId,'next');assert.equal(next.state.version,53);
});

test('Intent timestamp отклоняет microseconds/leap second и сохраняет zero-ms интервал',()=>{
 const body={commandId:command.commandId,timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.123Z'};
 const parse=value=>parseCommand('brai.timer.v1.command.start',Buffer.from(JSON.stringify(value)));
 assert.ok(parse(body));
 const reused=decide('start',body,{version:0,active:null},body.startedAt,{...ids,timerIdExists:true});
 assert.equal(reused.event.error.code,'INVALID_ARGUMENT');assert.equal(reused.state.version,0);
 assert.equal(parse({...body,startedAt:'2026-01-01T00:00:00.123456Z'}),null);
 assert.equal(parse({...body,startedAt:'2026-01-01T00:00:60.123Z'}),null);
 const started=decide('start',body,{version:0,active:null},body.startedAt,ids);
 const stopped=decide('stop',{commandId:'stop',timerId:ids.timerId,stoppedAt:body.startedAt},started.state,body.startedAt,ids);
 assert.equal(stopped.event.interval.durationMs,0);
});
