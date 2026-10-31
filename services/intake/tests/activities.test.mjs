// ABOUTME: Проверяет сохранение snapshot и безопасные повторные попытки внешних заданий.
// ABOUTME: Не обращается к Temporal серверу; проверяет границу Activities через собственные порты.
import test from 'node:test';
import assert from 'node:assert/strict';
import {channelRequest} from '../dist/channel-contract.js';
import {channelResult} from './channel-fixture.mjs';
import {inputHash} from '../dist/contracts.js';
import {createActivities} from '../dist/activities.js';
function fixture(){
 const p={id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',source:'telegram',receivedAt:'2026-10-30T00:00:00Z',scenario:'incoming.v1',state:'registered',original:{type:'message.incoming',causationId:null,data:{conversationId:'conversation',sourceRef:{botId:'123',chatId:'456',threadId:null},author:{kind:'human',id:'456'},text:'text',attachments:[]}},jobs:{},attempts:{},resumeVersion:0};
 const rows=new Map([['packet',p]]),calls=[];
 const store={async get(id){return rows.has(id)?structuredClone(rows.get(id)):null;},async update(id,fn){const v=structuredClone(rows.get(id));fn(v);rows.set(id,v);return structuredClone(v);}};
 const ports={async call(name,packet,id){calls.push({name,id});if(name==='channel')return channelResult(channelRequest(packet));if(name==='contact')return {contactId:'person'};if(name==='inbox')return {messageId:'saved'};return {accepted:true,operationId:id};},async prepareFiles(){return [];},async history(){}};
 const configs=Object.fromEntries(['hermes','understand','memory','deliver'].map(k=>[k,{subject:'subject',resultSource:'source'}]));
 return {store,ports,rows,calls,a:createActivities(store,ports,configs)};
}
test('snapshot and prepared input survive repeated preparation',async()=>{
 const f=fixture();await f.a.prepare('packet');await f.a.prepare('packet');
 assert.equal(f.calls.filter(v=>v.name==='channel').length,1);
 assert.equal((await f.store.get('packet')).context.rulesVersion,inputHash([]));
});
test('retry of a lost start response uses one operation; unknown never becomes a new execution',async()=>{
 const f=fixture();const first=await f.a.startJob('packet','deliver'),same=await f.a.startJob('packet','deliver');
 assert.equal(first,same);
 await f.store.update('packet',p=>{p.jobs[first].state='unknown';});
 assert.equal(await f.a.startJob('packet','deliver'),first);
 assert.equal(f.calls.length,2);
 await assert.rejects(f.a.retryJob('packet','deliver',first),{message:'UNSAFE_RETRY'});
});
test('explicit retry after confirmed failure preserves old job and increments its attempt',async()=>{
 const f=fixture();const first=await f.a.startJob('packet','hermes');
 await f.store.update('packet',p=>{p.jobs[first].state='failed';});
 await f.a.retryJob('packet','hermes',first);
 const second=await f.a.startJob('packet','hermes');assert.notEqual(second,first);
 assert.equal(Object.keys((await f.store.get('packet')).jobs).length,2);
});
test('reply cannot claim a foreign parent context',async()=>{
 const f=fixture();await f.store.update('packet',p=>{p.original.type='message.outgoing';p.original.causationId='parent';});
 f.rows.set('parent',{ownerId:'foreign'});
 await assert.rejects(f.a.prepare('packet'),{message:'INVALID_REPLY_LINK'});
 assert.equal(f.calls.length,0);
});
test('completed process requires durable recipient, analysis and memory confirmations',async()=>{
 const f=fixture();await assert.rejects(f.a.complete('packet'),{message:'INCOMPLETE_PROCESS'});
});

test('success in another branch cannot hide or clear a pending stop',async()=>{
 const f=fixture();const v=await f.a.attention('packet','HISTORY_FAILED','audit');
 await f.a.prepare('packet');assert.equal((await f.store.get('packet')).state,'needs_attention');
 await f.a.attention('packet','DELIVERY_FAILED','deliver');
 await f.a.clearAttention('packet','audit',v);
 const p=await f.store.get('packet');assert.equal(p.state,'needs_attention');assert.equal(p.reason,'DELIVERY_FAILED');
 await f.a.clearAttention('packet','deliver',v);assert.equal((await f.store.get('packet')).state,'processing');
});

test('replayed attention preserves the stop threshold across an accepted resume',async()=>{
 const f=fixture();assert.equal(await f.a.attention('packet','FAILED','step'),0);
 await f.store.update('packet',p=>{p.resumeVersion=1;});
 assert.equal(await f.a.attention('packet','FAILED','step'),0);
 await f.a.clearAttention('packet','step',0);
 assert.equal((await f.store.get('packet')).state,'processing');
 assert.equal(await f.a.attention('packet','FAILED_AGAIN','step'),1);
});
test('retry transition is idempotent even after a later failed business attempt',async()=>{
 const f=fixture(),first=await f.a.startJob('packet','deliver');
 await f.store.update('packet',p=>{p.jobs[first].state='failed';});
 await f.a.retryJob('packet','deliver',first);await f.a.retryJob('packet','deliver',first);
 const second=await f.a.startJob('packet','deliver');assert.equal(second,'packet/deliver/1');
 await f.store.update('packet',p=>{p.jobs[second].state='failed';});
 await f.a.retryJob('packet','deliver',second);await f.a.retryJob('packet','deliver',first);
 assert.equal((await f.store.get('packet')).attempts.deliver,2);
 await assert.rejects(f.a.retryJob('packet','hermes',first),{message:'UNSAFE_RETRY'});
});

test('legacy context stops explicitly without rewriting snapshot or starting neighbors',async()=>{
 const f=fixture();await f.store.update('packet',p=>{p.context={channelId:'old',rulesVersion:'old'};});
 await assert.rejects(f.a.prepare('packet'),{message:'CHANNEL_CONTEXT_VERSION_UNSUPPORTED'});
 assert.deepEqual((await f.store.get('packet')).context,{channelId:'old',rulesVersion:'old'});
 assert.equal(f.calls.length,0);
});

test('malformed channel result stops before persistence with a permanent diagnostic',async()=>{
 const f=fixture(),call=f.ports.call;
 f.ports.call=async(name,p,id)=>{const result=await call(name,p,id);if(name==='channel')result.snapshot.channel.name='bad'+String.fromCharCode(0);return result;};
 await assert.rejects(f.a.prepare('packet'),{message:'INVALID_CHANNEL_RESULT'});
 const p=await f.store.get('packet');assert.equal(p.context,undefined);
 assert.deepEqual(p.dependencyFailure,{stage:'channel.resolve',code:'INVALID_CHANNEL_RESULT',retryable:false});
 assert.equal(f.calls.length,1);
});
