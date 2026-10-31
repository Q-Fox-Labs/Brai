// ABOUTME: Запускает настоящий процесс Каналов на ресурсах disposable стенда.
// ABOUTME: Удаляет только собственные временные файлы и дочерние процессы.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {connect} from 'nats';
import {Pool} from 'pg';
import {operations,hash} from '../../dist/contracts.js';
export const root=fileURLToPath(new URL('../../../../',import.meta.url));
export const enabled=process.env.INTAKE_TEST_DISPOSABLE==='1';
export const url=(role,db='brai_channels_test')=>'postgresql://'+role+':intake-test@127.0.0.1:25643/'+db;
export function run(script,env){
 const child=spawn(process.execPath,[root+script],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 let output='';for(const p of [child.stdout,child.stderr])p.on('data',b=>{output=(output+b).slice(-6000);});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',c=>resolve(c));});
 return {child,done,output:()=>output,async stop(){if(child.exitCode!==null)return;child.kill('SIGTERM');const t=setTimeout(()=>child.kill('SIGKILL'),6000);try{await done;}finally{clearTimeout(t);}}};
}
export async function eventually(fn,ms=15000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,40));}throw last??Error('TEST_TIMEOUT');}
export const metadata=()=>({requestId:randomUUID(),ownerId:'fixture',actorId:null,reason:'synthetic acceptance'});
export const rule=title=>({id:'title',priority:0,when:[],assign:[{field:'title',mode:'override',value:title}]});
export async function startChannels(){
 if(!enabled)throw Error('DISPOSABLE_REQUIRED');
 const temp=await mkdtemp(root+'tmp/channels-test-'),clients=[];
 const owner=new Pool({connectionString:url('channels_test_owner'),max:2}),app=new Pool({connectionString:url('channels_test'),max:4});
 const migrate=()=>run('services/channels/dist/migrate.js',{CHANNELS_OWNER_DATABASE_URL:url('channels_test_owner'),CHANNELS_RUNTIME_ROLE:'channels_test'});
 const m=migrate();if(await m.done!==0)throw Error(m.output());
 const binding={ownerIds:['fixture'],operations:[],sourceIds:[],replySourceIds:[],connectionIds:null};
 const callers={
  admin_test:{...binding,ownerIds:['fixture','foreign'],operations:operations.filter(x=>x!=='status'),sourceIds:['telegram','telegram_other'],replySourceIds:['fixture_hermes']},
  reader_test:{...binding,operations:['types.list','types.get','connections.get','connections.list','channels.get','channels.list']},
  intake_test:{...binding,operations:['resolve'],sourceIds:['telegram'],replySourceIds:['fixture_hermes']},
  delivery_test:{...binding,operations:['delivery.check']}
 };
 await writeFile(temp+'/key',Buffer.alloc(32,7),{mode:0o600});
 await writeFile(temp+'/nats.json',JSON.stringify({user:'channels',pass:'intake-test',inboxPrefix:'_INBOX.channels'}),{mode:0o600});
 await writeFile(temp+'/runtime.json',JSON.stringify({databaseUrl:url('channels_test'),natsUrl:'nats://127.0.0.1:24343',natsOptionsFile:temp+'/nats.json',cursorKeyFile:temp+'/key',callers}),{mode:0o600});
 const client=async name=>{const nc=await connect({servers:'nats://127.0.0.1:24343',user:'channels_'+name,pass:'intake-test',inboxPrefix:'_INBOX.channels_'+name});clients.push(nc);return nc;};
 const admin=await client('admin'),reader=await client('reader'),delivery=await client('delivery');
 const rpc=async(op,q={},nc=admin,caller='admin_test')=>{
  const m=await nc.request('brai.channels.v1.'+op+(op==='status'?'':'.'+caller),Buffer.from(JSON.stringify(q)),{timeout:8000});
  const body=JSON.parse(new TextDecoder().decode(m.data));
  if(m.headers?.get('Nats-Service-Error-Code'))throw Object.assign(Error(body.code),body,{status:Number(m.headers.get('Nats-Service-Error-Code'))});
  return body;
 };
 let process=run('services/channels/dist/main.js',{CHANNELS_CONFIG:temp+'/runtime.json'});
 await eventually(async()=>(await rpc('status')).ready);
 return {temp,owner,app,admin,reader,delivery,rpc,migrate,hash,
  async restart(databaseUrl=url('channels_test')){await process.stop();const config=JSON.parse(await readFile(temp+'/runtime.json','utf8'));config.databaseUrl=databaseUrl;await writeFile(temp+'/runtime.json',JSON.stringify(config),{mode:0o600});process=run('services/channels/dist/main.js',{CHANNELS_CONFIG:temp+'/runtime.json'});await eventually(async()=>{await rpc('status');return true;});},
  pid:()=>process.child.pid,
  async close(){await process.stop();await Promise.all(clients.map(c=>c.close()));await app.end();await owner.end();await rm(temp,{recursive:true,force:true});}
 };
}
export async function seed(f,{sourceId='telegram',botId='123'}={}){
 const settings={name:'Synthetic bot',enabled:true,credentialsRef:'opaque_bot_ref',allowedActorIds:['456'],extensions:{}};
 const c=await f.rpc('connections.create',{...metadata(),type:{code:'telegram',version:1},sourceId,botId,settings});
 const channelSettings={name:'Synthetic topic',enabled:true,allowedActorIds:['456'],locationRef:'space:initial',rules:[rule('initial')],extensions:{}};
 const h=await f.rpc('channels.create',{...metadata(),connectionId:c.result.id,kind:'topic',address:{botId,chatId:'456',threadId:'7'},parentId:null,settings:channelSettings});
 return {c,h,settings,channelSettings};
}
export function incoming(extra={}){return {operationId:randomUUID(),packetId:randomUUID(),ownerId:'fixture',sourceId:'telegram',asOf:new Date().toISOString(),eventType:'message.incoming',direction:'incoming',sourceRef:{botId:'123',chatId:'456',threadId:'7'},author:{kind:'human',id:'456'},facts:{hasText:true,contentKinds:['text']},initialFields:{},replyTo:null,...extra};}
