// ABOUTME: Проверяет служебную личность Диалогов через защищённый Unix broker.
// ABOUTME: Не передаёт userId в запросе авторизации и не получает общие credentials.
import {createConnection} from 'node:net';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
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

/** Делает одну проверку Auth за 3 секунды; любой неполный/чужой ответ закрывает доступ. */
export function createPersonalAuthorizer(path:string,expected:PersonalPrincipal,verify=verifyBrokerSocket){
 if(!expected.userId||!expected.profileId)throw new Error('INVALID_PERSONAL_BINDING');
 return async function authorize(){
  verify(path);
  const id=randomUUID();
  await new Promise<void>((resolve,reject)=>{
   const socket=createConnection(path);let buffer=Buffer.alloc(0),settled=false;
   const finish=(ok:boolean)=>{
    if(settled)return;settled=true;clearTimeout(timer);socket.destroy();
    ok?resolve():reject(new Error('PERSONAL_AUTH_UNAVAILABLE'));
   };
   const timer=setTimeout(()=>finish(false),3000);
   socket.on('error',()=>finish(false));
   socket.on('end',()=>finish(false));
   socket.once('connect',()=>socket.write(JSON.stringify({jsonrpc:'2.0',id,method:'dialogues.authorize',params:{}})+'\n'));
   socket.on('data',part=>{
    buffer=Buffer.concat([buffer,part]);
    if(buffer.length>8192){finish(false);return;}
    const end=buffer.indexOf(10);if(end<0)return;
    try{
     if(end!==buffer.length-1)throw new Error('MULTIPLE_RESPONSES');
     const reply=JSON.parse(buffer.subarray(0,end).toString('utf8'));
     finish(reply.jsonrpc==='2.0'&&reply.id===id&&!reply.error&&
      reply.result?.userId===expected.userId&&reply.result?.profileId===expected.profileId);
    }catch{finish(false);}
   });
  });
 };
}
