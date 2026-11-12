// ABOUTME: Собирает личные инструменты Hermes для проверенного UID и владельца.
// ABOUTME: Общие MCP без подтверждённой привязки владельца не подключаются.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateConfig } from '../config.mjs';
import { serviceDataScope } from '../../auth/contracts/service-data-scope.mjs';
import { createBraiTools, connectPorts } from '../runtime.mjs';
import { createHistoryCatalog } from './history.mjs';
import { createBugHuntCatalog } from './bug-hunt.mjs';
import { createOwnerTranscription } from './transcription.mjs';
import { fileConfiguration } from '../files/configuration.mjs';
import { readProtectedJSON, runStdio as runControl } from './control.mjs';

const invalid=()=>{throw new Error('IDENTITY_RUNTIME_CONFIG_NOT_READY');};
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const overlaps=(a,b)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
function rootDirectory(path) {
 if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path||realpathSync(path)!==path)invalid();
 for(let dir=path;;dir=dirname(dir)){
  const stat=lstatSync(dir);
  if(!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022))invalid();
  if(dir==='/')break;
 }
 return path;
}
function checkSnapshot(path,root) {
 if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path||!path.startsWith(root+sep)||realpathSync(path)!==path)invalid();
 rootDirectory(dirname(path));
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)||stat.nlink!==1||stat.size>67108864)invalid();
}
/** Собирает порты только из root-owned конфигураций, закреплённых за профилем. */
export function createRuntimeAdapters(config,{readProtected=readProtectedJSON,start,openPorts=connectPorts,transcriptionFactory=createOwnerTranscription,verifyDirectory=rootDirectory,verifySnapshot=checkSnapshot,readFiles=fileConfiguration}={}) {
 const cache=new Map();
 let booting=0,stopped=false;const waiting=[];
 // AIDEV-NOTE: Холодная сборка MCP компилирует схемы; массовый старт не должен задерживать обратный Auth.
 async function startLimited(build){
  if(stopped)invalid();
  if(booting<2)booting++;
  else{if(waiting.length>=32)invalid();await new Promise((resolve,reject)=>waiting.push({resolve,reject}));}
  try{if(stopped)invalid();return await build();}
  finally{const next=waiting.shift();if(next)next.resolve();else booting--;}
 }
 function loadEntries(){
  const entries=config?.runtimeProfilesPath?readProtected(config.runtimeProfilesPath):config?.runtimeProfiles;
  if(!object(entries))invalid();
  const uids=Object.keys(entries), all=new Set();
  for(const uid of uids){
   const entry=entries[uid];
   if(!/^[1-9]\d*$/.test(uid)||!object(entry)||typeof entry.userId!=='string'||!entry.userId||typeof entry.profileId!=='string'||!entry.profileId||
      typeof entry.home!=='string'||!isAbsolute(entry.home)||normalize(entry.home)!==entry.home||entry.home==='/'||
      typeof entry.toolsConfigPath!=='string'||!isAbsolute(entry.toolsConfigPath)||
      typeof entry.cacheRoot!=='string'||!isAbsolute(entry.cacheRoot)||normalize(entry.cacheRoot)!==entry.cacheRoot||entry.cacheRoot==='/'||
      typeof entry.stagingRoot!=='string'||!isAbsolute(entry.stagingRoot)||normalize(entry.stagingRoot)!==entry.stagingRoot||basename(entry.stagingRoot)!==uid||
      overlaps(entry.cacheRoot,entry.stagingRoot)||overlaps(entry.home,entry.cacheRoot)||overlaps(entry.home,entry.stagingRoot))invalid();
   for(const key of ['userId','profileId','home','toolsConfigPath','stagingRoot','cacheRoot']){const value=key+':'+entry[key];if(all.has(value))invalid();all.add(value);}
  }
  for(let i=0;i<uids.length;i++)for(let j=i+1;j<uids.length;j++){
   const a=entries[uids[i]], b=entries[uids[j]];
   if([a.home,a.stagingRoot,a.cacheRoot].some(left=>[b.home,b.stagingRoot,b.cacheRoot].some(right=>overlaps(left,right))))invalid();
  }
  return {entries,uids};
 }
 function validateProfile(profile,status) {
  const {entries,uids}=loadEntries();
  const uid=String(profile?.workerUid), entry=entries[uid];
  if(!entry||profile.userId!==entry.userId||profile.profileId!==entry.profileId||profile.home!==entry.home||profile.status!==status)invalid();
  verifyDirectory(entry.stagingRoot);
  const scope=serviceDataScope(entry.profileId);
  if(entry.serviceDataScope!==undefined&&entry.serviceDataScope!==scope)invalid();
  const sourceTools=validateConfig(readProtected(entry.toolsConfigPath),entry.userId);
  if(sourceTools.serviceDataScope!==undefined&&sourceTools.serviceDataScope!==scope)invalid();
  const tools={...sourceTools,serviceDataScope:scope};
  if(tools.dialogues?.enabled===true&&(tools.dialogues.userId!==entry.userId||tools.dialogues.profileId!==entry.profileId))invalid();
  // AIDEV-NOTE: Bearer MCP должен быть проверенно привязан сервисом к owner; до этого доступ закрыт.
  if(['gameCore','history','transcription'].some(name=>tools[name]?.enabled!==false||Object.keys(tools[name]).some(key=>key!=='enabled')))invalid();
  const publisher=readProtected(tools.publisher.configPath);
  if(publisher?.ownerId!==entry.userId||publisher.resultRoot!==entry.cacheRoot||!Array.isArray(publisher.allowedReadRoots)||publisher.allowedReadRoots.length!==1||publisher.allowedReadRoots[0]!==entry.stagingRoot)invalid();
  verifyDirectory(publisher.resultRoot);
  for(const otherUid of uids){
   if(otherUid===uid)continue;
   const other=entries[otherUid], otherTools=validateConfig(readProtected(other.toolsConfigPath),other.userId);
   if(otherTools.publisher.configPath===tools.publisher.configPath)invalid();
   const otherPublisher=readProtected(otherTools.publisher.configPath);
   if(typeof otherPublisher?.resultRoot!=='string'||overlaps(otherPublisher.resultRoot,publisher.resultRoot))invalid();
  }
  let shared = null;
  if(entry.sharedServicesConfigPath!==undefined){
   const path=entry.sharedServicesConfigPath;
   if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path)invalid();
   shared=readProtected(path);
   if(!object(shared))invalid();
  }
  return {uid,entry,tools,publisher,shared};
 }
 async function checkedFiles(entry,tools){
  const value=await readFiles(tools,invalid);
  const roots=[join(entry.home,'workspace'),join(entry.home,'media'),join(entry.home,'results')];
  if(value?.ownerId!==entry.userId||value.stateRoot!==join(entry.home,'workspace','files')||value.resultRoot!==roots[2]||
    !Array.isArray(value.readRoots)||value.readRoots.length!==roots.length||roots.some(root=>!value.readRoots.includes(root)))invalid();
  return {...value,moduleRoot:'/opt/brai-profile/runtime/services/hermes/files'};
 }
 async function perUserRuntime(profile) {
  if(stopped)invalid();
  const phase=profile.bootstrap===true?'provisioning':'active';
  const {uid,entry,tools,publisher,shared}=validateProfile(profile,phase);
  const signature=JSON.stringify([entry,tools,publisher,shared,profile.role,profile.generation,phase]), existing=cache.get(uid);
  if(existing?.signature===signature)return existing.promise;
  if(existing){cache.delete(uid);const old=await existing.promise.catch(()=>null);await old?.close();}
  const promise=(async()=>{
   let bugHunt;
   const runtime=await startLimited(async()=>{
   if(start)return start(tools);
   let runtime;
   {
    const ports=await openPorts(tools);
    try{
    const history=createHistoryCatalog(ports.request.bind(ports));
    if(shared?.bugHunt?.enabled===true)bugHunt=createBugHuntCatalog(ports.request.bind(ports),{userId:entry.userId,profileId:entry.profileId});
    const endpoint=shared?.transcription;
    const transcription=endpoint&&endpoint.enabled!==false
     ? transcriptionFactory({userId:entry.userId,profileId:entry.profileId},endpoint,
        {isAdmin:async()=>['creator','admin'].includes(profile.role)}) : null;
     runtime=await createBraiTools({...tools,history:{enabled:true},
      ...(transcription?{transcription:{enabled:true}}:{})},{
      ...ports,
      async list(name){
       if(name==='history')return history.list();
       if(name==='transcription'&&transcription)return transcription.list();
       return ports.list(name);
      },
      async mcp(endpoint,name,args,signal){
       if(endpoint==='history')return history.call(name,args,signal);
       if(endpoint==='transcription'&&transcription)return transcription.call(name,args,signal);
       return ports.mcp(endpoint,name,args,signal);
      },
     });
    }catch(error){await ports.close();throw error;}
   }
   return runtime;
   });
   return {
    async listTools(){return [...(await runtime.listTools()).filter(tool=>!['publish_file','fetch_file'].includes(tool.name)),...(bugHunt?.list()??[])];},
    async callTool(name,args,signal){
     if(['publish_file','fetch_file'].includes(name))invalid();
     if(name.startsWith('bug_hunt_')){if(!bugHunt)invalid();return bugHunt.call(name,args,signal);}
     // Личный broker принимает тот же короткий голосовой ввод, что и MCP.
     return name==='local_ai_invoke_synthesize'
      ? runtime.synthesizeVoice(args,signal) : runtime.call(name,args,signal);
    },
    async filesConfiguration(){return checkedFiles(entry,tools);},
    async publishSnapshot(path,requestId){verifySnapshot(path,entry.stagingRoot);return runtime.call('publish_file',{path,requestId});},
    async fetchArtifact(artifactId){return runtime.call('fetch_file',{artifactId});},
    close:()=>runtime.close(),
   };
  })();
  cache.set(uid,{signature,promise,userId:entry.userId});
  try{return await promise;}catch(error){if(cache.get(uid)?.promise===promise)cache.delete(uid);throw error;}
 }
 return {
  perUserRuntime,
  async bootstrapFilesConfiguration(profile){const {entry,tools}=validateProfile(profile,'provisioning');return checkedFiles(entry,tools);},
  async historyCall(profile,name,args,signal){
   if(!['history_list','history_get','history_categories_list','history_types_list','history_type_get'].includes(name))invalid();
   const runtime=await perUserRuntime(profile);return runtime.callTool(name,args,signal);
  },
  async onIdentityChanged({userId}){
   const uid=[...cache.keys()].find(key=>cache.get(key).userId===userId), item=uid&&cache.get(uid);
   if(!item)return;
   cache.delete(uid);const runtime=await item.promise.catch(()=>null);await runtime?.close();
  },
  async close(){stopped=true;for(const item of waiting.splice(0))item.reject(new Error('SOURCE_CLOSED'));const current=[...cache.values()];cache.clear();await Promise.allSettled(current.map(async item=>(await item.promise).close()));}
 };
}
/** Запускает закрытый control через stdio с персональными портами. */
export async function runStdio() {
 const config=readProtectedJSON(process.env.BRAI_IDENTITY_CONTROL_CONFIG);
 const adapters=createRuntimeAdapters(config);
 try{await runControl(adapters);}finally{await adapters.close();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])&&process.argv[2]==='--stdio') {
 runStdio().catch(()=>{process.stderr.write('Identity runtime unavailable\n');process.exitCode=1;});
}
