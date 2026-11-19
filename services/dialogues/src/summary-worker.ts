// ABOUTME: Выполняет единственный запрос свёртки в контейнере с лимитом памяти 256 МиБ.
// ABOUTME: Вход и выход идут ограниченными кадрами; root-посредник не собирает их целиком.
import {readFileSync,lstatSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createLuna} from './luna.js';
try{
 const path=process.env.DIALOGUES_SUMMARY_CONFIG;
 if(!path)throw new Error('CONFIG_REQUIRED');
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.uid!==0||(stat.mode&0o027)||!(stat.mode&0o400))throw new Error('UNSAFE_CONFIG');
 const cfg=JSON.parse(readFileSync(path,'utf8'));
 const parts:string[]=[];let ended=false;
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 for await(const line of lines){
  if(Buffer.byteLength(line)>65536)throw new Error('FRAME_TOO_LARGE');
  const value=JSON.parse(line);
  if(value.end===true&&Object.keys(value).sort().join(',')==='end,id'){ended=true;break;}
  if(Object.keys(value).sort().join(',')!=='id,text'||typeof value.text!=='string')throw new Error('INVALID_INPUT');
  parts.push(value.text);
 }
 lines.close();
 if(!ended)throw new Error('INPUT_INCOMPLETE');
 const luna=createLuna(cfg.socketUrl,cfg.cwd);
 let result:string;
 try{result=await luna.run(parts.join(''),{},async()=>{});}
 finally{await luna.close();parts.length=0;}
 const send=async(value:unknown)=>{if(!process.stdout.write(JSON.stringify(value)+'\n'))await once(process.stdout,'drain');};
 let bytes=0;const hash=createHash('sha256');
 for(let offset=0;offset<result.length;){
  let end=Math.min(offset+8192,result.length);
  if(end<result.length&&result.charCodeAt(end-1)>=0xD800&&result.charCodeAt(end-1)<=0xDBFF)end--;
  const text=result.slice(offset,end);
  await send({status:'chunk',offset:bytes,text});
  bytes+=Buffer.byteLength(text);hash.update(text);offset=end;
 }
 await send({status:'completed',totalBytes:bytes,sha256:hash.digest('hex')});
}catch{process.stderr.write('DIALOGUES_SUMMARY_FAILED\n');process.exitCode=1;}
