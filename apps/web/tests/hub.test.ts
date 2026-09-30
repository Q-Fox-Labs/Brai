// ABOUTME: Проверяет bootstrap race, bounded slow-client и восстановление SSE.
// ABOUTME: Fake snapshot port исключает зависимость от конкретного брокера.
import test from "node:test";
import assert from "node:assert/strict";
import { Hub, eventStream, MAX_QUEUE, MAX_CLIENTS } from "../server/hub.ts";
import type { Snapshot, TimerEvent } from "../lib/types.ts";
const snapshot: Snapshot = { active: null, version: 0, serverTime: "2026-09-29T00:00:00.000Z", recentCompleted: [], nextCursor: null };
const event = (version: number): TimerEvent => ({ userId: "account-a", eventId: String(version), commandId: String(version), version, timerId: String(version), startedAt: snapshot.serverTime });
const turn = () => new Promise(resolve => setImmediate(resolve));
test("attaches before snapshot, buffers race, dedups eventId, closes on version gap", async () => {
 const hub = new Hub(); let finish: (s: Snapshot) => void = () => {};
 const stream = eventStream(hub, () => new Promise(resolve => { finish = resolve; }), new AbortController().signal, "account-a", "session-a", async () => true);
 const reader = stream.getReader(); hub.broadcast(event(1)); finish(snapshot); await turn();
 const decode = new TextDecoder(); assert.match(decode.decode((await reader.read()).value), /event: snapshot/);
 assert.match(decode.decode((await reader.read()).value), /event: change/);
 hub.broadcast(event(1)); hub.broadcast(event(3)); assert.equal((await reader.read()).done, true);
});
test("bootstrap and transport queues close bounded slow clients; fast client proceeds", async () => {
 const hub = new Hub();
 const bootstrap = eventStream(hub, () => new Promise(() => {}), new AbortController().signal, "account-a", "session-a", async () => true);
 for (let n=1; n<=MAX_QUEUE+1; n++) hub.broadcast(event(n));
 assert.equal((await bootstrap.getReader().read()).done, true);
 const slow = eventStream(hub, async () => snapshot, new AbortController().signal, "account-a", "session-a", async () => true);
 await turn();
 for (let n=1000; n<1000+MAX_QUEUE+2; n++) hub.broadcast({ ...event(n), version: 0 });
 const reader = slow.getReader(); let frames = 0;
 while (!(await reader.read()).done) frames++;
 assert.ok(frames <= 1);
 let seen = 0; const detach = hub.attach("account-a", "session-a", () => seen++, () => {}); hub.broadcast(event(3000)); assert.equal(seen, 1); detach();
});
test("disconnect closes subscriptions and subscriber count is bounded", async () => {
 const hub = new Hub(); const stream = eventStream(hub, async () => snapshot, new AbortController().signal, "account-a", "session-a", async () => true);
 await turn(); hub.disconnect(); const reader = stream.getReader(); await reader.read(); assert.equal((await reader.read()).done, true);
 const release = Array.from({length: MAX_CLIENTS}, () => hub.attach("account-a", "session-a", () => {}, () => {}));
 assert.throws(() => hub.attach("account-a", "session-a", () => {}, () => {}), /CLIENT_LIMIT/); release.forEach(fn => fn());
});

test("hub filters owner and stops every frame after session invalidation", async () => {
 const hub=new Hub();let valid=true;
 const stream=eventStream(hub,async()=>snapshot,new AbortController().signal,"account-a","session-a",async()=>valid);
 const reader=stream.getReader();await reader.read();
 hub.broadcast({...event(1),userId:"account-b"});hub.broadcast(event(1));
 assert.match(new TextDecoder().decode((await reader.read()).value), /account-a/);
 valid=false;hub.broadcast(event(2));assert.equal((await reader.read()).done,true);
 const another=eventStream(hub,async()=>snapshot,new AbortController().signal,"account-a","session-a",async()=>true);
 const other=another.getReader();await other.read();hub.invalidate("session-a");assert.equal((await other.read()).done,true);
});
