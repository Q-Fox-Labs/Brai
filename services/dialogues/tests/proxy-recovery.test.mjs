// ABOUTME: Проверяет безопасное восстановление вызова proxy после ошибки транспорта.
// ABOUTME: Не открывает сеть и фиксирует число вызовов операции.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callWithRecovery} from '../dist/proxy-recovery.js';

test('неизвестный исход не запускает повтор записи',async()=>{
 let dispatches=0,reconnections=0;
 const result=await callWithRecovery('dialogues_exchange',async()=>{dispatches++;throw new Error('connection lost after dispatch');},async()=>{reconnections++;},async()=>{dispatches++;return {};},()=>false);
 assert.equal(result.isError,true);assert.equal(dispatches,1);assert.equal(reconnections,0);
});
test('отказ до вызова допускает только один повтор того же запроса',async()=>{
 let dispatches=0,reconnections=0;
 const result=await callWithRecovery('dialogues_exchange',async()=>{throw new Error('session 404');},async()=>{reconnections++;},async()=>{dispatches++;return {saved:true};},()=>true);
 assert.equal(result.saved,true);assert.equal(dispatches,1);assert.equal(reconnections,1);
});
