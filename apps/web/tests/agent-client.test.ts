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
    async (path: string) => { const url = new URL(path, "https://example.test"); calls.push(path); const id = url.searchParams.get("threadId")!; return Response.json(snapshots.get(id) ?? base(id)); },
  );
  const client = module.exports.createAgentClient("account", () => assert.fail("unexpected auth failure"));
  return { client, sources, calls, snapshots, get applications() { return applications; } };
}

test("A→B→A keeps one stream, immediate SDK state and background text without repeated open", async () => {
  const f = fixture();
  try {
    let shown: NativeSnapshot | null = null;
    let stop = f.client.watch("brai", "A", value => { shown = value; });
    assert.equal(f.calls.length, 0);
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 0);
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

test("real gaps block stale state; ready refreshes once, seq rollback is ignored, missing patch base reloads", async () => {
  const f = fixture();
  try {
    f.client.watch("brai", "A", () => {}); f.sources[0].send("ready", { generation: "gen" }); await tick();
    f.sources[0].onerror!(); assert.equal(f.client.current("brai", "A"), null);
    f.snapshots.set("A", base("A", 10));
    f.sources[0].send("ready", { generation: "gen" }); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 10);
    f.sources[0].send("agent", envelope(base("A", 3))); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 10);
    f.snapshots.set("A", base("A", 12));
    f.sources[0].send("agent", encodeFrame(envelope(base("A", 12)), base("A", 11))); await tick();
    assert.equal(f.client.current("brai", "A")!.seq, 12);
    assert.equal(f.calls.length, 3); assert.equal(f.sources.length, 1);
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
