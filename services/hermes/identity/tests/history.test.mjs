// ABOUTME: Проверяет каталог инструментов History и маршрутизацию его чтений.
// ABOUTME: Синтетический порт исключает доступ к сети и пользовательским данным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryCatalog } from '../history.mjs';

test('catalog forwards only valid public reads and preserves pagination', async () => {
 const calls=[];
 const port=createHistoryCatalog(async (...args)=>{calls.push(args);return {items:[],next_cursor:null};});
 const tools=port.list();
 assert.deepEqual(tools.map(tool=>tool.name),['history_categories_list','history_types_list','history_type_get']);
 assert.equal(tools[1].inputSchema.properties.category_id.minimum,1);
 assert.deepEqual(tools[2].inputSchema.required,['id']);
 const signal=new AbortController().signal;
 await port.call('history_categories_list',{limit:1,cursor:'cursor'},signal);
 await port.call('history_types_list',{category_id:2,limit:100,cursor:null});
 await port.call('history_type_get',{id:3});
 assert.deepEqual(calls.map(call=>call.slice(0,2)),[
  ['brai.history.v1.query.categories-list',{limit:1,cursor:'cursor'}],
  ['brai.history.v1.query.types-list',{category_id:2,limit:100,cursor:null}],
  ['brai.history.v1.query.type-get',{id:3}],
 ]);
 assert.equal(calls[0][2],signal);
 for (const [name,args] of [
  ['history_categories_list',{limit:101}],['history_categories_list',{user_id:'other'}],
  ['history_types_list',{category_id:0}],['history_type_get',{}],
  ['history_type_get',{id:1,owner_id:'other'}],['history_append',{}],
 ]) await assert.rejects(port.call(name,args),/INVALID_ARGUMENT/);
 assert.equal(calls.length,3);
});

