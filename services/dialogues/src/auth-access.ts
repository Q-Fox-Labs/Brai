// ABOUTME: Авторизует персональные Диалоги прямым запросом в Auth.
// ABOUTME: Subject закреплён установщиком; запрос не содержит выбираемого владельца.
import {readFileSync} from 'node:fs';
import {connect,credsAuthenticator,type NatsConnection} from 'nats';
import type {PersonalPrincipal} from './personal-auth.js';
/** Соединение переиспользуется; close вызывается владельцем runtime. */
export async function connectAuthAccess(env:NodeJS.ProcessEnv,expected:PersonalPrincipal){
 const subject=env.DIALOGUES_AUTH_SUBJECT;
 if(!subject||!/^brai\.auth\.v2\.dialogues-access\.[a-f0-9]{64}$/.test(subject)||!env.DIALOGUES_NATS_CREDS_FILE||!env.DIALOGUES_NATS_SERVERS||!env.DIALOGUES_NATS_INBOX_PREFIX)throw new Error('INVALID_AUTH_CONFIG');
 const nc=await connect({servers:env.DIALOGUES_NATS_SERVERS.split(','),authenticator:credsAuthenticator(readFileSync(env.DIALOGUES_NATS_CREDS_FILE)),tls:env.DIALOGUES_NATS_CA_FILE?{caFile:env.DIALOGUES_NATS_CA_FILE}:undefined,inboxPrefix:env.DIALOGUES_NATS_INBOX_PREFIX,maxReconnectAttempts:-1,name:'dialogues-auth'});
 return {authorize:createAuthAccess(nc,subject,expected),close:()=>nc.drain()};
}
/** Ошибка транспорта закрывает доступ с отдельным кодом, без повторной выдачи данных. */
export function createAuthAccess(nc:Pick<NatsConnection,'request'>,subject:string,expected:PersonalPrincipal){
 return async()=>{
  let result:any;
  try{
   const reply=await nc.request(subject,Buffer.from('{}'),{timeout:3000});
   if(reply.headers?.get('Nats-Service-Error-Code'))throw new Error();
   result=JSON.parse(new TextDecoder().decode(reply.data));
   if(typeof result?.allowed!=='boolean'||result.userId!==expected.userId||result.profileId!==expected.profileId)throw new Error();
  }catch{throw new Error('PERSONAL_AUTH_UNAVAILABLE');}
  if(!result.allowed)throw new Error('PERSONAL_AUTH_DENIED');
 };
}
