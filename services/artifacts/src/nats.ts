// ABOUTME: Подключает artifacts как NATS Services request-reply API.
// ABOUTME: Не использует JetStream и проверяет оба направления payload.
import {connect,type NatsConnection,type Service} from 'nats';
import {serviceName,subjects,validateRequest,validateResponse} from '../contracts/index.mjs';
import type {Config} from './config.js';
import type {ArtifactsCore} from './core.js';
import {ArtifactError,storageError} from './errors.js';
const operationBySubject=new Map(Object.entries(subjects).map(([operation,subject])=>[subject,operation]));
const encoder=new TextEncoder();
/** Открывает authenticated NATS connection с отдельным inbox prefix. */
export async function startArtifactsNats(cfg:Config,core:ArtifactsCore){
 const nc=await connect({servers:cfg.natsURL.split(',').map(s=>s.trim()),user:cfg.natsUser,pass:cfg.natsPassword,inboxPrefix:cfg.natsInboxPrefix,maxReconnectAttempts:-1,timeout:5000,name:serviceName});
 let service:Service|undefined;const pending=new Set<Promise<void>>();let stopping=false;
 try{
  service=await nc.services.add({name:serviceName,version:'1.0.0',description:'Brai artifact metadata and lifecycle API',queue:serviceName});
  for(const [subject,operation] of operationBySubject){const name=operation.replace(/[A-Z]/g,m=>'_'+m.toLowerCase());service.addEndpoint(name,{subject,queue:serviceName,handler:(err,msg)=>{
   if(err||stopping)return;
   if(pending.size>=cfg.maxConcurrentNats){msg.respondError(429,'OVERLOADED');return;}
   const work=(async()=>{const started=Date.now();let requestId:string|undefined;let operationId:string|undefined;let code='OK';let responded=false;let deadline:NodeJS.Timeout|undefined;
    try{
     if(msg.data.byteLength>cfg.maxNatsRequestBytes)throw new ArtifactError('PAYLOAD_TOO_LARGE');
     let request:unknown;try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));}catch{throw new ArtifactError('INVALID_ARGUMENT');}
     if(!validateRequest(subject,request))throw new ArtifactError('INVALID_ARGUMENT');
     if(request&&typeof request==='object'){const value=request as {requestId?:unknown;scope?:{operationId?:unknown}};if(typeof value.requestId==='string')requestId=value.requestId;if(typeof value.scope?.operationId==='string')operationId=value.scope.operationId;}
     deadline=setTimeout(()=>{if(!responded){responded=true;code='STORAGE_UNAVAILABLE';msg.respondError(503,code);}},cfg.requestTimeoutMs);deadline.unref();
     const response=await core.execute(operation,request);if(!validateResponse(subject,response))throw new ArtifactError('INTERNAL');
     const bytes=encoder.encode(JSON.stringify(response));if(bytes.byteLength>cfg.maxNatsResponseBytes)throw new ArtifactError('PAYLOAD_TOO_LARGE');
     if(!responded){responded=true;msg.respond(bytes);}
    }catch(error){const safe=error instanceof ArtifactError?error:storageError(error);if(!responded){code=safe.code;responded=true;msg.respondError(safe.status,safe.code);}}
    finally{if(deadline)clearTimeout(deadline);console.info(JSON.stringify({requestId,operationId,endpoint:subject,result:code==='OK'?'success':'error',code,durationMs:Date.now()-started,executor:'nats'}));}
   })();pending.add(work);void work.finally(()=>pending.delete(work));
  }});}
 }catch(error){await nc.close();throw error;}
 let stopPromise:Promise<void>|undefined;
 return {instanceId:service.info().id,connection:nc,stop(){return stopPromise??=(async()=>{stopping=true;const bounded=async(promise:Promise<unknown>,ms:number)=>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms);timer.unref();})]);}finally{if(timer)clearTimeout(timer);}};if(!await bounded(service!.stop(),cfg.requestTimeoutMs))await nc.close();if(!await bounded(Promise.allSettled([...pending]),cfg.requestTimeoutMs))await nc.close();if(!nc.isClosed()&&!await bounded(nc.drain(),cfg.requestTimeoutMs))await nc.close();})();}};
}
