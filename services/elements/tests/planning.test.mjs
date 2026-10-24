// ABOUTME: Проверяет неизменный нормативный сборщик через продуктовый адаптер.
// ABOUTME: Использует только синтетический пакет; не принимает решения Игрока и не обращается к БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assemble,baseline,PlanningFault} from '../dist/planning.js';

import {fixture} from './planning-fixture.mjs';

test('нормативная сборка сохраняет границы, выпуск связывает критерии и кандидат',async()=>{
 assert.equal(baseline.id,'planning-9.2-review-1.3');
 const f=fixture();
 const bound=await assemble({files:f.files,baseline:f.criteria});
 const built=await assemble({files:f.files,baseline:f.criteria,candidate:f.candidate});
 assert.equal(bound.baseline_sha256,built.baseline_sha256);
 assert.equal(built.stage.operation.id,f.move.id);
 assert.equal(built.stage.records.length,5);
 assert.equal(built.stage.resources.filter(r=>r.state==='given').length,1);
 assert.ok(built.stage.resources.some(r=>r.state==='expected'&&r.producer===built.stage.symbols.uppercase));
 const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,verdict:'accept',coverage:[{requirement:'word',items:['upper']},{requirement:'signal',items:['signal']}],errors:[],notes:[]};
 const released=await assemble({files:f.files,baseline:f.criteria,candidate:f.candidate,review});
 assert.equal(released.receipt.operation,f.move.id);
 assert.equal(released.receipt.element,f.element.id);
 await assert.rejects(()=>assemble({files:f.files,baseline:f.criteria,candidate:f.candidate,review:{...review,coverage:[{requirement:'word',items:['signal']},{requirement:'signal',items:['signal']}]}}),/INVALID_ARGUMENT/);
 await assert.rejects(()=>assemble({files:f.files,baseline:f.criteria,candidate:f.candidate,review:{...review,candidate_sha256:'0'.repeat(64)}}),/INVALID_ARGUMENT/);
});

test('отказ сохраняет этап и причину, исправленная цитата проходит bind',async()=>{
 const f=fixture(),invalid=structuredClone(f.criteria);
 invalid.requirements[0].quote='Цитата, которой нет в исходном поручении.';
 await assert.rejects(assemble({files:f.files,baseline:invalid}),error=>{
  assert.ok(error instanceof PlanningFault);
  assert.equal(error.code,'INVALID_ARGUMENT');
  assert.deepEqual(error.diagnostic,{phase:'bind',reason:'Нет основания требования'});
  return true;
 });
 assert.ok((await assemble({files:f.files,baseline:f.criteria})).baseline_sha256);
 await assert.rejects(assemble({files:f.files,baseline:f.criteria,candidate:{...f.candidate,unexpected:true}}),error=>{
  assert.deepEqual(error.diagnostic,{phase:'build',reason:'Неверный состав предметного плана'});return true;
 });
 const built=await assemble({files:f.files,baseline:f.criteria,candidate:f.candidate});
 await assert.rejects(assemble({files:f.files,baseline:f.criteria,candidate:f.candidate,review:{baseline_sha256:built.baseline_sha256,candidate_sha256:'0'.repeat(64)}}),error=>{
  assert.deepEqual(error.diagnostic,{phase:'review',reason:'Проверена другая версия'});return true;
 });
});

test('диагностика не возвращает динамические значения и пути из ошибок сборщика',async()=>{
 const f=fixture(),built=await assemble({files:f.files,baseline:f.criteria,candidate:f.candidate});
 const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,
  verdict:'reject',coverage:[{requirement:'word',items:['upper']},{requirement:'signal',items:['signal']}],errors:['PRIVATE-REVIEW-TEXT /private/path'],notes:[]};
 await assert.rejects(assemble({files:f.files,baseline:f.criteria,candidate:f.candidate,review}),error=>{
  assert.deepEqual(error.diagnostic,{phase:'review',reason:'Неверная структура данных планирования'});
  assert.ok(!JSON.stringify(error).includes('PRIVATE-REVIEW-TEXT'));return true;
 });
});
