// ABOUTME: Передаёт одну свёртку через ограниченные кадры и проверяет полную контрольную сумму.
// ABOUTME: Держит данные только в персональном процессе; общего root-буфера сводки нет.
import {createConnection} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
/** Один поток без повтора: неполный ответ, таймаут и нарушенная целостность отклоняются. */
export function callSummaryStream(path:string,input:string,timeout:number):Promise<{status:'busy'}|{status:'completed';result:string}>{
 return new Promise((resolve,reject)=>{
  const socket=createConnection(path),id=randomUUID(),parts:string[]=[],hash=createHash('sha256');
  let buffer=Buffer.alloc(0),bytes=0,ready=false,settled=false;
  const finish=(value?:{status:'busy'}|{status:'completed';result:string})=>{
   if(settled)return;settled=true;clearTimeout(timer);socket.destroy();
   value?resolve(value):reject(new Error('PERSONAL_SUMMARY_UNAVAILABLE'));
  };
  const timer=setTimeout(()=>finish(),timeout);
  const send=async(value:unknown)=>{
   if(settled)throw new Error('STREAM_CLOSED');
   if(!socket.write(JSON.stringify(value)+'\n'))await once(socket,'drain');
  };
  const writeInput=async()=>{
   for(let offset=0;offset<input.length;){
    let end=Math.min(offset+8192,input.length);
    if(end<input.length&&input.charCodeAt(end-1)>=0xD800&&input.charCodeAt(end-1)<=0xDBFF)end--;
    await send({id,text:input.slice(offset,end)});offset=end;
   }
   await send({id,end:true});
  };
  socket.once('connect',()=>{void send({jsonrpc:'2.0',id,method:'dialogues.summarize-stream',params:{}}).catch(()=>finish());});
  socket.on('error',()=>finish());socket.on('end',()=>finish());
  socket.on('data',part=>{
   buffer=Buffer.concat([buffer,part]);
   for(;;){
    const end=buffer.indexOf(10);
    if(end<0){if(buffer.length>65536)finish();return;}
    if(end>65536){finish();return;}
    const raw=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
    try{
     const response=JSON.parse(raw.toString('utf8'));
     if(response.jsonrpc!=='2.0'||response.id!==id||response.error)throw new Error('INVALID_RESPONSE');
     const value=response.result;
     if(value.status==='busy'&&!ready){finish({status:'busy'});return;}
     if(value.status==='ready'&&!ready){ready=true;void writeInput().catch(()=>finish());continue;}
     if(!ready)throw new Error('NOT_READY');
     if(value.status==='chunk'&&value.offset===bytes&&typeof value.text==='string'){
      parts.push(value.text);bytes+=Buffer.byteLength(value.text);hash.update(value.text);continue;
     }
     if(value.status==='completed'&&value.totalBytes===bytes&&value.sha256===hash.digest('hex')){
      finish({status:'completed',result:parts.join('')});return;
     }
     throw new Error('INVALID_STREAM');
    }catch{finish();return;}
   }
  });
 });
}
