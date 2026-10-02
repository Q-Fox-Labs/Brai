// ABOUTME: Проверяет SSE агента при быстром источнике, медленном клиенте и сбоях связи.
// ABOUTME: Использует настоящий шлюз и ReadableStream, заменяя только NATS и проверку сессии.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { encodeFrame, decodeFrame } from "../lib/agent/stream.ts";
import type { NativeSnapshot } from "@brai/agent/contracts";

const root = process.env.BRAI_STREAM_TEST_ROOT ?? resolve(import.meta.dirname, "../../..");
const filename = process.env.BRAI_STREAM_TEST_SOURCE ?? resolve(root, "apps/web/server/agent-http.ts");
const require = createRequire(pathToFileURL(resolve(root, "apps/web/server/agent-http.ts")));
const ts = require("typescript") as typeof import("typescript");
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const base: NativeSnapshot = {
  projectId: "brai", threadId: "thread-fixture", generation: "generation-1", epoch: "epoch-1", seq: 0,
  thread: { id: "thread-fixture", title: "Fixture", preview: "Fixture", model: null, canAcceptDirectInput: true, updatedAt: 1 },
  turn: { id: "turn-fixture", status: "inProgress" }, state: "inProgress", items: [], requests: [], truncated: false,
};
const session = { user: { id: "user-fixture", email: "sse@example.test" }, session: { id: "session-fixture", userId: "user-fixture" } };

function fixture(initial: NativeSnapshot = base, holdOpen = false, multiplex = false) {
  let callback: (error: Error | null, message: { data: Uint8Array }) => void;
  let stopped = false, statusFailures = 0, ready = true, allowed = true;
  let releaseOpen: (value: NativeSnapshot) => void = () => {};
  const intervals = new Map<number, () => Promise<void>>();
  const commands: { action: string; itemIds?: string[] }[] = [];
  const nc = {
    async *status() { await new Promise<void>(() => {}); yield { type: "unused" }; },
    subscribe(_subject: string, options: { callback: typeof callback }) {
      callback = options.callback;
      return { unsubscribe() { stopped = true; } };
    },
    async request(_subject: string, payload: Uint8Array) {
      const command = JSON.parse(Buffer.from(payload).toString()) as { action: string; itemIds?: string[] };
      commands.push(command);
      if (command.action === "status" && statusFailures > 0) { statusFailures--; throw new Error("temporary"); }
      const result = command.action === "projects" ? { generation: initial.generation, projects: [{ projectId: "brai", available: true }, { projectId: "admin", available: true }, { projectId: "hidden", available: false }] } : command.action === "status" ? { generation: initial.generation, ready } : holdOpen ? await new Promise<NativeSnapshot>(resolve => { releaseOpen = resolve; }) : initial;
      return { data: Buffer.from(JSON.stringify(result)), headers: { get: () => undefined } };
    },
  };
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { agentGet: (request: Request, context: { params: Promise<{ path: string[] }> }) => Promise<Response> } };
  const overrides: Record<string, unknown> = {
    "../lib/agent/stream": { encodeFrame },
    "./gateway": { natsConnection: async () => nc, GatewayError: class extends Error {} },
    "./auth": { checkOrigin() {}, requireTimerSession: async () => { if (!allowed) throw new Error("revoked"); return session; } },
  };
  new Function("require", "module", "exports", "setInterval", "clearInterval", output)(
    (name: string) => overrides[name] ?? require(name), module, module.exports,
    (fn: () => Promise<void>) => { const id = intervals.size + 1; intervals.set(id, fn); return id; },
    (id: number) => { intervals.delete(id); },
  );
  const abort = new AbortController();
  const originalAllowlist = process.env.BRAI_AGENT_ALLOWED_EMAILS;
  process.env.BRAI_AGENT_ALLOWED_EMAILS = session.user.email;
  const response = module.exports.agentGet(new Request(multiplex ? "https://brai.example/api/agent/events?expectedUserId=user-fixture" : "https://brai.example/api/agent/events?projectId=brai&threadId=thread-fixture&expectedUserId=user-fixture", { signal: abort.signal }), { params: Promise.resolve({ path: ["events"] }) });
  return {
    response,
    commands,
    get(path: string, query: URLSearchParams) { return module.exports.agentGet(new Request(`https://brai.example/api/agent/${path}?${query}`), { params: Promise.resolve({ path: [path] }) }); },
    push(snapshot: NativeSnapshot) { callback(null, { data: Buffer.from(JSON.stringify({ projectId: snapshot.projectId, threadId: snapshot.threadId, generation: snapshot.generation, epoch: snapshot.epoch, seq: snapshot.seq, event: { type: "STATE_SNAPSHOT", snapshot } })) }); },
    releaseOpen(snapshot: NativeSnapshot) { releaseOpen(snapshot); },
    failStatus(times: number) { statusFailures = times; },
    unavailable() { ready = false; },
    revoke() { allowed = false; },
    async tick() { for (const fn of intervals.values()) await fn(); },
    get stopped() { return stopped; },
    close() { abort.abort(); if (originalAllowlist === undefined) delete process.env.BRAI_AGENT_ALLOWED_EMAILS; else process.env.BRAI_AGENT_ALLOWED_EMAILS = originalAllowlist; },
  };
}

async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SSE delivery timeout")), 1000); })]);
    assert.equal(value.done, false);
    const frame = new TextDecoder().decode(value.value);
    return { type: frame.split("\n")[0], data: JSON.parse(frame.split("\ndata: ")[1]) as ReturnType<typeof encodeFrame> };
  } finally { clearTimeout(timer); }
}

function large(seq: number): NativeSnapshot {
  return { ...base, seq, items: Array.from({ length: 120 }, (_value, index) => ({ id: `item-${index}`, turnId: "turn-fixture", type: "agentMessage", text: index === 119 ? `Latest ${seq}` : "x".repeat(4000) })) };
}

test("SSE burst and paused consumer retain latest state without disconnect or obsolete backlog", async () => {
  const f = fixture(large(0));
  try {
    const response = await f.response;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await next(reader)).data.seq, 0);
    for (let seq = 1; seq <= 40; seq++) f.push(large(seq));
    await wait(80);
    for (let seq = 41; seq <= 80; seq++) f.push(large(seq));
    await wait(80);
    assert.equal(f.stopped, false, "a slow consumer must not lose its stream");
    assert.equal((await next(reader)).data.seq, 40);
    const started = performance.now();
    assert.equal((await next(reader)).data.seq, 80);
    assert.ok(performance.now() - started < 500, "the latest text must arrive without replaying forty obsolete frames");
    await reader.cancel();
    assert.equal(f.stopped, true);
  } finally { f.close(); }
});

test("SSE merges observations received while the opening query is pending", async () => {
  const f = fixture(base, true);
  try {
    const reader = (await f.response).body!.getReader();
    await wait(0);
    f.push({ ...base, seq: 12 });
    f.releaseOpen({ ...base, seq: 10 });
    assert.equal((await next(reader)).data.seq, 12);
    assert.equal(f.stopped, false);
  } finally { f.close(); }
});

test("SSE ignores foreign chats and stale seq; generation change requires a fresh stream", async () => {
  const f = fixture();
  try {
    const reader = (await f.response).body!.getReader();
    await next(reader);
    f.push({ ...base, seq: 4 });
    f.push({ ...base, seq: 100, threadId: "foreign-chat", thread: { ...base.thread, id: "foreign-chat" } });
    f.push({ ...base, seq: 3 });
    assert.equal((await next(reader)).data.seq, 4);
    f.push({ ...base, generation: "generation-2", seq: 5 });
    assert.equal(f.stopped, true);
  } finally { f.close(); }
});

test("SSE heartbeat keeps an idle stream open and one status failure does not disconnect", async () => {
  const f = fixture();
  try {
    const reader = (await f.response).body!.getReader();
    await next(reader);
    f.failStatus(1);
    await f.tick();
    assert.equal((await next(reader)).type, "event: heartbeat");
    assert.equal(f.stopped, false);
    await f.tick();
    await next(reader);
    assert.equal(f.stopped, false);
    f.failStatus(3);
    for (let i = 0; i < 3; i++) { await f.tick(); await next(reader); }
    assert.equal(f.stopped, true, "repeated unavailability must still close the stream");
  } finally { f.close(); }
});

test("SSE immediately closes on revoked session or confirmed executor unavailability", async () => {
  for (const cause of ["session", "executor"]) {
    const f = fixture();
    try {
      const reader = (await f.response).body!.getReader();
      await next(reader);
      if (cause === "session") f.revoke(); else f.unavailable();
      await f.tick();
      assert.equal(f.stopped, true);
    } finally { f.close(); }
  }
});


test("one account stream filters unavailable projects and transmits compact standard deltas", async () => {
  const f = fixture(large(0), false, true);
  try {
    const reader = (await f.response).body!.getReader();
    assert.equal((await next(reader)).type, "event: ready");
    f.push(large(0));
    const initial = (await next(reader)).data;
    assert.equal(initial.event.type, "STATE_SNAPSHOT");
    const before = decodeFrame(initial);
    f.push(large(1));
    const update = (await next(reader)).data;
    assert.equal(update.event.type, "STATE_DELTA");
    assert.ok(JSON.stringify(update).length < 2000, "history must not be retransmitted on each text change");
    assert.equal(decodeFrame(update, before).items.at(-1)!.text, "Latest 1");
    f.push({ ...base, projectId: "hidden", seq: 1 });
    f.push({ ...base, projectId: "admin", seq: 1 });
    assert.equal((await next(reader)).data.projectId, "admin");
    f.push({ ...base, generation: "generation-2", seq: 2 });
    assert.equal(f.stopped, true);
  } finally { f.close(); }
});

test("delta bases follow sent frames even when many source snapshots are coalesced", async () => {
  const f = fixture(large(0), false, true);
  try {
    const reader = (await f.response).body!.getReader();
    await next(reader); f.push(large(0));
    let snapshot = decodeFrame((await next(reader)).data);
    for (let seq = 1; seq <= 40; seq++) f.push(large(seq));
    await wait(80);
    for (let seq = 41; seq <= 80; seq++) f.push(large(seq));
    await wait(80);
    snapshot = decodeFrame((await next(reader)).data, snapshot);
    assert.equal(snapshot.seq, 40);
    snapshot = decodeFrame((await next(reader)).data, snapshot);
    assert.equal(snapshot.seq, 80);
    assert.equal(f.stopped, false);
  } finally { f.close(); }
});


test("HTTP lazy reads parse bounded JSON itemIds and reject malformed or duplicated query fields before publishing", async () => {
  const f = fixture();
  try {
    await f.response;
    const query = new URLSearchParams({ projectId: "brai", threadId: "thread-fixture", turnId: "turn-fixture", itemIds: JSON.stringify(["first", "second"]) });
    assert.equal((await f.get("activities", query)).status, 200);
    assert.deepEqual(f.commands.at(-1), { action: "activities", projectId: "brai", threadId: "thread-fixture", turnId: "turn-fixture", itemIds: ["first", "second"] });
    const published = f.commands.length;
    query.set("itemIds", "first,second"); assert.equal((await f.get("activities", query)).status, 400);
    query.set("itemIds", JSON.stringify(Array.from({ length: 101 }, (_, i) => String(i)))); assert.equal((await f.get("activities", query)).status, 400);
    query.set("itemIds", JSON.stringify(["first", "first"])); assert.equal((await f.get("activities", query)).status, 400);
    query.set("itemIds", JSON.stringify(["first"])); query.append("itemIds", JSON.stringify(["second"])); assert.equal((await f.get("activities", query)).status, 400);
    assert.equal(f.commands.length, published);
  } finally { f.close(); }
});
