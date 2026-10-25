// ABOUTME: Устанавливает модели через собственный lifecycle Local AI.
// ABOUTME: Сохраняет служебные operationId без пользовательских данных.

import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const {connect,JSONCodec}=createRequire(process.env.BRAI_INSTALL_NPM_ROOT+'/package.json')('nats');
const input=JSON.parse(fs.readFileSync(process.argv[3])),m=JSON.parse(fs.readFileSync(process.argv[4]));
const codec=JSONCodec(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const controlRoot=process.env.BRAI_INSTALL_ROOT??'/var/lib/brai-install';
const file=controlRoot+'/model-operations.json';
const journal=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
const must=(v)=>{if(!v)throw Error('OWNER_OPERATION_FAILED');};
function save(){fs.writeFileSync(file+'.new',JSON.stringify(journal),{mode:0o600});fs.renameSync(file+'.new',file);}
async function broker(t){
 for(let attempt=0;attempt<60;attempt++){
  try{return await connect({servers:'nats://127.0.0.1:'+(t==='prod'?4222:4223),user:input.provision.user,pass:input.provision.password,inboxPrefix:'_INBOX.brai_install',timeout:3000,maxReconnectAttempts:0});}
  catch(error){if(attempt===59)throw error;await pause(2000);}
 }
}
async function rpc(nc,s,r){const msg=await nc.request(s,codec.encode(r),{timeout:15000});const v=codec.decode(msg.data);must(!v?.code);return v;}
async function brokers(){
 for(const target of Object.keys(m.streams)){
  const nc=await broker(target);
  try{
   const j=await nc.jetstreamManager();
   for(const stream of m.streams[target]){
    let found;try{found=await j.streams.info(stream.config.name);}catch(e){if(e?.api_error?.err_code!==10059)throw e;}
    if(!found)await j.streams.add(stream.config);
    for(const c of stream.consumers){
     let exists;try{exists=await j.consumers.info(stream.config.name,c.durable_name);}catch(e){if(e?.api_error?.err_code!==10014)throw e;}
     if(!exists)await j.consumers.add(stream.config.name,c);
    }
   }
  }finally{await nc.close();}
 }
}
async function models(target){
 const root='/opt/brai-components/local-ai/'+m.installed[target]['local-ai'].slice(7)+'/services/local-ai';
 const {subjects}=await import(root+'/contracts/index.mjs');
 const name=target==='dev'?'brai-dev/local-ai':Object.keys(m.local_ai).find(k=>k!=='brai-dev/local-ai');
 const cfg=JSON.parse(JSON.parse(fs.readFileSync(controlRoot+'/projects/'+name.split('/')[0]+'.json')).services[name.split('/')[1]].environment.LOCAL_AI_CONFIG_JSON);
 const nc=await broker(target);
 try{
  let ready=false;
  for(let i=0;i<90;i++){try{await rpc(nc,subjects.modelsList,{filter:{}});ready=true;break;}catch{await pause(2000);}}
  must(ready);
  for(const profileId of Object.keys(cfg.runtime)){
   const p=JSON.parse(fs.readFileSync(root+'/profiles/'+profileId+'.json'));
   const key=target+'/'+profileId;
   const card=await rpc(nc,subjects.modelsGet,{modelId:p.modelId});
   if(!(card.installationState==='installed'&&card.revision===p.source.revision)){
   if(!journal[key]){journal[key]={requestId:randomUUID(),ownerId:'brai-first-install',deadlineAt:new Date(Date.now()+3500000).toISOString()};save();}
   const state=journal[key];
   if(!state.operationId){
    const op=await rpc(nc,subjects.modelsInstall,{modelId:p.modelId,revision:p.source.revision,profileId,requestId:state.requestId,ownerId:state.ownerId,deadlineAt:state.deadlineAt});
    must(op.operationId);state.operationId=op.operationId;save();
   }
   const end=Date.now()+3600000;let done=false;
   while(Date.now()<end){
    const op=await rpc(nc,subjects.operationsGet,{operationId:state.operationId,ownerId:state.ownerId});
    if(op.status==='completed'){done=true;break;}
    must(['accepted','running'].includes(op.status));await pause(1500);
   }
   must(done);
   }
   // AIDEV-NOTE: Explicit model settings belong to installation inputs, including already installed models.
   const settings=m.local_ai[name].settings??{};
   if(Object.hasOwn(settings,profileId)){
    const declared=settings[profileId];
    must(declared&&Object.keys(declared).length===1&&Object.hasOwn(declared,'idleUnloadSeconds'));
    must(declared.idleUnloadSeconds===null||Number.isSafeInteger(declared.idleUnloadSeconds)&&declared.idleUnloadSeconds>0&&declared.idleUnloadSeconds<=2147483647);
    const configured=await rpc(nc,subjects.modelsConfigure,{modelId:p.modelId,revision:p.source.revision,profileId,ownerId:'brai-first-install',idleUnloadSeconds:declared.idleUnloadSeconds});
    must(configured.idleUnloadSeconds===declared.idleUnloadSeconds);
   }
  }
 }finally{await nc.close();}
}
try{
 if(process.argv[2]==='brokers')await brokers();
 else{must(['dev','prod'].includes(process.argv[2]));await models(process.argv[2]);}
 console.log('INSTALL_OWNER_OPERATION_COMPLETE');
}catch{console.error('INSTALL_OWNER_OPERATION_FAILED');process.exitCode=1;}
