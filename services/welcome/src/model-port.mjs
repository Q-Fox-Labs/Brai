// ABOUTME: Связывает Welcome с отдельным исполнителем через закрытый Unix-сокет.
// ABOUTME: Схема ответа и доступные действия по-прежнему проверяет Welcome.
import {request} from 'node:http';
import {isAbsolute} from 'node:path';

export async function readModelMessage(stream){
 const chunks=[];
 let size=0;
 for await(const part of stream){
  size+=part.length;
  if(size>2*1024*1024)throw Error('WELCOME_MODEL_FRAME');
  chunks.push(part);
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function modelPort(config){
 if(typeof config.socketPath!=='string'||!isAbsolute(config.socketPath))throw Error('WELCOME_MODEL_SOCKET');
 function invoke(path,value){
  return new Promise((resolve,reject)=>{
   const call=request({socketPath:config.socketPath,method:'POST',path,headers:{'content-type':'application/json'}},reply=>{
    if(reply.statusCode!==200){reply.resume();reject(Error('WELCOME_MODEL_UNAVAILABLE'));return;}
    readModelMessage(reply).then(resolve,reject);
   });
   call.once('error',()=>reject(Error('WELCOME_MODEL_UNAVAILABLE')));
   call.end(JSON.stringify(value));
  });
 }
 return {catalog:()=>invoke('/catalog',{}),respond:input=>invoke('/turn',input)};
}
