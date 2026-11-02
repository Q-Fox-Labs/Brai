// ABOUTME: Проверяет ограниченную и обратимую упаковку полного графа для веба.
// ABOUTME: Синтетические данные не попадают в БД или NATS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { graphReply, respond } from '../dist/nats.js';

test('large graph travels losslessly when explicitly compressed', () => {
 const graph = {elements:[],moves:[],resources:[{content:'синтетические данные '.repeat(40000)}],revisions:[{fields:{text:'полная версия'}}]};
 assert.throws(() => graphReply(graph,false), e => e.code === 'INTERNAL');
 const packed = JSON.parse(graphReply(graph,true).toString());
 const raw = gunzipSync(Buffer.from(packed.data,'base64'));
 assert.equal(packed.encoding,'gzip-base64'); assert.equal(packed.size,raw.length);
 assert.deepEqual(JSON.parse(raw.toString()),graph);
});
test('compressed and uncompressed limits reject oversized responses', () => {
 assert.throws(() => graphReply({text:'x'.repeat(8_388_609)},true), e => e.code === 'INTERNAL');
 assert.throws(() => graphReply({text:randomBytes(500000).toString('base64')},true), e => e.code === 'INTERNAL');
 assert.deepEqual(JSON.parse(graphReply({ok:true},false).toString()),{ok:true});
});
test('NATS graph negotiates compression while old clients keep the original reply', async () => {
 const graph={elements:[],moves:[],resources:[{content:'synthetic'.repeat(80000)}]};
 const calls=[];let data,error;
 const handlers={graphGet:async value=>{calls.push(value);return graph;}};
 const gate={run:async fn=>fn({})};
 const invoke=async request=>{
  data=undefined;error=undefined;
  await respond('graph',{data:Buffer.from(JSON.stringify(request)),respond:value=>{data=value;},respondError:(status,code)=>{error={status,code};}},handlers,gate);
 };
 await invoke({user_id:'synthetic',response_encoding:'gzip-base64'});
 assert.deepEqual(calls.pop(),{user_id:'synthetic'});
 const envelope=JSON.parse(data.toString());
 assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(envelope.data,'base64')).toString()),graph);
 await invoke({user_id:'synthetic'});assert.equal(error.code,'INTERNAL');
 await invoke({user_id:'synthetic',response_encoding:'unsupported'});assert.equal(error.code,'INVALID_ARGUMENT');
});
