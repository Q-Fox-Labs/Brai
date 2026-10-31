// ABOUTME: Проверяет UUID ссылок и доступ к прежним версиям без PostgreSQL и NATS.
// ABOUTME: История и хеш исходной команды остаются неизменными при сравнении идентичности.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../dist/domain.js';
import {hash,request} from '../dist/contracts.js';
const connectionId='abcdefab-1111-4111-8111-111111111111',channelId='abcdefab-2222-4222-8222-222222222222',parentId='abcdefab-3333-4333-8333-333333333333';
const time='2026-10-31T00:00:00.123456Z';
const settings={name:'Synthetic channel',enabled:true,locationRef:'space:fixture',allowedActorIds:['456'],rules:[],extensions:{}};
const version={id:channelId,ownerId:'fixture',connectionId:connectionId.toUpperCase(),kind:'dialog',address:{botId:'123',chatId:'456',threadId:null},parentId:null,version:1,rulesVersion:hash([]),effectiveFrom:time,recordedAt:time,settings};
const command={requestId:'abcdefab-4444-4444-8444-444444444444',ownerId:'fixture',actorId:null,reason:'UUID regression',connectionId:connectionId.toUpperCase(),kind:'dialog',address:version.address,parentId:null,settings};
const receipt={requestId:command.requestId,operation:'channels.create',ownerId:'fixture',inputHash:hash({operation:'channels.create',request:request('channels.create',command)}),committedAt:time,result:version,historyEvent:{id:'abcdefab-5555-4555-8555-555555555555',type_id:101,occurred_at:time,actor_id:null,scope_type:'user',scope_id:'fixture',object_type:'channel',object_id:channelId,data:{operation:'channels.create',requestId:command.requestId,version:1,previousVersion:null,changes:Object.keys(settings).sort()}}};
const binding=connectionIds=>({ownerIds:['fixture'],operations:['channels.get','channels.create','operations.get'],sourceIds:[],replySourceIds:[],connectionIds});
const api=(repo,ids)=>createService({transaction:async(_ctx,work)=>work(repo)},{test:binding(ids)},Buffer.alloc(32,7));
test('UUID scope ignores hexadecimal case but never changes owner or allowed connection',async()=>{
 for(const stored of [connectionId,connectionId.toUpperCase()]){
  const value={...version,connectionId:stored};
  const repo={channel:async()=>({...value,currentVersion:1}),version:async()=>value};
  for(const allowed of [connectionId,connectionId.toUpperCase()])assert.deepEqual(await api(repo,[allowed]).execute('channels.get','test',{ownerId:'fixture',channelId}),value);
  for(const ids of [[],['abcdefab-9999-4999-8999-999999999999']])await assert.rejects(api(repo,ids).execute('channels.get','test',{ownerId:'fixture',channelId}),{code:'FORBIDDEN'});
  await assert.rejects(api({...repo,channel:async()=>({...value,ownerId:'foreign',currentVersion:1})},[connectionId]).execute('channels.get','test',{ownerId:'fixture',channelId}),{code:'NOT_FOUND'});
 }
});
test('legacy uppercase receipts replay exactly with their original input hash',async()=>{
 const saved=structuredClone(receipt),repo={lockKey:async()=>{},receipt:async()=>saved};
 const service=api(repo,[connectionId]);
 assert.deepEqual(await service.execute('channels.create','test',command),receipt);
 assert.deepEqual(await service.execute('operations.get','test',{ownerId:'fixture',requestId:command.requestId.toUpperCase()}),receipt);
 await assert.rejects(service.execute('channels.create','test',{...command,reason:'changed'}),{code:'REQUEST_ID_CONFLICT'});
 assert.deepEqual(saved,receipt);
});
test('new channel links use loaded canonical IDs even with a legacy parent body',async()=>{
 for(const stored of [connectionId,connectionId.toUpperCase()]){
  const writes=[];
  const repo={
   lockKey:async()=>{},receipt:async()=>null,
   connection:async()=>({id:connectionId,ownerId:'fixture',botId:'123',currentVersion:1}),
   channel:async()=>({id:parentId,ownerId:'fixture',connectionId:stored,kind:'dialog',address:version.address,currentVersion:1}),
   now:async()=>time,
   insertIdentity:async(_kind,value)=>writes.push(structuredClone(value)),
   insertVersion:async()=>{},saveReceipt:async()=>{}
  };
  const result=await api(repo,[connectionId]).execute('channels.create','test',{...command,kind:'topic',parentId:parentId.toUpperCase(),address:{...version.address,threadId:'7'}});
  assert.equal(result.result.connectionId,connectionId);
  assert.equal(result.result.parentId,parentId);
  assert.equal(writes[0].connectionId,connectionId);
 }
});
