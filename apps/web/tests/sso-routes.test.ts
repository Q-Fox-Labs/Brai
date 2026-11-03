// ABOUTME: Проверяет HTTP-границы передачи входа между DEV и preview.
// ABOUTME: Подменяет только сервис авторизации; реальные сессии и сеть не используются.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";
import * as sso from "../server/sso.ts";

const web = resolve(import.meta.dirname, "..");
const names = ["BRAI_ENVIRONMENT", "WEB_ORIGIN", "WEB_SSO_HUB_ORIGIN", "WEB_SSO_PREVIEW_ORIGINS"] as const;
const previous = names.map(name => process.env[name]);
after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
const hub = "https://dev.brai.one", preview = "https://preview01.brai.one";
function configure(origin: string) {
 process.env.BRAI_ENVIRONMENT = "dev"; process.env.WEB_ORIGIN = origin;
 process.env.WEB_SSO_HUB_ORIGIN = hub; process.env.WEB_SSO_PREVIEW_ORIGINS = preview;
}
class GatewayError extends Error {
 status: number;
 constructor(status: number) { super("gateway"); this.status = status; }
}
type Reply = { status: number; body: unknown; setCookies: string[] };
let calls = 0, anonymous = false;
let reply: Reply = { status: 200, body: { success: true }, setCookies: ["session=secret; Path=/; HttpOnly"] };
const auth = {
 async requireSession() { calls++; if (anonymous) throw new GatewayError(401); return {}; },
 async authRequest() { calls++; return reply; },
 authResponse(result: Reply, body: unknown) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of result.setCookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status: result.status, headers });
 },
};
/** Загружает исходный маршрут с реальными SSO-правилами и тестовой границей auth. */
function route(path: string): { GET?: (request: Request) => Promise<Response> | Response; POST?: (request: Request) => Promise<Response> } {
 const filename = resolve(web, path), source = readFileSync(filename, "utf8");
 const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const module = { exports: {} };
 const base = createRequire(pathToFileURL(filename));
 const local = (name: string) => name === "@/server/sso" ? sso : name === "@/server/auth" ? auth : name === "@/server/gateway" ? { GatewayError } : base(name);
 new Function("require", "module", "exports", output)(local, module, module.exports);
 return module.exports;
}
const authorize = route("app/api/auth/sso/authorize/route.ts").GET!;
const redeem = route("app/api/auth/sso/redeem/route.ts").POST!;
const callback = route("app/auth/sso/callback/route.ts").GET!;
const challenge = "a".repeat(43), verifier = "b".repeat(43);
function post(body: string, headers: Record<string, string> = {}) {
 return new Request(`${preview}/api/auth/sso/redeem`, { method: "POST", headers: { origin: preview, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), cookie: `__Host-brai-sso=${verifier}`, ...headers }, body });
}

test("authorize отклоняет чужое назначение и дубликаты до auth, а анонимному сохраняет безопасное продолжение", async () => {
 configure(hub); calls = 0; anonymous = true;
 const params = new URLSearchParams({ targetOrigin: "https://evil.example", challenge });
 assert.equal((await authorize(new Request(`${hub}/api/auth/sso/authorize?${params}`))).status, 400);
 params.set("targetOrigin", preview); params.append("challenge", challenge);
 assert.equal((await authorize(new Request(`${hub}/api/auth/sso/authorize?${params}`))).status, 400);
 assert.equal(calls, 0);
 params.delete("challenge"); params.set("challenge", challenge);
 const response = await authorize(new Request(`${hub}/api/auth/sso/authorize?${params}`));
 assert.equal(response.status, 302); assert.equal(calls, 1);
 const location = new URL(response.headers.get("location")!, hub);
 assert.equal(location.origin, hub); assert.equal(location.pathname, "/auth");
 assert.equal(location.searchParams.get("targetOrigin"), preview); assert.equal(location.searchParams.get("challenge"), challenge);
 anonymous = false;
});

test("redeem отклоняет чужой Origin, отсутствие состояния и слишком большое тело до auth", async () => {
 configure(preview); calls = 0;
 const body = JSON.stringify({ ticket: "ticket" });
 assert.equal((await redeem(post(body, { origin: "https://evil.example" }))).status, 400);
 assert.equal((await redeem(post(body, { cookie: "" }))).status, 400);
 const oversized = post(JSON.stringify({ ticket: "x".repeat(9001) })); oversized.headers.delete("content-length");
 assert.equal((await redeem(oversized)).status, 400);
 assert.equal(calls, 0);
});

test("redeem выдаёт cookie только после успешного обмена и не раскрывает ticket или тело auth", async () => {
 configure(preview); calls = 0;
 reply = { status: 200, body: { token: "hidden-session-token" }, setCookies: ["session=secret; Path=/; HttpOnly"] };
 const request = post(JSON.stringify({ ticket: "private-ticket" })); request.headers.delete("content-length");
 const response = await redeem(request);
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
 const cookies = response.headers.getSetCookie();
 assert.ok(cookies.some(cookie => cookie.startsWith("session=secret;")));
 assert.ok(cookies.some(cookie => cookie.includes("Max-Age=0")));
 assert.equal(response.headers.get("cache-control"), "no-store");
 reply = { status: 403, body: { token: "hidden-session-token" }, setCookies: ["session=must-not-escape"] };
 const rejected = await redeem(post(JSON.stringify({ ticket: "private-ticket" })));
 assert.equal(rejected.status, 400); assert.equal(rejected.headers.getSetCookie().length, 0);
 const text = await rejected.text(); assert.ok(!text.includes("private-ticket") && !text.includes("hidden-session-token"));
 assert.equal(calls, 2);
});

test("callback изолирован от ресурсов и не раскрывает ticket в URL запроса", async () => {
 configure(preview);
 const response = await callback(new Request(`${preview}/auth/sso/callback`));
 assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
 assert.equal(response.headers.get("referrer-policy"), "no-referrer");
 assert.match(response.headers.get("content-security-policy")!, /default-src 'none'/);
 const html = await response.text();
 assert.ok(html.indexOf("history.replaceState") < html.indexOf("fetch("));
 assert.ok(!html.includes("https://") && !html.includes("?ticket="));
});
