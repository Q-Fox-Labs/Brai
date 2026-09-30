// ABOUTME: Подключает JetStream команды/события и NATS Services чтения.
// ABOUTME: Прикладные переходы выполняет хранилище; публикация предшествует ACK команды.
import { connect,nanos,AckPolicy,RetentionPolicy,StorageType,DiscardPolicy,DeliverPolicy,ReplayPolicy, type NatsConnection, type ConsumerMessages, type ServiceMsg } from "nats";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { identity, parseQuery } from "./schema.js";
import { handleDelivery } from "./flow.js";
export const commandsStream="BRAI_TIMER_COMMANDS_V2",eventsStream="BRAI_TIMER_EVENTS_V2",commandsConsumer="timer_commands";
/** Создаёт authenticated connection с собственным inbox и бесконечным reconnect. */
export function connectNats(cfg:Config){return connect({servers:cfg.natsURL,user:cfg.natsUser,pass:cfg.natsPassword,inboxPrefix:cfg.inboxPrefix,maxReconnectAttempts:-1,timeout:5000,name:"brai_timer"});}
/** Создаёт или обновляет только собственные streams и командный durable consumer. */
export async function setupJetStream(nc:NatsConnection,cfg:Config){
 const manager=await nc.jetstreamManager();
 for(const spec of [{name:commandsStream,subjects:["brai.timer.v2.command.*"],retention:RetentionPolicy.Workqueue,max_age:0,max_bytes:cfg.commandMaxBytes},{name:eventsStream,subjects:["brai.timer.v2.event.*"],retention:RetentionPolicy.Limits,max_age:nanos(cfg.eventMaxAgeMs),max_bytes:cfg.eventMaxBytes}]){
   const desired={...spec,storage:StorageType.File,discard:spec.name===commandsStream?DiscardPolicy.New:DiscardPolicy.Old,num_replicas:1,max_msgs:-1,max_msgs_per_subject:-1};
   try{await manager.streams.info(spec.name);await manager.streams.update(spec.name,desired);}catch(error){if((error as {code?:string}).code!=="404")throw error;await manager.streams.add(desired);}
 }
 const desired={durable_name:commandsConsumer,ack_policy:AckPolicy.Explicit,ack_wait:nanos(cfg.ackWaitMs),max_ack_pending:1,max_deliver:-1,filter_subject:"brai.timer.v2.command.*",deliver_policy:DeliverPolicy.All,replay_policy:ReplayPolicy.Instant};
 await manager.consumers.add(commandsStream,desired);
}
function safeError(error:unknown){return error instanceof Error ? (error as Error&{code?:string}).code??error.name : "UNKNOWN";}
/** Объявляет endpoints и последовательно обрабатывает durable command stream. */
export async function runNats(nc:NatsConnection,cfg:Config,store:Store){
 await store.ready();await setupJetStream(nc,cfg);
 const js=nc.jetstream();
 const service=await nc.services.add({name:"brai_timer",version:"2.0.0",description:"Личный секундомер Brai",queue:"brai_timer"});
 for(const [name,dto] of [["snapshot","SnapshotRequest"],["history","HistoryRequest"],["command","CommandLookupRequest"]]){
  service.addEndpoint(name,{subject:`brai.timer.v2.query.${name}`,queue:"brai_timer",handler:(error,msg)=>{if(error)return;void respond(name,dto,msg);}});
 }
 let queries=0;
 async function respond(name:string,dto:string,msg:ServiceMsg){
  if(queries>=3){msg.respondError(503,"INTERNAL",Buffer.from(JSON.stringify({code:"INTERNAL",message:"Сервис занят",retryable:true})));return;}
  queries++;
  try {
   const request=parseQuery(dto,msg.data);
   const result=name==="snapshot"?await store.snapshot(request.userId as string):name==="history"?await store.history(request.userId as string,request.limit as number,request.cursor):await store.command(request.userId as string,request.commandId as string);
   msg.respond(Buffer.from(JSON.stringify(result)));
  }catch(error){const code=error instanceof Error?error.message:"INTERNAL";const known=code==="INVALID_ARGUMENT"||code==="NOT_FOUND";msg.respondError(code==="NOT_FOUND"?404:known?400:503,known?code:"INTERNAL",Buffer.from(JSON.stringify({code:known?code:"INTERNAL",message:known?code:"Сервис временно недоступен",retryable:!known})));}
  finally{queries--;}
 }
 let stopped=false;
 const consumer=await js.consumers.get(commandsStream,commandsConsumer);
 let messages:ConsumerMessages|undefined;
 const done=(async()=>{
  while(!stopped&&!nc.isClosed()){
   try{
    // AIDEV-NOTE: consume сохраняет inbox при idle/resume; next timeout мог отбросить доставку до чтения socket.
    messages=await consumer.consume({max_messages:1,expires:1000});
    for await(const message of messages){
     if(stopped){message.nak();break;}
     const begin=performance.now(),info=message.info;
     const queueDelayMs=Math.max(0,Date.now()-info.timestampNanos/1e6);
     try{
      const saved=await handleDelivery({subject:message.subject,data:message.data,key:`${info.stream}:${info.streamSequence}`},{save:store.process,publish:result=>js.publish(result.subject,Buffer.from(JSON.stringify(result.event)),{msgID:result.event.eventId}),ack:()=>message.ack()});
      console.log(JSON.stringify({commandId:saved.event.commandId,executor:service.info().id,result:saved.event.error?.code??saved.subject,durationMs:Math.round(performance.now()-begin),redelivery:info.redeliveryCount,queueDelayMs}));
     }catch(error){
      console.error(JSON.stringify({operation:"command",error:safeError(error),executor:service.info().id,commandId:identity(message.data).commandId,deliveryKey:`${info.stream}:${info.streamSequence}`,durationMs:Math.round(performance.now()-begin),redelivery:info.redeliveryCount,queueDelayMs}));
      if(error instanceof Error && error.message === "INVALID_OWNER") message.term();
      else message.nak(Math.min(30000,1000*2**Math.min(info.redeliveryCount,5)));
     }
    }
   }catch(error){
    if(!stopped&&!nc.isClosed())console.error(JSON.stringify({operation:"command.consume",error:safeError(error)}));
   }finally{messages?.stop();messages=undefined;}
   if(!stopped&&!nc.isClosed())await new Promise(resolve=>setTimeout(resolve,1000));
  }
 })();
 return {service,done,async stop(){stopped=true;messages?.stop();await service.stop();await done;}};
}
