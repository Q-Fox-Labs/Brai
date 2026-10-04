// ABOUTME: Проверяет версии, монотонные часы и сохранение страниц истории.
// ABOUTME: Не зеркалит разметку и не использует внешние сервисы.
import test from "node:test";
import assert from "node:assert/strict";
import { initialView, applySnapshot, applyEvent, duration, formatDuration, mergeIntervals, sumCompleted } from "../lib/model.ts";
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

test("owner total includes unloaded history; fractional seconds and duplicate deliveries accumulate once", () => {
 const rows = Array.from({length:50}, (_,n) => ({...interval,timerId:`recent-${n}`,durationMs:600}));
 let view = applySnapshot(initialView(), {active:{timerId:"active",startedAt:stamp},version:111,serverTime:stamp,totalCompletedMs:33000,recentCompleted:rows,nextCursor:"tail"}, 10);
 assert.equal(view.items.length,50); assert.equal(view.totalCompletedMs,33000);
 const event = {userId:"account-a",eventId:"stop",commandId:"command",version:112,interval:{...interval,timerId:"active",durationMs:600}};
 view = applyEvent(view,event); assert.equal(view.totalCompletedMs,33600);
 view = applyEvent(view,event); assert.equal(view.totalCompletedMs,33600);
 view = applySnapshot(view,{active:null,version:110,serverTime:stamp,totalCompletedMs:1,recentCompleted:[],nextCursor:null},20);
 assert.equal(view.totalCompletedMs,33600);
 view = applySnapshot(view,{active:null,version:112,serverTime:stamp,totalCompletedMs:33600,recentCompleted:[event.interval],nextCursor:"tail"},30);
 assert.equal(view.totalCompletedMs,33600); assert.equal(formatDuration(view.totalCompletedMs!),"00:00:33");
 assert.equal(formatDuration(sumCompleted([{...interval,durationMs:600},{...interval,timerId:"second",durationMs:600}])) ,"00:00:01");
});

test("legacy sum waits for complete history and deduplicates a STOP already read on a page", () => {
 const incomplete = applySnapshot(initialView(), {active:null,version:1,serverTime:stamp,recentCompleted:[interval],nextCursor:"tail"},0);
 assert.equal(incomplete.totalCompletedMs,null);
 const complete = applySnapshot({...incomplete,items:[interval,{...interval,timerId:"second",durationMs:200}],cursor:null,paged:true},
  {active:null,version:1,serverTime:stamp,recentCompleted:[interval],nextCursor:"tail"},0);
 assert.equal(complete.totalCompletedMs,1200);
 const next = applyEvent(complete,{userId:"account-a",eventId:"stop",commandId:"command",version:2,interval:{...interval,timerId:"second",durationMs:200}});
 assert.equal(next.totalCompletedMs,1200);
 assert.equal(sumCompleted([interval,interval]),1000);
});
