// ABOUTME: Проверяет узкий порт Каналов и привязку полного Resolution к пакету Приёма.
// ABOUTME: Не подменяет runtime Каналов и не обращается к сети.
import test from 'node:test';
import assert from 'node:assert/strict';
import {channelRequest,checkResolution,channelError} from '../dist/channel-contract.js';
import {channelResult} from './channel-fixture.mjs';
const packet=()=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',source:'telegram',receivedAt:'2026-10-31T10:00:00.000001Z',scenario:'incoming.v1',original:{type:'message.incoming',causationId:null,data:{text:'',author:{kind:'human',id:'456',name:'Private name'},sourceRef:{botId:'123',chatId:'456',threadId:null},attachments:[{fileId:'private',filename:'private',mimeType:'image/jpeg',caption:'Private caption'},{fileId:'audio',mimeType:'audio/ogg'},{fileId:'pdf',mimeType:'application/pdf'}]}}});
test('only facts and external IDs cross the Channels boundary',()=>{
 const p=packet(),q=channelRequest(p);
 assert.deepEqual(q.facts,{hasText:true,contentKinds:['text','image','audio','document']});
 assert.deepEqual(q.author,{kind:'human',id:'456'});
 assert.deepEqual(q.initialFields,{});
 const json=JSON.stringify(q);assert.ok(!json.includes('Private'));assert.ok(!json.includes('fileId'));assert.ok(!json.includes('filename'));
 assert.equal(q.sourceRef.threadId,null);
});
test('full response rejects foreign identity, changed time, destination, rules hash and mode',()=>{
 const p=packet(),q=channelRequest(p),result=channelResult(q);
 checkResolution(p,result);
 const changes=[{packetId:'22222222-2222-4222-8222-222222222222'},{ownerId:'foreign'},{sourceId:'foreign'},{asOf:'2026-10-31T10:00:00.000002Z'},{processing:{mode:'jetstream',scenario:'incoming.v1'}},{destination:{...result.destination,chatId:'999'}},{rulesVersion:'f'.repeat(64)},{snapshot:{...result.snapshot,extra:true}},{assignments:{title:'unattributed'}}];
 for(const change of changes)assert.throws(()=>checkResolution(p,{...result,...change}),{code:'INVALID_CHANNEL_RESULT'});
});
test('only safe declared errors retain domain code and retryability',()=>{
 assert.equal(channelError({code:'BUSY',message:'BUSY',retryable:true},503).retryable,true);
 assert.equal(channelError({code:'DISABLED',message:'DISABLED',retryable:false},409).code,'DISABLED');
 assert.equal(channelError({code:'DISABLED',message:'secret',retryable:true},503).code,'INVALID_CHANNEL_RESULT');
 assert.equal(channelError({code:'SQL_SECRET',message:'secret',retryable:true},503).code,'INVALID_CHANNEL_RESULT');
});

test('hostile Unicode, depth, extension bytes and false input provenance are rejected',()=>{
 const p=packet(),base=channelResult(channelRequest(p));
 let nested={};for(let n=0;n<70;n++)nested={next:nested};
 let extension={};for(let n=0;n<9;n++)extension={next:extension};
 const values=[
  {...base,snapshot:{...base.snapshot,channel:{...base.snapshot.channel,name:'bad'+String.fromCharCode(0)}}},
  {...base,snapshot:{...base.snapshot,channel:{...base.snapshot.channel,name:'bad'+String.fromCharCode(0xd800)}}},
  {...base,snapshot:{...base.snapshot,channel:{...base.snapshot.channel,extensions:{'test.deep':nested}}}},
  {...base,snapshot:{...base.snapshot,channel:{...base.snapshot.channel,extensions:{'test.deep':extension}}}},
  {...base,snapshot:{...base.snapshot,channel:{...base.snapshot.channel,extensions:{'test.large':'a'.repeat(8193)}}}},
  {...base,assignments:{title:'forged'},fieldOrigins:{title:{source:'input',ruleId:null,rulesVersion:null,mode:null}}}
 ];
 for(const value of values)assert.throws(()=>checkResolution(p,value),{code:'INVALID_CHANNEL_RESULT'});
});
