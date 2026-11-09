// ABOUTME: Объявляет NATS Services endpoints сервиса авторизации.
// ABOUTME: Ограничивает параллелизм и не хранит сообщения в JetStream.
import { connect,credsAuthenticator,type NatsConnection } from "nats";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { bridge,subjects,type Operation } from "./bridge.js";
import { captureEmailGrant, confirmEmailSession, permitsWebSession, responseCookies } from "./web-access.js";
import { sessionIdentity,v2,v2Subjects } from "./v2.js";
/** Подключается только с явно настроенными NATS credentials и собственным inbox. */
export function connectNats(cfg:Config){return connect({servers:cfg.natsServers,user:cfg.natsUser,pass:cfg.natsPassword,authenticator:cfg.natsCredsFile?credsAuthenticator(readFileSync(cfg.natsCredsFile)):undefined,tls:cfg.natsCAFile?{caFile:cfg.natsCAFile}:undefined,inboxPrefix:"_INBOX.brai_auth",maxReconnectAttempts:-1,timeout:5000,name:"brai_auth"});}
/** Собирает transport; stop прекращает новые вызовы и ждёт уже принятые операции. */
export async function runNats(nc:NatsConnection,cfg:Config,handler:(request:Request)=>Promise<Response>,pool:Pool){
 const service=await nc.services.add({name:"brai_auth",version:"2.0.0",description:"Brai authentication",queue:"brai_auth"});
 const pending=new Set<Promise<void>>();
 for(const [name,subject] of Object.entries({...subjects,...v2Subjects}))service.addEndpoint(name.replaceAll("-","_"),{subject,queue:"brai_auth",handler:(error,msg)=>{
  if(error)return;
  if(pending.size>=16){msg.respondError(503,"AUTH_BUSY");return;}
  const work=(async()=>{let request:unknown;
   try{if(msg.data.length>32768)throw new Error();request=JSON.parse(new TextDecoder().decode(msg.data));}catch{msg.respondError(400,"INVALID_ARGUMENT");return;}
   try{let response;
    if(Object.hasOwn(v2Subjects,name))response=await v2(name,request,cfg,pool,handler);
    else {
     const data=request as {headers:HeadersInit;body?:{email?:unknown}};
     const emailGrant=cfg.identityMode!=="telegram"&&["send-code","verify-code"].includes(name)?await captureEmailGrant(pool,data.body?.email):null;
     if(emailGrant&&!emailGrant.allowed){msg.respond(Buffer.from(JSON.stringify({status:403,body:{error:"FORBIDDEN"},setCookies:[]})));return;}
     if(name==="sso-issue"&&!await permitsWebSession(pool,cfg,handler,new Headers(data.headers))){msg.respond(Buffer.from(JSON.stringify({status:403,body:{error:"INVALID_SSO"},setCookies:[]})));return;}
     response=await bridge(name as Operation,request,cfg.origin,handler,cfg);
     if(emailGrant&&name==="verify-code"&&response.status===200&&!await confirmEmailSession(pool,cfg,handler,responseCookies(response.setCookies),emailGrant))response={status:401,body:{error:"UNAUTHORIZED"},setCookies:[]};
     if(cfg.identityMode!=="telegram"&&name==="session"&&response.body&&!await permitsWebSession(pool,cfg,handler,new Headers(data.headers)))response.body=null;
     if(cfg.identityMode==="telegram"&&name==="session"&&response.body){
      const user=await sessionIdentity(pool,cfg,handler,new Headers((request as {headers:HeadersInit}).headers));
      if(user){const {sessionId,...publicUser}=user;response.body={user:publicUser,session:{id:sessionId,userId:user.id,expiresAt:response.body.session.expiresAt}};}
      else response.body=null;
     }
     if((name==="sso-issue"||name==="sso-redeem")&&response.status===200){
      const headers=name==="sso-issue"?new Headers((request as {headers:HeadersInit}).headers):new Headers({cookie:response.setCookies.map(value=>value.split(";")[0]).join("; ")});
      if(!await permitsWebSession(pool,cfg,handler,headers))response={status:403,body:{error:"INVALID_SSO"},setCookies:[]};
     }
    }
    msg.respond(Buffer.from(JSON.stringify(response)));}
   catch(error){const invalid=error instanceof Error&&/^(Invalid|Origin required)/.test(error.message);msg.respondError(invalid?400:503,invalid?"INVALID_ARGUMENT":"AUTH_UNAVAILABLE");}
  })();pending.add(work);void work.finally(()=>pending.delete(work));
 }});
 return {service,async stop(){await service.stop();await Promise.allSettled(pending);}};
}
