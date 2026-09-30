// ABOUTME: Объявляет четыре NATS Services endpoints сервиса авторизации.
// ABOUTME: Ограничивает параллелизм и не хранит сообщения в JetStream.
import { connect,credsAuthenticator,type NatsConnection } from "nats";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { bridge,subjects,type Operation } from "./bridge.js";
/** Подключается только с явно настроенными NATS credentials и собственным inbox. */
export function connectNats(cfg:Config){return connect({servers:cfg.natsServers,user:cfg.natsUser,pass:cfg.natsPassword,authenticator:cfg.natsCredsFile?credsAuthenticator(readFileSync(cfg.natsCredsFile)):undefined,tls:cfg.natsCAFile?{caFile:cfg.natsCAFile}:undefined,inboxPrefix:"_INBOX.brai_auth",maxReconnectAttempts:-1,timeout:5000,name:"brai_auth"});}
/** Собирает transport; stop прекращает новые вызовы и ждёт уже принятые операции. */
export async function runNats(nc:NatsConnection,cfg:Config,handler:(request:Request)=>Promise<Response>){
 const service=await nc.services.add({name:"brai_auth",version:"1.0.0",description:"Brai email OTP authentication",queue:"brai_auth"});
 const pending=new Set<Promise<void>>();
 for(const [name,subject] of Object.entries(subjects))service.addEndpoint(name.replaceAll("-","_"),{subject,queue:"brai_auth",handler:(error,msg)=>{
  if(error)return;
  if(pending.size>=16){msg.respondError(503,"AUTH_BUSY");return;}
  const work=(async()=>{let request:unknown;
   try{if(msg.data.length>32768)throw new Error();request=JSON.parse(new TextDecoder().decode(msg.data));}catch{msg.respondError(400,"INVALID_ARGUMENT");return;}
   try{const response=await bridge(name as Operation,request,cfg.origin,handler);msg.respond(Buffer.from(JSON.stringify(response)));}
   catch(error){const invalid=error instanceof Error&&/^(Invalid|Origin required)/.test(error.message);msg.respondError(invalid?400:503,invalid?"INVALID_ARGUMENT":"AUTH_UNAVAILABLE");}
  })();pending.add(work);void work.finally(()=>pending.delete(work));
 }});
 return {service,async stop(){await service.stop();await Promise.allSettled(pending);}};
}
