// ABOUTME: Публикует caller-scoped NATS Services endpoints Каналов.
// ABOUTME: Ограничивает активные операции; не создаёт очереди, credentials или broker resources.
import type {NatsConnection} from 'nats';
import {operations,response,representable} from './contracts.js';
import {Fault,type Data,type Caller} from './types.js';
import type {createService} from './domain.js';
/** Подключает все разрешённые операции и ожидает фактического завершения при остановке. */
export async function serve(nc:NatsConnection,api:ReturnType<typeof createService>,callers:Record<string,Caller>){
 const service=await nc.services.add({name:'service_channels',version:'1.0.0',queue:'service_channels'});
 const active=new Set<Promise<void>>();let closing=false;
 const endpoint=(op:string,callerId:string)=>{
  const subject='brai.channels.v1.'+op+(op==='status'?'':'.'+callerId);
  service.addEndpoint((op+'_'+callerId).replaceAll('.','_'),{subject,handler:(_err,msg)=>{
   if(closing||active.size>=8){msg.respondError(503,'BUSY',Buffer.from(JSON.stringify({code:'BUSY',message:'BUSY',retryable:true})));return;}
   const work=(async()=>{
    try{
     if(msg.data.length>65536)throw new Fault('REQUEST_TOO_LARGE');
     let value:Data;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));}catch{throw new Fault('INVALID_ARGUMENT');}
     if(!representable(value))throw new Fault('INVALID_ARGUMENT');
     const result=await api.execute(op,callerId,value,{deadline:performance.now()+5000});
     msg.respond(response(op,result));
    }catch(e){const f=e instanceof Fault?e:new Fault('NOT_READY');msg.respondError(f.status,f.code,Buffer.from(JSON.stringify({code:f.code,message:f.code,retryable:f.retryable})));}
   })().finally(()=>active.delete(work));active.add(work);
  }});
 };
 for(const [caller,b]of Object.entries(callers))for(const op of b.operations)endpoint(op,caller);
 endpoint('status','');
 return {async close(){if(closing){await Promise.allSettled(active);return;}closing=true;await service.stop();await Promise.allSettled(active);}};
}
