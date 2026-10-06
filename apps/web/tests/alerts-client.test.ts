// ABOUTME: Проверяет live, сверку и жизненный цикл alerts через наблюдаемые запросы.
// ABOUTME: Подменяет HTTP и EventSource; не требует React или настоящего брокера.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AlertsClient } from "../lib/alerts-client.ts";
import type { AlertNotification } from "../lib/alerts-types.ts";
const item = (id: string, read = false) => ({ id, service_id: "fixture", read_at: read ? "2026-10-06T00:00:00Z" : null } as AlertNotification);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function fixture() {
 const handlers = new Map<string, () => void>(), calls: { path: string; init: RequestInit }[] = [];
 let count = 2, failed = false, closed = 0, unauthorized = 0, marked = false;
 const client = new AlertsClient({ userId: "user-a", onUnauthorized: () => { unauthorized++; },
  events: () => ({ addEventListener: (name: string, listener: () => void) => { handlers.set(name, listener); }, close: () => { closed++; } }),
  fetch: (async (path: string, init: RequestInit) => {
   calls.push({ path, init });
   if (failed) throw new Error("offline");
   if (init.method === "POST") { count = path.endsWith("read-all") ? 0 : 1; marked = true; }
   return Response.json(path.includes("?") ? { items: path.includes("cursor=") ? [item("older")] : [item("newer", marked)], next_cursor: path.includes("cursor=") ? null : "opaque" } : { unread_count: count, category: null });
  }) as typeof fetch,
 });
 return { client, handlers, calls, fail: () => { failed = true; }, get closed() { return closed; }, get unauthorized() { return unauthorized; } };
}
test("alerts starts unknown, keeps count and loaded pages offline, refreshes on SSE and explicitly reads", async () => {
 const f = fixture(); assert.equal(f.client.getSnapshot().summary, null);
 f.client.start(); f.client.start(); await settle();
 assert.equal(f.calls.length, 1); assert.equal(f.client.getSnapshot().summary?.unread_count, 2);
 f.client.openFeed(); await settle();
 assert.equal(f.calls.filter(call => call.init.method === "POST").length, 0);
 assert.deepEqual(f.client.getSnapshot().items?.map(item => item.id), ["newer"]);
 f.client.loadMore(); await settle();
 assert.deepEqual(f.client.getSnapshot().items?.map(item => item.id), ["newer", "older"]);
 assert.ok(f.calls.some(call => call.path.endsWith("cursor=opaque")));
 await f.client.read(item("newer")); await settle();
 assert.equal(f.client.getSnapshot().summary?.unread_count, 1);
 assert.ok(f.client.getSnapshot().items?.[0].read_at);
 await f.client.read(); await settle();
 assert.equal(f.client.getSnapshot().summary?.unread_count, 0);
 assert.ok(f.calls.some(call => call.path === "/api/alerts/read-all" && call.init.method === "POST"));
 const before = f.calls.length; f.handlers.get("changed")!(); await settle(); assert.ok(f.calls.length > before);
 f.fail(); f.handlers.get("error")!(); f.client.refresh(); await settle();
 assert.equal(f.client.getSnapshot().summary?.unread_count, 0); assert.equal(f.client.getSnapshot().items?.length, 2);
 assert.ok(f.client.getSnapshot().error); assert.equal(f.client.getSnapshot().live, false);
 assert.ok(f.calls.every(call => new Headers(call.init.headers).get("x-brai-user") === "user-a"));
 f.client.stop(); assert.equal(f.closed, 1);
 const stopped = f.calls.length; f.handlers.get("changed")!(); f.client.refresh(); await settle(); assert.equal(f.calls.length, stopped);
});
test("stop aborts pending requests and rejects stale responses; account-change 401 closes SSE", async () => {
 let release: (value: Response) => void = () => {}, signal: AbortSignal | undefined, closed = 0;
 const stale = new AlertsClient({ userId: "a", onUnauthorized: () => assert.fail("stale response handled"),
  events: () => ({ addEventListener() {}, close() { closed++; } }),
  fetch: ((_path: unknown, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch });
 stale.start(); stale.stop(); assert.equal(signal?.aborted, true); release(Response.json({ unread_count: 99, category: null })); await settle();
 assert.equal(stale.getSnapshot().summary, null); assert.equal(closed, 1);
 let unauthorized = 0;
 const switched = new AlertsClient({ userId: "a", onUnauthorized: () => { unauthorized++; }, events: () => ({ addEventListener() {}, close() { closed++; } }),
  fetch: (async () => Response.json({ code: "ACCOUNT_CHANGED" }, { status: 401 })) as typeof fetch });
 switched.start(); await settle(); assert.equal(unauthorized, 1); assert.equal(closed, 2);
 assert.equal(switched.getSnapshot().summary, null); switched.stop();
});
test("15 second reconciliation recovers dropped Core signals and stopping removes the timer", async context => {
 context.mock.timers.enable({ apis: ["setInterval"] });
 const f = fixture(); f.client.start(); await settle(); const before = f.calls.length;
 context.mock.timers.tick(15000); await settle(); assert.equal(f.calls.length, before + 1);
 f.client.stop(); context.mock.timers.tick(30000); await settle(); assert.equal(f.calls.length, before + 1);
});
