// ABOUTME: Запускает закрытую выдачу персональных MCP-подключений для Welcome.
// ABOUTME: Auth проверяется через служебный NATS-порт, состояние хранится в штатных Диалогах.
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {connect,credsAuthenticator} from 'nats';
import {welcomeOwner} from './welcome-owner.js';

function required(name:string){
 const value=process.env[name];if(!value)throw Error('MISSING_'+name);return value;
}
const env=JSON.parse(readFileSync(required('DIALOGUES_WELCOME_CONFIG'),'utf8'));
const owner=new Pool({connectionString:env.ownerDatabaseURL});
const administrator=new Pool({connectionString:env.administratorDatabaseURL});
const natsAuthentication=env.natsCredsFile
 ? {authenticator:credsAuthenticator(readFileSync(env.natsCredsFile))}
 : {user:env.natsUser,pass:env.natsPassword};
if(!env.natsCredsFile&&(!env.natsUser||!env.natsPassword))throw Error('WELCOME_NATS_AUTH_REQUIRED');
const nc=await connect({servers:env.natsServers,...natsAuthentication,inboxPrefix:env.natsInbox});
const gateway=welcomeOwner({owner,administrator,ownerRole:env.ownerRole,databaseURL:env.runtimeDatabaseURL,
 secret:readFileSync(env.secretFile,'utf8').trim(),grantToken:readFileSync(env.grantFile,'utf8').trim(),
 publicOrigin:env.origin,authorize:async userId=>{
  const reply=await nc.request('brai.auth.v2.identity-get',Buffer.from(JSON.stringify({userId})),{timeout:3000});
  if(reply.headers?.get('Nats-Service-Error-Code')) throw Error('WELCOME_AUTH_UNAVAILABLE');
  return JSON.parse(Buffer.from(reply.data).toString()).user??null;
 }});
await new Promise<void>((resolve,reject)=>gateway.server.once('error',reject).listen(env.port,env.host,resolve));
let stopping=false;
async function stop(){
 if(stopping)return;
 stopping=true;
 await gateway.close();
 await Promise.all([owner.end(),administrator.end(),nc.close()]);
}
process.on('SIGTERM',()=>void stop());
process.on('SIGINT',()=>void stop());
