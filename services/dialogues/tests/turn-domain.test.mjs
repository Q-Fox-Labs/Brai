// ABOUTME: Проверяет предметные правила входов и результатов управляемого хода.
// ABOUTME: Не использует PostgreSQL, MCP или другие сервисы.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fieldId,mergeResult,message,requireCompletion,validateChanges,version} from '../dist/turn-domain.js';

test('версия и ID сообщают поле неверного аргумента',()=>{
 assert.equal(version('12'),'12');assert.throws(()=>version('0'),e=>e.code==='INVALID_ARGUMENT'&&e.details.field==='expected_version');
 assert.throws(()=>fieldId('bad id','turn_id'),e=>e.code==='INVALID_ARGUMENT'&&e.details.field==='turn_id');
});
test('пакет сохраняет формулировки и проверяет повтор ссылок',()=>{
 const changes=validateChanges({add:[{id:'one',formulation:'Первая',source_refs:['input']} ]});assert.equal(changes.add[0].formulation,'Первая');
 assert.throws(()=>validateChanges({add:[{id:'one',formulation:'Текст',source_refs:['x','x']}]}),{code:'INVALID_ARGUMENT'});
 assert.throws(()=>validateChanges({add:[{id:'one',formulation:'Текст'}],update:[{id:'one',status:'done'}]}),{code:'DUPLICATE_RESULT_ID'});
 for(const field of ['add','update'])assert.throws(()=>validateChanges({[field]:null}),e=>e.code==='INVALID_ARGUMENT'&&e.details.field==='changes.'+field);
 assert.throws(()=>validateChanges(null),e=>e.code==='INVALID_ARGUMENT'&&e.details.field==='changes');
 assert.throws(()=>validateChanges({['x'.repeat(100000)]:true}),e=>e.code==='INVALID_ARGUMENT'&&e.details.field_truncated===true&&e.details.field.length<200);
 assert.equal(message({id:'a',text:'😀'},'input').text,'😀');
});
test('частичный результат сохраняет прежние поля и требует причину',()=>{
 const old={formulation:'Задача',source_refs:['a'],status:'pending',result:null,verification:null,reason:null,remainder:null};
 assert.equal(mergeResult(old,{}).changed,false);const done=mergeResult(old,{status:'done',result:'готово'});assert.equal(done.changed,true);assert.deepEqual(done.next.source_refs,['a']);
 assert.throws(()=>mergeResult(old,{status:'not_done'}),{code:'REASON_REQUIRED'});assert.throws(()=>requireCompletion('cancelled',null,''),{code:'REASON_REQUIRED'});requireCompletion('not_done',null,'не проверено');
 assert.throws(()=>mergeResult(old,{status:'done'}),{code:'RESULT_REQUIRED'});
 assert.throws(()=>validateChanges({add:[{id:'x',formulation:'Задача',status:'finished'}]}),e=>e.code==='INVALID_ARGUMENT'&&e.details.field==='changes.add[0].status'&&e.details.allowed.includes('done'));
});
