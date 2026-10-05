// ABOUTME: Проверяет реальные history маршруты, схемы и trusted session boundary.
// ABOUTME: Подменяет только NATS; RLS и реальная интеграция проверяются отдельно на стенде.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
const root = resolve(import.meta.dirname, "../../..");
const server = resolve(root, "apps/web/server");
function load(filename: string, overrides: Record<string, unknown> = {}) {
 const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true,
 } }).outputText;
 const module = { exports: {} as Record<string, unknown> }, base = createRequire(pathToFileURL(filename));
 new Function("require", "module", "exports", output)((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : base(name), module, module.exports);
 return module.exports;
}
const event = { id: "11111111-1111-4111-8111-111111111111", source: "fixture", type_id: 101,
 occurred_at: "2026-10-05T12:00:00Z", recorded_at: "2026-10-05T12:00:01Z", actor_id: null,
 scope_type: "user", scope_id: "user-a", object_type: null, object_id: null, data: {} };
let authBody: unknown, ownerBody: unknown, raw: Uint8Array | undefined, ownerHeaders = new Headers(), transportError: unknown;
const calls: { subject: string; body: Record<string, unknown>; timeout: number }[] = [];
const nc = { isClosed: () => false, isDraining: () => false, async *status() {},
 async request(subject: string, bytes: Uint8Array, options: { timeout: number }) {
  calls.push({ subject, body: JSON.parse(Buffer.from(bytes).toString()), timeout: options.timeout });
  if (subject === "brai.auth.v1.session") return { data: Buffer.from(JSON.stringify({ status: 200, body: authBody, setCookies: [] })), headers: new Headers() };
  if (transportError) throw transportError;
  return { data: raw ?? Buffer.from(JSON.stringify(ownerBody)), headers: ownerHeaders };
 }};
const contracts = load(resolve(server, "contracts.ts"));
const base = createRequire(pathToFileURL(resolve(server, "gateway.ts")));
const gateway = load(resolve(server, "gateway.ts"), { nats: { ...base("nats"), connect: async () => nc }, "./contracts": contracts });
const auth = load(resolve(server, "auth.ts"), { "./gateway": gateway, "./contracts": contracts });
const http = load(resolve(server, "http.ts"), { "./gateway": gateway, "./auth": auth });
const history = load(resolve(server, "history.ts"), { "./gateway": gateway, "./contracts": contracts });
const overrides = { "@/server/auth": auth, "@/server/gateway": gateway, "@/server/history": history, "@/server/http": http };
const list = load(resolve(root, "apps/web/app/api/history/route.ts"), overrides).GET as (request: Request) => Promise<Response>;
const get = load(resolve(root, "apps/web/app/api/history/[source]/[id]/route.ts"), overrides).GET as (request: Request, context: { params: Promise<{ source: string; id: string }> }) => Promise<Response>;
function session(userId: string) { return { user: { id: userId, email: "fixture@example.test" }, session: { id: "session-" + userId, userId, expiresAt: new Date(Date.now() + 60000).toISOString() } }; }
function request(query = "") { return new Request("https://fixture.example/api/history" + query, { headers: { cookie: "session=synthetic", "x-brai-user": "forged-user" } }); }
function context(source = event.source, id = event.id) { return { params: Promise.resolve({ source, id }) }; }
async function check(response: Response, status: number, code?: string) {
 assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
 const body = await response.json(); if (code) assert.equal(body.code, code); return body;
}
test("history routes derive trusted identity, enforce owner input and classify wire failures", async () => {
 const previous = process.env.NATS_URL; process.env.NATS_URL = "nats://offline-fixture.invalid:4222";
 try {
  authBody = null; ownerBody = { items: [event], next_cursor: null };
  await check(await list(request()), 401, "UNAUTHORIZED");
  await check(await get(request(), context()), 401, "UNAUTHORIZED");
  assert.equal(calls.filter(call => call.subject.startsWith("brai.history")).length, 0);
  authBody = session("user-a");
  assert.deepEqual(await check(await list(request("?source=fixture&type_id=101&category_id=1&limit=2&actor_id=actor&occurred_from=2026-10-05T00%3A00%3A00Z&cursor=opaque")), 200), ownerBody);
  assert.deepEqual(calls.at(-1), { subject: "brai.history.v1.query.list", timeout: 10000, body: {
   user_id: "user-a", filters: { source: "fixture", type_id: 101, category_id: 1, actor_id: "actor", occurred_from: "2026-10-05T00:00:00Z" }, limit: 2, cursor: "opaque" } });
  ownerBody = { items: [], next_cursor: null }; authBody = session("text-user-b");
  assert.deepEqual(await check(await list(request()), 200), ownerBody);
  assert.deepEqual(calls.at(-1)?.body, { user_id: "text-user-b" });
  for (const query of ["?scope_type=system", "?scope_id=user-a", "?user_id=user-a", "?userId=user-a", "?filters={}", "?limit=2&limit=3", "?limit=0", "?limit=101", "?limit=2e1", "?type_id=-1", "?category_id=2147483648", "?cursor=", "?cursor=" + "x".repeat(2049), "?source=bad-code", "?occurred_from=not-time"]) {
   const before = calls.filter(call => call.subject.startsWith("brai.history")).length;
   await check(await list(request(query)), 400, "INVALID_ARGUMENT");
   assert.equal(calls.filter(call => call.subject.startsWith("brai.history")).length, before, query);
  }
  ownerBody = { event }; authBody = session("user-a");
  assert.deepEqual(await check(await get(request(), context()), 200), ownerBody);
  assert.deepEqual(calls.at(-1)?.body, { user_id: "user-a", source: "fixture", id: event.id });
  for (const [source, id] of [["bad-code", event.id], ["fixture", "invalid"]]) await check(await get(request(), context(source, id)), 400, "INVALID_ARGUMENT");
  await check(await get(request("?scope_id=user-a"), context()), 400, "INVALID_ARGUMENT");
  for (const [code, status] of [["NOT_FOUND", 404], ["INVALID_CURSOR", 400], ["BUSY", 503], ["DATABASE_UNAVAILABLE", 503], ["RESULT_TOO_LARGE", 413], ["DEADLINE_EXCEEDED", 504], ["INTERNAL", 500]] as const) {
   ownerBody = { code, message: "private database detail", retryable: false };
   ownerHeaders = new Headers({ "Nats-Service-Error": code, "Nats-Service-Error-Code": String(status) });
   assert.deepEqual(await check(await get(request(), context()), status, code), { code, outcome: "query" });
  }
  ownerHeaders = new Headers({ "Nats-Service-Error": "NOT_FOUND", "Nats-Service-Error-Code": "503" });
  ownerBody = { code: "NOT_FOUND", message: "private", retryable: false };
  await check(await list(request()), 502, "BAD_REPLY");
  for (const incomplete of [new Headers({ "Nats-Service-Error": "NOT_FOUND" }), new Headers({ "Nats-Service-Error-Code": "404" })]) {
   ownerHeaders = incomplete; await check(await list(request()), 502, "BAD_REPLY");
  }
  ownerHeaders = new Headers();
  for (const malformed of [{ items: [event] }, { items: [], next_cursor: null, secret: "hidden" }, { items: [{ ...event, id: "bad" }], next_cursor: null }]) {
   ownerBody = malformed; await check(await list(request()), 502, "BAD_REPLY");
  }
  for (const malformed of [Buffer.from("{"), new Uint8Array([255]), Buffer.alloc(512 * 1024 + 1)]) {
   raw = malformed; await check(await list(request()), 502, "BAD_REPLY");
  }
  raw = undefined; transportError = { code: "TIMEOUT" }; await check(await list(request()), 504, "DEADLINE_EXCEEDED");
  transportError = new Error("secret broker url"); await check(await list(request()), 503, "UNAVAILABLE");
 } finally { transportError = undefined; if (previous === undefined) delete process.env.NATS_URL; else process.env.NATS_URL = previous; }
});
