// ABOUTME: Запускает отдельный Codex для Luna с существующей подписочной авторизацией.
// ABOUTME: Получает access через закрытый RPC, не копирует OAuth state и не вызывает Hermes.
import {createConnection} from 'node:net';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DialoguesFault} from './domain.js';
import {createLuna,type LunaSocket} from './luna.js';
export type SubscriptionConfig={binary:string;python:string;credentialClient:string;credentialSocket:string;sourceRef:string;home:string;cwd:string;catalogPath:string;node?:string};
const toml=(value:any):string=>value&&typeof value==='object'&&!Array.isArray(value)?'{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+'='+toml(item)).join(',')+'}':JSON.stringify(value);
const baseUrl='https://chatgpt.com/backend-api/codex';
/** Один credential RPC; неизвестный исход никогда не повторяется этим адаптером. */
export async function credential(socketPath:string){
 const id=randomUUID();
 return new Promise<any>((resolve,reject)=>{
  const socket=createConnection(socketPath);const decoder=new StringDecoder('utf8');let raw='';let finished=false;
  const fail=()=>{if(!finished){finished=true;socket.destroy();reject(new DialoguesFault('LUNA_AUTH_UNAVAILABLE'));}};
  socket.once('error',fail);socket.once('end',fail);
  socket.once('connect',()=>socket.write(JSON.stringify({jsonrpc:'2.0',id,method:'credentials.resolve',params:{}})+'\n'));
  socket.on('data',part=>{raw+=decoder.write(part);if(Buffer.byteLength(raw)>4*1024*1024){fail();return;}const end=raw.indexOf('\n');if(end<0)return;
   try{const response=JSON.parse(raw.slice(0,end));if(response.jsonrpc!=='2.0'||response.id!==id||response.error)throw new Error();finished=true;socket.destroy();resolve(response.result);}catch{fail();}
  });
 });
}
/** Преобразует публичный stdio Codex в транспорт существующего Luna executor. */
export class NativeSocket extends EventEmitter implements LunaSocket {
 readyState=0;private child:ChildProcessWithoutNullStreams;private buffer='';
 private stopping:NodeJS.Timeout|undefined;
 constructor(binary:string,args:string[],home:string,cwd:string,path='/usr/bin:/bin'){
  super();
  const decoder=new StringDecoder('utf8');
  this.child=spawn(binary,args,{cwd,env:{HOME:home,CODEX_HOME:home+'/.codex',PATH:path},stdio:'pipe'});
  this.child.once('spawn',()=>{this.readyState=1;this.emit('open');});
  this.child.once('error',()=>{this.emit('error',new Error('LUNA_UNAVAILABLE'));});
  this.child.once('close',()=>{
   if(this.stopping) clearTimeout(this.stopping);
   this.readyState=3;this.emit('close');
  });
  this.child.stderr.resume();
  this.child.stdin.on('error',()=>this.emit('error',new Error('LUNA_UNAVAILABLE')));
  this.child.stdout.on('error',()=>this.emit('error',new Error('LUNA_UNAVAILABLE')));
  this.child.stdout.on('data',part=>{
   this.buffer+=decoder.write(part);if(Buffer.byteLength(this.buffer)>4*1024*1024){this.terminate();return;}let end:number;
   while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(line)this.emit('message',Buffer.from(line));}
  });
 }
 /** Отправляет один native RPC без shell и диагностического echo. */
 send(value:string,callback?:(error?:Error)=>void){this.child.stdin.write(value+'\n',error=>callback?.(error??undefined));}
 /** Завершение транспорта подтверждается фактическим выходом дочернего процесса. */
 terminate(){
  if(this.readyState>=2)return;
  this.readyState=2;
  this.child.kill('SIGTERM');
  // Use the same grace period as the App Server interrupt and unsubscribe RPCs.
  this.stopping=setTimeout(()=>{if(this.readyState!==3)this.child.kill('SIGKILL');},5000).unref();
 }
}
/** Каждый запрос использует актуальную связь аккаунта и отдельный временный native. */
export function createSubscriptionLuna(cfg:SubscriptionConfig, selection?:{model:string;reasoning:string}){
 for(const key of ['binary','python','credentialClient','credentialSocket','home','cwd','catalogPath'] as const)if(typeof cfg[key]!=='string'||!cfg[key].startsWith('/'))throw new Error('INVALID_SUBSCRIPTION_CONFIG');
 if(!/^[a-f0-9]{64}$/.test(cfg.sourceRef))throw new Error('INVALID_SUBSCRIPTION_CONFIG');
 return createLuna('',cfg.cwd,async()=>{
  const {prepareSubscriptionCatalog}=await import('./subscription-catalog.js');
  await prepareSubscriptionCatalog(cfg);
  const value=await credential(cfg.credentialSocket);
  if(value?.baseUrl!==baseUrl||value.sourceRef!==cfg.sourceRef||typeof value.binding!=='string'||!value.binding||typeof value.accountId!=='string'||!value.accountId||!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()/1000)throw new DialoguesFault('LUNA_AUTH_UNAVAILABLE');
  // AIDEV-NOTE: Access остаётся внутри helper/auth.command. Native не получает его через env/argv.
  delete value.access;
  const provider='dialogues_subscription';
  const settings:Record<string,unknown>={model:selection?.model??'gpt-6-luna',model_provider:provider,model_catalog_json:cfg.catalogPath,check_for_update_on_startup:false,
   [`model_providers.${provider}.name`]:'Dialogues subscription',
   [`model_providers.${provider}.base_url`]:baseUrl,[`model_providers.${provider}.wire_api`]:'responses',
   [`model_providers.${provider}.requires_openai_auth`]:false,
   [`model_providers.${provider}.auth.command`]:cfg.python,
   [`model_providers.${provider}.auth.args`]:['-I','-S','-B',cfg.credentialClient,'--socket',cfg.credentialSocket,'--binding',value.binding],
   [`model_providers.${provider}.auth.refresh_interval_ms`]:0,
   [`model_providers.${provider}.http_headers`]:{'ChatGPT-Account-Id':value.accountId},
   [`model_providers.${provider}.supports_websockets`]:false,
   [`model_providers.${provider}.request_max_retries`]:0,[`model_providers.${provider}.stream_max_retries`]:0};
  const args=['app-server','--listen','stdio://'];for(const [key,item]of Object.entries(settings))args.push('-c',key+'='+toml(item));
  return new NativeSocket(cfg.binary,args,cfg.home,cfg.cwd,cfg.node?cfg.node.slice(0,cfg.node.lastIndexOf('/'))+':/usr/bin:/bin':'/usr/bin:/bin');
 },selection);
}
