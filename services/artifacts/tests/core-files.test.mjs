// ABOUTME: Проверяет реальные потоковые FS операции artifacts.
// ABOUTME: Использует собственные временные директории и не касается пользовательских файлов.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {getEventListeners} from "node:events";
import {createFileStore} from "../dist/files.js";
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),"artifacts-fs-"));try{await fn(await createFileStore(root),root);}finally{await rm(root,{recursive:true,force:true});}}
test("FS empty and small files publish immutable IDs with exact bytes",()=>fixture(async(files,root)=>{
  for(const value of [Buffer.alloc(0),Buffer.from("image/document/audio/video")]){const id=randomUUID(),p=await files.write(id,(async function*(){yield value;})(),1024);assert.equal(p.sizeBytes,value.length);assert.equal(p.sha256,createHash("sha256").update(value).digest("hex"));assert.equal(await files.inspect(id),undefined);await files.publish(id,p);assert.deepEqual(await readFile(join(root,"files",id)),value);assert.deepEqual(await files.inspect(id),{sizeBytes:p.sizeBytes,sha256:p.sha256});const duplicate=await files.write(id,(async function*(){yield Buffer.from("different");})(),1024);await assert.rejects(files.publish(id,duplicate),e=>e.code==="CONFLICT");assert.deepEqual(await readFile(join(root,"files",id)),value);await files.removeTemp(duplicate.tempName);await files.remove(id);await files.remove(id);assert.equal(await files.inspect(id),undefined);}
}));
test("limit and stream interruption remove temporary bytes",()=>fixture(async(files,root)=>{
  await assert.rejects(files.write(randomUUID(),(async function*(){yield Buffer.alloc(100);})(),99),e=>e.code==="PAYLOAD_TOO_LARGE");
  await assert.rejects(files.write(randomUUID(),(async function*(){yield Buffer.from("partial");throw new Error("stream broken");})(),100),e=>e.code==="STORAGE_UNAVAILABLE");assert.deepEqual(await readdir(join(root,"tmp")),[]);assert.deepEqual(await readdir(join(root,"files")),[]);
}));
test("abort stalled producer rejects promptly and releases temp/listeners",()=>fixture(async(files,root)=>{
  const controller=new AbortController();let returning=false;let nextStarted;
  const started=new Promise(resolve=>{nextStarted=resolve;});
  const source={[Symbol.asyncIterator](){return {next(){nextStarted();return new Promise(()=>{});},async return(){returning=true;return {done:true};}};}};
  const write=files.write(randomUUID(),source,1024,controller.signal);await started;controller.abort();await assert.rejects(Promise.race([write,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("abort did not finish")),1000);timer.unref();})]));assert.equal(returning,true);assert.equal(getEventListeners(controller.signal,"abort").length,0);assert.deepEqual(await readdir(join(root,"tmp")),[]);
}));
test("many packets respect backpressure and cancellation listeners remain bounded",()=>fixture(async(files,root)=>{
  const controller=new AbortController();let generated=0,maxListeners=0;
  const source=(async function*(){for(let n=0;n<10000;n++){generated++;maxListeners=Math.max(maxListeners,getEventListeners(controller.signal,"abort").length);yield Buffer.from([n%256]);}})();
  const p=await files.write(randomUUID(),source,10000,controller.signal);assert.equal(generated,10000);assert.equal(p.sizeBytes,10000);assert.ok(maxListeners<=1);assert.equal(getEventListeners(controller.signal,"abort").length,0);await files.removeTemp(p.tempName);
  await writeFile(join(root,"tmp","foreign.tmp"),"keep");await assert.rejects(files.removeTemp("../../foreign.tmp"),e=>e.code==="INVALID_ARGUMENT");assert.deepEqual(await readdir(join(root,"tmp")),["foreign.tmp"]);
}));

test("synchronous next fault releases cancellation listener and temporary file",()=>fixture(async(files,root)=>{
  const controller=new AbortController(),source={[Symbol.asyncIterator](){return {next(){throw new Error("sync source fault");},return(){throw new Error("faulty cleanup");}};}};
  await assert.rejects(files.write(randomUUID(),source,1024,controller.signal),e=>e.code==="STORAGE_UNAVAILABLE");assert.equal(getEventListeners(controller.signal,"abort").length,0);assert.deepEqual(await readdir(join(root,"tmp")),[]);
}));
