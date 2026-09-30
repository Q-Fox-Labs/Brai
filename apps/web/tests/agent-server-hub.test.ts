// ABOUTME: Проверяет согласование snapshot, порядок и освобождение SSE agent.
// ABOUTME: Fake hub и snapshot исключают внешний NATS и active-turn side effects.
import assert from "node:assert/strict";
import test from "node:test";
import { AgentHub, agentEventStream } from "../server/agent-hub.ts";
import type { EventEnvelope } from "@brai/agent/contracts";

const generation = "00000000-0000-4000-8000-000000000001";
const epoch = "00000000-0000-4000-8000-000000000002";
const identity = { userId: "u", sessionId: "s", projectId: "brai", threadId: "t" };
const snapshot = (seq: number) => ({ projectId: "brai", threadId: "t", generation, streamEpoch: epoch, seq, state: "ready" as const, messages: [], pendingRequests: [], truncation: { truncated: false, reason: "none" as const }, activeTurnId: null, turnStatus: null, traceItems: [] });
const event = (seq: number, eventGeneration = generation, streamEpoch = epoch): EventEnvelope => ({ projectId: "brai", threadId: "t", turnId: null, generation: eventGeneration, streamEpoch, seq, event: { type: "RUN_STARTED", threadId: "t", runId: `r${seq}` } as EventEnvelope["event"] });
async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return result.done ? null : new TextDecoder().decode(result.value);
}

test("subscribes before snapshot and drops buffered events through snapshot watermark", async () => {
  const hub = new AgentHub(); let release!: (value: ReturnType<typeof snapshot>) => void;
  const waiting = new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve; });
  const stream = agentEventStream(hub, () => waiting, new AbortController().signal, identity, async () => true);
  const reader = stream.getReader();
  hub.broadcast(event(1));
  hub.broadcast(event(1, "00000000-0000-4000-8000-000000000003", epoch));
  release(snapshot(1));
  assert.match((await nextFrame(reader))!, /id: .*:1\nevent: snapshot/);
  hub.broadcast(event(1));
  hub.broadcast(event(2));
  assert.match((await nextFrame(reader))!, /id: .*:2\nevent: agent/);
  await reader.cancel();
});

test("a post-snapshot gap closes the stream and never emits later events", async () => {
  const hub = new AgentHub();
  const reader = agentEventStream(hub, async () => snapshot(4), new AbortController().signal, identity, async () => true).getReader();
  assert.match((await nextFrame(reader))!, /event: snapshot/);
  hub.broadcast(event(6));
  assert.equal(await nextFrame(reader), null);
});

test("slow consumers hit the bounded queue, while cancel and logout only release streams", async () => {
  const hub = new AgentHub();
  const reader = agentEventStream(hub, async () => snapshot(0), new AbortController().signal, identity, async () => true).getReader();
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let seq = 1; seq <= 65; seq++) hub.broadcast(event(seq));
  assert.match((await nextFrame(reader))!, /event: snapshot/);
  let frames = 0;
  for (;;) { const frame = await nextFrame(reader); if (frame === null) break; frames++; }
  assert.ok(frames <= 64);

  const second = agentEventStream(hub, async () => snapshot(0), new AbortController().signal, { ...identity, sessionId: "logout" }, async () => true).getReader();
  await nextFrame(second);
  hub.invalidate("logout");
  assert.equal(await nextFrame(second), null);
});

test("authorization loss closes the event stream; abort only releases the subscription", async () => {
  const hub = new AgentHub(); const abort = new AbortController(); let checks = 0;
  const reader = agentEventStream(hub, async () => snapshot(0), abort.signal, identity, async () => ++checks < 2).getReader();
  assert.match((await nextFrame(reader))!, /event: snapshot/);
  hub.broadcast(event(1));
  assert.equal(await nextFrame(reader), null);

  const cancel = new AbortController();
  const cancelled = agentEventStream(hub, async () => snapshot(0), cancel.signal, identity, async () => true).getReader();
  cancel.abort(); await cancelled.cancel();
});
