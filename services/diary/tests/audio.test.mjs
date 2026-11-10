// ABOUTME: Проверяет реальный FFmpeg, неизменность PCM и закрытую временную область.
// ABOUTME: Данные синтетические; сетевой источник только собственный loopback HTTP fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareAudioFiles,checkedDuration,cutFrames,wavHeader} from '../src/audio.mjs';
test('five-hour metadata limit includes its boundary and rejects longer or video sources',()=>{
 const input={format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'18000'},streams:[{codec_type:'audio'}]};
 assert.equal(checkedDuration(input,18000),18000);
 input.format.duration='18000.001';assert.throws(()=>checkedDuration(input,18000),/AUDIO_TOO_LONG/);
 input.format.duration='30';input.streams.push({codec_type:'video'});assert.throws(()=>checkedDuration(input,18000),/AUDIO_INVALID/);
});
test('quiet cut stays inside the available PCM and retains a positive prefix',()=>{
 const pcm=Buffer.alloc(170*16000*2);assert.ok(cutFrames(pcm,170*16000)<170*16000);assert.ok(cutFrames(pcm,170*16000)>155*16000);
 assert.equal(cutFrames(pcm,170*16000,true),170*16000);
});
test('real decode and splitting preserve every sample, tail, hash and foreign file',{skip:spawnSync('/usr/bin/ffmpeg',['-version']).status!==0,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'diary-audio-test-')),spool=join(root,'spool');await mkdir(spool,{mode:0o700});
 const frames=356*16000+12345,pcm=Buffer.alloc(frames*2);for(let i=0;i<frames;i++)pcm.writeInt16LE((i%31001)-15500,i*2);
 pcm.fill(0,155*16000*2,160*16000*2);
 const input=Buffer.concat([wavHeader(pcm.length),pcm]),file=join(root,'fixture.wav');await writeFile(file,input);
 await writeFile(join(spool,'foreign-marker'),'keep');
 const server=createServer((req,res)=>createReadStream(file).pipe(res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const cfg={spoolDirectory:spool,ffmpegCommand:['/usr/bin/ffmpeg'],ffprobeCommand:['/usr/bin/ffprobe'],maxSeconds:18000,partSeconds:170,prepareTimeoutMs:30000};
 const args={entryId:randomUUID(),url:'http://127.0.0.1:'+server.address().port,sha256:createHash('sha256').update(input).digest('hex'),sizeBytes:input.length};
 try{
  const result=await prepareAudioFiles(cfg,args),joined=[];let offset=0;
  for(const p of result.parts){const bytes=await readFile(p.path);assert.equal(p.startFrame,offset);offset+=p.frames;assert.equal(bytes.length,p.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),p.sha256);joined.push(bytes.subarray(44));}
  assert.equal(offset,frames);assert.equal(result.totalFrames,frames);assert.deepEqual(Buffer.concat(joined),pcm);
  await result.cleanup();assert.deepEqual(await readdir(spool),['foreign-marker']);
  await assert.rejects(prepareAudioFiles(cfg,{...args,sha256:'b'.repeat(64)}),/ORIGINAL_CHANGED/);
  assert.deepEqual(await readdir(spool),['foreign-marker']);
  const link=join(root,'linked');await symlink(spool,link);await assert.rejects(prepareAudioFiles({...cfg,spoolDirectory:link},args),/AUDIO_CONFIG_INVALID/);
 }finally{server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
});
