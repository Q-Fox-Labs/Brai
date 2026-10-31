// ABOUTME: Проверяет регистр UUID через настоящий процесс Каналов и ограниченные NATS identities.
// ABOUTME: Старые body и квитанции создаются только вставкой fixture; история не переписывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createStore} from '../../dist/storage.js';
import {hash,request} from '../../dist/contracts.js';
import {enabled,startChannels,seed,incoming,metadata} from './fixture.mjs';
test('UUID references: canonical new identities and unchanged legacy history under scoped NATS callers',{skip:!enabled,timeout:60000},async t=>{
 const f=await startChannels();
 try{
  await f.owner.query('TRUNCATE channels.channel_operation_receipts,channels.channel_resolutions,channels.channel_versions,channels.channels,channels.channel_connection_versions,channels.channel_connections');
  const {c,h,channelSettings}=await seed(f),other=await seed(f,{sourceId:'telegram_other',botId:'124'});
  const cid=c.result.id,upper=cid.toUpperCase();
  const legacyCommand={...metadata(),connectionId:upper,kind:'dialog',address:{botId:'123',chatId:'456',threadId:null},parentId:null,settings:channelSettings};
  let legacy;
  // AIDEV-NOTE: Имитируем сохранение прежней версии кода, только INSERT через штатный SQL-порт.
  await createStore(f.app).transaction({deadline:performance.now()+5000},async r=>{
   const time=await r.now(),identity={id:randomUUID(),ownerId:'fixture',connectionId:upper,kind:'dialog',address:legacyCommand.address,parentId:null,currentVersion:1};
   const value={...structuredClone(h.result),id:identity.id,connectionId:upper,kind:'dialog',address:identity.address,parentId:null,effectiveFrom:time,recordedAt:time};
   legacy={...structuredClone(h),requestId:legacyCommand.requestId,inputHash:hash({operation:'channels.create',request:request('channels.create',legacyCommand)}),committedAt:time,result:value,
    historyEvent:{...structuredClone(h.historyEvent),id:randomUUID(),object_id:identity.id,occurred_at:time,data:{...h.historyEvent.data,requestId:legacyCommand.requestId}}};
   await r.insertIdentity('channel',identity);
   await r.insertVersion('channel',identity,{value,actorId:null,reason:legacyCommand.reason});
   await r.saveReceipt('admin_test',legacy);
  });
  const oldInput=incoming({asOf:legacy.result.effectiveFrom,sourceRef:legacy.result.address});
  const oldResolution=await f.rpc('resolve',oldInput);
  const stored=async()=>({
   identity:(await f.owner.query('SELECT body::text value FROM channels.channels WHERE id=$1',[legacy.result.id])).rows[0].value,
   version:(await f.owner.query('SELECT body::text value FROM channels.channel_versions WHERE channel_id=$1 AND version=1',[legacy.result.id])).rows[0].value,
   receipt:(await f.owner.query("SELECT body::text value FROM channels.channel_operation_receipts WHERE caller_id='admin_test' AND request_id=$1",[legacy.requestId])).rows[0].value,
   resolution:(await f.owner.query('SELECT result::text value FROM channels.channel_resolutions WHERE id=$1',[oldResolution.resolutionId])).rows[0].value
  });
  const original=await stored();
  const scopes=async id=>{
   const file=f.temp+'/runtime.json',config=JSON.parse(await readFile(file,'utf8'));
   for(const caller of Object.values(config.callers))caller.connectionIds=[id];
   await writeFile(file,JSON.stringify(config),{mode:0o600});await f.restart();
  };
  for(const mode of ['legacy','new'])await t.test(mode+' channel: list/get/create replay/receipt/publish/resolve/delivery and revocation',async()=>{
   await scopes(cid);
   const cmd=mode==='legacy'?legacyCommand:{...metadata(),connectionId:upper,kind:'topic',address:{botId:'123',chatId:'456',threadId:'8'},parentId:legacy.result.id.toUpperCase(),settings:channelSettings};
   const receipt=mode==='legacy'?legacy:await f.rpc('channels.create',cmd);
   const value=receipt.result;
   if(mode==='new'){assert.equal(value.connectionId,cid);assert.equal(value.parentId,legacy.result.id);}
   else assert.equal(value.connectionId,upper);
   const list=await f.rpc('channels.list',{ownerId:'fixture',connectionId:upper},f.reader,'reader_test');
   assert.ok(list.items.some(v=>v.id===value.id));
   assert.deepEqual(await f.rpc('channels.get',{ownerId:'fixture',channelId:value.id.toUpperCase()},f.reader,'reader_test'),value);
   assert.deepEqual(await f.rpc('channels.create',cmd),receipt);
   assert.deepEqual(await f.rpc('operations.get',{ownerId:'fixture',requestId:receipt.requestId.toUpperCase()}),receipt);
   await assert.rejects(f.rpc('channels.create',{...cmd,reason:'different'}),{code:'REQUEST_ID_CONFLICT'});
   await assert.rejects(f.rpc('channels.get',{ownerId:'fixture',channelId:other.h.result.id},f.reader,'reader_test'),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('channels.get',{ownerId:'foreign',channelId:value.id}),{code:'NOT_FOUND'});
   const q=mode==='legacy'?oldInput:incoming({asOf:value.effectiveFrom,sourceRef:value.address});
   const resolution=await f.rpc('resolve',q);
   if(mode==='legacy')assert.deepEqual(resolution,oldResolution);
   assert.equal(resolution.connectionId,cid);
   const check={ownerId:'fixture',resolutionId:resolution.resolutionId.toUpperCase(),destinationHash:hash(resolution.destination)};
   assert.equal((await f.rpc('delivery.check',check,f.delivery,'delivery_test')).allowed,true);
   const reply=incoming({eventType:'message.outgoing',direction:'outgoing',sourceId:'fixture_hermes',sourceRef:value.address,author:{kind:'agent',id:'hermes'},replyTo:{packetId:resolution.packetId,resolutionId:resolution.resolutionId.toUpperCase()}});
   const outgoing=await f.rpc('resolve',reply);
   assert.deepEqual(outgoing.destination,resolution.destination);
   const publish={...metadata(),channelId:value.id.toUpperCase(),expectedVersion:1,settings:{...channelSettings,name:'Published '+mode}};
   const published=await f.rpc('channels.publish',publish);
   assert.equal(published.result.version,2);
   assert.deepEqual(await f.rpc('channels.publish',publish),published);
   assert.deepEqual(await f.rpc('channels.get',{ownerId:'fixture',channelId:value.id,version:1}),value);
   assert.deepEqual(await f.rpc('resolve',q),resolution);
   assert.deepEqual(await f.rpc('channels.create',cmd),receipt);
   await scopes(other.c.result.id);
   await assert.rejects(f.rpc('channels.get',{ownerId:'fixture',channelId:value.id}),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('channels.create',cmd),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('operations.get',{ownerId:'fixture',requestId:receipt.requestId}),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('resolve',q),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('delivery.check',check,f.delivery,'delivery_test'),{code:'FORBIDDEN'});
   assert.deepEqual(await stored(),original);
  });
 }finally{await f.close();}
});
