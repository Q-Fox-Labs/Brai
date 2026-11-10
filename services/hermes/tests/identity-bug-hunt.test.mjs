// ABOUTME: Проверяет каталог bug-hunt личного Hermes без общих полномочий модели.
// ABOUTME: Проверка транспорта выполняется отдельно на реальном NATS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBugHuntCatalog} from '../identity/bug-hunt.mjs';
test('broker назначает owner и не предоставляет review',async()=>{
 const calls=[];const catalog=createBugHuntCatalog(async(...args)=>{calls.push(args);return {registered:true};},{userId:'owner-a',profileId:'profile-a'});
 assert.deepEqual(catalog.list().map(x=>x.name),['bug_hunt_help','bug_hunt_report','bug_hunt_get','bug_hunt_list']);
 const guide=await catalog.call('bug_hunt_help',{});
 assert.ok(guide.instructions.includes('request_id'));assert.ok(guide.instructions.includes('Пример входа'));assert.equal(calls.length,0);
 await assert.rejects(catalog.call('bug_hunt_help',{owner_id:'forged'}));
 const input={request_id:'r',observation:{title:'Сбой',operation:'open',expected:'ok',observed:'failed'}};
 await catalog.call('bug_hunt_report',input);await catalog.call('bug_hunt_report',input);
 assert.deepEqual(calls[0][1],calls[1][1]);assert.deepEqual(calls[0][1].context,{kind:'hermes',userId:'owner-a',profileId:'profile-a'});
 for(const name of ['bug_hunt_review','bug_hunt_status'])await assert.rejects(catalog.call(name,{}));
 await assert.rejects(catalog.call('bug_hunt_report',{...input,owner_id:'b'}));assert.equal(calls.length,2);
});

test('личный runtime публикует каталог при выключенном bug-hunt и закрывает его',async()=>{
 const {createRuntimeAdapters}=await import('../identity/runtime.mjs');
 const entry={userId:'fixture-owner',profileId:'fixture-profile',home:'/fixture/home',toolsConfigPath:'/fixture/tools.json',cacheRoot:'/fixture/cache',stagingRoot:'/fixture/staging/45001'};
 const tools={ownerId:entry.userId,nats:{servers:['nats://fixture']},history:{enabled:false},transcription:{enabled:false},gameCore:{enabled:false},publisher:{configPath:'/fixture/publisher.json'}};
 const publisher={ownerId:entry.userId,resultRoot:entry.cacheRoot,allowedReadRoots:[entry.stagingRoot]};
 let closed=false;
 const adapters=createRuntimeAdapters({runtimeProfiles:{45001:entry}},{readProtected:path=>path===entry.toolsConfigPath?tools:publisher,verifyDirectory:()=>{},start:async()=>({listTools:async()=>[{name:'history_list'},{name:'publish_file'}],call:async()=>({ok:true}),close:async()=>{closed=true;}})});
 try{
  const runtime=await adapters.perUserRuntime({...entry,workerUid:45001,status:'active'});
  assert.deepEqual((await runtime.listTools()).map(t=>t.name),['history_list']);
  assert.deepEqual(await runtime.callTool('history_list',{}),{ok:true});
  await assert.rejects(runtime.callTool('bug_hunt_report',{}),/IDENTITY_RUNTIME_CONFIG_NOT_READY/);
 }finally{await adapters.close();}
 assert.equal(closed,true);
});
