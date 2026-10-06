// ABOUTME: Проверяет реальные HTTP маршруты alerts и схемы доверенной границы.
// ABOUTME: Подменяет только NATS; данные браузера не задают полномочия владельца.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
const root = resolve(import.meta.dirname, "../../.."), server = resolve(root, "apps/web/server");
function load(filename: string, overrides: Record<string, unknown> = {}) {
 const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true } }).outputText;
 const module = { exports: {} as Record<string, unknown> }, base = createRequire(pathToFileURL(filename));
 new Function("require", "module", "exports", output)((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : base(name), module, module.exports);
 return module.exports;
}
let authBody: unknown, ownerBody: unknown = { unread_count: 0, category: null }, ownerHeaders = new Headers(), raw: Uint8Array | undefined;
const calls: { subject: string; body: object }[] = [];
const nc = { isClosed: () => false, isDraining: () => false, async *status() {}, async request(subject: string, bytes: Uint8Array) {
 calls.push({ subject, body: JSON.parse(Buffer.from(bytes).toString()) });
 return { data: subject.startsWith("brai.auth") ? Buffer.from(JSON.stringify({ status: 200, body: authBody, setCookies: [] })) : raw ?? Buffer.from(JSON.stringify(ownerBody)), headers: subject.startsWith("brai.auth") ? new Headers() : ownerHeaders };
} };
const contracts = load(resolve(server, "contracts.ts")), base = createRequire(pathToFileURL(resolve(server, "gateway.ts")));
const gateway = load(resolve(server, "gateway.ts"), { nats: { ...base("nats"), connect: async () => nc }, "./contracts": contracts });
const auth = load(resolve(server, "auth.ts"), { "./gateway": gateway, "./contracts": contracts });
const http = load(resolve(server, "http.ts"), { "./gateway": gateway, "./auth": auth });
const alerts = load(resolve(server, "alerts.ts"), { "./gateway": gateway, "./contracts": contracts });
const alertsHttp = load(resolve(server, "alerts-http.ts"), { "./gateway": gateway, "./auth": auth, "./http": http, "./alerts": alerts, "./request-body": load(resolve(server, "request-body.ts")) });
const overrides = { "@/server/alerts-http": alertsHttp };
const route = (path: string, method: string) => load(resolve(root, "apps/web/app/api/alerts", path, "route.ts"), overrides)[method] as (request: Request, context?: object) => Promise<Response>;
const list = route("", "GET"), summary = route("summary", "GET"), get = route("[service]/[id]", "GET"), read = route("[service]/[id]/read", "POST"), all = route("read-all", "POST");
const id = "11111111-1111-4111-8111-111111111111", context = { params: Promise.resolve({ service: "fixture", id }) };
function session(user: string) { return { user: { id: user, email: "fixture@example.test" }, session: { id: "s-" + user, userId: user, expiresAt: new Date(Date.now() + 60000).toISOString() } }; }
function request(query = "", body?: string, user = "a", origin = "https://fixture.example") { return new Request("https://fixture.example/api/alerts" + query, { method: body === undefined ? "GET" : "POST", headers: { "x-brai-user": user, origin, "content-type": "application/json" }, ...(body === undefined ? {} : { body }) }); }
async function check(response: Response, status: number, code?: string) { assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store"); const body = await response.json(); if (code) assert.equal(body.code, code); return body; }
test("alerts derives identity, rejects stale account and browser fields, validates read origin and owner replies", async () => {
 const previous = process.env.NATS_URL; process.env.NATS_URL = "nats://fixture.invalid:4222";
 try {
  authBody = null; await check(await summary(request()), 401, "UNAUTHORIZED"); assert.equal(calls.filter(call => call.subject.startsWith("brai.alerts")).length, 0);
  authBody = session("b"); await check(await summary(request()), 401, "ACCOUNT_CHANGED"); assert.equal(calls.filter(call => call.subject.startsWith("brai.alerts")).length, 0);
  authBody = session("a"); assert.deepEqual(await check(await summary(request()), 200), ownerBody); assert.deepEqual(calls.at(-1), { subject: "brai.alerts.v1.query.summary", body: { user_id: "a" } });
  ownerBody = { items: [], next_cursor: null }; await check(await list(request("?limit=50&cursor=opaque")), 200); assert.deepEqual(calls.at(-1)?.body, { user_id: "a", limit: 50, cursor: "opaque" });
  for (const query of ["?user_id=b", "?scope_type=system", "?limit=0", "?limit=101", "?limit=2&limit=3", "?cursor=", "?cursor=" + "x".repeat(2049)]) await check(await list(request(query)), 400, "INVALID_ARGUMENT");
  ownerBody = { unread_count: 0, category: null };
  await check(await read(request("", "{}"), context), 200); assert.deepEqual(calls.at(-1), { subject: "brai.alerts.v1.command.read", body: { user_id: "a", service_id: "fixture", id } });
  await check(await all(request("", "{}")), 200); assert.deepEqual(calls.at(-1), { subject: "brai.alerts.v1.command.read_all", body: { user_id: "a" } });
  await check(await read(request("", "{}", "a", "https://evil.example"), context), 403, "ORIGIN");
  for (const body of ['{"user_id":"b"}', "[]", "null", "{", "x".repeat(2049)]) await check(await all(request("", body)), body.length > 2048 ? 413 : 400);
  await check(await get(request(), { params: Promise.resolve({ service: "fixture", id: "invalid" }) }), 400, "INVALID_ARGUMENT");
  for (const [code, status] of [["NOT_FOUND", 404], ["BUSY", 503], ["INVALID_CURSOR", 400]] as const) {
   ownerBody = { code, message: "private", retryable: false }; ownerHeaders = new Headers({ "Nats-Service-Error": code, "Nats-Service-Error-Code": String(status) });
   assert.deepEqual(await check(await summary(request()), status, code), { code, outcome: "query" });
  }
  ownerHeaders = new Headers({ "Nats-Service-Error": "NOT_FOUND", "Nats-Service-Error-Code": "503" }); await check(await summary(request()), 502, "BAD_REPLY");
  ownerHeaders = new Headers();
  for (const malformed of [{ unread_count: -1, category: null }, { unread_count: 1, category: null, secret: "private" }]) { ownerBody = malformed; await check(await summary(request()), 502, "BAD_REPLY"); }
  for (const value of [Buffer.from("{"), new Uint8Array([255]), Buffer.alloc(512 * 1024 + 1)]) { raw = value; await check(await summary(request()), 502, "BAD_REPLY"); }
 } finally { raw = undefined; if (previous === undefined) delete process.env.NATS_URL; else process.env.NATS_URL = previous; }
});
