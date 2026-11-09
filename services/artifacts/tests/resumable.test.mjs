// ABOUTME: Проверяет дозагрузку на реальных HTTP и файловом томе.
// ABOUTME: Отдельный in-memory порт БД позволяет воспроизвести рестарт и неизвестный checkpoint без рабочих данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,appendFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,request} from 'node:http';
import {createFileStore} from '../dist/files.js';
import {createArtifactsCore} from '../dist/core.js';
import {startArtifactsHttp} from '../dist/http.js';
const MB=1048576,zero='0'.repeat(64),hash=b=>createHash('sha256').update(b).digest('hex');
const chain=(before,bytes)=>hash(Buffer.from(before+hash(bytes),'hex'));
const source=bytes=>(async function*(){yield bytes;})();
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'artifacts-resume-')),records=new Map();let clock=Date.now(),gate=Promise.resolve();
 const session={artifact:async id=>structuredClone(records.get(id)),prepared:async id=>structuredClone([...records.values()].find(r=>r.artifact.requestId===id)),uploading:async token=>structuredClone([...records.values()].find(r=>r.uploadToken===token)),saveArtifact:async r=>records.set(r.artifact.artifactId,structuredClone(r)),unfinished:async(after,limit)=>[...records.values()].filter(r=>["pending","failed","deleting"].includes(r.artifact.status)&&(!after||r.artifact.artifactId>after)).map(r=>r.artifact.artifactId).sort().slice(0,limit)};
 const store={async withLocks(_keys,work){let release;const before=gate;gate=new Promise(r=>{release=r;});await before;try{return await work(session,new AbortController().signal);}finally{release();}}};
 const config={uploadBaseURL:'http://fixture',internalBaseURL:'http://internal',maxUploadBytes:10*MB,staleTempAgeMs:3600000};
 const make=async()=>createArtifactsCore({store,files:await createFileStore(root),config,now:()=>clock});
 try{await fn({root,records,session,make,advance:n=>clock+=n});}finally{await rm(root,{recursive:true,force:true});}
}
async function prepared(core){
 const p=await core.execute('prepare',{requestId:randomUUID(),ownerId:'fixture-owner',kind:'original',metadata:{title:'Test',filename:'test.wav',extension:'wav',mimeType:'audio/wav',source:'diary'}});
 return {id:p.artifact.artifactId,token:p.uploadUrl.split('/').at(-1)};
}
test('saved prefix survives new core and file adapter, wrong file/offset rejected; exact final bytes',()=>fixture(async f=>{
 let core=await f.make();const {id,token}=await prepared(core),a=Buffer.alloc(MB,11),b=Buffer.from('tail'),totalBytes=a.length+b.length;
 let state=await core.uploadChunk(token,{offset:0,totalBytes,chain:zero},source(a));assert.equal(state.offset,MB);assert.equal(state.chain,chain(zero,a));
 core=await f.make();assert.deepEqual(await core.uploadStatus(token),state);assert.equal(await (await createFileStore(f.root)).inspect(id),undefined);
 for(const patch of [{offset:0},{chain:zero},{totalBytes:totalBytes+1}])await assert.rejects(core.uploadChunk(token,{offset:MB,totalBytes,chain:state.chain,...patch},source(b)),e=>e.code==='CONFLICT');
 state=await core.uploadChunk(token,{offset:MB,totalBytes,chain:state.chain},source(b));assert.equal(state.ready,true);
 const expected=Buffer.concat([a,b]);assert.deepEqual(await readFile(join(f.root,'files',id)),expected);
 assert.equal(f.records.get(id).artifact.sha256,hash(expected));assert.equal(f.records.size,1);
 assert.equal((await (await f.make()).uploadStatus(token)).offset,totalBytes);
 await assert.rejects(core.upload(token,source(b)),e=>e.code==='CONFLICT');
}));
test('incomplete part and uncommitted tail preserve prior confirmed position',()=>fixture(async f=>{
 const core=await f.make(),{id,token}=await prepared(core),a=Buffer.alloc(MB,7),totalBytes=3*MB;
 const state=await core.uploadChunk(token,{offset:0,totalBytes,chain:zero},source(a));
 await assert.rejects(core.uploadChunk(token,{offset:MB,totalBytes,chain:state.chain},(async function*(){yield Buffer.alloc(200);throw Error('disconnected');})()));
 assert.equal((await core.uploadStatus(token)).offset,MB);
 // Симулируем fsync до потерянного checkpoint: сервер не должен доверять лишнему хвосту.
 await appendFile(join(f.root,'tmp',f.records.get(id).resumable.tempName),Buffer.from('uncommitted'));
 const next=await (await f.make()).uploadChunk(token,{offset:MB,totalBytes,chain:state.chain},source(a));
 assert.equal(next.offset,2*MB);
 assert.equal((await readFile(join(f.root,'tmp',f.records.get(id).resumable.tempName))).length,2*MB);
}));
test('last saved part without publication intent is finalized on status after restart',()=>fixture(async f=>{
 const core=await f.make(),{id,token}=await prepared(core),a=Buffer.alloc(MB,3);
 const original=f.session.saveArtifact;let stopped=false;
 f.session.saveArtifact=async r=>{if(r.publication&&!stopped){stopped=true;throw Error('process stopped before publication');}return original(r);};
 await assert.rejects(core.uploadChunk(token,{offset:0,totalBytes:MB,chain:zero},source(a)));
 assert.equal(f.records.get(id).resumable.offset,MB);assert.equal(f.records.get(id).publication,undefined);
 f.session.saveArtifact=original;f.advance(3600001);const restored=await f.make();
 assert.equal((await restored.reconcile()).ready,1,"full checkpoint must publish even without a browser and after partial TTL");
 const state=await restored.uploadStatus(token);
 assert.equal(state.ready,true);assert.deepEqual(await readFile(join(f.root,'files',id)),a);
}));
test('stale partial expires explicitly instead of claiming missing bytes',()=>fixture(async f=>{
 const core=await f.make(),{token}=await prepared(core),a=Buffer.alloc(MB,8);
 await core.uploadChunk(token,{offset:0,totalBytes:2*MB,chain:zero},source(a));f.advance(3600001);
 const state=await core.uploadStatus(token);assert.equal(state.offset,0);assert.equal(state.totalBytes,null);
 assert.equal((await core.uploadChunk(token,{offset:0,totalBytes:2*MB,chain:zero},source(a))).offset,MB);
}));
test('HTTP disconnect inside next part, lost acknowledgement, restart and maximum limits',{timeout:15000},()=>fixture(async f=>{
 let core=await f.make(),http;const {id,token}=await prepared(core),a=Buffer.alloc(MB,41),b=Buffer.alloc(MB,42);
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const cfg={dataDir:f.root,httpHost:'127.0.0.1',httpPort:port,maxUploadBytes:10*MB,maxConcurrentUploads:4,requestTimeoutMs:1000,uploadTimeoutMs:1000,receiveTimeoutMs:500};
 const url='http://127.0.0.1:'+port+'/upload/'+token;
 const headers=(offset,previous,total=2*MB)=>({'upload-offset':String(offset),'upload-length':String(total),'upload-chain':previous});
 try{
  http=await startArtifactsHttp(cfg,core,{},{});assert.equal((await fetch(url,{method:'HEAD'})).headers.get('upload-offset'),'0');
  // Успешная часть: подтверждение теряется у клиента; HEAD находит принятую границу.
  await new Promise((resolve,reject)=>{const req=request(url,{method:'PATCH',headers:headers(0,zero)},res=>{assert.equal(res.statusCode,204);res.destroy();resolve();});req.on('error',reject);req.end(a);});
  let status=await fetch(url,{method:'HEAD'});assert.equal(status.headers.get('upload-offset'),String(MB));
  const previous=status.headers.get('upload-chain');
  await new Promise(resolve=>{const req=request(url,{method:'PATCH',headers:headers(MB,previous)});req.on('error',()=>{});req.write(b.subarray(0,200));setTimeout(()=>{req.destroy();resolve();},30);});
  await http.stop();http=undefined;core=await f.make();http=await startArtifactsHttp(cfg,core,{},{});
  status=await fetch(url,{method:'HEAD'});assert.equal(status.headers.get('upload-offset'),String(MB));
  assert.equal((await fetch(url,{method:'PATCH',headers:headers(MB,previous,20*MB),body:b})).status,413);
  assert.equal((await fetch(url,{method:'PATCH',headers:headers(0,zero),body:a})).status,409);
  const final=await fetch(url,{method:'PATCH',headers:headers(MB,previous),body:b});assert.equal(final.status,201);assert.equal(final.headers.get('upload-complete'),'true');
  assert.deepEqual(await readFile(join(f.root,'files',id)),Buffer.concat([a,b]));
  assert.equal((await fetch(url+'wrong',{method:'HEAD'})).status,404);
 }finally{await http?.stop();}
}));

test('missing confirmed bytes are never replaced with a zero-filled prefix',()=>fixture(async f=>{
 const core=await f.make(),{id,token}=await prepared(core),a=Buffer.alloc(MB,21),totalBytes=2*MB;
 const saved=await core.uploadChunk(token,{offset:0,totalBytes,chain:zero},source(a));
 const path=join(f.root,'tmp',f.records.get(id).resumable.tempName);await writeFile(path,'short');
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(core.uploadChunk(token,{offset:MB,totalBytes,chain:saved.chain},source(a)),e=>e.code==='STORAGE_UNAVAILABLE');
 assert.equal((await readFile(path)).toString(),'short');
}));
