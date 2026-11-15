// ABOUTME: Проверяет владение долгим engine между start/status Activities.
// ABOUTME: Потеря ответа, продвижение часов и остановка не повторяют модельный запуск.
import test from "node:test";
import assert from "node:assert/strict";
import {verificationProcess,shutdownVerification} from "../dist/verification-process.js";
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test("status calls and four elapsed hours keep one process-owned execution alive",async t=>{
 let resolve,calls=0;const owned=new Promise(r=>resolve=r),result={terminal:false,wait_ms:1,code:"REVIEW_PENDING"};
 const process=verificationProcess({advance:async()=>{calls++;return owned;},requestStopOwned:async()=>{throw Error("not stopping");}});
 assert.equal((await process.advance("own")).code,"ENGINE_PENDING");await flush();assert.equal(calls,1);
 const initial=Date.now();t.mock.method(Date,"now",()=>initial+4*60*60*1000);
 for(let n=0;n<400;n++)assert.equal((await process.advance("own")).code,"ENGINE_PENDING");
 assert.equal((await process.advance("other")).code,"BUSY");assert.equal(calls,1);
 resolve(result);await flush();assert.deepEqual(await process.advance("own"),result);assert.equal(calls,1);
});
test("stop is idempotent, records obligation before cleanup and admits no other work",async()=>{
 const events=[];let resolve,calls=0;const current=new Promise(r=>resolve=r);
 const process=verificationProcess({advance:async id=>{events.push("advance:"+id);calls++;if(calls===1)return current;return {terminal:true,wait_ms:0,code:"WORKER_STOPPED"};},requestStopOwned:async()=>{events.push("stop:own");resolve({terminal:false,wait_ms:1,code:"WORKER_STOPPING"});return {ids:["own"],unknown:false};}});
 await process.advance("own");await flush();
 const stop=process.stop();assert.equal(process.stop(),stop);assert.equal(process.stopping,true);
 assert.equal((await process.advance("other")).code,"WORKER_STOPPING");
 await stop;assert.deepEqual(events,["advance:own","stop:own","advance:own"]);assert.equal(calls,2);
});
test("metadata failure does not turn a worker exception into a defect verdict or blind replay",async()=>{
 let calls=0;const process=verificationProcess({advance:async()=>{calls++;throw Error("private detail");},requestStopOwned:async()=>({ids:[],unknown:false})});
 await process.advance("own");await flush();
 const result=await process.advance("own");assert.equal(result.code,"ENGINE_UNAVAILABLE");assert.equal(result.terminal,false);
 assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes("private"));
});

test("a BUSY engine response grants no remembered ID permission to stop another owner",async()=>{
 let calls=0;const process=verificationProcess({advance:async()=>{calls++;return {terminal:false,wait_ms:1,code:"BUSY"};},requestStopOwned:async()=>({ids:[],unknown:false})});
 await process.advance("foreign-held");await flush();assert.equal((await process.advance("foreign-held")).code,"BUSY");
 await process.stop();assert.equal(calls,1);
});
test("shutdown reconciles every actually owned unresolved investigation across completed passes",async()=>{
 const calls=[];let stopping=false;
 const process=verificationProcess({advance:async id=>{calls.push(id);return {terminal:false,wait_ms:1,code:stopping?"WORKER_STOPPED":"REVIEW_PENDING"};},requestStopOwned:async()=>{stopping=true;return {ids:["a","b"],unknown:false};}});
 await process.advance("a");await flush();await process.advance("a");
 await process.advance("b");await flush();await process.advance("b");
 await process.stop();assert.deepEqual(calls,["a","b","a","b"]);
});
test("failed execution cleanup closes every transport independently and reports unknown",async()=>{
 const closed=[];
 await assert.rejects(shutdownVerification(Promise.resolve(),Promise.reject(Error("cleanup failed")),[
  async()=>{closed.push("nats");throw Error("close failed");},async()=>{closed.push("pg");},async()=>{closed.push("native");},async()=>{closed.push("control");}
 ]),e=>e.message==="VERIFICATION_STOP_UNKNOWN");
 assert.deepEqual(closed,["nats","pg","native","control"]);
});

test("cleanup is sequential and continues after one failure without exhausting the production SQL pool",async()=>{
 let active=0,peak=0;const calls=[];
 const process=verificationProcess({requestStopOwned:async()=>({ids:["a","b","c"],unknown:false}),advance:async id=>{
  calls.push(id);peak=Math.max(peak,++active);await flush();active--;
  if(id==="b")throw Error("synthetic failure");return {terminal:false,wait_ms:1,code:"WORKER_STOPPED"};
 }});
 await assert.rejects(process.stop(),e=>e.message==="VERIFICATION_STOP_UNKNOWN");
 assert.deepEqual(calls,["a","b","c"]);assert.equal(peak,1);
});
