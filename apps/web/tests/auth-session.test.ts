// ABOUTME: Проверяет requireSession через исходный web код и схему владельца auth.
// ABOUTME: Подменяет только NATS transport port; сеть и сервис не запускаются.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../..");
const webServer = resolve(root, "apps/web/server");
const originalNatsUrl = process.env.NATS_URL;
const calls: { subject: string; timeout: number; payload: unknown }[] = [];
let ownerReply: unknown;
const natsConnection = {
  isClosed: () => false,
  isDraining: () => false,
  async *status() {},
  async request(subject: string, payload: Uint8Array, options: { timeout: number }) {
    calls.push({ subject, timeout: options.timeout, payload: JSON.parse(Buffer.from(payload).toString("utf8")) });
    return { data: Buffer.from(JSON.stringify(ownerReply)), headers: { has: () => false } };
  },
};

/** Загружает исходный TypeScript тестируемых модулей без импорта production service. */
function loadTypeScript(filename: string, overrides: Record<string, unknown> = {}) {
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true,
  } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const baseRequire = createRequire(pathToFileURL(filename));
  const localRequire = (name: string) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    return baseRequire(name);
  };
  new Function("require", "module", "exports", output)(localRequire, module, module.exports);
  return module.exports as Record<string, (...args: never[]) => unknown>;
}

const contracts = loadTypeScript(resolve(webServer, "contracts.ts"));
const baseRequire = createRequire(pathToFileURL(resolve(webServer, "gateway.ts")));
const natsStub = { ...baseRequire("nats"), connect: async () => natsConnection };
const gateway = loadTypeScript(resolve(webServer, "gateway.ts"), { nats: natsStub, "./contracts": contracts });
const auth = loadTypeScript(resolve(webServer, "auth.ts"), { "./contracts": contracts, "./gateway": gateway });
const accountSession = loadTypeScript(resolve(webServer, "account-session.ts"), { "./auth": auth, "./gateway": gateway });
const GatewayError = gateway.GatewayError as unknown as new (...args: never[]) => Error & { status: number; code: string; outcome: string };

after(() => {
  if (originalNatsUrl === undefined) delete process.env.NATS_URL;
  else process.env.NATS_URL = originalNatsUrl;
});

function reply(status: number, body: unknown) { return { status, body, setCookies: [] }; }
function session(expiresAt = new Date(Date.now() + 60_000).toISOString(), userId = "user-1") {
  return { user: { id: "user-1", email: "person@example.test" }, session: { id: "session-1", userId, expiresAt } };
}

test("requireSession classifies owner status and session identity using the real auth schema", async () => {
  process.env.NATS_URL = "nats://offline-fixture.invalid:4222";
  calls.length = 0;
  const request = new Request("https://brai.example/api/auth/session", { headers: { cookie: "session=fake" } });
  const requireSession = auth.requireSession as (request: Request) => Promise<unknown>;
  const requireTimerSession = auth.requireTimerSession as (request: Request, eventStream?: boolean) => Promise<unknown>;

  for (const status of [429, 500, 503, 418]) {
    ownerReply = reply(status, { message: "offline" });
    const before = calls.length;
    await assert.rejects(requireSession(request), error => error instanceof GatewayError && error.status === 503 && error.code === "AUTH_UNAVAILABLE");
    assert.equal(calls.length, before + 1, `status ${status} must issue one auth query`);
  }

  for (const status of [401, 403]) {
    ownerReply = reply(status, null);
    const before = calls.length;
    await assert.rejects(requireSession(request), error => error instanceof GatewayError && error.status === 401 && error.code === "UNAUTHORIZED");
    assert.equal(calls.length, before + 1);
  }

  for (const body of [null, session(new Date(Date.now() - 60_000).toISOString()), session(undefined, "another-user")]) {
    ownerReply = reply(200, body);
    const before = calls.length;
    await assert.rejects(requireSession(request), error => error instanceof GatewayError && error.status === 401);
    assert.equal(calls.length, before + 1);
  }

  ownerReply = reply(200, session());
  const beforeValid = calls.length;
  assert.deepEqual(await requireSession(request), sessionFromReply(ownerReply));
  assert.equal(calls.length, beforeValid + 1);
  assert.equal(calls.at(-1)?.subject, "brai.auth.v1.session");
  assert.equal(calls.at(-1)?.timeout, 10000);
  assert.deepEqual(calls.at(-1)?.payload, { headers: { cookie: "session=fake" }, body: {} });

  const expected = new Request("https://brai.example/api/timer", { headers: { cookie: "session=fake", "x-brai-user": "user-1" } });
  const beforeAccount = calls.length;
  await requireTimerSession(expected);
  assert.equal(calls.length, beforeAccount + 1);
  const mismatch = new Request("https://brai.example/api/timer", { headers: { cookie: "session=fake", "x-brai-user": "different-user" } });
  const beforeMismatch = calls.length;
  await assert.rejects(requireTimerSession(mismatch), error => error instanceof GatewayError && error.status === 401);
  assert.equal(calls.length, beforeMismatch + 1);
});

test("requireSession rejects malformed owner envelopes with the actual JSON Schema", async () => {
  ownerReply = { status: 200, body: null };
  const requireSession = auth.requireSession as (request: Request) => Promise<unknown>;
  await assert.rejects(requireSession(new Request("https://brai.example/api/auth/session")), error => error instanceof GatewayError && error.status === 503 && error.code === "AUTH_UNAVAILABLE");
  assert.equal(calls.at(-1)?.subject, "brai.auth.v1.session");
});

function sessionFromReply(value: unknown) { return (value as { body: unknown }).body; }

test("document bootstrap forwards cookie through real auth and returns only public identity", async () => {
  const load = accountSession.loadAccountSession as (headers: Headers) => Promise<unknown>;
  const before = calls.length;
  assert.deepEqual(await load(new Headers()), { status: "anonymous" });
  assert.equal(calls.length, before, "anonymous document needs no owner lookup");
  ownerReply = reply(200, { ...session(), token: "never-serialize-token" });
  const headers = new Headers({ cookie: "session=fake" });
  assert.deepEqual(await load(headers), { status: "authenticated", user: { id: "user-1", email: "person@example.test" } });
  assert.equal(calls.length, before + 1);
  assert.deepEqual(calls.at(-1)?.payload, { headers: { cookie: "session=fake" }, body: {} });
});

test("new documents distinguish expired or revoked sessions from temporary auth failure", async () => {
  const load = accountSession.loadAccountSession as (headers: Headers) => Promise<unknown>;
  const headers = new Headers({ cookie: "session=fake" });
  for (const status of [401, 403]) {
    ownerReply = reply(status, null);
    assert.deepEqual(await load(headers), { status: "anonymous" });
  }
  ownerReply = reply(200, session(new Date(Date.now() - 1).toISOString()));
  assert.deepEqual(await load(headers), { status: "anonymous" });
  for (const status of [429, 500, 503]) {
    ownerReply = reply(status, null);
    assert.deepEqual(await load(headers), { status: "unavailable" });
  }
  ownerReply = { status: 200, body: null };
  assert.deepEqual(await load(headers), { status: "unavailable" });
});

test("server-confirmed role survives document bootstrap when the web identity setting is absent", async () => {
  const previous = process.env.WEB_IDENTITY_MODE;
  delete process.env.WEB_IDENTITY_MODE;
  try {
    const load = accountSession.loadAccountSession as (headers: Headers) => Promise<{ status: string; user: { role?: string; status?: string } }>;
    const headers = new Headers({ cookie: "session=fake" });
    for (const role of ["admin", "user"] as const) {
      ownerReply = reply(200, { ...session(), user: { id: "user-1", name: "Имя", role, status: "active" } });
      const result = await load(headers);
      assert.equal(result.user.role, role);
      assert.equal(result.user.status, "active");
    }
  } finally { if (previous === undefined) delete process.env.WEB_IDENTITY_MODE; else process.env.WEB_IDENTITY_MODE = previous; }
});

test("Telegram identity rejects blocked users and redeems a code once through v2", async () => {
  const previous = process.env.WEB_IDENTITY_MODE;
  process.env.WEB_IDENTITY_MODE = "telegram";
  try {
    const request = new Request("https://brai.example/api/auth/session", { headers: { cookie: "session=fake" } });
    const requireSession = auth.requireSession as (request: Request) => Promise<unknown>;
    const authRequest = auth.authRequest as (request: Request, operation: string, body: object) => Promise<unknown>;
    const identity = { ...session(), user: { id: "user-1", name: "Имя", role: "user", status: "active", telegramId: "1", profileId: null } };
    ownerReply = reply(200, identity);
    assert.deepEqual(await requireSession(request), identity);
    const load = accountSession.loadAccountSession as (headers: Headers) => Promise<{ status: string; user: { agentOwnerId: string | null } }>;
    assert.equal((await load(new Headers({ cookie: "session=fake" }))).user.agentOwnerId, null);
    ownerReply = reply(200, { ...identity, user: { ...identity.user, role: "admin" } });
    assert.equal((await load(new Headers({ cookie: "session=fake" }))).user.agentOwnerId, "user-1");
    ownerReply = reply(200, { ...identity, user: { ...identity.user, status: "blocked" } });
    await assert.rejects(requireSession(request), error => error instanceof GatewayError && error.status === 401);
    ownerReply = reply(200, { success: true });
    const before = calls.length;
    await authRequest(request, "login-code-redeem", { code: "0123456789AB" });
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)?.subject, "brai.auth.v2.login-code-redeem");
    await assert.rejects(authRequest(request, "login-code-redeem", { code: "INVALID" }), error => error instanceof GatewayError && error.status === 400);
  } finally { if (previous === undefined) delete process.env.WEB_IDENTITY_MODE; else process.env.WEB_IDENTITY_MODE = previous; }
});
