// ABOUTME: Проверяет NATS чтение системного каталога через прикладные обработчики.
// ABOUTME: Порт хранения синтетический и не содержит пользовательских событий.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryHandlers } from '../dist/domain.js';
import { createLoadGate } from '../dist/load.js';
import { runNats } from '../dist/nats.js';

test('catalog validation, pagination and missing type follow MCP semantics', async () => {
 const rows=[{id:1,code:'a',name:'A',description:''},{id:2,code:'b',name:'B',description:''}];
 const type={id:3,category_id:1,code:'c',name:'C',description:''};
 const scopes=[], endpoints=new Map();
 const store={ready:async()=>{},async transaction(scope,context,run){
  scopes.push(scope);
  return run({catalogList:async(table,category,after,count)=>(table==='sys_categories'?rows:[type]).filter(row=>(!category||row.category_id===category)&&(!after||row.id>after)).slice(0,count),
   catalog:async(table,id)=>id===3?type:null});
 }};
 const service={info:()=>({id:'test'}),addEndpoint:(name,options)=>endpoints.set(name,options.handler),stop:async()=>{}};
 const connection={flush:async()=>{},services:{add:async()=>service}};
 const gate=createLoadGate({deadlineMs:1000,active:1,queue:1});
 const runtime=await runNats(connection,createHistoryHandlers(store,{cursorKey:'synthetic-history-cursor-key-32-bytes'}),gate);
 async function call(name,args){
  let resolve;const response=new Promise(done=>resolve=done);
  endpoints.get(name)(null,{data:Buffer.from(JSON.stringify(args)),respond:payload=>resolve({body:JSON.parse(payload)}),respondError:(status,code,payload)=>resolve({status,code,body:JSON.parse(payload)})});
  return response;
 }
 try {
  const first=await call('categoriesList',{limit:1});assert.deepEqual(first.body.items,[rows[0]]);
  assert.deepEqual((await call('categoriesList',{cursor:first.body.next_cursor})).body.items,[rows[1]]);
  assert.deepEqual((await call('typesList',{category_id:1})).body.items,[type]);
  assert.deepEqual((await call('typeGet',{id:3})).body,{type});
  assert.equal((await call('typesList',{category_id:0})).code,'INVALID_ARGUMENT');
  assert.equal((await call('typeGet',{id:3,user_id:'other'})).code,'INVALID_ARGUMENT');
  assert.equal((await call('typeGet',{id:4})).code,'NOT_FOUND');
  assert.ok(scopes.every(scope=>scope===null));
 } finally {gate.stopAccepting();await runtime.stop();await gate.drain();}
});
