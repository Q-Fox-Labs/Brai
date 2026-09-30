// ABOUTME: Проверяет pending I/O, отправку после PubAck и lifecycle generation.
// ABOUTME: Fake HTTP/SSE порты наблюдают body, гонки и число повторов без реального сервиса.
import test from "node:test";
import assert from "node:assert/strict";
import { createClient, PENDING_KEY } from "../lib/client.ts";
import type { Snapshot, TimerEvent } from "../lib/types.ts";
const id = "91ae2be0-8d8f-4c50-9fd3-80b516b69a01";
const snapshot: Snapshot = { active: null, version: 0, serverTime: "2026-09-29T00:00:00.000Z", recentCompleted: [], nextCursor: null };
const done: TimerEvent = { eventId: id, commandId: id, version: 1, timerId: id, startedAt: snapshot.serverTime };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetcher: (path: string, options?: RequestInit) => Promise<Response>, saved?: string) {
 const storage = new Map<string,string>(); if (saved) storage.set(PENDING_KEY, saved);
 const streams: { snapshot: (data: Snapshot) => void; event: (data: TimerEvent) => void; lost: () => void }[] = [];
 let ids = 0;
 const client = createClient({ now: () => 100, id: () => ++ids === 1 ? id : "91ae2be0-8d8f-4c50-9fd3-80b516b69a02", fetch: fetcher,
 storage: { getItem: key => storage.get(key) ?? null, setItem: (key,value) => { storage.set(key,value); }, removeItem: key => { storage.delete(key); } },
 stream(s,e,l) { streams.push({snapshot:s,event:e,lost:l}); return () => {}; } });
 client.start(); streams[0].snapshot(snapshot); return {client,streams,storage};
}
test("PubAck stops republishing for ten polls; immediate button presses issue one command", async t => {
 t.mock.timers.enable({ apis: ["setInterval"] }); let posts = 0;
 const f = fixture(async (path, options) => { if(options?.method === "POST") { posts++; return Response.json({}, {status:202}); } return Response.json({}, {status:404}); });
 f.client.command(); f.client.command(); await turn();
 for(let n=0;n<10;n++) { t.mock.timers.tick(2000); await turn(); }
 assert.equal(posts,1); assert.ok(f.client.getView().pending); f.client.stop();
});
test("definitive first failure clears pending; unknown then definitive retry does not", async t => {
 t.mock.timers.enable({apis:["setInterval"]}); let posts=0;
 const f = fixture(async (_path,options) => options?.method === "POST" ? Response.json({outcome: ++posts === 1 ? "unknown" : "not-published"},{status:503}) : Response.json({}, {status:404}));
 f.client.command(); await turn(); t.mock.timers.tick(2000); await turn();
 assert.equal(posts,2); assert.ok(f.client.getView().pending); f.client.stop();
 const first = fixture(async () => Response.json({outcome:"not-published"},{status:503}));
 first.client.command(); await turn(); assert.equal(first.client.getView().pending,null); assert.equal(first.storage.size,0); first.client.stop();
});
test("SSE before 202 resolves pending permanently and persists before POST", async () => {
 let finish: (r: Response) => void = () => {}; let persisted = false;
 const f = fixture(async () => { persisted = f.storage.has(PENDING_KEY); return new Promise(resolve => { finish = resolve; }); });
 f.client.command(); f.streams[0].event(done); finish(Response.json({}, {status:202})); await turn();
 assert.ok(persisted); assert.equal(f.client.getView().pending,null); assert.equal(f.storage.size,0); f.client.stop();
});
test("reload retries exactly saved body/id; rejection has no version; stale stream cannot unlock", async t => {
 t.mock.timers.enable({apis:["setTimeout"]}); const pending = { commandId:id,type:"stop",expectedVersion:8,timerId:id };
 const bodies: unknown[] = [];
 const f = fixture(async (_path,options) => { if(options?.method === "POST") { bodies.push(JSON.parse(options.body as string)); return Response.json({}, {status:202}); } return Response.json({}, {status:404}); }, JSON.stringify(pending));
 await turn(); assert.deepEqual(bodies,[{commandId:id,expectedVersion:8,timerId:id}]);
 f.client.resync(); f.streams[0].snapshot({...snapshot,version:99}); assert.equal(f.client.getView().connected,false);
 t.mock.timers.tick(1000); f.streams[1].snapshot({...snapshot,version:8});
 f.streams[0].event(done); assert.ok(f.client.getView().pending);
 f.streams[1].event({eventId:"reject",commandId:id,correlationId:"wire",error:{code:"VERSION_CONFLICT",message:"conflict",retryable:false}});
 assert.equal(f.client.getView().pending,null); f.client.stop();
});

test("poll does not retry an in-flight POST", async t => {
 t.mock.timers.enable({apis:["setInterval"]}); let posts = 0, lookups = 0;
 let finish: (response: Response) => void = () => {};
 const f = fixture(async (_path,options) => { if(options?.method === "POST") { posts++; return new Promise(resolve => {finish = resolve;}); }
 lookups++; return Response.json({}, {status:404}); });
 f.client.command(); t.mock.timers.tick(2000); await turn();
 assert.equal(posts,1); assert.equal(lookups,0); assert.ok(f.client.getView().pending);
 finish(Response.json({}, {status:202})); await turn(); f.client.stop();
});
test("late failure JSON cannot clear a newer pending command", async () => {
 let finish: (body: {outcome:string}) => void = () => {}; let posts = 0;
 const f = fixture(async (_path, options) => { if (options?.method === "POST" && ++posts === 1)
 return {status:503,json:() => new Promise(resolve => {finish = resolve;})} as Response;
 return Response.json({}, {status:202}); });
 f.client.command(); await turn(); f.streams[0].event(done); f.client.command();
 const newer = f.client.getView().pending; assert.notEqual(newer?.commandId,id);
 finish({outcome:"not-published"}); await turn(); assert.equal(f.client.getView().pending?.commandId,newer?.commandId); f.client.stop();
});
