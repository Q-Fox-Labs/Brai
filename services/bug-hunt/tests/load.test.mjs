// ABOUTME: Проверяет конечную очередь и удержание слота после тайм-аута.
// ABOUTME: Не требует внешних процессов и не маскирует продолжающуюся операцию.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGate} from '../dist/load.js';
test('deadline сохраняет active slot до фактической остановки',async()=>{
 const gate=createGate(1,1,30);let finish;
 const first=gate.run(()=>new Promise(r=>{finish=r;}),true);
 const second=gate.run(async()=>1);
 await assert.rejects(gate.run(async()=>2),e=>e.code==='BUSY');
 await assert.rejects(first,e=>e.code==='DEADLINE_EXCEEDED'&&e.outcome==='unknown');
 await assert.rejects(second,e=>e.code==='DEADLINE_EXCEEDED'&&e.outcome==='not_accepted');
 let drained=false;const drain=gate.drain().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);
 finish();await drain;assert.equal(drained,true);gate.stop();await assert.rejects(gate.run(async()=>1),e=>e.code==='BUSY');
});
