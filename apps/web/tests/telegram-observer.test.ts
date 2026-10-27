// ABOUTME: Проверяет авторизацию Telegram-наблюдения и выдачи файлов.
// ABOUTME: Использует синтетическую сессию и подменённые NATS ответы.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

test("наблюдение доступно всем сессиям DEV, файл требует связи и владельца", async () => {
  const keys = ["BRAI_ENVIRONMENT", "BRAI_WEB_AGENT_MODE", "BRAI_WEB_TELEGRAM_OBSERVER_ENABLED"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { BRAI_ENVIRONMENT: "dev", BRAI_WEB_AGENT_MODE: "hermes_telegram", BRAI_WEB_TELEGRAM_OBSERVER_ENABLED: "1" });
  const id = "11111111-1111-4111-8111-111111111111";
  let allowed = true, authenticated = true, owner = "owner", observedAfter = -1;
  class Failure extends Error {
    status: number; code: string;
    constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
  }
  const session = { session: { id: "session" }, user: { id: "any-dev-user" } };
  const nats = { async request(subject: string, data: Uint8Array) {
    const input = JSON.parse(Buffer.from(data).toString());
    if (input.action === "changes") observedAfter = input.after;
    const value = input.action === "changes" ? { cursor: input.after + 3, changes: [1, 2, 3].map(offset => ({ change_seq: input.after + offset, identity: `message-${offset}` })) }
      : subject.endsWith(".query") ? { allowed, ownerId: "owner", cursor: 0, chats: [] } : { ownerId: owner, status: "ready", filename: "image.png", mimeType: "image/png" };
    return { data: Buffer.from(JSON.stringify(value)), headers: { has: () => false } };
  } };
  const filename = new URL("../server/telegram-observer.ts", import.meta.url);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Record<string, any> };
  const original = createRequire(filename);
  const dependencies: Record<string, unknown> = {
    "./auth": { requireSession: async () => { if (!authenticated) throw new Failure(401, "UNAUTHORIZED"); return session; } },
    "./gateway": { GatewayError: Failure, natsConnection: async () => nats },
    "./agent-artifacts": { agentResultsConnection: async () => nats },
    "../../../services/artifacts/contracts/index.mjs": { subjects: { get: "brai.artifacts.v1.get" }, validateRequest: () => true, validateResponse: () => true },
  };
  new Function("require", "module", "exports", output)((name: string) => dependencies[name] ?? original(name), module, module.exports);
  const auth = () => new Request("https://dev.test/api/telegram-observer/file-auth", { headers: {
    "x-forwarded-method": "GET", "x-forwarded-uri": `/api/telegram-observer/files/${id}?message=telegram%3A123%3A44`,
  } });
  try {
    assert.equal((await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/chats"))).status, 200);
    assert.equal((await module.exports.observerFileAuth(auth())).status, 200);
    for (const uri of [`//other.test/api/telegram-observer/files/${id}?message=x`, `/\\other.test/api/telegram-observer/files/${id}?message=x`, `/api/telegram-observer/files/${id}?message=x#fragment`, `/api/telegram-observer/files/${id}?message=x&message=y`]) {
      const bad = new Request("https://dev.test/api/telegram-observer/file-auth", { headers: { "x-forwarded-method": "GET", "x-forwarded-uri": uri } });
      assert.equal((await module.exports.observerFileAuth(bad)).status, 400);
    }
    const stream = await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/events?after=3", { headers: { "last-event-id": "7" } }));
    const reader = stream.body!.getReader(), chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /id: 8\nevent: message/);
    assert.equal(observedAfter, 7);
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: 9\nevent: message/);
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: 10\nevent: message/);
    await reader.cancel();
    const streams = await Promise.all(Array.from({ length: 64 }, () => module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/events?after=7"))));
    assert.ok(streams.every((response: Response) => response.status === 200));
    assert.equal((await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/events?after=7"))).status, 503);
    await Promise.all(streams.map((response: Response) => response.body!.cancel()));
    const reopened = await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/events?after=8"));
    assert.equal(reopened.status, 200);
    await reopened.body!.cancel();
    allowed = false;
    assert.equal((await module.exports.observerFileAuth(auth())).status, 404);
    allowed = true; owner = "another-owner";
    assert.equal((await module.exports.observerFileAuth(auth())).status, 404);
    owner = "owner"; authenticated = false;
    assert.equal((await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/chats"))).status, 401);
    assert.equal((await module.exports.observerFileAuth(auth())).status, 401);
    authenticated = true; process.env.BRAI_WEB_TELEGRAM_OBSERVER_ENABLED = "0";
    assert.equal((await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/chats"))).status, 404);
    process.env.BRAI_WEB_TELEGRAM_OBSERVER_ENABLED = "1"; process.env.BRAI_ENVIRONMENT = "prod";
    assert.equal((await module.exports.observerGet(new Request("https://dev.test/api/telegram-observer/chats"))).status, 404);
    assert.equal((await module.exports.observerFileAuth(auth())).status, 404);
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
