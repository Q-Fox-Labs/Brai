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
import { encodeFrame, decodeFrame } from "../lib/agent/stream.ts";
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
  const ports: Record<string, unknown> = { "@ag-ui/client": { AbstractAgent, defaultApplyEvents: (...args: Parameters<typeof defaultApplyEvents>) => { applications++; return defaultApplyEvents(...args); } }, "@ag-ui/core/schemas": { EventSchema }, rxjs, "@brai/agent/contracts": contracts, "./stream": { decodeFrame } };
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

test("480 KB history does not delay a burst of intermediate text or replay obsolete prefixes", async () => {
  const f = fixture();
  try {
    const initial = { ...base("A"), items: Array.from({ length: 120 }, (_, i) => ({ id: `item-${i}`, turnId: "turn", type: "agentMessage", text: i === 119 ? "" : "x".repeat(4000) })) };
    f.snapshots.set("A", initial);
    const updates: number[] = [];
    f.client.watch("brai", "A", value => { if (value) updates.push(value.seq); });
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].send("agent", envelope(initial));
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
    assert.ok(performance.now() - started < 2000, "text burst must not take eighty seconds");
  } finally { f.client.dispose(); }
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
  const previous = base("A"), next = base("A", 1), frame = encodeFrame(envelope(next), previous);
  assert.deepEqual(decodeFrame(frame, previous), next);
  assert.equal(previous.seq, 0);
  assert.throws(() => decodeFrame(frame), /STREAM_BASE_MISMATCH/);
  assert.throws(() => decodeFrame({ ...frame, event: { type: "STATE_DELTA", delta: [{ op: "add", path: "/__proto__/polluted", value: true }] }, baseSeq: 0 }, previous));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
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
