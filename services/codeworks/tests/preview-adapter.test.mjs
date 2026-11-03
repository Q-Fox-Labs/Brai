// ABOUTME: Проверяет передачу намерения preview через дочерний JSON-RPC порт.
// ABOUTME: Ошибки и несопоставленные ответы трактуются только как неизвестный исход.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createPreviewAdapter} from '../src/preview-adapter.mjs';
const preview='00000000-0000-4000-8000-000000000001';
test('RPC передаёт только сохранённую идентичность и проверяет ответ',async()=>{
 let request;
 const call=createPreviewAdapter({executable:'/trusted',run:async(_path,args,options)=>{
  assert.deepEqual(args,[]);request=JSON.parse(options.input);return {code:0,stdout:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{status:'ready',preview_id:preview,generation:3,deployed_sha:'a'.repeat(40),image_reference:'ghcr.io/web@sha256:'+'b'.repeat(64)}})};
 }});
 assert.equal((await call('publish',preview,3)).status,'ready');
 assert.deepEqual(request.params,{preview_id:preview,generation:3});
});
test('потеря, ошибка и чужой id не доказывают результат публикации',async()=>{
 for(const run of [async()=>{throw Error('timeout');},async()=>({code:1}),async()=>({code:0,stdout:JSON.stringify({jsonrpc:'2.0',id:'other',result:{status:'ready'}})})])
  assert.equal((await createPreviewAdapter({executable:'/trusted',run})('publish',preview,1)).status,'unknown');
});
