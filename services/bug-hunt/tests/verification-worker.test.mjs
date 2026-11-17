// ABOUTME: Проверяет readiness и локальный lifecycle worker с управляемыми SQL/NATS/Temporal портами.
// ABOUTME: Проверки не подключаются к серверам и не создают model или runner effects.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,existsSync,statSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {startVerificationWorker,verificationRuntime} from "../dist/verification-worker.js";
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{fail,changeConfig=false,unknown=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),"bug-hunt-worker-test-")),file=path.join(root,".worker-ready.json"),configFile=path.join(root,"config.json");
 const bytes=Buffer.from('{\n "fixture": true\n}\n');writeFileSync(configFile,bytes,{mode:0o600});writeFileSync(file,'{"pid":-1}',{mode:0o600});
 const old=process.env.BRAI_BUG_HUNT_CONFIG;process.env.BRAI_BUG_HUNT_CONFIG=configFile;
 t.after(()=>{if(old===undefined)delete process.env.BRAI_BUG_HUNT_CONFIG;else process.env.BRAI_BUG_HUNT_CONFIG=old;rmSync(root,{recursive:true,force:true});});
 const events=[],activities={};let state="INITIALIZED",finish,flight,stopping=false,advances=0;
 const running=new Promise(resolve=>finish=resolve),held=new Promise(resolve=>flight=resolve);
 const event=name=>{events.push(name);if(name!=="tick")assert.equal(existsSync(file),false,"marker must be absent during "+name);if(fail===name)throw Error("synthetic dependency failure");};
 const worker={run(){event("run");state=fail==="state"?"FAILED":"RUNNING";if(changeConfig)writeFileSync(configFile,'{"changed":true}',{mode:0o600});if(fail==="state")return Promise.reject(Error("run rejected"));return running;},getState:()=>state,shutdown(){event("shutdown");state="STOPPED";finish();}};
 const deps={Pool:class{async query(sql){assert.equal(sql,"SELECT 1");event("sql");return {rows:[{"?column?":1}]};}async end(){event("pool-close");}},connectNats:async()=>{event("nats");return {close:async()=>event("nats-close")};},createVerificationStore:()=>({tick:async()=>events.push("tick"),pending:async()=>[]}),createVerificationEngine:()=>({async advance(){advances++;return stopping?{terminal:false,wait_ms:60000,code:"WORKER_STOP_UNKNOWN"}:held;},async requestStopOwned(){event("stop-owned");stopping=true;flight({terminal:false,wait_ms:1,code:"WORKER_STOPPING"});return {ids:unknown?["own"]:[],unknown:false};}}),NativeConnection:{connect:async()=>{event("temporal-native");return {close:async()=>event("native-close")};}},Connection:{connect:async()=>{event("temporal-control");return {close:async()=>event("control-close")};}},Client:class{},Worker:{create:async options=>{event("create");Object.assign(activities,options.activities);return worker;}}};
 const infra={temporal:{address:"fake",namespace:"fake",taskQueue:"bug-hunt-test",identity:"bug-hunt-test"},runnerSocket:"/fake/runner.sock",sources:[],recipes:[],nativeProfiles:{},readinessFile:file};
 const cfg={verificationRuntime:infra,databaseURL:"fake",installationId:"test",cursorKey:"x".repeat(32),maxDatabaseBytes:16777216};
 return {file,root,configFile,bytes,cfg,deps,events,activities,exit(){state="STOPPED";finish();},get advances(){return advances;}};
}
test("runtime readiness path is optional operator input and rejects non-absolute values",()=>{
 const base={temporal:{address:"fake",namespace:"fake",taskQueue:"bug-hunt-test",identity:"bug-hunt-test"},runnerSocket:"/runner.sock",sources:[],recipes:[],nativeProfiles:{}};
 assert.equal(verificationRuntime(base),base);assert.equal(verificationRuntime({...base,readinessFile:"/private/ready.json"}).readinessFile,"/private/ready.json");
 for(const readinessFile of [null,1,"","relative/ready.json"])assert.throws(()=>verificationRuntime({...base,readinessFile}),/UNPREPARED/);
});
test("disabled dispatch publishes marker only after SQL, NATS and running Temporal, removes it before drain",async t=>{
 const f=fixture(t),runtime=await startVerificationWorker(f.cfg,f.deps);const value=JSON.parse(readFileSync(f.file,"utf8"));
 assert.deepEqual(Object.keys(value).sort(),["configSha256","pid","startedAt","version"]);assert.equal(value.version,1);assert.equal(value.pid,process.pid);assert.equal(value.configSha256,createHash("sha256").update(f.bytes).digest("hex"));assert.ok(Number.isFinite(Date.parse(value.startedAt)));assert.equal(statSync(f.file).mode&0o777,0o600);assert.equal(f.advances,0);
 assert.deepEqual(f.events.slice(0,6),["sql","nats","temporal-native","temporal-control","create","run"]);assert.equal(readdirSync(f.root).some(name=>name.endsWith(".tmp")),false);
 const stop=runtime.stop();assert.equal(runtime.stop(),stop);await stop;assert.equal(existsSync(f.file),false);assert.ok(f.events.includes("stop-owned"));assert.ok(f.events.includes("shutdown"));for(const name of ["pool-close","nats-close","native-close","control-close"])assert.ok(f.events.includes(name));
});
test("partial dependency failure never leaves readiness and closes each acquired dependency",async t=>{
 for(const fail of ["sql","nats","temporal-native","temporal-control","create","state"]){await t.test(fail,async child=>{const f=fixture(child,{fail});await assert.rejects(startVerificationWorker(f.cfg,f.deps));assert.equal(existsSync(f.file),false);assert.ok(f.events.includes("pool-close"));if(!["sql","nats"].includes(fail))assert.ok(f.events.includes("nats-close"));if(["temporal-control","create","state"].includes(fail))assert.ok(f.events.includes("native-close"));if(["create","state"].includes(fail))assert.ok(f.events.includes("control-close"));});}
});
test("config replacement during dependency startup fails closed and drains the started worker",async t=>{
 const f=fixture(t,{changeConfig:true});await assert.rejects(startVerificationWorker(f.cfg,f.deps),/VERIFICATION_CONFIG_CHANGED/);assert.equal(existsSync(f.file),false);assert.ok(f.events.includes("shutdown"));assert.ok(f.events.includes("pool-close"));
});
test("saved unknown model stop completes local drain without waiting for remote terminal",{timeout:3000},async t=>{
 const f=fixture(t,{unknown:true}),runtime=await startVerificationWorker(f.cfg,f.deps);
 await assert.rejects(runtime.stop(),/VERIFICATION_STOP_UNKNOWN/);assert.equal(f.advances,1);assert.equal(existsSync(f.file),false);for(const name of ["pool-close","nats-close","native-close","control-close"])assert.ok(f.events.includes(name));await flush();
});

test("unexpected normal poller exit removes readiness and closes local dependencies",async t=>{
 const f=fixture(t),runtime=await startVerificationWorker(f.cfg,f.deps);f.exit();await runtime.running;await flush();await runtime.stop();assert.equal(existsSync(f.file),false);assert.ok(f.events.includes("pool-close"));
});
