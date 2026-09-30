// ABOUTME: Проверяет версии, монотонные часы и сохранение страниц истории.
// ABOUTME: Не зеркалит разметку и не использует внешние сервисы.
import test from "node:test";
import assert from "node:assert/strict";
import { initialView, applySnapshot, applyEvent, duration, formatDuration, mergeIntervals } from "../lib/model.ts";
const stamp = "2026-09-29T00:00:00.000Z";
const interval = { timerId: "old", startedAt: stamp, stoppedAt: stamp, durationMs: 1000 };
/** Проверяет больше суток и независимость от Date.now. */
test("clock is monotonic and supports >24h; start resets; stop keeps result", () => {
 const view = applySnapshot(initialView(), { active: { timerId: "active", startedAt: stamp }, version: 1,
 serverTime: "2026-09-30T01:00:00.000Z", recentCompleted: [], nextCursor: null }, 100);
 assert.equal(formatDuration(duration(view, 2100)), "25:00:02");
 const oldNow = Date.now; Date.now = () => 0;
 try { assert.equal(formatDuration(duration(view, 3100)), "25:00:03"); } finally { Date.now = oldNow; }
 const stopped = applyEvent(view, { eventId: "stop", commandId: "cmd", version: 2, interval: { ...interval, timerId: "active", durationMs: 90003000 } });
 assert.equal(formatDuration(duration(stopped, 900000)), "25:00:03");
 const started = applyEvent(stopped, { eventId: "start", commandId: "next", version: 3, timerId: "next", startedAt: "2026-09-30T01:00:03.000Z" });
 assert.equal(duration(started, 3100), 0);
});
test("rejection and old event resolve pending independently of version; gap requires resync", () => {
 const pending = { type: "start" as const, expectedVersion: 4, commandId: "cmd" };
 const view = { ...initialView(), version: 4, connected: true, pending };
 const rejection = applyEvent(view, { eventId: "reject", commandId: "cmd", correlationId: "delivery", error: { code: "VERSION_CONFLICT", message: "conflict", retryable: false } });
 assert.equal(rejection.pending, null); assert.equal(rejection.version, 4);
 const old = applyEvent(view, { eventId: "old", commandId: "cmd", version: 1, timerId: "old", startedAt: stamp });
 assert.equal(old.pending, null); assert.equal(old.active, null);
 assert.equal(applyEvent(view, { eventId: "gap", commandId: "x", version: 6, timerId: "x", startedAt: stamp }).connected, false);
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
