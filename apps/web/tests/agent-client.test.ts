// ABOUTME: Проверяет одно SSE, фоновые чаты и скорость настоящего passive AG-UI SDK.
// ABOUTME: Заменяет HTTP/EventSource; код клиента и upstream SDK исполняются без упрощений.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { AbstractAgent, defaultApplyEvents } from "@ag-ui/client";
import { EventSchema } from "@ag-ui/core/schemas";
import * as rxjs from "rxjs";
import * as contracts from "@brai/agent/contracts";
import type { NativeSnapshot } from "@brai/agent/contracts";
import { encodeFrame, decodeFrame, decodeWireFrame } from "../lib/agent/stream.ts";
const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const base = (id: string, seq = 0): NativeSnapshot => ({ projectId: "brai", threadId: id, generation: "gen", epoch: `epoch-${id}`, seq, thread: { id, title: id, preview: "", model: null, canAcceptDirectInput: true, updatedAt: 1 }, turn: null, state: "completed", requests: [], truncated: false, items: [{ id: "message", turnId: "turn", type: "agentMessage", text: "Начало" }] });
const envelope = (s: NativeSnapshot) => ({ projectId: s.projectId, threadId: s.threadId, generation: s.generation, epoch: s.epoch, seq: s.seq, event: { type: "STATE_SNAPSHOT" as const, snapshot: s } });
function fixture() {
  const sources: FakeSource[] = [], calls: string[] = [], snapshots = new Map<string, NativeSnapshot>();
  const requests: { path: string; method: string; body: BodyInit | null | undefined }[] = [];
  let applications = 0;
  class FakeSource extends EventTarget {
    onerror: (() => void) | null = null;
    closed = false;
    url: string;
    constructor(url: string) { super(); this.url = url; sources.push(this); }
    close() { this.closed = true; }
    send(type: string, value: unknown) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) })); }
  }
  const source = readFileSync(new URL("../lib/agent/client.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { createAgentClient: typeof import("../lib/agent/client").createAgentClient } };
  const ports: Record<string, unknown> = { "@ag-ui/client": { AbstractAgent, defaultApplyEvents: (...args: Parameters<typeof defaultApplyEvents>) => { applications++; return defaultApplyEvents(...args); } }, "@ag-ui/core/schemas": { EventSchema }, rxjs, "@brai/agent/contracts": contracts, "./stream": { decodeWireFrame } };
  new Function("require", "module", "exports", "EventSource", "fetch", compiled)(
    (name: string) => ports[name] ?? require(name), module, module.exports, FakeSource,
    async (path: string, options: RequestInit) => { const url = new URL(path, "https://example.test"); calls.push(path); requests.push({ path, method: options.method!, body: options.body }); const id = url.searchParams.get("threadId")!; return Response.json(url.pathname.endsWith("/goalGet") ? { generation: "gen", goal: { state: "ready", value: null } } : snapshots.get(id) ?? base(id)); },
  );
  const client = module.exports.createAgentClient("account", () => assert.fail("unexpected auth failure"));
  return { client, sources, calls, snapshots, requests, get applications() { return applications; } };
}

test("goalGet uses query-only GET without mutation body or automatic turn", async () => {
  const f = fixture();
  try {
    const value = await f.client.request({ action: "goalGet", projectId: "brai", threadId: "A" });
    assert.deepEqual(value.goal, { state: "ready", value: null });
    assert.deepEqual(f.requests, [{ path: "/api/agent/goalGet?projectId=brai&threadId=A", method: "GET", body: undefined }]);
    assert.equal(f.sources.length, 0);
  } finally { f.client.dispose(); }
});
test("read state uses GET and idempotent readMark uses POST without browser-selected owner", async () => {
  const f = fixture();
  try {
    await f.client.request({ action: "readState" });
    await f.client.request({ action: "readMark", projectId: "brai", threadId: "A", messageId: "final", lastMessageAt: 100 });
    assert.deepEqual(f.requests, [
      { path: "/api/agent/readState?", method: "GET", body: undefined },
      { path: "/api/agent/readMark", method: "POST", body: JSON.stringify({ projectId: "brai", threadId: "A", messageId: "final", lastMessageAt: 100 }) },
    ]);
    assert.equal(f.sources.length, 0);
    await assert.rejects(f.client.request({ action: "readState", ownerId: "other" }), /INVALID_ARGUMENT/);
    await assert.rejects(f.client.request({ action: "readMark", projectId: "brai", threadId: "A", messageId: "final", lastMessageAt: -1 }), /INVALID_ARGUMENT/);
    assert.equal(f.requests.length, 2);
  } finally { f.client.dispose(); }
});

test("A→B→A keeps one stream, immediate SDK state and background text without repeated open", async () => {
  const f = fixture();
  try {
    let shown: NativeSnapshot | null = null;
    let stop = f.client.watch("brai", "A", value => { shown = value; });
    assert.equal(f.calls.length, 0);
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 0);
    f.sources[0].send("agent", envelope(base("A")));
    stop(); stop = f.client.watch("brai", "B", value => { shown = value; }); await tick();
    const next = { ...base("A", 1), items: [{ ...base("A").items[0], text: "Фоновое сообщение" }] };
    f.sources[0].send("agent", encodeFrame(envelope(next), base("A"))); await tick();
    stop(); stop = f.client.watch("brai", "A", value => { shown = value; });
    assert.equal((shown as NativeSnapshot | null)?.items[0].text, "Фоновое сообщение");
    assert.equal(f.sources.length, 1); assert.equal(f.sources[0].closed, false);
    assert.equal(f.calls.filter(path => path.includes("/open")).length, 2);
    assert.equal(f.applications, 2);
    stop();
  } finally { f.client.dispose(); }
  assert.equal(f.sources[0].closed, true);
});

test("480 KB history avoids redundant full serialization and obsolete prefixes", async t => {
  const f = fixture();
  const stringify = JSON.stringify;
  try {
    const initial = { ...base("A"), items: Array.from({ length: 120 }, (_, i) => ({ id: `item-${i}`, turnId: "turn", type: "agentMessage", text: i === 119 ? "" : "x".repeat(4000) })) };
    f.snapshots.set("A", initial);
    const updates: number[] = [];
    f.client.watch("brai", "A", value => { if (value) updates.push(value.seq); });
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].send("agent", envelope(initial));
    let fullSerializations = 0;
    const historyCharacters = initial.items.reduce((total, item) => total + item.text.length, 0);
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const encoded = stringify(...args);
      if (typeof encoded === "string" && encoded.length >= historyCharacters) fullSerializations++;
      return encoded;
    }) as typeof JSON.stringify;
    const started = performance.now(); let previous = initial;
    for (let seq = 1; seq <= 80; seq++) {
      const current = { ...initial, seq, items: initial.items.map((item, i) => i === 119 ? { ...item, text: "Проверяю передачу событий. ".repeat(seq) } : item) };
      const frame = encodeFrame(envelope(current), previous);
      assert.ok(JSON.stringify(frame).length < 4000);
      f.sources[0].send("agent", frame); previous = current;
    }
    await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 80);
    assert.equal(f.client.current("brai", "A")!.items.at(-1)!.text, previous.items.at(-1)!.text);
    assert.ok(updates.length < 10, "SDK must coalesce pending snapshots rather than replay all prefixes");
    t.diagnostic(`Обработка 80 кадров: ${Math.round(performance.now() - started)} мс`);
    // На кадр остаются JSON-копия и проверка размера оболочки.
    assert.ok(fullSerializations <= 2 * 80,
              `redundant full history serialization: ${fullSerializations}`);
  } finally { JSON.stringify = stringify; f.client.dispose(); }
});

test("real gaps block stale state; ready refreshes once, seq rollback is ignored", async () => {
  const f = fixture();
  try {
    f.client.watch("brai", "A", () => {}); f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].onerror!(); assert.equal(f.client.current("brai", "A"), null);
    f.snapshots.set("A", base("A", 10));
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 10);
    f.sources[0].send("agent", envelope(base("A", 3))); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 10);
    assert.equal(f.calls.length, 2); assert.equal(f.sources.length, 1);
  } finally { f.client.dispose(); }
});

test("delta validation refuses missing base and prototype changes; reconstruction preserves prior snapshot", () => {
  const previous = base("A"), next = { ...base("A", 1), items: [{ ...base("A").items[0], text: "Обновлено" }] };
  const frame = encodeFrame(envelope(next), previous);
  assert.deepEqual(decodeFrame(frame, previous), next);
  assert.equal(previous.seq, 0);
  assert.equal(previous.items[0].text, "Начало");
  assert.throws(() => decodeFrame(frame), /STREAM_BASE_MISMATCH/);
  assert.throws(() => decodeFrame({ ...frame, event: { type: "STATE_DELTA", delta: [{ op: "add", path: "/__proto__/polluted", value: true }] }, baseSeq: 0 }, previous));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("delta retains JSON-clone semantics for exceptional values and failed patches", () => {
  const sparse: unknown[] = [1, ,]; (sparse as unknown as { extra: number }).extra = 2;
  const values = [-0, Infinity, sparse, { toJSON: () => "custom" }, new Proxy({ text: "plain" }, {})];
  for (const extra of values) {
    const previous = { ...base("A"), extra } as NativeSnapshot;
    const frame = { ...envelope(base("A", 1)), baseSeq: 0,
      event: { type: "STATE_DELTA" as const, delta: [{ op: "replace" as const, path: "/seq", value: 1 }] } };
    const expected = JSON.parse(JSON.stringify(previous)); expected.seq = 1;
    assert.deepEqual(decodeFrame(frame, previous), expected);
    assert.equal(previous.seq, 0);
    assert.throws(() => decodeFrame({ ...frame, event: { type: "STATE_DELTA", delta: [
      { op: "replace", path: "/items/0/text", value: "Изменено" },
      { op: "replace", path: "/missing", value: 1 },
    ] } }, previous));
    assert.equal(previous.items[0].text, "Начало");
  }
});

test("wire JSON preserves both UTF-8 limits at and beyond their boundaries", () => {
  const within = { ...base("A"), items: [{ ...base("A").items[0], text: "" }] };
  const overhead = contracts.bytes(within);
  const boundary = { ...within, items: [{ ...within.items[0], text: "x".repeat(contracts.limits.state - overhead) }] };
  assert.equal(contracts.bytes(boundary), contracts.limits.state);
  const frame = envelope(boundary);
  assert.deepEqual(decodeWireFrame(JSON.stringify(frame)), boundary);
  const above = { ...boundary, items: [{ ...boundary.items[0], text: boundary.items[0].text + "x" }] };
  assert.throws(() => decodeWireFrame(JSON.stringify(envelope(above))), /BAD_EVENT/);
  assert.throws(() => decodeWireFrame(JSON.stringify({ ...envelope(within), padding: "x".repeat(contracts.limits.frame) })), /BAD_EVENT/);
  for (const text of ["кириллица 😀", "\\\"\n\ud800", "😃".repeat(4000)]) {
    const snapshot = { ...within, items: [{ ...within.items[0], text }] };
    const raw = JSON.stringify(envelope(snapshot));
    assert.deepEqual(decodeWireFrame(raw), decodeFrame(JSON.parse(raw)));
  }
});

test("wire delta rejects oversized snapshots and prototype changes without altering the base", () => {
  const previous = base("A");
  const frame = { ...envelope(base("A", 1)), baseSeq: 0, event: { type: "STATE_DELTA" as const, delta: [
    { op: "replace" as const, path: "/seq", value: 1 },
    { op: "replace" as const, path: "/items/0/text", value: "я".repeat(contracts.limits.state / 2) },
  ] } };
  assert.throws(() => decodeWireFrame(JSON.stringify(frame), previous), /BAD_EVENT/);
  for (const operation of [
    { op: "add", path: "/__proto__/polluted", value: true },
    { op: "add", path: "/constructor/prototype/polluted", value: true },
    { op: "copy", from: "/__proto__/polluted", path: "/items/0/text" },
    { op: "move", from: "/constructor/prototype/polluted", path: "/items/0/text" },
  ]) {
    const malicious = { ...frame, event: { type: "STATE_DELTA", delta: [operation] } };
    assert.throws(() => decodeWireFrame(JSON.stringify(malicious), previous));
  }
  assert.equal(previous.seq, 0);
  assert.equal(previous.items[0].text, "Начало");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("non-string event data is rejected without coercion", async () => {
  const f = fixture();
  try {
    f.client.watch("brai", "A", () => {});
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    let coercions = 0;
    f.sources[0].dispatchEvent(new MessageEvent("agent", { data: { toString() { coercions++; return JSON.stringify(envelope(base("A", 1))); } } }));
    assert.equal(coercions, 0);
    assert.notEqual(f.client.current("brai", "A")?.seq, 1);
  } finally { f.client.dispose(); }
});

test("wire size check retains both limits when built-in prototypes have toJSON", () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value(this: { large?: boolean }, key: string) {
      if (this.large) return key === "snapshot" ? {} : { text: "x".repeat(contracts.limits.state) };
      return this;
    } });
    const snapshot = { ...base("A"), large: true };
    assert.equal(contracts.validateJSONEnvelope(envelope(snapshot)), false);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
  }
});


test("an unopened chat keeps its wire base even when GETopen is ahead of the latest sent frame", async () => {
  const f = fixture();
  try {
    const stop = f.client.watch("brai", "A", () => {});
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].send("agent", envelope(base("B", 10)));
    f.snapshots.set("B", base("B", 15));
    stop(); f.client.watch("brai", "B", () => {}); await tick();
    f.sources[0].send("agent", encodeFrame(envelope(base("B", 20)), base("B", 10))); await tick();
    assert.equal(f.client.current("brai", "B")!.seq, 20);
    assert.equal(f.calls.length, 2); assert.equal(f.sources.length, 1);
  } finally { f.client.dispose(); }
});

test("metadata subscription sees unopened chats without another watch, open or stream", async () => {
  const f = fixture();
  try {
    const changes: NativeSnapshot[] = [];
    const stop = f.client.subscribeThreads(value => changes.push(value));
    assert.equal(f.sources.length, 1);
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    const working = { ...base("unopened", 1), thread: { ...base("unopened").thread, active: true, lastMessageAt: 1234 } };
    f.sources[0].send("agent", envelope(working)); await tick();
    f.sources[0].send("agent", envelope({ ...working, seq: 2, thread: { ...working.thread, active: false } })); await tick();
    assert.deepEqual(changes.map(value => value.thread.active), [true, false]);
    assert.equal(changes[1].thread.lastMessageAt, 1234);
    assert.equal(f.calls.length, 0);
    assert.equal(f.applications, 0);
    stop();
  } finally { f.client.dispose(); }
});

test("authoritative reopen updates metadata even if the passive SDK previously held an active snapshot", async () => {
  const f = fixture();
  try {
    const changes: NativeSnapshot[] = [];
    f.client.subscribeThreads(value => changes.push(value));
    const old = { ...base("A", 8), thread: { ...base("A").thread, active: true } };
    f.snapshots.set("A", old);
    f.client.watch("brai", "A", () => {});
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].onerror!();
    f.snapshots.set("A", { ...old, seq: 10, thread: { ...old.thread, active: false } });
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    assert.equal(changes.at(-1)?.seq, 10);
    assert.equal(changes.at(-1)?.thread.active, false);
  } finally { f.client.dispose(); }
});

test("account limits stay separate, ignore older frames, accept equal revision after reconnect, and clear on generation change", async () => {
  const f = fixture();
  const changes: { state: string; revision: number; windows: { remainingPercent: number }[] }[] = [];
  try {
    f.client.subscribeLimits(value => changes.push(value));
    assert.equal(changes.at(-1)?.state, "loading");
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    const value = (revision: number, remainingPercent: number) => ({ state: "ready", revision, observedAt: 1, windows: [{ slot: "primary", remainingPercent, windowDurationMins: 10080, resetsAt: null }] });
    f.sources[0].send("limits", { generation: "gen", limits: value(5, 40) });
    assert.equal(changes.at(-1)?.windows[0].remainingPercent, 40);
    f.sources[0].onerror!();
    assert.equal(changes.at(-1)?.state, "stale");
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].send("limits", { generation: "gen", limits: value(4, 90) });
    assert.equal(changes.at(-1)?.windows[0].remainingPercent, 40);
    f.sources[0].send("limits", { generation: "gen", limits: value(5, 35) });
    assert.equal(changes.at(-1)?.windows[0].remainingPercent, 35);
    f.sources[0].send("ready", { generation: "next-gen" }); await tick();
    assert.equal(changes.at(-1)?.state, "loading");
    f.sources[0].send("limits", { generation: "gen", limits: value(99, 10) });
    assert.equal(changes.at(-1)?.state, "loading");
    f.sources[0].send("limits", { generation: "next-gen", limits: value(0, 100) });
    assert.equal(changes.at(-1)?.windows[0].remainingPercent, 100);
    const beforeDispose = changes.length;
    f.client.dispose();
    f.sources[0].send("limits", { generation: "next-gen", limits: value(1, 0) });
    assert.equal(changes.length, beforeDispose);
  } finally { f.client.dispose(); }
});

test("lazy read actions encode itemIds as JSON rather than comma-separated query text", async () => {
  const f = fixture();
  try {
    await f.client.request({ action: "activities", projectId: "brai", threadId: "A", turnId: "turn", itemIds: ["first", "second"] });
    const url = new URL(f.calls[0], "https://example.test");
    assert.equal(url.pathname, "/api/agent/activities");
    assert.deepEqual(JSON.parse(url.searchParams.get("itemIds")!), ["first", "second"]);
    assert.equal(f.sources.length, 0);
    await f.client.request({ action: "item", projectId: "brai", threadId: "A", turnId: "turn", itemId: "first" });
    assert.equal(new URL(f.calls[1], "https://example.test").pathname, "/api/agent/item");
    await assert.rejects(f.client.request({ action: "activities", projectId: "brai", threadId: "A", turnId: "turn", itemIds: Array.from({ length: 101 }, (_, i) => String(i)) }), /INVALID_ARGUMENT/);
    assert.equal(f.calls.length, 2);
  } finally { f.client.dispose(); }
});
