// ABOUTME: Публикует ограниченные NATS Services endpoints Контактов.
// ABOUTME: Deadline отвечает отдельно, но активный слот держится до прекращения SQL.
import type {NatsConnection} from 'nats';
import {operations,response,representable} from './contracts.js';
import {Fault,type Caller,type Data} from './types.js';
import type {createService} from './domain.js';
/** Обслуживает только явно разрешённые caller subjects и ожидает очистку при остановке. */
export async function serve(nc:NatsConnection,api:ReturnType<typeof createService>,callers:Record<string,Caller>){
 const service=await nc.services.add({name:'service_contacts',version:'1.0.0',queue:'service_contacts'}),active=new Set<Promise<void>>();let closing=false;
 const endpoint=(op:string,caller:string)=>service.addEndpoint((op+'_'+caller).replaceAll('.','_'),{subject:'brai.contacts.v1.'+op+(op==='status'?'':'.'+caller),handler:(_err,msg)=>{
  if(closing||active.size>=8){msg.respondError(503,'BUSY',Buffer.from(JSON.stringify({code:'BUSY',message:'BUSY',retryable:true})));return;}
  let answered=false,outcome='OK';const fail=(f:Fault)=>{if(answered)return;answered=true;outcome=f.code;msg.respondError(f.status,f.code,Buffer.from(JSON.stringify({code:f.code,message:f.code,retryable:f.retryable})));};
  const deadline=performance.now()+5000,timer=setTimeout(()=>fail(new Fault('DEADLINE_EXCEEDED')),5000);
  const work=(async()=>{try{
   if(msg.data.length>65536)throw new Fault('REQUEST_TOO_LARGE');
   let q:Data;try{q=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));}catch{throw new Fault('INVALID_REQUEST');}
   if(!representable(q))throw new Fault('INVALID_REQUEST');
   const result=await api.execute(op,caller,q,{deadline}),bytes=response(op,result);
   if(!answered){answered=true;msg.respond(bytes);}
  }catch(e){fail(e instanceof Fault?e:new Fault('INTERNAL'));}})().finally(()=>{clearTimeout(timer);active.delete(work);console.log(JSON.stringify({operation:op,callerId:caller,result:outcome,durationMs:Math.round(performance.now()-(deadline-5000))}));});
  active.add(work);
 }});
 for(const[id,b]of Object.entries(callers))for(const op of b.operations)endpoint(op,id);
 endpoint('status','');
 return {async close(){closing=true;await service.stop();await Promise.allSettled(active);}};
}
