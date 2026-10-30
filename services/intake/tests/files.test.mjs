// ABOUTME: Проверяет границу непрозрачных fileId файлового адаптера.
// ABOUTME: Не делает внешних запросов; проверяет схему и сформированные HTTP-адреса.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEvent} from '../dist/contracts.js';
import {createPorts} from '../dist/ports.js';
const event=fileId=>({version:1,eventId:randomUUID(),source:'source',type:'message.incoming',occurredAt:'2026-10-31T00:00:00Z',correlationId:'chain',causationId:null,data:{materialId:'material',revision:1,conversationId:'chat',replyToMessageId:null,author:{kind:'human',id:'human'},sourceRef:{},text:null,attachments:[{fileId,filename:'file.txt',mimeType:'text/plain'}]}});
test('dot segments are rejected by the published schema and before any side effect',async()=>{
 let requests=0;
 const ports=createPorts({async request(){requests++;throw Error('UNEXPECTED_REQUEST');}},null,{sources:{source:{fileBaseUrl:'http://source.test/files'}},artifactBaseUrl:'http://artifacts.test'});
 for(const id of ['.','..']){
  assert.throws(()=>parseEvent(Buffer.from(JSON.stringify(event(id)))),{code:'INVALID_ARGUMENT'});
  await assert.rejects(ports.prepareFiles({ownerId:'owner',source:'source',original:event(id)}),{code:'INVALID_ARGUMENT'});
 }
 assert.equal(requests,0);
});
test('opaque IDs remain one path segment inside the configured adapter base',async t=>{
 const seen=[],artifactId=randomUUID();
 const nc={async request(subject){return {data:Buffer.from(JSON.stringify(subject.endsWith('.prepare')?{artifact:{artifactId,ownerId:'owner',status:'pending'},uploadUrl:'http://artifacts.test/upload'}:{artifactId,ownerId:'owner',status:'ready'}))};}};
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(options.method!=='PUT')seen.push(new URL(url).pathname);
  return {ok:true,status:200,body:new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}})};
 });
 const ports=createPorts(nc,null,{sources:{source:{fileBaseUrl:'http://source.test/files'}},artifactBaseUrl:'http://artifacts.test'});
 for(const id of ['part/name','雪','a b','%2e%2e','x?y#z']){
  const e=parseEvent(Buffer.from(JSON.stringify(event(id))));
  const refs=await ports.prepareFiles({ownerId:'owner',source:'source',original:e});
  assert.equal(refs[0].artifactId,artifactId);
  assert.equal(seen.at(-1),'/files/'+encodeURIComponent(id));
 }
});
