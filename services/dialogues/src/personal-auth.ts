// ABOUTME: Проверяет служебную личность Диалогов через защищённый Unix broker.
// ABOUTME: Не передаёт userId в запросе авторизации и не получает общие credentials.
import {createConnection} from 'node:net';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {callSummaryStream} from './personal-summary-stream.js';
export type PersonalPrincipal={userId:string;profileId:string};

/** Проверяет root-owned socket и всю цепочку родителей до подключения. */
export function verifyBrokerSocket(path:string){
 if(!isAbsolute(path)||realpathSync(path)!==path)throw new Error('UNSAFE_BROKER_SOCKET');
 const socket=lstatSync(path);
 if(!socket.isSocket()||socket.uid!==0)throw new Error('UNSAFE_BROKER_SOCKET');
 for(let parent=dirname(path);;parent=dirname(parent)){
  const stat=lstatSync(parent);
  if(!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022))throw new Error('UNSAFE_BROKER_SOCKET');
  if(parent==='/')break;
 }
}

/** Один приватный RPC без повтора; ошибка или неполный ответ закрывают доступ. */
export async function callPersonalBroker(path:string,method:'dialogues.authorize'|'dialogues.summarize',params:Record<string,unknown>,timeout=3000,verify=verifyBrokerSocket):Promise<any>{
 verify(path);
 if(method==='dialogues.summarize'){
  if(Object.keys(params).join(',')!=='input'||typeof params.input!=='string'||!params.input)throw new Error('INVALID_SUMMARY_INPUT');
  return callSummaryStream(path,params.input,timeout);
 }
 const id=randomUUID(),request=JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';
 if(Buffer.byteLength(request)>2*1024*1024)throw new Error('PERSONAL_REQUEST_TOO_LARGE');
 return new Promise((resolve,reject)=>{
  const socket=createConnection(path);let buffer=Buffer.alloc(0),settled=false;
  const finish=(value?:any)=>{
   if(settled)return;settled=true;clearTimeout(timer);socket.destroy();
   value===undefined?reject(new Error('PERSONAL_AUTH_UNAVAILABLE')):resolve(value);
  };
  const timer=setTimeout(()=>finish(),timeout);
  socket.on('error',()=>finish());socket.on('end',()=>finish());
  socket.once('connect',()=>socket.write(request));
  socket.on('data',part=>{
   buffer=Buffer.concat([buffer,part]);
   if(buffer.length>2*1024*1024){finish();return;}
   const end=buffer.indexOf(10);if(end<0)return;
   try{
    if(end!==buffer.length-1)throw new Error('MULTIPLE_RESPONSES');
    const reply=JSON.parse(buffer.subarray(0,end).toString('utf8'));
    if(reply.jsonrpc!=='2.0'||reply.id!==id||reply.error||reply.result===undefined)throw new Error('INVALID_RESPONSE');
    finish(reply.result);
   }catch{finish();}
  });
 });
}

/** Проверяет аккаунт из UID-derived ответа; владелец не передаётся на авторизацию. */
export function createPersonalAuthorizer(path:string,expected:PersonalPrincipal,verify=verifyBrokerSocket){
 const {userId,profileId}=expected;
 if(!userId||!profileId)throw new Error('INVALID_PERSONAL_BINDING');
 return async()=>{
  const result=await callPersonalBroker(path,'dialogues.authorize',{},3000,verify);
  if(result?.userId!==userId||result?.profileId!==profileId)throw new Error('PERSONAL_AUTH_UNAVAILABLE');
 };
}
