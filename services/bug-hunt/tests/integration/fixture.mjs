// ABOUTME: Собирает реальные Auth, bug-hunt, MCP и NATS в собственном тестовом контуре.
// ABOUTME: URL ограничены loopback и выделенными synthetic БД; модели и DEV не используются.
import {readFileSync} from 'node:fs';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {connect} from 'nats';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createAuth} from '../../../auth/dist/auth.js';
import {runNats} from '../../../auth/dist/nats.js';
import {provision} from '../../../auth/dist/identity.js';
import {issueCode} from '../../../auth/dist/login-code.js';
import {migrate} from '../../dist/migrate.js';
import {startRuntime} from '../../dist/main.js';
export const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
const exec=promisify(execFile);
const secret='fixture-auth-secret-at-least-32-characters';
for(const [key,path] of [['ownerURL','/brai_bug_hunt_test'],['appURL','/brai_bug_hunt_test'],['authOwnerURL','/brai_auth_test'],['authAppURL','/brai_auth_test']]){
 const url=new URL(fixture[key]);if(url.hostname!=='127.0.0.1'||url.pathname!==path)throw new Error('Only isolated synthetic fixture permitted');
}
if(new URL(fixture.natsURL).hostname!=='127.0.0.1'||new URL(fixture.origin).hostname!=='127.0.0.1')throw new Error('Loopback fixture required');
/** Запускает реальные адаптеры fixture и возвращает контролируемый cleanup. */
export async function startFixture(){
 const tempRoot=fileURLToPath(new URL('../../../../tmp/',import.meta.url));await mkdir(tempRoot,{recursive:true});
 const temp=await mkdtemp(join(tempRoot,'bug-hunt-runtime-'));
 const authCfg={origin:fixture.origin,trustedOrigins:[fixture.origin],secret,identityMode:'telegram',emailFrom:'',resendKey:'',natsServers:[fixture.natsURL],natsUser:'auth',natsPassword:'fixture-auth'};
 const env={...process.env,AUTH_DATABASE_URL:fixture.authOwnerURL,AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'auth_app',AUTH_ORIGIN:fixture.origin,AUTH_SECRET:secret,AUTH_IDENTITY_MODE:'telegram'};
 await exec(process.execPath,[fileURLToPath(new URL('../../../auth/dist/migrate.js',import.meta.url))],{env,timeout:30000});
 const bootstrapPath=join(temp,'bootstrap.json');await writeFile(bootstrapPath,JSON.stringify({userId:'bug-fixture-admin',telegramId:'120010001',name:'Fixture reviewer',profileId:'fixture-admin'}),{mode:0o600});
 await exec(process.execPath,[fileURLToPath(new URL('../../../auth/dist/bootstrap.js',import.meta.url))],{env:{...env,AUTH_BOOTSTRAP_FILE:bootstrapPath},timeout:30000});
 const authPool=new Pool({connectionString:fixture.authAppURL,max:8});
 const owner=new Pool({connectionString:fixture.ownerURL,max:1});
 await migrate(owner,'bug_hunt_owner','bug_hunt_app');await owner.end();
 const authNc=await connect({servers:fixture.natsURL,user:'auth',pass:'fixture-auth',inboxPrefix:'_INBOX.brai_auth'});
 const auth=createAuth(authCfg,authPool);
 const authRuntime=await runNats(authNc,authCfg,auth.handler,authPool);
 const nc=await connect({servers:fixture.natsURL,user:'fixture',pass:'fixture-operator'});
 const brokerNc=await connect({servers:fixture.natsURL,user:'hermes',pass:'fixture-hermes',inboxPrefix:'_INBOX.hermes'});
 const call=async(subject,input,connection=nc)=>{
  const msg=await connection.request(subject,Buffer.from(JSON.stringify(input)),{timeout:11000});
  const value=msg.data.length?JSON.parse(Buffer.from(msg.data).toString()):{};
  if(msg.headers?.has('Nats-Service-Error')||msg.headers?.has('Nats-Service-Error-Code'))throw Object.assign(new Error(value.code??msg.headers.get('Nats-Service-Error')),{code:value.code??msg.headers.get('Nats-Service-Error'),outcome:value.outcome,headers:msg.headers});
  return value;
 };
 const user=await provision(authPool,secret,{requestId:randomUUID(),telegramId:String(120020000+Math.floor(Math.random()*900000)),userId:randomUUID(),profileId:'fixture-'+randomUUID(),name:'Fixture reporter',role:'user',status:'active'});
 const token='synthetic-bughunt-'+randomUUID(),principalsPath=join(temp,'principals.json');
 const entry={tokenSha256:createHash('sha256').update(token).digest('hex'),ownerId:user.id,principalId:user.id,enabled:true};
 await writeFile(principalsPath,JSON.stringify([entry]),{mode:0o600});
 const cfg={databaseURL:fixture.appURL,installationId:'fixture-runtime',cursorKey:'fixture-runtime-cursor-key-more-than-32-bytes',nats:{servers:[fixture.natsURL],user:'bughunt',password:'fixture-bughunt',inboxPrefix:'_INBOX.bughunt'},mcp:{host:'127.0.0.1',port:fixture.mcpPort,allowedHosts:['127.0.0.1:'+fixture.mcpPort],allowedOrigins:[fixture.origin],principalsFile:principalsPath,maxConnections:24},maxReports:10000,reportsPerMinute:1000,maxDatabaseBytes:1073741824,artifactsEnabled:false};
 let runtime=await startRuntime(cfg);
 const client=new Client({name:'bug-hunt-fixture',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcp.url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
 const login=async(telegramId)=>{
  const issued=await issueCode(authPool,secret,telegramId);if(!issued)throw new Error('Fixture code unavailable');
  const value=await call('brai.auth.v2.login-code-redeem',{headers:{origin:fixture.origin},body:{code:issued.code}});
  if(value.status!==200)throw new Error('Fixture login failed');
  return value.setCookies.map(cookie=>cookie.split(';')[0]).join('; ');
 };
 const cookie=await login(user.telegramId),adminCookie=await login('120010001');
 return {temp,fixture,cfg,nc,brokerNc,call,authPool,client,user,cookie,adminCookie,principalsPath,entry,token,
  get runtime(){return runtime;},
  async restart(){await runtime.stop();runtime=await startRuntime(cfg);},
  async browserCode(){const issued=await issueCode(authPool,secret,'120010001');return issued.code;},
  async close(){await client.close().catch(()=>{});await runtime.stop();await authRuntime.stop();await Promise.all([nc.drain(),brokerNc.drain(),authNc.drain()]);await authPool.end();await rm(temp,{recursive:true,force:true});},
 };
}
