// ABOUTME: Проверяет reconnect readiness и ограниченную остановку HTTP adapter.
// ABOUTME: Использует локальные doubles, не запускает PostgreSQL/NATS или core.
import test,{mock} from "node:test";
import assert from "node:assert/strict";
import {Socket,createServer as createNetServer} from "node:net";
import {mkdir,mkdtemp,rm,writeFile,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import fsPromises from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import {loadArtifactsConfig} from "../dist/config.js";
import {artifactsReadiness} from "../dist/health.js";
import {startArtifactsHttp} from "../dist/http.js";

async function fixture(){const dataDir=await mkdtemp(join(tmpdir(),"artifacts-transport-unit-"));await mkdir(join(dataDir,"files"));await mkdir(join(dataDir,"tmp"));const probe=createNetServer();const port=await new Promise((resolve,reject)=>{probe.once("error",reject);probe.listen(0,"127.0.0.1",()=>{const value=probe.address().port;probe.close(()=>resolve(value));});});const cfg=loadArtifactsConfig({ARTIFACTS_DATABASE_URL:"postgres://localhost/artifacts",NATS_URL:"nats://127.0.0.1:4222",ARTIFACTS_DATA_DIR:dataDir,ARTIFACTS_UPLOAD_BASE_URL:`http://127.0.0.1:${port}`,ARTIFACTS_INTERNAL_BASE_URL:"http://internal",ARTIFACTS_HTTP_HOST:"127.0.0.1",ARTIFACTS_HTTP_PORT:String(port),ARTIFACTS_REQUEST_TIMEOUT_MS:"100"});return {cfg,dataDir};}

test("readiness does not call a disconnected NATS connection ready while flush is unresolved",async()=>{
 const {cfg,dataDir}=await fixture();try{const pool={query:async()=>({rows:[]})};const nc={isClosed:()=>false,isDraining:()=>false,flush:()=>new Promise(()=>{})};const started=Date.now();assert.deepEqual(await artifactsReadiness(pool,nc,dataDir),{status:"not-ready"});assert.ok(Date.now()-started<1500,"NATS readiness flush must be bounded");}finally{await rm(dataDir,{recursive:true,force:true});}
});

test("HTTP stop closes an accepted socket that never sends a request",async()=>{
 const {cfg,dataDir}=await fixture();cfg.requestTimeoutMs=100;let http,socket;try{http=await startArtifactsHttp(cfg,{}, {}, {});socket=new Socket();await new Promise((resolve,reject)=>{socket.once("error",reject);socket.connect(cfg.httpPort,cfg.httpHost,resolve);});const started=Date.now();await http.stop();assert.ok(Date.now()-started<1800,"HTTP shutdown must not wait forever for an idle peer");await Promise.race([new Promise(resolve=>socket.once("close",resolve)),new Promise(resolve=>setTimeout(resolve,100))]);assert.equal(socket.destroyed,true);}finally{socket?.destroy();await http?.stop().catch(()=>{});await rm(dataDir,{recursive:true,force:true});}
});

test("readiness requires both storage directories and their actual read/write/traverse permissions",async()=>{
 const {dataDir}=await fixture(),pool={query:async()=>({rows:[]})},nc={isClosed:()=>false,isDraining:()=>false,flush:async()=>{}};
 try{
  assert.deepEqual(await artifactsReadiness(pool,nc,dataDir),{status:"ready"});
  for(const name of ["files","tmp"]){const path=join(dataDir,name);await rm(path,{recursive:true});await writeFile(path,"regular file");assert.deepEqual(await artifactsReadiness(pool,nc,dataDir),{status:"not-ready"});await rm(path);await mkdir(path);
   if(process.getuid?.()!==0){for(const mode of [0o500,0o300,0o600]){await chmod(path,mode);assert.deepEqual(await artifactsReadiness(pool,nc,dataDir),{status:"not-ready"},name+" mode "+mode.toString(8));}await chmod(path,0o700);}
  }
  assert.deepEqual(await artifactsReadiness(pool,nc,dataDir),{status:"ready"});
  assert.deepEqual(await artifactsReadiness({query:async()=>{throw new Error("DB unavailable");}},nc,dataDir),{status:"not-ready"});assert.deepEqual(await artifactsReadiness(pool,{...nc,isClosed:()=>true},dataDir),{status:"not-ready"});
 }finally{for(const name of ["files","tmp"])await chmod(join(dataDir,name),0o700).catch(()=>{});await rm(dataDir,{recursive:true,force:true});}
});

test("sharing HEAD deadline covers delayed file open and releases the late descriptor",async()=>{
 const {cfg,dataDir}=await fixture();cfg.externalBaseURL="http://share";cfg.requestTimeoutMs=40;const artifactId="11111111-1111-4111-8111-111111111111";await writeFile(join(dataDir,"files",artifactId),"bytes");
 let http,release,opened,closed=false;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{opened=resolve;}),originalOpen=fsPromises.open;
 try{
  http=await startArtifactsHttp(cfg,{shared:async()=>({artifactId})},{},{});
  mock.method(fsPromises,"open",async(...args)=>{opened();await gate;const handle=await originalOpen(...args),close=handle.close.bind(handle);handle.close=async()=>{closed=true;return close();};return handle;});syncBuiltinESMExports();
  const request=fetch(`http://127.0.0.1:${cfg.httpPort}/share/${"a".repeat(32)}`,{method:"HEAD"});await started;
  const deadline=setTimeout(release,200);const response=await request;clearTimeout(deadline);assert.equal(response.status,503,"must not serve a file after the request deadline");assert.equal(await response.text(),"");
  release();for(let n=0;n<50&&!closed;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,true,"late open must be closed even after the HTTP response");
 }finally{release?.();mock.restoreAll();syncBuiltinESMExports();await http?.stop();await rm(dataDir,{recursive:true,force:true});}
});
