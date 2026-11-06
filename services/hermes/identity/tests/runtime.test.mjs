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
 await f.adapters.historyCall(f.profile('1001'),'history_list',{});await assert.rejects(f.adapters.historyCall(f.profile('1001'),'history_categories_list',{}),/CONFIG_NOT_READY/);
 assert.deepEqual(f.calls.map(row=>row.slice(0,2)),[['u1','publish_file'],['u2','fetch_file'],['u1','history_list']]);
 await assert.rejects(f.adapters.perUserRuntime({...f.profile('1001'),userId:'u2'}),/CONFIG_NOT_READY/);
 const removed=f.profile('1001');delete f.records['/profiles']['1001'];
 await assert.rejects(f.adapters.perUserRuntime(removed),/CONFIG_NOT_READY/);
 f.records['/profiles']['1001']=removed;
 await f.adapters.onIdentityChanged({userId:'u1'});assert.deepEqual(f.closes,['u1']);await f.adapters.close();assert.deepEqual(f.closes.sort(),['u1','u2']);
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
