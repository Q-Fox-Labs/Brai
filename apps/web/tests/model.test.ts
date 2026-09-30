// ABOUTME: Проверяет версии, монотонные часы и сохранение страниц истории.
// ABOUTME: Не зеркалит разметку и не использует внешние сервисы.
import test from "node:test";
import assert from "node:assert/strict";
import { initialView, applySnapshot, applyEvent, duration, formatDuration, mergeIntervals } from "../lib/model.ts";
const stamp = "2026-09-29T00:00:00.000Z";
const interval = { timerId: "old", startedAt: stamp, stoppedAt: stamp, durationMs: 1000 };
test("local clock is monotonic >24h; STOP is zero and late owner data is separate", () => {
 const view = { ...initialView(), local: {timerId:"local", startedAt:stamp}, localElapsed:90000000, localMono:100 };
 assert.equal(formatDuration(duration(view,2100)),"25:00:02");
 const oldNow=Date.now;Date.now=()=>0;
 try { assert.equal(formatDuration(duration(view,3100)),"25:00:03"); } finally {Date.now=oldNow;}
 const stopped={...view,local:null};
 assert.equal(duration(applySnapshot(stopped,{active:{timerId:"old",startedAt:stamp},version:1,serverTime:stamp,recentCompleted:[],nextCursor:null},10),900000),0);
});
test("stale snapshot cannot reverse confirmed version; gap requires resync", () => {
 const view={...initialView(),version:4,connected:true};
 assert.equal(applySnapshot(view,{active:{timerId:"old",startedAt:stamp},version:1,serverTime:stamp,recentCompleted:[],nextCursor:null},10).active,null);
 assert.equal(applyEvent(view,{userId: "account-a",eventId:"gap",commandId:"x",version:6,timerId:"x",startedAt:stamp}).connected,false);
});
test("snapshot/live dedup retain old loaded pages and owner cursor", () => {
 const view = { ...initialView(), items: [interval], paged: true, cursor: "owner-tail" };
 const next = applySnapshot(view, { active: null, version: 8, serverTime: stamp, recentCompleted: [{ ...interval, timerId: "new", startedAt: "2026-09-30T00:00:00.000Z" }, interval], nextCursor: "owner-first" }, 10);
 assert.deepEqual(next.items.map(x => x.timerId), ["new", "old"]); assert.equal(next.cursor, "owner-tail");
 assert.equal(mergeIntervals(next.items, [interval]).length, 2);
});

test("resnapshot without overlap restarts paging at owner boundary and retains loaded rows", () => {
 const view = { ...initialView(), items: [interval], paged: true, cursor: "old-tail" };
 const recentCompleted = Array.from({length:50}, (_,n) => ({...interval,timerId:`new-${n}`,startedAt:`2026-09-30T00:00:${String(n).padStart(2,"0")}.000Z`}));
 const next = applySnapshot(view,{active:null,version:120,serverTime:stamp,recentCompleted,nextCursor:"fresh-boundary"},10);
 assert.equal(next.items.length,51);assert.equal(next.cursor,"fresh-boundary");assert.equal(next.paged,false);
 assert.ok(next.items.some(item=>item.timerId==='old'));
});
