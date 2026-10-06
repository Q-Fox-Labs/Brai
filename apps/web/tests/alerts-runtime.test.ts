// ABOUTME: Проверяет ошибки общего NATS подключения отдельно от собственной подписки alerts.
// ABOUTME: Подменяет transport iterators; реальные схемы и HTTP проверяются соседними тестами.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AlertsHub } from "../server/alerts-hub.ts";
class Queue<T> {
 private values: T[] = [];
 private waiter: (() => void) | undefined;
 private done = false;
 private error: Error | undefined;
 push(value: T) { this.values.push(value); this.waiter?.(); }
 stop(error?: Error) { this.done = true; this.error = error; this.waiter?.(); }
 unsubscribe() { this.stop(); }
 async *[Symbol.asyncIterator]() {
  for (;;) {
   if (this.error) throw this.error;
   if (this.values.length) { yield this.values.shift()!; continue; }
   if (this.done) return;
   await new Promise<void>(resolve => { this.waiter = resolve; }); this.waiter = undefined;
  }
 }
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
test("unrelated ACL status leaves alerts live; own ACL and disconnect close safely and resubscribe", async () => {
 const key = Symbol.for("brai.web.alerts.runtime.v1"), globals = globalThis as typeof globalThis & { [key]?: unknown };
 const prior = globals[key]; delete globals[key];
 const statuses = new Queue<{ type: string }>(), subscribers: Queue<{ data: Uint8Array }>[] = []; let statusCalls = 0;
 const nc = { isClosed: () => false, isDraining: () => false, flush: async () => {},
  subscribe(subject: string, options?: unknown) { assert.equal(subject, "brai.alerts.v1.changed"); assert.equal(options, undefined); const sub = new Queue<{ data: Uint8Array }>(); subscribers.push(sub); return sub; },
  status() { statusCalls++; return statuses; },
 };
 class GatewayError extends Error { status: number; code: string; constructor(status: number, code: string) { super(code); this.status = status; this.code = code; } }
 const source = readFileSync(new URL("../server/alerts-runtime.ts", import.meta.url), "utf8");
 const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const module = { exports: {} as { alertsRuntime: () => { hub: AlertsHub; connect: () => Promise<void> } } }, require = createRequire(import.meta.url);
 const overrides: Record<string, unknown> = { "./alerts-hub": { AlertsHub }, "./gateway": { GatewayError, natsConnection: async () => nc }, "./contracts": { valid: () => true }, "./alerts": { alertsSchema: "owner#/definitions/" } };
 new Function("require", "module", "exports", compiled)((name: string) => overrides[name] ?? require(name), module, module.exports);
 const runtime = module.exports.alertsRuntime(); let delivered = 0, closed = 0, detach = () => {};
 const attach = () => { detach = runtime.hub.attach("a", "s", () => { delivered++; }, () => { closed++; detach(); }); };
 try {
  await runtime.connect(); attach();
  statuses.push({ type: "error" }); await settle(); await runtime.connect(); assert.equal(closed, 0);
  for (let i = 0; i < 2; i++) { subscribers[0].push({ data: Buffer.from('{"user_id":"a"}') }); await settle(); }
  assert.equal(delivered, 2); assert.equal(subscribers.length, 1);
  statuses.push({ type: "disconnect" }); await settle(); assert.equal(closed, 1);
  await assert.rejects(runtime.connect(), /UNAVAILABLE/);
  statuses.push({ type: "reconnect" }); await settle(); await runtime.connect(); attach();
  subscribers[0].stop(new Error("PERMISSIONS_VIOLATION alerts")); await settle(); assert.equal(closed, 2);
  await runtime.connect(); assert.equal(subscribers.length, 2); assert.equal(statusCalls, 1); attach();
  subscribers[1].push({ data: Buffer.from('{"user_id":null}') }); await settle(); assert.equal(delivered, 3);
 } finally {
  detach(); statuses.stop(); for (const sub of subscribers) sub.stop(); await settle();
  if (prior === undefined) delete globals[key]; else globals[key] = prior;
 }
});
