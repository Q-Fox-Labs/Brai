// ABOUTME: Обслуживает общий JetStream вход и read-only NATS Services API.
// ABOUTME: ACK следует только за передачей ответственности; ресурсы брокера готовит оператор.
import { createHash } from 'node:crypto';
import { connect, AckPolicy, DeliverPolicy, ReplayPolicy, RetentionPolicy, DiscardPolicy, StorageType, type ConnectionOptions, type JsMsg, type NatsConnection } from 'nats';
import { readFileSync } from 'node:fs';
import { inputHash, parseEvent, isGetRequest } from './contracts.js';
import { ingest, lookup } from './domain.js';
import { Fault, type Delivery, type Event, type Ports, type Store } from './types.js';
import type { Config } from './config.js';
export const ingressStream='BRAI_INTAKE_INGRESS_V1', dispatchStream='BRAI_INTAKE_DISPATCH_V1', durable='intake_ingress';
/** Открывает runtime identity из защищённых options; содержимое не логируется. */
export function connectBroker(c:Config):Promise<NatsConnection> {
 const options:ConnectionOptions=c.natsOptionsFile?JSON.parse(readFileSync(c.natsOptionsFile,'utf8')):{};
 return connect({...options,servers:c.natsUrl,name:'service_intake',maxReconnectAttempts:-1,timeout:5000});
}
/** Проверяет фиксированные гарантии очередей без их изменения. */
export async function checkBroker(nc:NatsConnection):Promise<void> {
 const m=await nc.jetstreamManager();
 for(const [name,subject] of [[ingressStream,'brai.intake.v1.ingress.*'],[dispatchStream,'brai.intake.v1.dispatch.*']]) {
  const {config:c}=await m.streams.info(name);
  if(c.storage!==StorageType.File || c.retention!==RetentionPolicy.Workqueue || c.discard!==DiscardPolicy.New || c.max_age!==0 || c.max_bytes!==268435456 || c.max_msg_size!==131072 || c.max_msgs!==-1 || c.max_msgs_per_subject!==-1 || c.subjects?.length!==1 || c.subjects[0]!==subject || c.no_ack) throw Error('INTAKE_STREAM_CONFIG_MISMATCH');
 }
 const {config:c}=await m.consumers.info(ingressStream,durable);
 if(c.ack_policy!==AckPolicy.Explicit || c.deliver_policy!==DeliverPolicy.All || c.replay_policy!==ReplayPolicy.Instant || (c.backoff?.length??0)>0 || (c.pause_until && Date.parse(c.pause_until)>Date.now()) || c.max_deliver!==-1 || c.max_ack_pending!==8 || c.filter_subject!=='brai.intake.v1.ingress.*' || c.deliver_subject || c.headers_only || c.ack_wait!==30000000000 || (c.inactive_threshold??0)!==0) throw Error('INTAKE_CONSUMER_CONFIG_MISMATCH');
}
/** Выполняет доставку и сохраняет безопасный отказ до ACK. */
export async function consumeOne(msg:JsMsg,store:Store,ports:Ports,cfg:Config):Promise<void> {
 const delivery:Delivery={stream:msg.info.stream,sequence:msg.info.streamSequence,source:msg.subject.split('.').at(-1)!,receivedAt:new Date(msg.info.timestampNanos/1000000).toISOString()};
 let event:Event|undefined;
 const pulse=setInterval(()=>msg.working(),10000);pulse.unref();
 try {event=parseEvent(msg.data);await ingest(store,ports,cfg.sources,event,delivery);msg.ack();}
 catch(e) {
  if(e instanceof Fault && !e.retryable) {
   try {
    await store.reject({delivery,ownerId:cfg.sources[delivery.source]?.ownerId??null,eventId:event?.eventId??null,hash:event?inputHash(event):createHash('sha256').update(msg.data).digest('hex'),code:e.code});
    msg.ack();
   } catch {msg.nak(5000);}
  } else msg.nak(5000);
 } finally {clearInterval(pulse);}
}
/** Подключает ограниченный consumer и caller-scoped read API. */
export async function runBroker(nc:NatsConnection,store:Store,ports:Ports,cfg:Config,temporalReady:()=>Promise<boolean>) {
 await store.ready();await checkBroker(nc);
 const service=await nc.services.add({name:'service_intake',version:'1.0.0',queue:'service_intake'});
 let apiActive=0;
 for(const [source,binding] of Object.entries(cfg.sources)) if(binding.read) {
  service.addEndpoint('get_'+source,{subject:'brai.intake.v1.get.'+source,handler:async(_err,msg)=>{
   if(apiActive>=8){msg.respondError(503,'BUSY');return;}
   apiActive++;
   try {
    if(msg.data.length>131072)throw new Fault('REQUEST_TOO_LARGE');
    let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(msg.data));}catch{throw new Fault('INVALID_ARGUMENT');}
    if(!isGetRequest(body))throw new Fault('INVALID_ARGUMENT');
    let p;
    if(body.sequence!==undefined) {
     if(!Number.isSafeInteger(body.sequence)||body.sequence<1||body.eventId!==undefined||body.expectedHash!==undefined)throw new Fault('INVALID_ARGUMENT');
     const rejection=await store.rejection(body.source,body.sequence);
     if(!rejection||rejection.ownerId!==binding.ownerId)throw new Fault('NOT_FOUND');
     p={state:'rejected',...rejection};
    } else {
     if(typeof body.eventId!=='string'||(body.expectedHash!==undefined&&typeof body.expectedHash!=='string'))throw new Fault('INVALID_ARGUMENT');
     p=await lookup(store,binding,body.source,body.eventId,body.expectedHash);
    }
    const bytes=Buffer.from(JSON.stringify(p));if(bytes.length>1048576)throw new Fault('RESULT_TOO_LARGE');
    msg.respond(bytes);
   } catch(e) {const f=e instanceof Fault?e:new Fault('DEPENDENCY_UNAVAILABLE',true);msg.respondError(f.retryable?503:f.code==='NOT_FOUND'?404:f.code==='FORBIDDEN'?403:f.code==='EVENT_ID_CONFLICT'?409:400,f.code);}
   finally {apiActive--;}
  }});
 }
 service.addEndpoint('status',{subject:'brai.intake.v1.status',handler:async(_err,msg)=>{
  if(apiActive>=8){msg.respondError(503,'BUSY');return;}apiActive++;
  try {await store.ready();await checkBroker(nc);msg.respond(Buffer.from(JSON.stringify({jetstream:true,temporal:await temporalReady()})));}
  catch {msg.respondError(503,'NOT_READY');}finally{apiActive--;}
 }});
 const consumer=await nc.jetstream().consumers.get(ingressStream,durable);
 const messages=await consumer.consume({max_messages:8,expires:1000});
 const active=new Set<Promise<void>>();
 const finished=(async()=>{
  for await(const msg of messages) {
   if(active.size>=8)await Promise.race(active);
   const work=consumeOne(msg,store,ports,cfg).finally(()=>active.delete(work));active.add(work);
  }
  await Promise.allSettled(active);
 })();
 return {finished,async close(){messages.stop();await finished;await service.stop();}};
}
