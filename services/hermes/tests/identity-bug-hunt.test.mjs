// ABOUTME: Проверяет каталог bug-hunt личного Hermes без общих полномочий модели.
// ABOUTME: Проверка транспорта выполняется отдельно на реальном NATS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBugHuntCatalog} from '../identity/bug-hunt.mjs';
test('broker назначает owner и не предоставляет review',async()=>{
 const calls=[];const catalog=createBugHuntCatalog(async(...args)=>{calls.push(args);return {registered:true};},{userId:'owner-a',profileId:'profile-a'});
 assert.deepEqual(catalog.list().map(x=>x.name),['bug_hunt_help','bug_hunt_report','bug_hunt_get','bug_hunt_list','bug_hunt_search','bug_hunt_similar','bug_hunt_enrichment','bug_hunt_groups_list','bug_hunt_groups_get','bug_hunt_verification_run','bug_hunt_verification_get','bug_hunt_verification_list','bug_hunt_verification_evidence']);
 const guide=await catalog.call('bug_hunt_help',{});
 assert.ok(guide.instructions.includes('request_id'));assert.ok(guide.instructions.includes('Пример входа'));assert.equal(calls.length,0);
 await assert.rejects(catalog.call('bug_hunt_help',{owner_id:'forged'}));
 const input={request_id:'r',observation:{title:'Сбой',operation:'open',expected:'ok',observed:'failed'}};
 await catalog.call('bug_hunt_report',input);await catalog.call('bug_hunt_report',input);
 assert.deepEqual(calls[0][1],calls[1][1]);assert.deepEqual(calls[0][1].context,{kind:'hermes',userId:'owner-a',profileId:'profile-a'});
 for(const name of ['bug_hunt_review','bug_hunt_status'])await assert.rejects(catalog.call(name,{}));
 await assert.rejects(catalog.call('bug_hunt_report',{...input,owner_id:'b'}));assert.equal(calls.length,2);
 await catalog.call('bug_hunt_search',{query:'timeout'});
 assert.equal(calls[2][0],'brai.bug_hunt.v2.search');
 assert.deepEqual(calls[2][1].context,{kind:'hermes',userId:'owner-a',profileId:'profile-a'});
 await assert.rejects(catalog.call('bug_hunt_membership_update',{}));
 await assert.rejects(catalog.call('bug_hunt_search',{query:'x',owner_id:'foreign'}));
 assert.equal(calls.length,3);
 await catalog.call('bug_hunt_verification_run',{request_id:'verify-one',target:{kind:'pending'}});
 assert.equal(calls[3][0],'brai.bug_hunt.v3.verification.run.request');
 assert.deepEqual(calls[3][1].context,{kind:'hermes',userId:'owner-a',profileId:'profile-a'});
 for(const name of ['bug_hunt_verification_review','bug_hunt_verification_cancel','bug_hunt_verification_pause'])await assert.rejects(catalog.call(name,{}));
 await assert.rejects(catalog.call('bug_hunt_verification_run',{request_id:'v',target:{kind:'pending'},owner_id:'foreign'}));
 assert.equal(calls.length,4);
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
