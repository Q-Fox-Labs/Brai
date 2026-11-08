// ABOUTME: Проверяет поток свёртки больше транспортного кадра, целостность и отказ без повтора.
// ABOUTME: Использует только временный Unix socket и синтетические Unicode-строки.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {callSummaryStream} from '../dist/personal-summary-stream.js';
test('поток передаёт input и summary >2MiB полностью и проверяет SHA-256',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dialogues-summary-stream-')),path=join(dir,'broker.sock');
 const input='Исходник 😀'.repeat(160000),result='Большая сводка 🧠'.repeat(140000);
 let calls=0,received='',broken=false,busy=false;
 const server=createServer(socket=>{
  calls++;socket.setEncoding('utf8');let buffer='',id;
  const send=value=>socket.write(JSON.stringify({jsonrpc:'2.0',id,result:value})+'\n');
  socket.on('data',data=>{
   buffer+=data;
   for(;;){
    const end=buffer.indexOf('\n');if(end<0)break;
    const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
    if(!id){id=value.id;assert.equal(value.method,'dialogues.summarize-stream');send({status:busy?'busy':'ready'});continue;}
    if(value.text!==undefined){received+=value.text;continue;}
    assert.equal(value.end,true);
    let offset=0;
    for(let i=0;i<result.length;){
     let end=Math.min(i+2000,result.length);
     if(end<result.length&&result.charCodeAt(end-1)>=0xD800&&result.charCodeAt(end-1)<=0xDBFF)end--;
     const text=result.slice(i,end);send({status:'chunk',offset,text});offset+=Buffer.byteLength(text);i=end;
    }
    send({status:'completed',totalBytes:offset,sha256:broken?'0'.repeat(64):createHash('sha256').update(result).digest('hex')});
   }
  });
 });
 await new Promise(done=>server.listen(path,done));
 try{
  assert.deepEqual(await callSummaryStream(path,input,15000),{status:'completed',result});
  assert.equal(received,input);assert.equal(calls,1);
  received='';broken=true;await assert.rejects(callSummaryStream(path,'test',15000));assert.equal(calls,2);
  busy=true;assert.deepEqual(await callSummaryStream(path,'test',15000),{status:'busy'});assert.equal(calls,3);
 }finally{await new Promise(done=>server.close(done));await rm(dir,{recursive:true,force:true});}
});
