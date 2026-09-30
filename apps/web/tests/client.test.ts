// ABOUTME: Проверяет локальный секундомер и долговечный FIFO через HTTP/SSE порты.
// ABOUTME: Задержанные ответы, reload и конфликты не заменяют новые намерения.
import test from "node:test";
import assert from "node:assert/strict";
import { createClient, OUTBOX_KEY, OUTBOX_LIMIT, PENDING_KEY } from "../lib/client.ts";
import { duration } from "../lib/model.ts";
import type { Snapshot, TimerEvent } from "../lib/types.ts";
const snapshot: Snapshot = { active:null,version:0,serverTime:"2026-09-29T00:00:00.000Z",recentCompleted:[],nextCursor:null };
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetcher:(path:string,options?:RequestInit)=>Promise<Response>, storage=new Map<string,string>()) {
 let mono=100,ids=0;
 const streams:{snapshot:(data:Snapshot)=>void;event:(data:TimerEvent)=>void;lost:()=>void}[]=[];
 const client=createClient({now:()=>mono,wall:()=>Date.parse(snapshot.serverTime)+mono-100,id:()=>`91ae2be0-8d8f-4c50-9fd3-${String(++ids).padStart(12,"0")}`,fetch:fetcher,
 storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}},
 stream(s,e,l){streams.push({snapshot:s,event:e,lost:l});return()=>{};}});
 client.start();streams[0].snapshot(snapshot);
 return {client,streams,storage,advance:(ms:number)=>{mono+=ms;},now:()=>mono};
}
const records=(f:ReturnType<typeof fixture>)=>JSON.parse(f.storage.get(OUTBOX_KEY)!).entries;
test("rapid START STOP START STOP remains local while HTTP is buffered; reload preserves four bodies",async()=>{
 let finish:(r:Response)=>void=()=>{};const bodies:string[]=[];
 const f=fixture(async(_path,options)=>options?.method==="POST" ? (bodies.push(options.body as string),new Promise(resolve=>{finish=resolve;})) : Response.json({},{status:404}));
 f.client.command();f.advance(175);f.client.command();assert.equal(duration(f.client.getView(),f.now()),0);
 f.client.command();f.advance(230);f.client.command();assert.equal(duration(f.client.getView(),f.now()),0);
 const original=records(f).map((item:{command:unknown})=>item.command);assert.equal(original.length,4);assert.equal(bodies.length,1);
 f.client.stop();finish(Response.json({},{status:202}));await turn();
 const posted:unknown[]=[];const reloaded=fixture(async(_path,options)=>{if(options?.method==="POST"){posted.push(JSON.parse(options.body as string));return Response.json({},{status:202});}return Response.json({},{status:404});},f.storage);
 await turn();await turn();assert.deepEqual(posted,original.map((command:Record<string,unknown>)=>Object.fromEntries(Object.entries(command).filter(([key])=>key!=="type"))));assert.equal(duration(reloaded.client.getView(),reloaded.now()),0);
 reloaded.client.stop();
});
test("PubAck advances FIFO without owner result and ten NOT_FOUND polls never republish",async t=>{
 t.mock.timers.enable({apis:["setInterval"]});let posts=0;
 const f=fixture(async(_path,options)=>options?.method==="POST" ? (++posts,Response.json({},{status:202})) : Response.json({},{status:404}));
 f.client.command();f.advance(50);f.client.command();f.client.command();await turn();
 assert.equal(posts,3);
 for(let n=0;n<10;n++){t.mock.timers.tick(2000);await turn();}
 assert.equal(posts,3);assert.equal(f.client.getView().queued,3);f.client.stop();
});
test("late STOP, stale snapshot and rejection cannot replace a newer local START",async()=>{
 const f=fixture(async(_path,options)=>options?.method==="POST" ? Response.json({},{status:202}) : Response.json({},{status:404}));
 f.client.command();f.advance(200);f.client.command();f.client.command();await turn();
 const [first,stop,last]=records(f).map((item:{command:Record<string,string>})=>item.command);
 f.streams[0].event({eventId:"start",commandId:first.commandId,version:1,timerId:first.timerId,startedAt:first.startedAt});
 f.streams[0].event({eventId:"stop",commandId:stop.commandId,version:2,interval:{timerId:first.timerId,startedAt:first.startedAt,stoppedAt:stop.stoppedAt,durationMs:200}});
 f.streams[0].snapshot({...snapshot,version:1,active:{timerId:first.timerId,startedAt:first.startedAt}});
 f.streams[0].event({eventId:"reject",commandId:stop.commandId,correlationId:"old",error:{code:"TIMER_NOT_ACTIVE",message:"old",retryable:false}});
 assert.equal(f.client.getView().local?.timerId,last.timerId);assert.equal(f.client.getView().queued,1);
 f.streams[0].event({eventId:"last",commandId:last.commandId,version:3,timerId:last.timerId,startedAt:last.startedAt});
 assert.equal(f.client.getView().queued,0);f.client.stop();
});
test("unknown retry keeps identical body; terminal rejection ends waiting and STOP remains zero",async t=>{
 t.mock.timers.enable({apis:["setInterval"]});const bodies:string[]=[];
 const f=fixture(async(_path,options)=>{if(options?.method==="POST"){bodies.push(options.body as string);return Response.json({outcome:bodies.length===1?"unknown":"not-published"},{status:503});}return Response.json({},{status:404});});
 f.client.command();await turn();t.mock.timers.tick(2000);await turn();assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
 const command=records(f)[0].command;
 f.streams[0].event({eventId:"reject",commandId:command.commandId,correlationId:"wire",error:{code:"TIMER_ALREADY_ACTIVE",message:"conflict",retryable:false}});
 assert.equal(f.client.getView().queued,0);assert.match(f.client.getView().message,/не записано/);
 f.client.command();assert.equal(duration(f.client.getView(),f.now()),0);f.client.stop();
});
test("legacy pending is replayed unchanged and stale stream callbacks stay inert",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});const pending={commandId:"91ae2be0-8d8f-4c50-9fd3-000000000001",type:"stop",timerId:"91ae2be0-8d8f-4c50-9fd3-000000000002",expectedVersion:8};
 const storage=new Map([[PENDING_KEY,JSON.stringify(pending)]]),bodies:unknown[]=[];
 const f=fixture(async(_path,options)=>{if(options?.method==="POST"){bodies.push(JSON.parse(options.body as string));return Response.json({},{status:202});}return Response.json({},{status:404});},storage);
 await turn();assert.deepEqual(bodies,[{commandId:pending.commandId,timerId:pending.timerId,expectedVersion:8}]);
 f.client.resync();f.streams[0].snapshot({...snapshot,version:99});assert.equal(f.client.getView().connected,false);
 t.mock.timers.tick(1000);f.streams[1].snapshot({...snapshot,version:8});f.streams[0].event({eventId:"old",commandId:pending.commandId,version:9,timerId:pending.timerId,startedAt:snapshot.serverTime});assert.equal(f.client.getView().queued,1);
 f.streams[1].event({eventId:"reject",commandId:pending.commandId,correlationId:"wire",error:{code:"TIMER_NOT_ACTIVE",message:"conflict",retryable:false}});assert.equal(f.client.getView().queued,0);f.client.stop();
});
test("queue cap is explicit and older confirmations cannot overwrite the unsaved local action",async()=>{
 const f=fixture(async()=>new Promise(()=>{}));
 for(let n=0;n<OUTBOX_LIMIT+1;n++)f.client.command();
 assert.equal(f.client.getView().queued,OUTBOX_LIMIT);assert.match(f.client.getView().message,/Очередь заполнена/);assert.ok(f.client.getView().local);f.client.stop();
});
test("SSE before delayed response resolves only that entry; dispose aborts in-flight I/O",async()=>{
 let finish:(r:Response)=>void=()=>{}, signal:AbortSignal|undefined;
 const f=fixture(async(_path,options)=>{signal=options?.signal as AbortSignal;return new Promise(resolve=>{finish=resolve;});});
 f.client.command();const command=records(f)[0].command;
 f.streams[0].event({eventId:"done",commandId:command.commandId,version:1,timerId:command.timerId,startedAt:command.startedAt});
 f.client.command();finish(Response.json({},{status:202}));await turn();assert.equal(f.client.getView().queued,1);
 f.client.stop();assert.equal(signal?.aborted,true);
});

test("latest rejection and overflow STOP survive older late success; damaged storage is preserved",async()=>{
 const f=fixture(async()=>new Promise(()=>{}));
 f.client.command();f.client.command();const [first,last]=records(f).map((item:{command:Record<string,string>})=>item.command);
 f.streams[0].event({eventId:"reject",commandId:last.commandId,correlationId:"wire",error:{code:"TIMER_NOT_ACTIVE",message:"conflict",retryable:false}});
 f.streams[0].event({eventId:"old",commandId:first.commandId,version:1,timerId:first.timerId,startedAt:first.startedAt});
 assert.equal(f.client.getView().local,null);assert.equal(f.client.getView().queued,0);f.client.stop();
 const full=fixture(async()=>new Promise(()=>{}));
 for(let n=0;n<OUTBOX_LIMIT+2;n++)full.client.command();
 const queued=records(full).map((item:{command:Record<string,string>})=>item.command);
 for(const command of queued)full.streams[0].event({eventId:command.commandId,commandId:command.commandId,version:1,timerId:command.timerId,startedAt:command.startedAt??snapshot.serverTime});
 assert.equal(full.client.getView().local,null);assert.equal(full.client.getView().queued,0);full.client.stop();
 const original="{accepted-but-damaged",storage=new Map([[OUTBOX_KEY,original]]);
 const broken=fixture(async()=>assert.fail("damaged outbox must not publish"),storage);
 broken.client.command();broken.client.stop();assert.equal(storage.get(OUTBOX_KEY),original);
});
test("failed persistence blocks publication; restored storage sends the same retained body",async t=>{
 t.mock.timers.enable({apis:["setInterval"]});let fail=true,posts=0;
 const data=new Map<string,string>();
 const client=createClient({now:()=>100,wall:()=>Date.parse(snapshot.serverTime),id:()=>"91ae2be0-8d8f-4c50-9fd3-000000000001",storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>{if(fail)throw new Error("storage");data.set(key,value);},removeItem:key=>{data.delete(key);}},stream:()=>()=>{},fetch:async(_path,options)=>{if(options?.method==="POST"){posts++;return Response.json({},{status:202});}return Response.json({},{status:404});}});
 client.start();client.command();await turn();assert.equal(posts,0);assert.ok(client.getView().local);
 fail=false;t.mock.timers.tick(2000);await turn();assert.equal(posts,1);assert.equal(JSON.parse(data.get(OUTBOX_KEY)!).entries.length,1);client.stop();
});

test("pending owner lookup never delays publishing a new intent after PubAck",async t=>{
 t.mock.timers.enable({apis:["setInterval"]});let posts=0,release:(response:Response)=>void=()=>{};
 const f=fixture(async(_path,options)=>options?.method==="POST" ? (++posts,Response.json({},{status:202})) : new Promise(resolve=>{release=resolve;}));
 f.client.command();await turn();t.mock.timers.tick(2000);await turn();
 f.client.command();await turn();assert.equal(posts,2);assert.equal(f.client.getView().local,null);
 release(Response.json({},{status:404}));await turn();f.client.stop();
});

test("running local elapsed survives reload and keeps monotonic STOP timestamp",async()=>{
 const f=fixture(async()=>new Promise(()=>{}));f.client.command();f.advance(200);const body=records(f)[0].command;f.client.stop();
 const reloaded=fixture(async(_path,options)=>options?.method==="POST" ? Response.json({},{status:202}) : Response.json({},{status:404}),f.storage);
 assert.equal(duration(reloaded.client.getView(),reloaded.now()),200);reloaded.advance(50);assert.equal(duration(reloaded.client.getView(),reloaded.now()),250);
 reloaded.client.command();assert.equal(duration(reloaded.client.getView(),reloaded.now()),0);
 const stop=records(reloaded).at(-1).command;assert.equal(Date.parse(stop.stoppedAt)-Date.parse(body.startedAt),250);reloaded.client.stop();
});
