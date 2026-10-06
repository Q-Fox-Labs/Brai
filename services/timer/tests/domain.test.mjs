// ABOUTME: Проверяет прикладные переходы и порядок побочных эффектов через простые порты.
// ABOUTME: PostgreSQL и NATS проверяются отдельно настоящим интеграционным стендом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, decideMutation } from '../dist/domain.js';
import { parseCommand } from '../dist/schema.js';
import { handleDelivery } from '../dist/flow.js';
const ids={eventId:'00000000-0000-4000-8000-000000000001',timerId:'00000000-0000-4000-8000-000000000002'};
const command={userId:'user-a',commandId:'00000000-0000-4000-8000-000000000003',expectedVersion:0};
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
 const start=decide('start',{userId:'user-a',commandId:command.commandId,timerId:ids.timerId,startedAt},{version:50,active:null},'2026-01-02T00:00:00.000Z',ids);
 assert.equal(start.state.active.startedAt,startedAt);
 const blocked=decide('start',{userId:'user-a',commandId:'other',timerId:'other',startedAt},start.state,startedAt,ids);
 assert.equal(blocked.event.error.code,'TIMER_ALREADY_ACTIVE');
 const invalid=decide('stop',{userId:'user-a',commandId:'before',timerId:ids.timerId,stoppedAt:'2025-12-31T00:00:00.000Z'},start.state,stoppedAt,ids);
 assert.equal(invalid.event.error.code,'INVALID_ARGUMENT');
 const stop=decide('stop',{userId:'user-a',commandId:'stop',timerId:ids.timerId,stoppedAt},start.state,'2026-01-02T00:00:00.000Z',ids);
 assert.equal(stop.event.interval.durationMs,175);assert.equal(stop.event.interval.stoppedAt,stoppedAt);
 const next=decide('start',{userId:'user-a',commandId:'next',timerId:'next',startedAt:stoppedAt},stop.state,stoppedAt,ids);
 assert.equal(next.state.active.timerId,'next');assert.equal(next.state.version,53);
});

test('Intent timestamp отклоняет microseconds/leap second и сохраняет zero-ms интервал',()=>{
 const body={userId:'user-a',commandId:command.commandId,timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.123Z'};
 const parse=value=>parseCommand('brai.timer.v2.command.start',Buffer.from(JSON.stringify(value)));
 assert.ok(parse(body));
 const reused=decide('start',body,{version:0,active:null},body.startedAt,{...ids,timerIdExists:true});
 assert.equal(reused.event.error.code,'INVALID_ARGUMENT');assert.equal(reused.state.version,0);
 assert.equal(parse({...body,startedAt:'2026-01-01T00:00:00.123456Z'}),null);
 assert.equal(parse({...body,startedAt:'2026-01-01T00:00:60.123Z'}),null);
 const started=decide('start',body,{version:0,active:null},body.startedAt,ids);
 const stopped=decide('stop',{userId:'user-a',commandId:'stop',timerId:ids.timerId,stoppedAt:body.startedAt},started.state,body.startedAt,ids);
 assert.equal(stopped.event.interval.durationMs,0);
});


test('v2 требует владельца и сохраняет его в каждом исходе',()=>{
 const input={userId:'better-auth-user',commandId:command.commandId,timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.000Z'};
 const encoded=Buffer.from(JSON.stringify(input));
 assert.ok(parseCommand('brai.timer.v2.command.start',encoded));
 assert.equal(parseCommand('brai.timer.v1.command.start',encoded),null);
 const {userId,...anonymous}=input;
 assert.equal(parseCommand('brai.timer.v2.command.start',Buffer.from(JSON.stringify(anonymous))),null);
 assert.equal(parseCommand('brai.timer.v2.command.start',Buffer.from(JSON.stringify({...input,userId:''}))),null);
 const begun=decide('start',input,{version:0,active:null},input.startedAt,ids);
 assert.equal(begun.event.userId,input.userId);
 const rejected=decide('start',input,begun.state,input.startedAt,ids);
 assert.equal(rejected.event.userId,input.userId);
 const ended=decide('stop',{userId:input.userId,commandId:command.commandId,timerId:ids.timerId,stoppedAt:input.startedAt},begun.state,input.startedAt,ids);
 assert.equal(ended.event.userId,input.userId);
});

test('edit/delete используют CAS, проверяют границы и сохраняют активный таймер',()=>{
 const active={timerId:ids.timerId,startedAt:'2026-01-01T00:00:00.000Z'};
 const state={version:7,active};
 const target={timerId:'00000000-0000-4000-8000-000000000004',startedAt:'2026-01-01T00:00:01.000Z',stoppedAt:'2026-01-01T00:00:02.000Z',durationMs:1000};
 const edit={userId:'user-a',commandId:'edit',timerId:target.timerId,expectedVersion:7,startedAt:'2026-01-01T00:00:02.000Z',stoppedAt:'2026-01-01T00:00:03.125Z'};
 const saved=decideMutation('edit',edit,state,target,false,ids.eventId);
 assert.equal(saved.event.version,8);assert.equal(saved.event.interval.durationMs,1125);assert.deepEqual(saved.state,{version:8,active});
 assert.equal(decideMutation('edit',{...edit,expectedVersion:6},state,target,false,ids.eventId).event.error.code,'VERSION_CONFLICT');
 assert.equal(decideMutation('edit',{...edit,stoppedAt:edit.startedAt},state,target,false,ids.eventId).event.error.code,'INVALID_ARGUMENT');
 assert.equal(decideMutation('edit',edit,state,target,true,ids.eventId).event.error.code,'INTERVAL_OVERLAP');
 assert.equal(decideMutation('edit',edit,state,null,false,ids.eventId).event.error.code,'NOT_FOUND');
 const removed=decideMutation('delete',{...edit,expectedVersion:7},state,target,false,ids.eventId);
 assert.equal(removed.event.operation,'delete');assert.equal(removed.state.version,8);assert.deepEqual(removed.state.active,active);
});

test('schema parser accepts only exact owner edit/delete payloads',()=>{
 const base={userId:'user-a',commandId:ids.eventId,timerId:ids.timerId,expectedVersion:3};
 const parse=(type,value)=>parseCommand(`brai.timer.v2.command.${type}`,Buffer.from(JSON.stringify(value)));
 assert.ok(parse('edit',{...base,startedAt:'2026-01-01T00:00:00.000Z',stoppedAt:'2026-01-01T00:00:01.000Z'}));
 assert.ok(parse('delete',base));
 assert.equal(parse('edit',{...base,startedAt:'2026-01-01T00:00:00.123456Z',stoppedAt:'2026-01-01T00:00:01.000Z'}),null);
 assert.equal(parse('delete',{...base,extra:true}),null);
});
