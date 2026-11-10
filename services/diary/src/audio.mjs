// ABOUTME: Проверяет оригинал и делит аудио до пяти часов на ограниченные PCM WAV.
// ABOUTME: Байты читаются потоково; временная область принадлежит одной записи и не заменяет Artifacts.
import {createHash} from 'node:crypto';
import {mkdir,rm,open,lstat,statfs} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DiaryFault,id} from './domain.mjs';
const exec=promisify(execFile),rate=16000,sampleBytes=2;
const formats='wav,flac,mp3,ogg,mov,mp4,m4a,3gp,3g2,mj2,aac,matroska,webm';
const fail=code=>new DiaryFault(code,409);
/** Проверяет конечные пределы и команды, заданные оператором, до чтения оригинала. */
export function audioConfig(c){
 if(!c||!isAbsolute(c.spoolDirectory)||c.spoolDirectory.split('/').includes('..')||
  !Number.isInteger(c.maxSeconds)||c.maxSeconds<1||c.maxSeconds>18000||
  !Number.isInteger(c.partSeconds)||c.partSeconds<26||c.partSeconds>170||
  !Number.isInteger(c.prepareTimeoutMs)||c.prepareTimeoutMs<1000||c.prepareTimeoutMs>900000)throw fail('AUDIO_CONFIG_INVALID');
 for(const key of ['ffmpegCommand','ffprobeCommand'])if(!Array.isArray(c[key])||!c[key].length||!isAbsolute(c[key][0])||c[key].some(v=>typeof v!=='string'||!v||v.includes('\0')))throw fail('AUDIO_CONFIG_INVALID');
 return c;
}
async function runCommand(command,args,cwd,timeout){
 try{return (await exec(command[0],[...command.slice(1),...args],{cwd,timeout,maxBuffer:16384,killSignal:'SIGKILL',encoding:'buffer',env:{PATH:'/usr/bin:/bin',LANG:'C',HOME:cwd,TMPDIR:cwd}})).stdout;}
 catch{throw fail('AUDIO_PREPARATION_FAILED');}
}
/** Проверяет фактический контейнер, один аудиопоток и длительность до декодирования. */
export function checkedDuration(p,maximum){
 const names=p?.format?.format_name?.split(','),duration=Number(p?.format?.duration);
 if(!names?.length||names.some(v=>!formats.split(',').includes(v))||!Array.isArray(p.streams)||p.streams.length!==1||p.streams[0].codec_type!=='audio'||!Number.isFinite(duration)||duration<=0)throw fail('AUDIO_INVALID');
 if(duration>maximum)throw fail('AUDIO_TOO_LONG');return duration;
}
/** Выбирает тихую границу в последних 15 секундах; каждый PCM-кадр остаётся ровно в одной части. */
export function cutFrames(pcm,maximumFrames,final=false){
 const available=pcm.length/sampleBytes;
 if(final||available<maximumFrames)return Math.min(available,maximumFrames);
 const width=rate/5,start=Math.max(width,maximumFrames-15*rate);
 let chosen=maximumFrames,best=200;
 for(let frame=start;frame+width<=maximumFrames;frame+=width){
  let sum=0;for(let i=frame;i<frame+width;i++)sum+=Math.abs(pcm.readInt16LE(i*sampleBytes));
  const level=sum/width;if(level<=best){best=level;chosen=frame+width/2;}
 }return chosen;
}
/** Создаёт канонический заголовок mono PCM 16 kHz, без пользовательских метаданных. */
export function wavHeader(bytes){
 const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(36+bytes,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*sampleBytes,28);b.writeUInt16LE(sampleBytes,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);return b;
}
async function wavData(file,maxFrames){
 const meta=await lstat(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>maxFrames*sampleBytes+1048576)throw fail('AUDIO_INVALID');
 const fd=await open(file,'r');
 try{
  const header=Buffer.alloc(Math.min(meta.size,1048576));const read=await fd.read(header,0,header.length,0);
  if(read.bytesRead!==header.length||header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE')throw fail('AUDIO_INVALID');
  let format=false;
  for(let offset=12;offset+8<=header.length;){
   const name=header.toString('ascii',offset,offset+4),size=header.readUInt32LE(offset+4),data=offset+8;
   if(name==='fmt '){if(size<16||data+16>header.length||header.readUInt16LE(data)!==1||header.readUInt16LE(data+2)!==1||header.readUInt32LE(data+4)!==rate||header.readUInt16LE(data+12)!==2||header.readUInt16LE(data+14)!==16)throw fail('AUDIO_INVALID');format=true;}
   if(name==='data'){
    const frames=size/sampleBytes;if(!format||!Number.isInteger(frames)||frames<1||frames>maxFrames||data+size>meta.size)throw fail('AUDIO_INVALID');
    return {offset:data,frames};
   }
   offset=data+size+(size%2);
  }throw fail('AUDIO_INVALID');
 }finally{await fd.close();}
}
async function original(url,path,expectedBytes,expectedHash,timeout){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});
 if(!response.ok||!response.body)throw fail('AUDIO_UNAVAILABLE');
 const fd=await open(path,'wx',0o600),hash=createHash('sha256');let bytes=0;
 try{
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>expectedBytes)throw fail('ORIGINAL_CHANGED');hash.update(chunk);await fd.writeFile(chunk);}
  if(bytes!==expectedBytes||hash.digest('hex')!==expectedHash)throw fail('ORIGINAL_CHANGED');
  await fd.sync();
 }finally{await fd.close();await response.body.cancel().catch(()=>{});}
}
/**
 * Проверяет оригинал по SHA-256, декодирует до EOF и возвращает части с точными смещениями.
 * Вызывающий загружает части в Artifacts и всегда вызывает cleanup; пути не попадают в БД.
 */
export async function prepareAudioFiles(config,{entryId,url,sha256,sizeBytes}){
 const c=audioConfig(config);id(entryId);
 if(!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(sizeBytes)||sizeBytes<1)throw fail('AUDIO_INVALID');
 const parent=await lstat(c.spoolDirectory);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o077))throw fail('AUDIO_CONFIG_INVALID');
 const dir=join(c.spoolDirectory,entryId),cleanup=()=>rm(dir,{recursive:true,force:true});
 await cleanup();await mkdir(dir,{mode:0o700});
 try{
  const space=await statfs(dir),maximumFrames=(c.maxSeconds+1)*rate;
  if(space.bavail*space.bsize<sizeBytes+maximumFrames*sampleBytes*2+1048576)throw fail('AUDIO_STORAGE_FULL');
  const source=join(dir,'source'),normalized=join(dir,'normalized.wav');
  await original(url,source,sizeBytes,sha256,c.prepareTimeoutMs);
  let metadata;try{metadata=JSON.parse((await runCommand(c.ffprobeCommand,['-v','error','-protocol_whitelist','file','-format_whitelist',formats,'-max_streams','1','-show_entries','format=format_name,duration:stream=codec_type','-of','json',source],dir,15000)).toString());}catch(error){if(error instanceof DiaryFault)throw error;throw fail('AUDIO_INVALID');}
  const duration=checkedDuration(metadata,c.maxSeconds);
  await runCommand(c.ffmpegCommand,['-nostdin','-v','error','-protocol_whitelist','file','-format_whitelist',formats,'-i',source,'-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1','-ac','1','-ar',String(rate),'-c:a','pcm_s16le','-fs',String(maximumFrames*sampleBytes+1048576),'-f','wav','-n',normalized],dir,c.prepareTimeoutMs);
  const data=await wavData(normalized,maximumFrames);
  if(Math.abs(data.frames/rate-duration)>1)throw fail('AUDIO_INCOMPLETE');
  const fd=await open(normalized,'r'),parts=[];let startFrame=0;
  try{
   while(startFrame<data.frames){
    const maximum=c.partSeconds*rate,frames=Math.min(maximum,data.frames-startFrame),pcm=Buffer.alloc(frames*sampleBytes);
    const read=await fd.read(pcm,0,pcm.length,data.offset+startFrame*sampleBytes);
    if(read.bytesRead!==pcm.length)throw fail('AUDIO_INCOMPLETE');
    const count=cutFrames(pcm,maximum,startFrame+frames===data.frames),content=pcm.subarray(0,count*sampleBytes),header=wavHeader(content.length);
    const index=parts.length,path=join(dir,'part-'+String(index).padStart(4,'0')+'.wav'),part=await open(path,'wx',0o600);
    try{await part.writeFile(header);await part.writeFile(content);}finally{await part.close();}
    parts.push({index,path,startFrame,frames:count,sha256:createHash('sha256').update(header).update(content).digest('hex'),sizeBytes:44+content.length});
    startFrame+=count;
   }
  }finally{await fd.close();}
  return {version:1,sampleRate:rate,totalFrames:data.frames,durationSeconds:data.frames/rate,parts,cleanup};
 }catch(error){await cleanup();throw error;}
}
