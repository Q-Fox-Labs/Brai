// ABOUTME: Проверяет границу административного чтения личных сервисов.
// ABOUTME: Auth и аудит обязательны до данных; caller не может выбрать scope.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { serviceDataScope } from "../../../services/auth/contracts/service-data-scope.mjs";
let deny = "", selectedId = "target", profileId: string | null = "verified-profile", dataCalls: unknown[][] = [];
let calls: { subject: string; body: any }[] = [];
class GatewayError extends Error {
 status: number;
 code: string;
 constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const data = async (...args: unknown[]) => { dataCalls.push(args); return { items: [], next_cursor: null }; };
const imports: Record<string, unknown> = {
 "../../../services/auth/contracts/service-data-scope.mjs": { serviceDataScope },
 "./gateway": { GatewayError, history: data, snapshot: data }, "./history": { listHistory: data },
 "./alerts": { listAlerts: data }, "./goals": { goalsRequest: data },
};
const source = readFileSync(resolve(import.meta.dirname, "../server/admin-personal.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} as { readAdminPersonal: (...args: any[]) => Promise<any> } };
new Function("require", "module", "exports", output)((name: string) => imports[name], module, module.exports);
const nc = { request: async (subject: string, raw: Uint8Array) => {
 const body = JSON.parse(Buffer.from(raw).toString()); calls.push({ subject, body });
 const status = subject.endsWith(deny || "never") ? 403 : 200;
 return { data: Buffer.from(JSON.stringify({ status, body: subject.endsWith("users-get") ? { user: { id: selectedId, profileId } } : { auditId: "audit" } })) };
} };
const headers = { cookie: "session=administrator", origin: "https://brai.test" };
const read = (input: object) => module.exports.readAdminPersonal(nc, headers, input);
function reset() { deny = ""; profileId = "verified-profile"; selectedId = "target"; calls = []; dataCalls = []; }
test("untrusted scope, unknown service and archive target are rejected before any transport", async () => {
 reset();
 for (const input of [{ userId: "target", service: "sql" }, { userId: "__quarantine__", service: "history" },
  { userId: "target", service: "history", scope: "victim" }, { userId: "target", service: "history", ownerId: "victim" }])
  await assert.rejects(read(input), (error: GatewayError) => error.status === 400);
 assert.equal(calls.length, 0); assert.equal(dataCalls.length, 0);
});
test("Auth rejection or audit rejection never starts a personal data request", async () => {
 for (const operation of ["users-get", "admin-audit"]) {
  reset(); deny = operation;
  await assert.rejects(read({ userId: "target", service: "history" }), (error: GatewayError) => error.status === 403);
  assert.equal(dataCalls.length, 0);
 }
});
test("target identity and ready profile must match the authoritative Auth reply", async () => {
 for (const value of ["foreign-id", null]) {
  reset(); if (value === null) profileId = null; else selectedId = value;
  await assert.rejects(read({ userId: "target", service: "goals" }), (error: GatewayError) => error.status === 404);
  assert.equal(dataCalls.length, 0); assert.equal(calls.length, 1);
 }
});
test("every service receives only the verified profile scope after recorded audit", async () => {
 for (const service of ["history", "timer", "alerts", "goals"]) {
  reset();
  const result = await read({ userId: "target", service });
  assert.equal(result.service, service);
  assert.equal(calls.length, 2); assert.equal(calls[1].subject, "brai.auth.v2.admin-audit");
  assert.deepEqual(calls[1].body, { headers, body: { userId: "target", action: "personal.read" } });
  assert.equal(dataCalls.length, service === "timer" ? 2 : 1);
  for (const call of dataCalls) assert.equal(call[0], serviceDataScope("verified-profile"));
  assert.notEqual(dataCalls[0][0], "target");
 }
});
