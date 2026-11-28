// ABOUTME: Проводит синтез, расшифровку и картинки через штатные порты Brai.
// ABOUTME: Идентичность операции задаёт сервер, никогда вывод модели.
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';

const stableUuid=value=>{
 const hex=createHash('sha256').update(value).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const deadline=()=>new Date(Date.now()+180_000).toISOString();

/** Использует установленные селекторы TTS и ASR. */
export function mediaPorts(bus,config) {
 return {
  async transcribe(event,identity){
   if(!Buffer.isBuffer(event.audioBytes))throw Error('WELCOME_AUDIO_NOT_PREPARED');
   const scratch=await mkdtemp(join(tmpdir(),'welcome-audio-'));
   let artifactId;
   try{
    const file=join(scratch,'audio');
    await writeFile(file,event.audioBytes,{mode:0o600});
    const info=JSON.parse((await promisify(execFile)(config.ffprobe,[
     '-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration,format_name:stream=codec_type','-of','json',file
    ])).stdout);
    const duration=Number(info.format?.duration);
    const formats={ogg:'audio/ogg',wav:'audio/wav',flac:'audio/flac',mp3:'audio/mpeg',m4a:'audio/mp4'};
    const container=info.format?.format_name;
    const extension=container==='mov,mp4,m4a,3gp,3g2,mj2'?'m4a':container;
    if(!Number.isFinite(duration)||duration<=0||duration>600||!formats[extension]||
       !info.streams?.length||info.streams.some(stream=>stream.codec_type!=='audio'))return null;
    const prepared=await bus.request('brai.artifacts.v1.prepare',{
     requestId:`welcome-audio:${event.botId}:${event.updateId}`,ownerId:identity.id,kind:'original',
     metadata:{title:'Вход Welcome',filename:'audio.'+extension,extension,mimeType:formats[extension],source:'welcome'}
    });
    artifactId=prepared.artifact.artifactId;
    const upload=new URL(prepared.uploadUrl);
    if(upload.origin!==config.artifactsUploadOrigin||upload.username||upload.password||!upload.pathname.startsWith('/upload/'))throw Error('WELCOME_UPLOAD_ORIGIN');
    if(prepared.artifact.status!=='ready'){
     const stored=await fetch(upload,{method:'PUT',redirect:'error',body:event.audioBytes});
     if(stored.status!==201)throw Error('WELCOME_UPLOAD_FAILED');
    }
    const result=await bus.request('brai.local_ai.v1.invoke.transcribe',{
     requestId:randomUUID(),operationId:stableUuid(`welcome-asr:${event.botId}:${event.updateId}`),
     ownerId:identity.id,deadlineAt:deadline(),model:config.asr,audioArtifactId:artifactId
    },180_000);
    return result.text;
   }finally{
    await rm(scratch,{recursive:true,force:true});
    if(artifactId)await bus.request('brai.artifacts.v1.delete',{
     artifactId
    });
   }
  },
  async synthesize(owner,text,origin){
   const result=await bus.request('brai.local_ai.v1.invoke.synthesize',{
    requestId:randomUUID(),operationId:stableUuid(origin),ownerId:owner,deadlineAt:deadline(),
    model:config.tts,text,voice:'eugene'
   },180_000);
   return result.audioArtifactId;
  },
  async artifact(owner,artifactId){
   const value=await bus.request('brai.artifacts.v1.get',{artifactId});
   const url=new URL(value.internalUrl??'about:blank');
   if(value.ownerId!==owner||value.status!=='ready'||url.origin!==config.artifactsOrigin||
      url.username||url.password||url.pathname!=='/files/'+artifactId) throw Error('WELCOME_MEDIA_BINDING');
   const file=await fetch(url,{redirect:'error'});
   if(!file.ok)throw Error('WELCOME_MEDIA_UNAVAILABLE');
   return file;
  },
  async image({owner,operationId,prompt,deadlineAt}){
   const identity={operationId:stableUuid(operationId),ownerId:owner};
   let result=await bus.request('brai.providers.v1.invoke.image',{
    ...identity,deadlineAt,provider:'openrouter',
    model:'google/gemini-2.5-flash-image',prompt,size:'1024x1024',quality:'standard',n:1,responseFormat:'b64_json'
   });
   while(['accepted','dispatching','output_pending'].includes(result.phase)){
    const remaining=Date.parse(deadlineAt)-Date.now();
    if(remaining<=0)break;
    await pause(Math.min(1000,remaining));
    result=await bus.request('brai.providers.v1.operations.get',identity,Math.min(10000,remaining));
   }
   const ready=result.result?.outputs?.find(output=>output.status==='ready');
   if(ready?.status!=='ready'||typeof ready.artifactId!=='string')throw Error('WELCOME_IMAGE_UNAVAILABLE');
   return ready.artifactId;
  }
 };
}
