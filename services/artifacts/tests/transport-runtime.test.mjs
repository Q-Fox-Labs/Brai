// ABOUTME: Проверяет reconnect readiness и ограниченную остановку HTTP adapter.
// ABOUTME: Использует локальные doubles, не запускает PostgreSQL/NATS или core.
import test from "node:test";
import assert from "node:assert/strict";
import {Socket,createServer as createNetServer} from "node:net";
import {mkdir,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
