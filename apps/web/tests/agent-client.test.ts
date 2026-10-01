// ABOUTME: Проверяет bounded состояние, AG-UI подключение и команды браузерного клиента.
// ABOUTME: Подмены HTTP и EventSource исключают сеть; примеры используют DTO контракта без копий.
import test from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope, ThreadSnapshot } from "@brai/agent/contracts";
import { limits, validateDto, validateEventEnvelope } from "@brai/agent/contracts";
import { createAgentClient, type AgentEventSource } from "../lib/agent/client.ts";
import { initialAgentClientState } from "../lib/agent/types.ts";
import { reduceAgentState } from "../lib/agent/state.ts";
import { buildAgentTimeline } from "../app/agent/timeline.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const nextGeneration = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333";
const nextEpoch = "44444444-4444-4444-8444-444444444444";

function snapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    projectId: "brai", threadId: "thread", generation, streamEpoch: epoch, seq: 0, state: "ready",
    messages: [], pendingRequests: [], truncation: { truncated: false, reason: "none" },
    activeTurnId: null, turnStatus: null, traceItems: [], ...overrides,
  };
}

function envelope(seq: number, event: unknown, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return { projectId: "brai", threadId: "thread", turnId: null, generation, streamEpoch: epoch, seq, event: event as EventEnvelope["event"], ...overrides };
}

class FakeEventSource implements AgentEventSource {
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, value: unknown) { this.listeners.get(type)?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
  fail() { this.onerror?.(new Event("error")); }
}

function baseFetch(options: { mutation?: (body: unknown, call: number) => Response | Promise<Response>; onMutation?: (body: unknown) => void } = {}) {
  let mutationCalls = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      options.onMutation?.(body);
      mutationCalls += 1;
      if (options.mutation) return options.mutation(body, mutationCalls);
    }
    if (url.endsWith("/threads?projectId=brai")) return Response.json({ generation, threads: [{ threadId: "thread", title: "Чат", updatedAt: "now" }], nextCursor: null });
    if (url.includes("/history?")) return Response.json({ generation, items: [], nextCursor: null, truncation: { truncated: false, reason: "none" } });
    if (url.includes("/threads/thread?projectId=brai")) return Response.json(snapshot());
    if (url.endsWith("/status")) return Response.json({ generation, ready: true, connection: "connected", authorization: "ready" });
    if (url.endsWith("/projects")) return Response.json({ generation, projects: [{ projectId: "brai", name: "Brai", available: true }] });
    return Response.json({ code: "NOT_FOUND", outcome: "query" }, { status: 404 });
  };
  return { fetcher, calls: () => mutationCalls };
}

function makeClient(fetcher = baseFetch().fetcher, sources: FakeEventSource[] = []) {
  return createAgentClient({
    expectedUserId: "user", fetch: fetcher, createId: () => "operation-1",
    createEventSource: () => { const source = new FakeEventSource(); sources.push(source); return source; },
  });
}

async function selectedClient(fetcher = baseFetch().fetcher) {
  const sources: FakeEventSource[] = [];
  const client = makeClient(fetcher, sources);
  await client.selectThread("brai", "thread");
  return { client, sources };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

test("initial project selection loads the default when no manual selection has begun", async () => {
  const client = makeClient();
  await client.getProjects();
  await client.selectInitialProject("brai");
  assert.equal(client.getState().selectedProjectId, "brai");
  assert.equal(client.getState().threads.length, 1);
  await client.dispose();
});

test("late status bootstrap preserves the manually selected thread, live SSE and terminal", async () => {
  let releaseStatus!: (response: Response) => void;
  const status = new Promise<Response>(resolve => { releaseStatus = resolve; });
  const wire = baseFetch({ mutation: () => Response.json({ generation, operationId: "operation-1", threadId: "thread", outcome: "accepted", turnId: "turn-1" }, { status: 202 }) });
  const sources: FakeEventSource[] = [];
  const client = makeClient((input, init) => String(input).endsWith("/status") ? status : wire.fetcher(input, init), sources);
  const bootstrap = Promise.allSettled([client.getProjects(), client.getStatus()]).then(async results => {
    if (results[0].status === "fulfilled") await client.selectInitialProject(results[0].value.projects[0].projectId);
  });
  await tick();
  assert.equal(client.getState().projects.length, 1);
  await client.selectProject("brai");
  await client.selectThread("brai", "thread");
  const source = sources[0];
  source.emit("snapshot", snapshot());
  await tick();
  client.setDraft("work");
  assert.equal((await client.submitDraft()).outcome, "accepted");
  source.emit("agent", envelope(1, { type: "RUN_STARTED", threadId: "thread", runId: "turn-1" }, { turnId: "turn-1" }));
  await tick();
  releaseStatus(Response.json({ generation, ready: true, connection: "connected", authorization: "ready" }));
  await bootstrap;
  assert.equal(client.getState().selectedThreadId, "thread");
  assert.equal(client.getState().threadStatus, "working");
  assert.equal(client.getState().activeTurnId, "turn-1");
  assert.equal(source.closed, false);
  source.emit("agent", envelope(2, { type: "RUN_FINISHED", threadId: "thread", runId: "turn-1", outcome: { type: "success" } }, { turnId: "turn-1" }));
  await tick();
  assert.equal(client.getState().threadStatus, "completed");
  assert.equal(client.getState().activeTurnId, null);
  assert.equal(source.closed, false);
  assert.equal(wire.calls(), 1);
  await client.dispose();
});

test("initial selection cannot overtake manual selection awaiting detach before project dispatch", async () => {
  const client = makeClient();
  const manual = client.selectProject("brai");
  assert.equal(client.getState().selectedProjectId, null);
  assert.equal(await client.selectInitialProject("default"), null);
  await manual;
  assert.equal(client.getState().selectedProjectId, "brai");
  assert.equal(client.getState().threads.length, 1);
  await client.dispose();
});

test("reducer replaces authoritative snapshots, ignores duplicate seq, and reports gaps to its caller", () => {
  let state = reduceAgentState(initialAgentClientState(), { type: "thread", value: snapshot({ seq: 4, messages: [{ id: "m", role: "assistant", content: "snapshot" }] }) });
  state = reduceAgentState(state, { type: "event", value: envelope(5, { type: "RUN_STARTED", threadId: "thread", runId: "turn" }, { turnId: "turn" }) });
  assert.equal(state.threadStatus, "working");
  assert.equal(state.activeTurnId, "turn");
  state = reduceAgentState(state, { type: "thread", value: snapshot({ generation: nextGeneration, streamEpoch: nextEpoch, seq: 1, messages: [{ id: "m2", role: "assistant", content: "replacement" }] }) });
  assert.deepEqual(state.messages.map(message => message.content), ["replacement"]);
  assert.equal(state.generation, nextGeneration);
  assert.equal(state.lastSeq, 1);
});

test("SSE duplicates are ignored and snapshot plus AG-UI deltas, final snapshot and cancel leave one SDK message", async () => {
  const { client, sources } = await selectedClient();
  const messages: unknown[][] = [];
  client.subscribe(state => messages.push(state.messages.map(message => message.content)));
  const source = sources[0];
  source.emit("snapshot", snapshot({ seq: 0 }));
  await tick();
  source.emit("agent", envelope(1, { type: "RUN_STARTED", threadId: "thread", runId: "turn-1" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(1, { type: "RUN_STARTED", threadId: "thread", runId: "turn-1" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(2, { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(3, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Hel" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(4, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "lo" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(5, { type: "TEXT_MESSAGE_END", messageId: "m" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(6, { type: "MESSAGES_SNAPSHOT", messages: [{ id: "m", role: "assistant", content: "Hello" }] }, { turnId: "turn-1" }));
  source.emit("agent", envelope(7, { type: "RUN_FINISHED", threadId: "thread", runId: "turn-1", outcome: { type: "cancelled" } }, { turnId: "turn-1" }));
  await tick();
  const state = client.getState();
  assert.equal(state.lastSeq, 7);
  assert.equal(state.threadStatus, "interrupted");
  assert.equal(state.messages.length, 1, JSON.stringify({ messages: state.messages, trace: messages }));
  assert.deepEqual(state.messages.map(message => message.content), ["Hello"]);
  assert.ok(messages.some(contents => contents.includes("Hello")));
  await client.dispose();
  assert.equal(source.closed, true);
});

test("reconnected SDK hydrates active message and tool lifecycles from snapshot before deltas", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot({
    state: "working", activeTurnId: "turn-1", turnStatus: "inProgress",
    messages: [
      { id: "partial", role: "assistant", content: "Hel" },
      { id: "tool-parent", role: "assistant", toolCalls: [{ id: "call-1", type: "function", function: { name: "exec", arguments: '{"command":"ls' } }] },
    ],
  }));
  await tick();
  source.emit("agent", envelope(1, { type: "TEXT_MESSAGE_CONTENT", messageId: "partial", delta: "lo" }, { turnId: "turn-1" }));
  await tick();
  assert.deepEqual(client.getState().messages.map(message => message.content).filter(Boolean), ["Hello"]);
  source.emit("agent", envelope(2, { type: "TEXT_MESSAGE_END", messageId: "partial" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(3, { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "} }" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(4, { type: "TOOL_CALL_END", toolCallId: "call-1" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(5, { type: "TOOL_CALL_RESULT", toolCallId: "call-1", messageId: "tool-result", role: "tool", content: "done" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(6, { type: "MESSAGES_SNAPSHOT", messages: [
    { id: "partial", role: "assistant", content: "Hello" },
    { id: "tool-parent", role: "assistant", toolCalls: [{ id: "call-1", type: "function", function: { name: "exec", arguments: '{"command":"ls"}' } }] },
    { id: "tool-result", role: "tool", toolCallId: "call-1", content: "done" },
  ] }, { turnId: "turn-1" }));
  source.emit("agent", envelope(7, { type: "RUN_FINISHED", threadId: "thread", runId: "turn-1", outcome: { type: "cancelled" } }, { turnId: "turn-1" }));
  await tick();
  assert.equal(client.getState().threadStatus, "interrupted");
  assert.equal(client.getState().messages.find(message => message.id === "partial")?.content, "Hello");
  assert.equal(client.getState().messages.length, 3);
  await client.dispose();
});

test("phase metadata arriving beside TEXT_START survives asynchronous SDK message updates", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot());
  await tick();
  source.emit("agent", envelope(1, { type: "RUN_STARTED", threadId: "thread", runId: "turn-1" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(2, { type: "TEXT_MESSAGE_START", messageId: "phase-message", role: "assistant" }, { turnId: "turn-1" }));
  source.emit("agent", envelope(3, { type: "CUSTOM", name: "brai.agent.message.phase", value: { itemId: "phase-message", phase: "commentary" } }, { turnId: "turn-1" }));
  await tick();
  assert.equal(client.getState().messagePhases["phase-message"], "commentary");
  assert.equal(client.getState().pendingMessagePhases["phase-message"], undefined);
  await client.dispose();
});

test("gap and generation change reconnect with a fresh snapshot source", async () => {
  const { client, sources } = await selectedClient();
  sources[0].emit("snapshot", snapshot());
  await tick();
  sources[0].emit("agent", envelope(2, { type: "RUN_STARTED", threadId: "thread", runId: "turn" }, { turnId: "turn" }));
  assert.equal(sources.length, 2);
  sources[1].emit("snapshot", snapshot({ generation: nextGeneration, streamEpoch: nextEpoch, seq: 8, state: "completed" }));
  await tick();
  assert.equal(client.getState().generation, nextGeneration);
  assert.equal(client.getState().lastSeq, 8);
  await client.dispose();
});

test("a delayed old-feed SDK callback cannot overwrite a new generation snapshot for the same thread", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-old", turnStatus: "inProgress", messages: [{ id: "old", role: "assistant", content: "old" }] }));
  await tick();
  source.emit("agent", envelope(1, { type: "TEXT_MESSAGE_CONTENT", messageId: "old", delta: " callback" }, { turnId: "turn-old" }));
  source.emit("snapshot", snapshot({ generation: nextGeneration, streamEpoch: nextEpoch, state: "working", activeTurnId: "turn-new", turnStatus: "inProgress", seq: 0, messages: [{ id: "new", role: "assistant", content: "new" }] }));
  await tick();
  await tick();
  assert.equal(client.getState().generation, nextGeneration);
  assert.deepEqual(client.getState().messages.map(message => message.id), ["new"]);
  await client.dispose();
});

test("an old SSE snapshot completing after selection change cannot replace the new thread or feed", async () => {
  const sources: FakeEventSource[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/threads?projectId=other")) return Response.json({ generation, threads: [{ threadId: "thread-2", title: "Новый чат", updatedAt: "now" }], nextCursor: null });
    if (url.includes("/threads/thread-2?projectId=other")) return Response.json(snapshot({ projectId: "other", threadId: "thread-2", messages: [{ id: "new", role: "assistant", content: "новый" }] }));
    if (url.includes("/history?") && url.includes("projectId=other")) return Response.json({ generation, items: [], nextCursor: null, truncation: { truncated: false, reason: "none" } });
    return baseFetch().fetcher(input, init);
  };
  const client = makeClient(fetcher, sources);
  await client.selectThread("brai", "thread");
  const oldSource = sources[0]!;
  oldSource.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-old", turnStatus: "inProgress", messages: [{ id: "old", role: "assistant", content: "старый" }] }));
  await tick();
  oldSource.emit("snapshot", snapshot({ seq: 0, messages: [{ id: "stale", role: "assistant", content: "устаревший снимок" }] }));
  const selectNew = client.selectThread("other", "thread-2");
  await selectNew;
  assert.equal(client.getState().selectedProjectId, "other");
  assert.equal(client.getState().selectedThreadId, "thread-2");
  assert.deepEqual(client.getState().messages.map(message => message.id), ["new"]);
  const newSource = sources.at(-1)!;
  assert.notEqual(newSource, oldSource);
  newSource.emit("snapshot", snapshot({ projectId: "other", threadId: "thread-2", seq: 0, messages: [{ id: "live", role: "assistant", content: "живой" }] }));
  await tick();
  await tick();
  assert.equal(client.getState().selectedThreadId, "thread-2");
  assert.deepEqual(client.getState().messages.map(message => message.id), ["live"]);
  assert.equal(newSource.closed, false);
  await client.dispose();
});

test("unknown mutation is not retried and steer conflict keeps the user's draft", async () => {
  const sent: unknown[] = [];
  const responses: Response[] = [
    Response.json({ code: "TIMEOUT", outcome: "unknown", operationId: "operation-1" }, { status: 504 }),
    Response.json({ code: "OPERATION_CONFLICT", outcome: "not-sent", operationId: "operation-1" }, { status: 409 }),
  ];
  const wire = baseFetch({ mutation: () => responses.shift()!, onMutation: body => sent.push(body) });
  const { client, sources } = await selectedClient(wire.fetcher);
  sources[0].emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress" }));
  await tick();
  client.setDraft("поручи проверить");
  const result = await client.submitDraft();
  assert.equal(result.outcome, "unknown");
  assert.equal(wire.calls(), 1);
  assert.equal(client.getState().draft, "поручи проверить");
  assert.equal((sent[0] as { expectedTurnId: string }).expectedTurnId, "turn-1");
  client.setDraft("добавить условие");
  const conflict = await client.submitDraft();
  assert.equal(conflict.outcome, "failed");
  assert.equal(client.getState().draft, "добавить условие");
  assert.equal(wire.calls(), 2);
  await client.dispose();
});

test("late accepted start response cannot restore a turn already finished on the live stream", async () => {
  let resolvePost!: (response: Response) => void;
  const wire = baseFetch({ mutation: () => new Promise<Response>(resolve => { resolvePost = resolve; }) });
  const { client, sources } = await selectedClient(wire.fetcher);
  const source = sources[0];
  source.emit("snapshot", snapshot({ seq: 0 }));
  await tick();
  client.setDraft("сделай задачу");
  const pending = client.submitDraft();
  source.emit("agent", envelope(1, { type: "RUN_STARTED", threadId: "thread", runId: "turn-late" }, { turnId: "turn-late" }));
  source.emit("agent", envelope(2, { type: "RUN_FINISHED", threadId: "thread", runId: "turn-late", outcome: { type: "success" } }, { turnId: "turn-late" }));
  await tick();
  resolvePost(Response.json({ generation, operationId: "operation-1", outcome: "accepted", threadId: "thread", turnId: "turn-late" }));
  assert.deepEqual(await pending, { outcome: "accepted", turnId: "turn-late" });
  assert.equal(client.getState().activeTurnId, null);
  assert.equal(client.getState().threadStatus, "completed");
  await client.dispose();
});

test("history item rejection remains visible while the selected thread still connects to SSE", async () => {
  const sources: FakeEventSource[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).includes("/history?")) {
      return Response.json({ code: "ITEM_TOO_LARGE", outcome: "query", message: "Элемент истории слишком велик" }, { status: 413 });
    }
    return baseFetch().fetcher(input, init);
  };
  const client = makeClient(fetcher, sources);
  await client.selectThread("brai", "thread");
  assert.match(client.getState().historyError ?? "", /слишком велик/);
  assert.equal(client.getState().connection, "connecting");
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.closed, false);
  sources[0]?.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress" }));
  await tick();
  assert.equal(client.getState().connection, "connected");
  assert.equal(client.getState().historyError, "Элемент истории слишком велик");
  await client.dispose();
});

test("question stays in open run until resolved and stale second answer is never success", async () => {
  const question = { requestId: "req-1", kind: "question", params: { threadId: "thread", turnId: "turn-1", itemId: "item", isBlocking: true, questions: [{ id: "q1", header: "Выбор", question: "Как продолжить?" }] } };
  let postCount = 0;
  const wire = baseFetch({ mutation: (_body, call) => {
    postCount = call;
    return call === 1
      ? Response.json({ generation, operationId: "operation-1", outcome: "accepted", requestId: "req-1" })
      : Response.json({ code: "STALE_REQUEST", outcome: "not-sent", operationId: "operation-1" }, { status: 409 });
  } });
  const first = await selectedClient(wire.fetcher);
  const second = await selectedClient(wire.fetcher);
  const source = first.sources[0];
  const secondSource = second.sources[0];
  source.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress" }));
  secondSource.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress" }));
  await tick();
  source.emit("agent", envelope(1, { type: "CUSTOM", name: "brai.agent.request.opened", value: { request: question } }, { turnId: "turn-1" }));
  secondSource.emit("agent", envelope(1, { type: "CUSTOM", name: "brai.agent.request.opened", value: { request: question } }, { turnId: "turn-1" }));
  assert.equal(validateEventEnvelope(envelope(1, { type: "CUSTOM", name: "brai.agent.request.opened", value: { request: question } }, { turnId: "turn-1" })), true);
  assert.equal(first.client.getState().threadStatus, "waiting");
  assert.equal(first.client.getState().activeTurnId, "turn-1");
  const answer = { answers: { q1: { answers: ["да"] } } };
  assert.equal((await first.client.respond("req-1", "question", answer)).outcome, "accepted");
  assert.equal(first.client.getState().pendingRequests.length, 1);
  assert.equal((await second.client.respond("req-1", "question", answer)).outcome, "failed");
  assert.equal(postCount, 2);
  source.emit("agent", envelope(2, { type: "CUSTOM", name: "brai.agent.request.resolved", value: { requestId: "req-1", outcome: "accepted" } }, { turnId: "turn-1" }));
  secondSource.emit("agent", envelope(2, { type: "CUSTOM", name: "brai.agent.request.resolved", value: { requestId: "req-1", outcome: "accepted" } }, { turnId: "turn-1" }));
  assert.equal(first.client.getState().pendingRequests.length, 0);
  assert.equal(first.client.getState().threadStatus, "working");
  assert.equal(first.client.getState().activeTurnId, "turn-1");
  await first.client.dispose();
  await second.client.dispose();
});

test("passive dispose detaches SSE/SDK without sending interrupt", async () => {
  const wire = baseFetch();
  const { client, sources } = await selectedClient(wire.fetcher);
  sources[0].emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress" }));
  await tick();
  await client.dispose();
  assert.equal(sources[0].closed, true);
  assert.equal(wire.calls(), 0);
});

test("queue, text, history and trace remain within client memory limits", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  for (let seq = 1; seq <= limits.uiQueue + 1; seq += 1) {
    source.emit("agent", envelope(seq, { type: "RUN_STARTED", threadId: "thread", runId: `turn-${seq}` }, { turnId: `turn-${seq}` }));
  }
  assert.equal(sources.length, 2);
  sources[1].emit("agent", "x".repeat(limits.natsSseFrameBytes + 1));
  assert.equal(sources.length, 3);
  const large = "x".repeat(300_000);
  const output = envelope(0, { type: "CUSTOM", name: "brai.agent.output", value: { itemId: "item-large", text: large, contentBytes: large.length } }, { turnId: "turn" });
  const traceState = reduceAgentState(initialAgentClientState(), { type: "thread", value: snapshot({ state: "working", activeTurnId: "turn" }) });
  const next = reduceAgentState(traceState, { type: "event", value: output });
  assert.ok(next.traceItems.length <= 200);
  assert.ok(JSON.stringify(next.traceItems).length < 128 * 1024);
  assert.equal(next.truncation?.truncated, true);
  await client.dispose();
});

test("native command metadata survives validated output deltas and terminal trace updates", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot({
    state: "working", activeTurnId: "turn-1", turnStatus: "inProgress",
    traceItems: [
      { itemId: "earlier", order: 6, kind: "output", content: "first", truncated: false, contentBytes: 5, turnId: "turn-1", trace: { type: "output", status: "completed", output: "first" } },
      { itemId: "native-command", order: 7, kind: "command", content: "old", truncated: false, contentBytes: 3, turnId: "turn-1", trace: { type: "command", status: "inProgress", command: "echo ready", output: "old" } },
      { itemId: "later", order: 8, kind: "output", content: "last", truncated: false, contentBytes: 4, turnId: "turn-1", trace: { type: "output", status: "completed", output: "last" } },
    ],
  }));
  await tick();
  assert.equal(client.getState().activeTurnId, "turn-1");

  const sendOutput = async (seq: number, value: Record<string, unknown>, turnId: string | null = "turn-1") => {
    const frame = envelope(seq, { type: "CUSTOM", name: "brai.agent.output", value }, { turnId });
    assert.equal(validateEventEnvelope(frame), true);
    source.emit("agent", frame);
    await tick();
  };
  await sendOutput(1, { itemId: "native-command", text: "partial", command: "echo ready", status: "inProgress" });
  assert.equal(client.getState().traceItems[1].turnId, "turn-1");
  await sendOutput(2, { itemId: "native-command", text: "failed attempt", status: "failed", exitCode: 17 });
  assert.equal(client.getState().traceItems[1].trace.exitCode, 17);
  let item = client.getState().traceItems[1];
  assert.equal(item.trace.exitCode, 17);
  await sendOutput(3, { itemId: "native-command", text: "complete", status: "completed", exitCode: 0 });
  item = client.getState().traceItems[1];
  assert.equal(item.trace.exitCode, 0);
  await sendOutput(4, { itemId: "native-command", text: "legacy replacement" });

  item = client.getState().traceItems[1];
  assert.equal(client.getState().traceItems.length, 3);
  assert.equal(item.itemId, "native-command");
  assert.equal(item.kind, "command");
  assert.equal(item.order, 7);
  assert.equal(item.turnId, "turn-1");
  assert.equal(item.content, "legacy replacement");
  assert.equal(item.trace.command, "echo ready");
  assert.equal(item.trace.status, "completed");
  assert.equal(item.trace.exitCode, 0);
  assert.equal(item.trace.output, "legacy replacement");

  await sendOutput(5, { itemId: "native-command", text: "unknown exit", exitCode: null });
  await sendOutput(6, { itemId: "native-command", text: "final legacy replacement" });
  await sendOutput(7, { itemId: "native-command", text: "null-turn legacy replacement" }, null);
  item = client.getState().traceItems[1];
  assert.equal(item.trace.exitCode, null);
  assert.equal(item.trace.status, "completed");
  assert.equal(item.trace.output, "null-turn legacy replacement");
  assert.equal(item.turnId, "turn-1");

  await sendOutput(8, { itemId: "empty-command", text: "", command: "", status: "declined", exitCode: null });
  item = client.getState().traceItems[3];
  assert.equal(item.kind, "command");
  assert.equal(item.trace.type, "command");
  assert.equal(item.trace.command, "");
  assert.equal(item.trace.status, "declined");
  assert.equal(item.trace.exitCode, null);

  await sendOutput(9, { itemId: "status-only", text: "output", status: "failed" });
  item = client.getState().traceItems[4];
  assert.equal(item.kind, "output");
  assert.equal(item.trace.type, "output");
  assert.equal(item.trace.status, "failed");
  assert.equal(Object.hasOwn(item.trace, "command"), false);
  assert.equal(Object.hasOwn(item.trace, "exitCode"), false);

  await sendOutput(10, { itemId: "new-final-command", text: "final", command: "echo final", status: "completed", exitCode: 0 });
  item = client.getState().traceItems[5];
  assert.equal(item.kind, "command");
  assert.equal(item.trace.status, "completed");
  assert.equal(item.trace.exitCode, 0);

  await sendOutput(11, { itemId: "late-turn-command", text: "first", command: "echo late", status: "inProgress" }, null);
  item = client.getState().traceItems[6];
  assert.equal(item.turnId, "");
  await sendOutput(12, { itemId: "late-turn-command", text: "identified", status: "completed" }, "turn-1");
  item = client.getState().traceItems[6];
  assert.equal(item.turnId, "turn-1");
  await sendOutput(13, { itemId: "late-turn-command", text: "legacy null turn" }, null);
  item = client.getState().traceItems[6];
  assert.equal(item.turnId, "turn-1");

  const timeline = buildAgentTimeline([], client.getState().traceItems, [], {});
  assert.deepEqual(timeline.map(entry => entry.kind === "trace" ? entry.item.itemId : "message"), [
    "earlier", "native-command", "later", "empty-command", "status-only", "new-final-command", "late-turn-command",
  ]);

  source.emit("agent", envelope(14, { type: "RUN_FINISHED", threadId: "thread", runId: "turn-1", outcome: { type: "success" } }, { turnId: "turn-1" }));
  await tick();
  await sendOutput(15, { itemId: "after-terminal", text: "plain output" });
  item = client.getState().traceItems[7];
  assert.equal(item.kind, "output");
  assert.equal(item.trace.status, "updated");
  assert.equal(Object.hasOwn(item.trace, "exitCode"), false);

  await sendOutput(16, { itemId: "native-diff", text: "not a diff" });
  const diff = envelope(17, { type: "CUSTOM", name: "brai.agent.diff", value: { itemId: "native-diff", diff: "patch" } }, { turnId: "turn-1" });
  assert.equal(validateEventEnvelope(diff), true);
  source.emit("agent", diff);
  await tick();
  item = client.getState().traceItems.find(traceItem => traceItem.itemId === "native-diff")!;
  assert.equal(item.kind, "file-change");
  assert.equal(item.content, "patch");
  assert.equal(item.trace.diffSummary, "patch");
  await client.dispose();
});

test("connected SDK event backlog is capped by count and serialized bytes", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress", messages: [{ id: "partial", role: "assistant", content: "" }] }));
  await tick();
  for (let seq = 1; seq <= 60; seq += 1) {
    source.emit("agent", envelope(seq, { type: "TEXT_MESSAGE_CONTENT", messageId: "partial", delta: "x".repeat(20_000) }, { turnId: "turn-1" }));
  }
  assert.ok(sources.length >= 2 && sources.length <= 3);
  await client.dispose();
});

test("FIFO SDK acknowledgements allow more than 64 sequential events without reconnect", async () => {
  const { client, sources } = await selectedClient();
  const source = sources[0];
  source.emit("snapshot", snapshot({ state: "working", activeTurnId: "turn-1", turnStatus: "inProgress", messages: [{ id: "partial", role: "assistant", content: "" }] }));
  await tick();
  for (let seq = 1; seq <= 70; seq += 1) {
    source.emit("agent", envelope(seq, { type: "TEXT_MESSAGE_CONTENT", messageId: "partial", delta: "x" }, { turnId: "turn-1" }));
    await tick();
  }
  assert.equal(sources.length, 1);
  assert.equal(client.getState().lastSeq, 70);
  await client.dispose();
});

test("oversized form sets and local command validation never truncate or send", async () => {
  const valid = snapshot({ messages: Array.from({ length: 257 }, (_, index) => ({ id: `m${index}`, role: "assistant", content: "x" })) });
  assert.equal(validateDto("ThreadSnapshot", valid), false);
  const wire = baseFetch();
  const { client } = await selectedClient(wire.fetcher);
  client.setDraft("x".repeat(70_000));
  const result = await client.submitDraft();
  assert.equal(result.outcome, "failed");
  assert.equal(wire.calls(), 0);
  assert.equal(client.getState().draft.length, 70_000);
  await client.dispose();
});
