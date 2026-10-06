// ABOUTME: Проверяет порядок bootstrap и безопасное завершение bounded alerts SSE.
// ABOUTME: Использует настоящий ReadableStream и управляемую авторизацию без NATS.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertsHub, alertsStream, MAX_ALERT_QUEUE, MAX_ALERT_CLIENTS } from "../server/alerts-hub.ts";
test("alerts hub routes personal/global signals and closes session or broker clients", () => {
 const hub = new AlertsHub(); let a = 0, b = 0, closed = 0;
 hub.attach("a", "sa", () => { a++; }, () => { closed++; }); hub.attach("b", "sb", () => { b++; }, () => { closed++; });
 hub.broadcast("a"); hub.broadcast(null); assert.equal(a, 2); assert.equal(b, 1);
 hub.invalidate("sa"); assert.equal(closed, 1); hub.disconnect(); assert.equal(closed, 3);
});
test("subscriber buffers change before ready; revoked authorization prevents delivery", async () => {
 const hub = new AlertsHub(), abort = new AbortController(); let ready: () => void = () => {}, authorized = true;
 const reader = alertsStream(hub, () => new Promise<void>(resolve => { ready = resolve; }), abort.signal, "a", "s", async () => authorized).getReader();
 hub.broadcast("a"); ready();
 assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
 assert.match(new TextDecoder().decode((await reader.read()).value), /event: changed/);
 authorized = false; hub.broadcast("a"); assert.equal((await reader.read()).done, true);
});
test("bootstrap overflow and client limit release resources instead of retaining unbounded queues", async () => {
 const hub = new AlertsHub(), abort = new AbortController();
 const reader = alertsStream(hub, () => new Promise(() => {}), abort.signal, "a", "s", async () => true).getReader();
 for (let i = 0; i <= MAX_ALERT_QUEUE; i++) hub.broadcast(null);
 assert.equal((await reader.read()).done, true);
 const releases = Array.from({ length: MAX_ALERT_CLIENTS }, () => hub.attach("b", "s", () => {}, () => {}));
 assert.throws(() => hub.attach("b", "s", () => {}, () => {}), /CLIENT_LIMIT/);
 for (const release of releases) release();
 const release = hub.attach("b", "s", () => {}, () => {}); release();
});
test("heartbeat rechecks authorization while the transport is stalled", async context => {
 context.mock.timers.enable({ apis: ["setInterval"] });
 const hub = new AlertsHub(), abort = new AbortController(); let allowed = true, checks = 0;
 const reader = alertsStream(hub, async () => {}, abort.signal, "a", "s", async () => { checks++; return allowed; }).getReader();
 await new Promise<void>(resolve => setImmediate(resolve));
 allowed = false; context.mock.timers.tick(2000); await new Promise<void>(resolve => setImmediate(resolve));
 assert.ok(checks >= 2);
 assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
 assert.equal((await reader.read()).done, true);
});
