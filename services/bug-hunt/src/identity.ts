// ABOUTME: Преобразует доверенные credentials, Web-сессию и broker-контекст в principal.
// ABOUTME: Каждый вызов повторно проверяет Auth; модель не задаёт владельца или роль.
import {createHash} from "node:crypto";
import {Fault,type Principal} from "./contracts.js";
import {readPrivate} from "./config.js";
export type Wire=(subject:string,input:unknown)=>Promise<any>;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:string[])=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
/** Проверяет текущую идентичность Auth по каноническому owner. */
export async function activeIdentity(wire:Wire,owner:string,profileId?:string){
 const result=await wire("brai.auth.v2.identity-get",{userId:owner});
 if(result?.user?.id!==owner||result.user.status!=="active"||profileId!==undefined&&result.user.profileId!==profileId)throw new Fault("FORBIDDEN");
 return result.user;
}
/** Проверяет credential по обновляемому root/operator-owned реестру без кэша допуска. */
export async function codexPrincipal(wire:Wire,path:string,authorization:string|undefined):Promise<Principal>{
 if(!authorization?.startsWith("Bearer ")||authorization.length>512)throw new Fault("UNAUTHENTICATED");
 const sha=createHash("sha256").update(authorization.slice(7)).digest("hex");
 let entries;try{entries=readPrivate(path);}catch{throw new Fault("DEPENDENCY_UNAVAILABLE");}
 if(!Array.isArray(entries)||entries.length>1000)throw new Fault("DEPENDENCY_UNAVAILABLE");
 const matching=entries.filter((v:any)=>exact(v,["tokenSha256","ownerId","principalId","enabled"])&&v.tokenSha256===sha&&v.enabled===true);
 if(matching.length!==1||typeof matching[0].ownerId!=="string"||typeof matching[0].principalId!=="string")throw new Fault("UNAUTHENTICATED");
 const entry=matching[0];
 await activeIdentity(wire,entry.ownerId);
 return {ownerId:entry.ownerId,actorId:"codex:"+entry.principalId,source:"codex",reviewer:false};
}
/** Разрешает Web либо личный broker; сам транспорт ограничивается NATS ACL. */
export async function natsPrincipal(wire:Wire,context:unknown):Promise<Principal>{
 if(!object(context))throw new Fault("UNAUTHENTICATED");
 if(context.kind==="web"&&exact(context,["kind","headers"])&&object(context.headers)){
  if(!exact(context.headers,["cookie","origin","user-agent","sec-fetch-site"])||!Object.values(context.headers).every(v=>typeof v==="string"))throw new Fault("INVALID_ARGUMENT");
  const reply=await wire("brai.auth.v1.session",{headers:context.headers,body:{}});
  const body=reply?.body;
  if(reply?.status!==200||!body?.user?.id||body.session?.userId!==body.user.id||!(Date.parse(body.session?.expiresAt)>Date.now())||body.user.status!=="active")throw new Fault("UNAUTHENTICATED");
  return {ownerId:body.user.id,actorId:"web:"+body.user.id,source:"web",reviewer:body.user.role==="admin"};
 }
 if(context.kind==="hermes"&&exact(context,["kind","userId","profileId"])&&typeof context.userId==="string"&&typeof context.profileId==="string"){
  await activeIdentity(wire,context.userId,context.profileId);
  return {ownerId:context.userId,actorId:"hermes:"+context.profileId,source:"hermes",reviewer:false};
 }
 throw new Fault("UNAUTHENTICATED");
}
