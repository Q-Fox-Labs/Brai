// ABOUTME: Проверяет timer edit/delete/statistics HTTP границу через owner schemas.
// ABOUTME: Подменяет только NATS transport и Better Auth reply; cookie и Origin остаются реальными.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../..");
const server = resolve(root, "apps/web/server");
const calls: { subject: string; body: Record<string, unknown> }[] = [];
const ownerId = "owner-a";
let authReply: unknown, queryReply: unknown, queryHeaders = new Headers();
const nc = {
 isClosed: () => false, isDraining: () => false,
 async *status() { await new Promise(() => {}); },
 async request(subject: string, bytes: Uint8Array) {
  const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  calls.push({ subject, body });
  if (subject === "brai.auth.v1.session") return { data: Buffer.from(JSON.stringify(authReply)), headers: new Headers() };
  return { data: Buffer.from(JSON.stringify(queryReply)), headers: queryHeaders };
 },
 jetstream() { return { async publish(subject: string, bytes: Uint8Array) {
  calls.push({ subject, body: JSON.parse(Buffer.from(bytes).toString("utf8")) }); return { seq: 1 };
 } }; },
};
function load(filename: string, overrides: Record<string, unknown> = {}) {
 const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true,
 } }).outputText;
 const module = { exports: {} as Record<string, unknown> }, base = createRequire(pathToFileURL(filename));
 new Function("require", "module", "exports", output)((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : base(name), module, module.exports);
 return module.exports as Record<string, (...args: never[]) => unknown>;
}
const contracts = load(resolve(server, "contracts.ts"));
const base = createRequire(pathToFileURL(resolve(server, "gateway.ts")));
const gateway = load(resolve(server, "gateway.ts"), { nats: { ...base("nats"), connect: async () => nc }, "./contracts": contracts });
const auth = load(resolve(server, "auth.ts"), { "./contracts": contracts, "./gateway": gateway });
const http = load(resolve(server, "http.ts"), { "./gateway": gateway, "./auth": auth });
const overrides = { "@/server/auth": auth, "@/server/gateway": gateway, "@/server/http": http };
const edit = load(resolve(root, "apps/web/app/api/timer/edit/route.ts"), overrides).POST as (request: Request) => Promise<Response>;
const remove = load(resolve(root, "apps/web/app/api/timer/delete/route.ts"), overrides).POST as (request: Request) => Promise<Response>;
const statistics = load(resolve(root, "apps/web/app/api/timer/statistics/route.ts"), overrides).GET as (request: Request) => Promise<Response>;
const history = load(resolve(root, "apps/web/app/api/timer/history/route.ts"), overrides).GET as (request: Request) => Promise<Response>;
function session() { return { status: 200, body: { user: { id: ownerId, email: "owner@example.test" }, session: { id: "session-a", userId: ownerId, expiresAt: new Date(Date.now() + 60_000).toISOString() } }, setCookies: [] }; }
function request(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
 const headers: Record<string, string> = { cookie: "session=fixture", "x-brai-user": ownerId,
  ...(method === "POST" ? { origin: "https://fixture.example", "content-type": "application/json" } : {}), ...extra };
 return new Request(`https://fixture.example${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function statisticsDto(version = 4) {
 const daily = Array.from({ length: 28 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, completedMs: 0, targetMs: 28_800_000, percent: 0, achieved: false }));
 return { userId: ownerId, version, serverTime: "2026-10-05T12:00:00.000Z", timeZone: "Europe/Moscow", totalCompletedMs: 0, daily: [],
  challenge: { startDate: "2026-10-04", endDateExclusive: "2026-11-01", timeZone: "Europe/Moscow", days: 28, dailyTargetMs: 28_800_000,
   targetMs: 806_400_000, completedMs: 0, remainingMs: 806_400_000, percent: 0, remainingDays: 28, requiredDailyMs: 28_800_000,
   achieved: false, closedDays: 0, daily } };
}
async function check(response: Response, status: number, code?: string) {
 assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
 const body = await response.json(); if (code) assert.equal(body.code, code); return body;
}

test("timer mutation routes use trusted session owner and preserve exact command bodies", async () => {
 const previous = process.env.NATS_URL, previousOrigin = process.env.WEB_ORIGIN; process.env.NATS_URL = "nats://fixture.invalid:4222"; process.env.WEB_ORIGIN = "https://fixture.example";
 try {
  authReply = session(); calls.length = 0;
  const editBody = { commandId: "91ae2be0-8d8f-4c50-9fd3-000000000001", timerId: "91ae2be0-8d8f-4c50-9fd3-000000000002", expectedVersion: 9,
   startedAt: "2026-10-05T09:10:11.123Z", stoppedAt: "2026-10-05T09:10:12.456Z" };
  assert.deepEqual(await check(await edit(request("/api/timer/edit", "POST", editBody)), 202), { commandId: editBody.commandId, status: "queued" });
  assert.deepEqual(calls.at(-1), { subject: "brai.timer.v2.command.edit", body: { ...editBody, userId: ownerId } });
  const deleteBody = { commandId: "91ae2be0-8d8f-4c50-9fd3-000000000003", timerId: editBody.timerId, expectedVersion: 10 };
  await check(await remove(request("/api/timer/delete", "POST", deleteBody)), 202);
  assert.deepEqual(calls.at(-1), { subject: "brai.timer.v2.command.delete", body: { ...deleteBody, userId: ownerId } });
  const before = calls.length;
  await check(await edit(request("/api/timer/edit", "POST", { ...editBody, userId: "forged" })), 400, "INVALID_ARGUMENT");
  await check(await remove(request("/api/timer/delete", "POST", deleteBody, { origin: "https://attacker.example" })), 403, "ORIGIN");
  await check(await edit(request("/api/timer/edit", "POST", editBody, { "x-brai-user": "other-user" })), 401, "ACCOUNT_CHANGED");
  assert.equal(calls.filter(call => call.subject.startsWith("brai.timer.v2.command.")).length, 2);
  assert.ok(calls.length > before);
 } finally { if (previous === undefined) delete process.env.NATS_URL; else process.env.NATS_URL = previous; if (previousOrigin === undefined) delete process.env.WEB_ORIGIN; else process.env.WEB_ORIGIN = previousOrigin; }
});

test("statistics and changed-history routes validate owner DTOs and map owner errors", async () => {
 const previous = process.env.NATS_URL, previousOrigin = process.env.WEB_ORIGIN; process.env.NATS_URL = "nats://fixture.invalid:4222"; process.env.WEB_ORIGIN = "https://fixture.example";
 try {
  authReply = session(); queryReply = statisticsDto(); queryHeaders = new Headers(); calls.length = 0;
  assert.deepEqual(await check(await statistics(request("/api/timer/statistics")), 200), queryReply);
  assert.deepEqual(calls.at(-1), { subject: "brai.timer.v2.query.statistics", body: { userId: ownerId } });
  queryReply = { code: "HISTORY_CHANGED", message: "cursor changed", retryable: false };
  queryHeaders = new Headers({ "Nats-Service-Error": "HISTORY_CHANGED", "Nats-Service-Error-Code": "409" });
  await check(await history(request("/api/timer/history?cursor=old")), 409, "HISTORY_CHANGED");
  assert.deepEqual(calls.at(-1), { subject: "brai.timer.v2.query.history", body: { userId: ownerId, limit: 50, cursor: "old" } });
 } finally { queryHeaders = new Headers(); if (previous === undefined) delete process.env.NATS_URL; else process.env.NATS_URL = previous; if (previousOrigin === undefined) delete process.env.WEB_ORIGIN; else process.env.WEB_ORIGIN = previousOrigin; }
});

test("SSE event parser accepts owner edit/delete DTOs", () => {
 const parseEvent = gateway.parseEvent as (data: Uint8Array) => unknown;
 const prefix = { eventId: "91ae2be0-8d8f-4c50-9fd3-000000000004", commandId: "91ae2be0-8d8f-4c50-9fd3-000000000001", version: 10, userId: ownerId };
 const interval = { timerId: "91ae2be0-8d8f-4c50-9fd3-000000000002", startedAt: "2026-10-05T09:10:11.123Z", stoppedAt: "2026-10-05T09:10:12.456Z", durationMs: 1333 };
 const edited = { ...prefix, operation: "edit", interval }, deleted = { ...prefix, operation: "delete", timerId: interval.timerId };
 assert.deepEqual(parseEvent(Buffer.from(JSON.stringify(edited))), edited);
 assert.deepEqual(parseEvent(Buffer.from(JSON.stringify(deleted))), deleted);
});
