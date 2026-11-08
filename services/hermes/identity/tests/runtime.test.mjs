// ABOUTME: Проверяет сборку личного runtime и границу publisher по UID.
// ABOUTME: Использует подставные порты без реальных токенов, сети и root-файлов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAdapters } from '../runtime.mjs';
import { Control, privateCall } from '../control.mjs';

function fixture(){
 const profiles={'1001':{userId:'u1',profileId:'p1',home:'/home/u1',toolsConfigPath:'/cfg/1',stagingRoot:'/stage/1001',cacheRoot:'/result/1001'},'1002':{userId:'u2',profileId:'p2',home:'/home/u2',toolsConfigPath:'/cfg/2',stagingRoot:'/stage/1002',cacheRoot:'/result/1002'}};
 const records={},calls=[],closes=[];
 for(const [uid,p] of Object.entries(profiles)){
  records[p.toolsConfigPath]={ownerId:p.userId,nats:{servers:['nats://fixture']},gameCore:{enabled:false},history:{enabled:false},transcription:{enabled:false},publisher:{configPath:'/pub/'+uid}};
  records['/pub/'+uid]={ownerId:p.userId,allowedReadRoots:[p.stagingRoot],resultRoot:'/result/'+uid};
 }
 const start=async config=>({async listTools(){return [{name:'history_list'},{name:'publish_file'},{name:'fetch_file'},{name:'timer_snapshot_get'}];},
  async call(name,args){calls.push([config.ownerId,name,args]);return {name,owner:config.ownerId};},
  async synthesizeVoice(args,signal){signal?.throwIfAborted();calls.push([config.ownerId,'voice',args,signal]);return {artifactId:'voice-'+config.ownerId};},
  async filesConfiguration(){const home='/home/'+config.ownerId;return {ownerId:config.ownerId,stateRoot:home+'/workspace/files',resultRoot:home+'/results',readRoots:[home+'/workspace',home+'/media',home+'/results']};},
  async close(){closes.push(config.ownerId);}});
 records['/profiles']=profiles;
 const readFiles=async config=>{const home='/home/'+config.ownerId;return {ownerId:config.ownerId,stateRoot:home+'/workspace/files',resultRoot:home+'/results',readRoots:[home+'/workspace',home+'/media',home+'/results']};};
 const adapters=createRuntimeAdapters({runtimeProfilesPath:'/profiles'},{readProtected:path=>structuredClone(records[path]),start,readFiles,verifyDirectory:()=>{},verifySnapshot:(path,root)=>{if(!path.startsWith(root+'/'))throw Error('bad snapshot');}});
 const profile=uid=>({...profiles[uid],status:'active',telegramId:uid,workerUid:Number(uid)});
 return {profiles,records,calls,closes,adapters,profile};
}
test('factory binds owner and staging to UID and separates history and publisher',async()=>{
 const f=fixture(),a=await f.adapters.perUserRuntime(f.profile('1001')),b=await f.adapters.perUserRuntime(f.profile('1002'));
 assert.deepEqual((await a.listTools()).map(x=>x.name),['history_list','timer_snapshot_get']);
 assert.equal((await a.filesConfiguration()).resultRoot,'/home/u1/results');
 await assert.rejects(a.callTool('publish_file',{path:'/etc/passwd'}),/CONFIG_NOT_READY/);
 await assert.rejects(a.publishSnapshot('/stage/1002/file','r'),/bad snapshot/);
 await a.publishSnapshot('/stage/1001/file','r');await b.fetchArtifact('artifact');
 await f.adapters.historyCall(f.profile('1001'),'history_list',{});await f.adapters.historyCall(f.profile('1001'),'history_categories_list',{});await assert.rejects(f.adapters.historyCall(f.profile('1001'),'history_delete',{}),/CONFIG_NOT_READY/);
 assert.deepEqual(f.calls.map(row=>row.slice(0,2)),[['u1','publish_file'],['u2','fetch_file'],['u1','history_list'],['u1','history_categories_list']]);
 await assert.rejects(f.adapters.perUserRuntime({...f.profile('1001'),userId:'u2'}),/CONFIG_NOT_READY/);
 const removed=f.profile('1001');delete f.records['/profiles']['1001'];
 await assert.rejects(f.adapters.perUserRuntime(removed),/CONFIG_NOT_READY/);
 f.records['/profiles']['1001']=removed;
 await f.adapters.onIdentityChanged({userId:'u1'});assert.deepEqual(f.closes,['u1']);await f.adapters.close();assert.deepEqual(f.closes.sort(),['u1','u2']);
});
test('personal voice uses the short-input adapter for each owner and forwards cancellation',async()=>{
 const f=fixture(),a=await f.adapters.perUserRuntime(f.profile('1001')),b=await f.adapters.perUserRuntime(f.profile('1002'));
 const args={text:'Проверка голоса.'},controller=new AbortController();
 try{
  assert.deepEqual(await a.callTool('local_ai_invoke_synthesize',args,controller.signal),{artifactId:'voice-u1'});
  assert.deepEqual(await b.callTool('local_ai_invoke_synthesize',args),{artifactId:'voice-u2'});
  assert.deepEqual(f.calls,[['u1','voice',args,controller.signal],['u2','voice',args,undefined]]);
  controller.abort();
  await assert.rejects(a.callTool('local_ai_invoke_synthesize',args,controller.signal),{name:'AbortError'});
  assert.equal(f.calls.length,2);
 }finally{await f.adapters.close();}
});

test('factory refuses shared publisher and unverified MCP bearer',async()=>{
 const f=fixture();
 f.records['/cfg/1'].gameCore={enabled:true,url:'http://example',ownerId:'u1',token:'shared'};
 await assert.rejects(f.adapters.perUserRuntime(f.profile('1001')),/CONFIG_NOT_READY/);
 f.records['/cfg/1'].gameCore={enabled:false};f.records['/pub/1002'].resultRoot='/result/1001';
 await assert.rejects(f.adapters.perUserRuntime(f.profile('1001')),/CONFIG_NOT_READY/);
});
test('control hides publisher from worker and routes private artifact operation after authorization',async()=>{
 const profile={userId:'u1',profileId:'p1',telegramId:'42',status:'active'},registry=async()=>({version:1,profiles:{'1001':profile}});
 const authCall=async()=>({user:{id:'u1',profileId:'p1',telegramId:'42',status:'active',role:'user'}});
 const calls=[];const ownerRuntime={listTools:async()=>[{name:'publish_file'},{name:'fetch_file'},{name:'timer_snapshot_get'}],callTool:async(name,args)=>({name,args}),filesConfiguration:async()=>({ownerId:'u1'}),publishSnapshot:async(...args)=>{calls.push(args);return {artifactId:'a'};}};
 const control=new Control({origin:'https://fixture.example',cursorKey:'x'.repeat(32),registry,authCall,perUserRuntime:async()=>ownerRuntime});
 const runtime={control,registry,authCall};
 const list=await privateCall(runtime,'tools.list',{uid:1001});assert.deepEqual(list.tools.map(item=>item.name),['timer_snapshot_get']);
 await assert.rejects(control.invokeTool(1001,'publish_file',{}),/FORBIDDEN/);
 assert.deepEqual(await privateCall(runtime,'files.configuration',{uid:1001}),{ownerId:'u1'});
 assert.deepEqual(await privateCall(runtime,'files.get',{uid:1001,args:{artifactId:'a'}}),{name:'files_get',args:{artifactId:'a'}});
 await assert.rejects(privateCall(runtime,'files.configuration',{uid:1001,ownerId:'u2'}),/INVALID_ARGUMENT/);
 assert.deepEqual(await privateCall(runtime,'artifacts.publish',{uid:1001,path:'/stage/1001/file',requestId:'r'}),{artifactId:'a'});
 assert.deepEqual(calls,[['/stage/1001/file','r']]);
 await assert.rejects(privateCall(runtime,'artifacts.publish',{uid:1002,path:'/stage/1001/file',requestId:'r'}),/FORBIDDEN/);
});

test('provisioning exposes only verified configuration without starting tools',async()=>{
 const f=fixture(),pending={...f.profile('1001'),status:'provisioning'};
 const data=await f.adapters.bootstrapFilesConfiguration(pending);
 assert.equal(data.resultRoot,'/home/u1/results');assert.deepEqual(f.calls,[]);
 await assert.rejects(f.adapters.perUserRuntime(pending),/CONFIG_NOT_READY/);
 await assert.rejects(f.adapters.bootstrapFilesConfiguration({...pending,status:'blocked'}),/CONFIG_NOT_READY/);
 const registry=async()=>({version:1,profiles:{'1001':pending}});
 const authCall=async()=>{throw Error('not available');};
 const control=new Control({origin:'https://fixture.example',cursorKey:'x'.repeat(32),registry,authCall});
 control.bootstrapFilesConfiguration=f.adapters.bootstrapFilesConfiguration;
 const runtime={control,registry,authCall};
 assert.equal((await privateCall(runtime,'files.configuration',{uid:1001})).resultRoot,'/home/u1/results');
 await assert.rejects(privateCall(runtime,'files.get',{uid:1001,args:{artifactId:'a'}}));
 pending.status='blocked';
 await assert.rejects(privateCall(runtime,'files.configuration',{uid:1001}));
 await f.adapters.close();
});

test('factory derives scope from registry profile and refuses protected aliases that disagree',async()=>{
 const {serviceDataScope}=await import('../../../auth/contracts/service-data-scope.mjs');
 const f=fixture();let config;
 const adapters=createRuntimeAdapters({runtimeProfiles:f.profiles},{readProtected:path=>structuredClone(f.records[path]),verifyDirectory:()=>{},start:async value=>{config=value;return {close:async()=>{}};}});
 await adapters.perUserRuntime(f.profile('1001'));
 assert.equal(config.ownerId,'u1');assert.equal(config.serviceDataScope,serviceDataScope('p1'));
 f.profiles['1001'].serviceDataScope=serviceDataScope('p2');
 await assert.rejects(adapters.perUserRuntime(f.profile('1001')),/CONFIG_NOT_READY/);
 delete f.profiles['1001'].serviceDataScope;f.records['/cfg/1'].serviceDataScope=serviceDataScope('p2');
 await assert.rejects(adapters.perUserRuntime(f.profile('1001')),/CONFIG_NOT_READY/);
 await adapters.close();
});

test('production factory restores catalog and transcription with private scope and role changes',async()=>{
 const {createOwnerTranscription}=await import('../transcription.mjs');
 const {serviceDataScope}=await import('../../../auth/contracts/service-data-scope.mjs');
 const f=fixture(),sent=[],nats=[],closed=[];
 const requestId='22222222-2222-4222-8222-222222222222';
 const settings={defaultLocalModel:null,allowReplacement:false,policyVersion:2};
 for(const entry of Object.values(f.profiles))entry.sharedServicesConfigPath='/shared';
 f.records['/shared']={transcription:{url:'http://transcription.test/mcp',token:'root-fixture'}};
 const adapters=createRuntimeAdapters({runtimeProfiles:f.profiles},{
  readProtected:path=>structuredClone(f.records[path]),verifyDirectory:()=>{},
  openPorts:async config=>({
   list:async()=>[],mcp:async()=>{throw Error('Legacy bearer used');},
   request:async(subject,args)=>{nats.push([config.ownerId,subject,args]);return {items:[],next_cursor:null};},
   publish:async()=>{},close:async()=>closed.push(config.ownerId),
  }),
  transcriptionFactory:(profile,endpoint,options)=>createOwnerTranscription(profile,endpoint,{...options,
   fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body);sent.push(body);
    return Response.json(body.method==='settings.set'?{settings,revision:2}:
     {state:'available',result:{requestId,text:profile.userId,segments:null,
      actualModel:{modelId:'whisper',revision:'v1',profileId:'cpu'}}});
   }}),
 });
 try{
  const a=await adapters.perUserRuntime({...f.profile('1001'),role:'admin'});
  const b=await adapters.perUserRuntime({...f.profile('1002'),role:'user'});
  const names=(await a.listTools()).map(tool=>tool.name);
  for(const name of ['history_categories_list','history_types_list','history_type_get','transcription_result_get'])
   assert.equal(names.includes(name),true,name);
  assert.equal(names.some(name=>name.startsWith('game_core_')),false);
  await adapters.historyCall({...f.profile('1001'),role:'admin'},'history_categories_list',{limit:1});
  assert.deepEqual(nats.at(-1),['u1','brai.history.v1.query.categories-list',{limit:1}]);
  await a.callTool('transcription_result_get',{requestId});
  await b.callTool('transcription_result_get',{requestId});
  assert.deepEqual(sent.map(row=>[row.principal.ownerId,row.principal.scopeId]),
   [['u1',serviceDataScope('p1')],['u2',serviceDataScope('p2')]]);
  await a.callTool('transcription_settings_set',{settings,expectedRevision:1});
  assert.equal(sent.at(-1).principal.permissions.includes('transcription:settings:write'),true);
  const downgraded=await adapters.perUserRuntime({...f.profile('1001'),role:'user'});
  await assert.rejects(downgraded.callTool('transcription_settings_set',{settings,expectedRevision:2}),{code:'FORBIDDEN'});
  assert.equal(sent.length,3);
  assert.deepEqual(closed,['u1']);
 }finally{await adapters.close();await f.adapters.close();}
});
