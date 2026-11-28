// ABOUTME: Подключает Welcome к Auth и к персональным Диалогам.
// ABOUTME: Секреты передаются только по доверенным портам и недоступны модели.
import {readFile} from 'node:fs/promises';
import {connect,credsAuthenticator} from 'nats';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Подключает отдельного NATS principal Welcome. */
export async function messaging(config) {
 const login=config.credentials?{authenticator:credsAuthenticator(await readFile(config.credentials))}:
  {user:config.user,pass:config.password};
 if(!config.credentials&&(!login.user||!login.pass))throw Error('WELCOME_NATS_AUTH_REQUIRED');
 const nc=await connect({servers:config.servers,...login,inboxPrefix:config.inbox});
 return {
  async request(subject,value,timeout=10000) {
   const reply=await nc.request(subject,Buffer.from(JSON.stringify(value)),{timeout});
   if(reply.headers?.get('Nats-Service-Error-Code')) throw Error('WELCOME_DEPENDENCY_ERROR');
   return JSON.parse(Buffer.from(reply.data).toString());
  },
  close:()=>nc.drain()
 };
}

/** Auth владеет привязкой Telegram и активацией гостя. */
export function authPort(bus) {
 const send=(method,value)=>bus.request('brai.auth.v2.'+method,value);
 return {
  async resolve(telegramId){return (await send('telegram-resolve',{telegramId})).user;},
  async register(value){return (await send('welcome-register',value)).user;},
  async approve(headers,telegramId,requestId){
   return send('users-add',{headers,body:{telegramId,requestId,role:'guest'}});
  },
  async operation(headers,requestId){
   return send('users-operation-get',{headers,body:{requestId}});
  },
  async admin(headers){
   const result=await bus.request('brai.auth.v1.session',{headers,body:{}});
   const user=result.body?.user;
   return result.status===200&&user?.status==='active'&&['creator','admin'].includes(user.role)?user:null;
  }
 };
}

/** Получает только одну персональную привязку по ID из Auth. */
export function dialoguesPort(config) {
 const origin=new URL(config.origin).origin;
 return async visitor=>{
  const userId=visitor.user_id,profileId=visitor.profile_id;
  const grant=await fetch(origin+'/endpoint',{method:'POST',redirect:'error',
   headers:{'content-type':'application/json',authorization:'Bearer '+config.token},
   body:JSON.stringify({userId,profileId})});
  if(!grant.ok) throw Error('WELCOME_DIALOGUES_UNAVAILABLE');
  const value=await grant.json();
  if(value.userId!==userId || value.profileId!==profileId || value.url!==origin+'/mcp/'+userId ||
   !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) throw Error('WELCOME_DIALOGUES_BINDING');
  const client=new Client({name:'brai-welcome',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(value.url),{requestInit:{headers:{
   authorization:'Bearer '+value.token,'x-brai-user-id':userId,'x-brai-profile-id':profileId
  }}});
  try{await client.connect(transport);}catch(error){await client.close().catch(()=>{});throw error;}
  return {
   async exchange(action,args){
    const request={action,arguments:args};
    if(action==='input') request.context={consumer_id:'welcome',context_instance_id:'welcome',format:'index',reset:true};
    const result=await client.callTool({name:'dialogues_exchange',arguments:request});
    const body=result.structuredContent;
    if(result.isError||!body||body.status==='rejected') throw Error('WELCOME_DIALOGUES_REJECTED');
    return body;
   },
   close:()=>client.close()
  };
 };
}
