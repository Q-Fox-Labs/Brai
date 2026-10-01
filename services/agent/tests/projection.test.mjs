// ABOUTME: Проверяет проекцию Codex в AG-UI на синтетических наблюдениях.
// ABOUTME: Использует реальную owner state и закреплённые SDK/contract validators без NATS и UI.

import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../dist/state.js";
import { createProjection } from "../dist/projection.js";
import { validateAguiEvent, validateDto, validateEventEnvelope, serializedBytes } from "../contracts/index.mjs";

function fixture() {
  const state = createState();
  const session = state.put("p", "thread-source", "/work");
  const projection = createProjection();
  const events = [];
  const unsubscribe = projection.subscribe((event) => events.push(event));
  function observe(event) {
    const change = state.observe(event);
    projection.onObservation(event, change.session, state, change);
    return change;
  }
  return { state, session, projection, events, unsubscribe, observe };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function validEvents(events) {
  for (const event of events) {
    assert.equal(validateEventEnvelope(event), true, JSON.stringify(event));
    assert.equal(validateAguiEvent(event.event), true, JSON.stringify(event.event));
  }
}

test("agent message deltas precede exact phase and final replacement without duplicate text", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "turn-native" } } });
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "turn-native", item: { id: "item-native", type: "agentMessage", text: "", phase: "commentary" } } });
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "turn-native", itemId: "item-native", delta: "Hel" } });
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "turn-native", itemId: "item-native", delta: "lo" } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "turn-native", item: { id: "item-native", type: "agentMessage", text: "Hello", phase: "final_answer" } } });
  await flush();

  const relevant = f.events.map((entry) => entry.event);
  const start = relevant.findIndex((entry) => entry.type === "TEXT_MESSAGE_START");
  const phase = relevant.findIndex((entry) => entry.type === "CUSTOM" && entry.name === "brai.agent.message.phase");
  const content = relevant.filter((entry) => entry.type === "TEXT_MESSAGE_CONTENT");
  assert.ok(start >= 0 && phase > start);
  assert.equal(relevant[start].phase, undefined);
  assert.ok(content.every((entry) => entry.phase === undefined));
  assert.deepEqual(content.map((entry) => entry.delta), ["Hel", "lo"]);
  const snapshot = relevant.filter((entry) => entry.type === "MESSAGES_SNAPSHOT").at(-1);
  assert.deepEqual(snapshot.messages, [{ id: "item-native", role: "assistant", content: "Hello" }]);
  assert.deepEqual(f.projection.snapshot(f.session, f.state).messagePhases, { "item-native": "final_answer" });
  assert.ok(f.events.every((entry) => entry.turnId === "turn-native"));
  assert.ok(f.events.every((entry, index) => index === 0 || entry.seq > f.events[index - 1].seq));
  validEvents(f.events);
  f.projection.close();
});

test("phase map follows retained message IDs and snapshots are immutable boundaries", async () => {
  const f = fixture();
  f.state.upsertMessage(f.session, { id: "retained", role: "assistant", content: "before" });
  f.state.setMessagePhase(f.session, "retained", "commentary");
  const boundary = f.projection.snapshot(f.session, f.state);
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "t", itemId: "retained", delta: " after" } });
  assert.deepEqual(boundary.messages, [{ id: "retained", role: "assistant", content: "before" }]);
  assert.deepEqual(boundary.messagePhases, { retained: "commentary" });
  for (let index = 0; index < 257; index++) {
    f.state.upsertMessage(f.session, { id: `m-${index}`, role: "assistant", content: "x" });
    f.state.setMessagePhase(f.session, `m-${index}`, "commentary");
  }
  const view = f.state.view(f.session);
  assert.equal(view.messages.length, 256);
  assert.equal(Object.hasOwn(view.messagePhases, "retained"), false);
  assert.equal(Object.keys(view.messagePhases).length, 256);
  await flush();
  const snapshots = f.events.filter((entry) => entry.event.type === "MESSAGES_SNAPSHOT");
  if (snapshots.length) assert.deepEqual(snapshots[0].event.messages[0], { id: "retained", role: "assistant", content: "before" });
  f.projection.close();
});

test("command output and file diff events replace the owner buffer with authoritative final values", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "turn-output" } } });
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "turn-output", item: { id: "cmd", type: "commandExecution", command: "printf", cwd: "/work", status: "inProgress" } } });
  f.observe({ type: "notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-source", turnId: "turn-output", itemId: "cmd", delta: "A" } });
  f.observe({ type: "notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-source", turnId: "turn-output", itemId: "cmd", delta: "B" } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "turn-output", item: { id: "cmd", type: "commandExecution", command: "printf", cwd: "/work", commandActions: [], status: "exited", exitCode: 0, aggregatedOutput: "AB" } } });
  f.observe({ type: "notification", method: "item/fileChange/outputDelta", params: { threadId: "thread-source", turnId: "turn-output", itemId: "patch", delta: "old" } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "turn-output", item: { id: "patch", type: "fileChange", changes: [{ path: "a.txt", kind: "update", diff: "new" }], status: "completed" } } });
  await flush();
  const outputs = f.events.filter((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.output").map((entry) => entry.event.value.text);
  assert.deepEqual(outputs, ["A", "AB", "AB", "old"]);
  const diffs = f.events.filter((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.diff").map((entry) => entry.event.value.diff);
  assert.deepEqual(diffs, ["--- a.txt\nnew"]);
  const outputTrace = f.state.view(f.session).traceItems.find((item) => item.itemId === "cmd");
  assert.equal(outputTrace.trace.output, "AB");
  validEvents(f.events);
  f.projection.close();
});

test("the last native command delta is replaced by full final output, including failure status", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-source", turnId: "t", itemId: "partial", delta: "LAST" } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "t", item: { id: "partial", type: "commandExecution", command: "run", cwd: "/work", commandActions: [], status: "exited", exitCode: 7, aggregatedOutput: "FIRSTLAST" } } });
  await flush();
  const outputs = f.events.filter((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.output").map((entry) => entry.event.value.text);
  assert.deepEqual(outputs, ["LAST", "FIRSTLAST"]);
  const result = f.events.find((entry) => entry.event.type === "TOOL_CALL_RESULT");
  assert.match(result.event.content, /status=exited; exitCode=7/);
  assert.match(result.event.content, /FIRSTLAST/);
  validEvents(f.events);
  f.projection.close();
});

test("the producer stream is accepted by the pinned AbstractAgent connectAgent reducer", async () => {
  const { AbstractAgent } = await import("@ag-ui/client");
  const { Observable } = await import("rxjs");
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "sdk-run" } } });
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "sdk-run", item: { id: "sdk-message", type: "agentMessage", text: "", phase: "commentary" } } });
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "sdk-run", itemId: "sdk-message", delta: "hello" } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "sdk-run", item: { id: "sdk-message", type: "agentMessage", text: "hello", phase: "final_answer" } } });
  f.observe({ type: "notification", method: "turn/completed", params: { threadId: "thread-source", turn: { id: "sdk-run", status: "completed", items: [] } } });
  await flush();
  const stream = f.events.map((entry) => entry.event);
  let runCalls = 0;
  class ProjectionAgent extends AbstractAgent {
    connect() { return new Observable((subscriber) => { for (const event of stream) subscriber.next(event); subscriber.complete(); }); }
    run() { runCalls++; throw new Error("projection must not start a run"); }
  }
  const agent = new ProjectionAgent({ threadId: "thread-source", messages: [] });
  const observed = [];
  await agent.connectAgent({}, { onEvent: ({ event }) => observed.push(event) });
  assert.equal(runCalls, 0);
  assert.deepEqual(agent.messages, [{ id: "sdk-message", role: "assistant", content: "hello" }]);
  assert.ok(observed.some((event) => event.type === "CUSTOM" && event.name === "brai.agent.message.phase"));
  assert.ok(observed.some((event) => event.type === "RUN_FINISHED" && event.outcome.type === "success"));
  f.projection.close();
});

test("a completed user message has a complete SDK lifecycle but starts no run", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "source-turn", item: { id: "user-item", type: "userMessage", content: [{ type: "text", text: "user text" }] } } });
  await flush();
  assert.deepEqual(f.events.map((entry) => entry.event.type), ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "MESSAGES_SNAPSHOT"]);
  assert.ok(f.events.every((entry) => entry.event.type !== "RUN_STARTED"));
  validEvents(f.events);
  f.projection.close();
});

test("a completed assistant message without an observed start produces one valid lifecycle", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "late-turn", item: { id: "late-item", type: "agentMessage", text: "done", phase: "final_answer" } } });
  await flush();
  assert.deepEqual(f.events.map((entry) => entry.event.type), ["TEXT_MESSAGE_START", "CUSTOM", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "MESSAGES_SNAPSHOT"]);
  assert.equal(f.events[1].event.value.phase, "final_answer");
  validEvents(f.events);
  f.projection.close();
});

test("tool argument end and tool result remain separate SDK events; native plans use activity snapshots", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "turn-tool" } } });
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "turn-tool", item: { id: "tool-native", type: "commandExecution", command: "ls", cwd: "/work", status: "inProgress" } } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "turn-tool", item: { id: "tool-native", type: "commandExecution", command: "ls", cwd: "/work", commandActions: [], status: "exited", exitCode: 0, aggregatedOutput: "done" } } });
  f.observe({ type: "notification", method: "turn/plan/updated", params: { threadId: "thread-source", turnId: "turn-tool", plan: [{ step: "Check", status: "completed" }] } });
  await flush();
  const types = f.events.map((entry) => entry.event.type);
  assert.ok(types.indexOf("TOOL_CALL_END") < types.indexOf("TOOL_CALL_RESULT"));
  assert.ok(types.includes("TOOL_CALL_RESULT"));
  assert.ok(f.events.some((entry) => entry.event.type === "ACTIVITY_SNAPSHOT" && entry.event.activityType === "plan"));
  validEvents(f.events);
  f.projection.close();
});

test("pending request resolution uses owner local UUID and turn terminal confirms remaining forms", async () => {
  const f = fixture();
  const params = { threadId: "thread-source", turnId: "turn-form", itemId: "item-form", startedAtMs: 1, command: "ls", availableDecisions: ["accept", "decline"] };
  f.observe({ type: "request", method: "item/commandExecution/requestApproval", params, id: 77, supported: true });
  const localId = f.state.pendingView(f.session)[0].requestId;
  assert.notEqual(localId, "77");
  f.observe({ type: "notification", method: "serverRequest/resolved", params: { threadId: "thread-source", requestId: 77 } });
  f.observe({ type: "request", method: "item/commandExecution/requestApproval", params: { ...params, itemId: "item-form-2" }, id: "next", supported: true });
  const secondId = f.state.pendingView(f.session)[0].requestId;
  f.observe({ type: "notification", method: "turn/completed", params: { threadId: "thread-source", turn: { id: "turn-form", status: "interrupted", items: [] } } });
  await flush();
  const resolved = f.events.filter((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.request.resolved").map((entry) => entry.event.value);
  assert.deepEqual(resolved, [{ requestId: localId, outcome: "unknown" }, { requestId: secondId, outcome: "stale" }]);
  assert.equal(f.state.pendingView(f.session).length, 0);
  assert.ok(f.events.some((entry) => entry.event.type === "RUN_FINISHED" && entry.event.outcome.type === "cancelled"));
  assert.equal(validateDto("ThreadSnapshot", f.projection.snapshot(f.session, f.state)), true);
  validEvents(f.events);
  f.projection.close();
});

test("oversized forms become compact unsupported requests; form capacity disables decisions", async () => {
  const f = fixture();
  const oversizedParams = { threadId: "thread-source", turnId: "turn-form", itemId: "large-form", startedAtMs: 1, command: "x".repeat(40 * 1024) };
  f.observe({ type: "request", method: "item/commandExecution/requestApproval", params: oversizedParams, id: "large-id", supported: true });
  await flush();
  const opened = f.events.find((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.request.opened");
  assert.equal(opened.event.value.request.kind, "unsupported");
  assert.equal(opened.event.value.request.reason, "oversized");
  assert.ok(serializedBytes(opened) < 1024);
  validEvents(f.events);
  f.projection.close();

  const full = fixture();
  for (let index = 0; index < 65; index++) {
    full.observe({ type: "request", method: "item/commandExecution/requestApproval", params: { threadId: "thread-source", turnId: "t", itemId: `form-${index}`, startedAtMs: 1, command: "x" }, id: index, supported: true });
  }
  await flush();
  assert.equal(full.state.pendingCount(), 64);
  assert.equal(full.projection.snapshot(full.session, full.state).state, "executor-unavailable");
  assert.equal(full.state.claimPending(full.session, full.state.pendingView(full.session)[0].requestId), undefined);
  assert.ok(full.events.some((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.connection" && entry.event.value.state === "executor-unavailable"));
  full.projection.close();
});

test("snapshot boundary is immutable after subscribe and failed turns produce safe run errors", async () => {
  const f = fixture();
  const boundary = f.projection.snapshot(f.session, f.state);
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "error-turn" } } });
  f.observe({ type: "notification", method: "turn/completed", params: { threadId: "thread-source", turn: { id: "error-turn", status: "failed", items: [] } } });
  await flush();
  const error = f.events.find((entry) => entry.event.type === "RUN_ERROR");
  assert.equal(error.event.message, "Codex turn failed.");
  assert.equal(boundary.seq, 0);
  assert.equal(boundary.state, "ready");
  assert.equal(f.projection.snapshot(f.session, f.state).state, "error");
  validEvents(f.events);
  f.projection.close();
});

test("UTF-8 and JSON escaping stay within the whole snapshot limit", () => {
  const f = fixture();
  const escaped = "\\\"\n🙂".repeat(4000);
  for (let index = 0; index < 256; index++) f.state.upsertMessage(f.session, { id: `escaped-${index}`, role: "assistant", content: escaped });
  const snapshot = f.projection.snapshot(f.session, f.state);
  assert.equal(validateDto("ThreadSnapshot", snapshot), true);
  assert.ok(serializedBytes(snapshot) <= 786432);
  assert.equal(snapshot.truncation.truncated, true);
  f.projection.close();
});

test("truncated Unicode payloads stay valid and snapshot JSON remains inside owner budget", async () => {
  const f = fixture();
  const huge = "🙂\"\\\n".repeat(20000);
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "turn-big" } } });
  f.observe({ type: "notification", method: "item/commandExecution/outputDelta", params: { threadId: "thread-source", turnId: "turn-big", itemId: "huge", delta: huge } });
  await flush();
  const output = f.events.find((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.output").event.value;
  assert.equal(output.truncated, true);
  assert.ok(output.contentBytes > Buffer.byteLength(output.text));
  assert.match(output.text, /содержимое сокращено/);
  const snapshot = f.projection.snapshot(f.session, f.state);
  assert.equal(validateDto("ThreadSnapshot", snapshot), true);
  assert.ok(serializedBytes(snapshot) <= 786432);
  validEvents(f.events);
  f.projection.close();
});

test("old handles are rejected after generation replacement and overloaded listeners get resync", async () => {
  const f = fixture();
  const stalled = [];
  f.projection.subscribe((event) => { stalled.push(event); return new Promise(() => {}); });
  for (let index = 0; index < 70; index++) {
    f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: `turn-${index}` } } });
  }
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(stalled.some((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.resync-required" && entry.event.value.reason === "overflow"));
  f.state.syncGeneration("550e8400-e29b-41d4-a716-446655440000");
  assert.throws(() => f.projection.snapshot(f.session, f.state), { code: "NOT_FOUND" });
  f.projection.close();
});

test("slow listeners get an explicit close reason; delivery copies are isolated", async () => {
  const f = fixture();
  const receivedBySecond = [];
  let closeReason;
  f.projection.subscribe(() => new Promise(() => {}), (reason) => { closeReason = reason; });
  f.projection.subscribe((event) => receivedBySecond.push(event));
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "slow-run" } } });
  await flush();
  const first = f.events.at(-1);
  first.event.type = "RUN_ERROR";
  first.event.message = "mutated";
  assert.equal(receivedBySecond[0].event.type, "RUN_STARTED");
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await flush();
  assert.equal(closeReason, "slow-listener");
  assert.equal(f.projection.snapshot(f.session, f.state).activeTurnId, "slow-run");
  f.projection.close();
});

test("generation replacement clears old phase and item lifecycle metadata", async () => {
  const f = fixture();
  f.state.upsertMessage(f.session, { id: "same-item", role: "assistant", content: "ready" });
  f.state.setMessagePhase(f.session, "same-item", "commentary");
  f.state.setMessageLifecycle(f.session, "same-item", "closed");
  const oldGeneration = f.session.generation;
  f.observe({ type: "connection", status: { generation: "550e8400-e29b-41d4-a716-446655440000", connection: "connected", authorization: "ready", eventOverflow: false } });
  const current = f.state.get("p", "thread-source");
  assert.notEqual(current.generation, oldGeneration);
  assert.deepEqual(f.state.view(current).messagePhases, {});
  assert.equal(f.state.messageLifecycle(current, "same-item"), "unknown");
  f.projection.close();
});

test("message owner keeps medium deltas intact and truncates oversized content explicitly", async () => {
  const f = fixture();
  const expected = "x".repeat(20 * 1024);
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "medium-turn", item: { id: "medium", type: "agentMessage", text: "" } } });
  for (let index = 0; index < 20; index++) f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "medium-turn", itemId: "medium", delta: "x".repeat(1024) } });
  const inFlight = f.projection.snapshot(f.session, f.state).messages.find((message) => message.id === "medium");
  assert.equal(inFlight.content, expected);
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "medium-turn", item: { id: "medium", type: "agentMessage", text: expected } } });
  const medium = f.projection.snapshot(f.session, f.state).messages.find((message) => message.id === "medium");
  assert.equal(medium.content, expected);
  const mediumTrace = f.projection.snapshot(f.session, f.state).traceItems.find((item) => item.itemId === "medium");
  assert.equal(mediumTrace.contentBytes, Buffer.byteLength(expected));
  assert.equal(mediumTrace.truncated, true);
  assert.equal(f.projection.snapshot(f.session, f.state).truncation.reason, "byte-budget");

  const oversized = "🙂\"\\\n".repeat(20000);
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "large-turn", item: { id: "large-message", type: "agentMessage", text: "" } } });
  for (let index = 0; index < 5; index++) f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "large-turn", itemId: "large-message", delta: oversized.slice(index * 16000, (index + 1) * 16000) } });
  f.observe({ type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "large-turn", item: { id: "large-message", type: "agentMessage", text: oversized } } });
  await flush();
  const snapshot = f.projection.snapshot(f.session, f.state);
  const finalMessage = snapshot.messages.find((message) => message.id === "large-message");
  assert.match(finalMessage.content, /содержимое сокращено/);
  assert.ok(Buffer.byteLength(finalMessage.content, "utf8") <= 64 * 1024);
  const trace = snapshot.traceItems.find((item) => item.itemId === "large-message");
  assert.equal(trace.contentBytes, Buffer.byteLength(oversized, "utf8"));
  assert.equal(trace.truncated, true);
  assert.equal(snapshot.truncation.truncated, true);
  assert.ok(f.events.some((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.truncation"));
  f.projection.close();
});

test("crossing the exact message byte cap replaces the SDK message before completion", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "cap-turn" } } });
  f.observe({ type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "cap-turn", item: { id: "cap-message", type: "agentMessage", text: "" } } });
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "cap-turn", itemId: "cap-message", delta: "x".repeat(64 * 1024) } });
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "cap-turn", itemId: "cap-message", delta: "y" } });
  await flush();

  const stream = f.events.map((entry) => entry.event);
  assert.equal(stream.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").length, 1);
  assert.equal(stream.filter((event) => event.type === "MESSAGES_SNAPSHOT").length, 1);
  const ownerMessages = f.projection.snapshot(f.session, f.state).messages;
  assert.match(ownerMessages[0].content, /содержимое сокращено/);
  assert.ok(Buffer.byteLength(ownerMessages[0].content, "utf8") <= 64 * 1024);

  const { AbstractAgent } = await import("@ag-ui/client");
  const { Observable } = await import("rxjs");
  class BoundaryAgent extends AbstractAgent {
    connect() { return new Observable((subscriber) => { for (const event of stream) subscriber.next(event); subscriber.complete(); }); }
    run() { throw new Error("projection must not start a run"); }
  }
  const agent = new BoundaryAgent({ threadId: "thread-source", messages: [] });
  await agent.connectAgent({});
  assert.deepEqual(agent.messages, ownerMessages);
  f.projection.close();
});

test("duplicate native item lifecycle observations do not duplicate SDK start or end", async () => {
  const f = fixture();
  f.observe({ type: "notification", method: "turn/started", params: { threadId: "thread-source", turn: { id: "repeat-turn" } } });
  const started = { type: "notification", method: "item/started", params: { threadId: "thread-source", turnId: "repeat-turn", item: { id: "repeat", type: "agentMessage", text: "", phase: "commentary" } } };
  const completed = { type: "notification", method: "item/completed", params: { threadId: "thread-source", turnId: "repeat-turn", item: { id: "repeat", type: "agentMessage", text: "done", phase: "final_answer" } } };
  f.observe(started);
  f.observe(started);
  f.observe({ type: "notification", method: "item/agentMessage/delta", params: { threadId: "thread-source", turnId: "repeat-turn", itemId: "repeat", delta: "done" } });
  f.observe(completed);
  f.observe(completed);
  f.observe({ type: "notification", method: "turn/completed", params: { threadId: "thread-source", turn: { id: "repeat-turn", status: "completed", items: [] } } });
  await flush();
  assert.equal(f.events.filter((entry) => entry.event.type === "TEXT_MESSAGE_START" && entry.event.messageId === "repeat").length, 1);
  assert.equal(f.events.filter((entry) => entry.event.type === "TEXT_MESSAGE_END" && entry.event.messageId === "repeat").length, 1);
  assert.equal(f.events.filter((entry) => entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.message.phase" && entry.event.value.itemId === "repeat").length, 2);
  validEvents(f.events);
  const { AbstractAgent } = await import("@ag-ui/client");
  const { Observable } = await import("rxjs");
  class DuplicateAgent extends AbstractAgent {
    connect() { return new Observable((subscriber) => { for (const entry of f.events) subscriber.next(entry.event); subscriber.complete(); }); }
    run() { throw new Error("connectAgent must not start a run"); }
  }
  const agent = new DuplicateAgent({ threadId: "thread-source", messages: [] });
  await agent.connectAgent({});
  assert.deepEqual(agent.messages, [{ id: "repeat", role: "assistant", content: "done" }]);
  f.projection.close();
});

test("LRU eviction signals the old epoch before owner deletion", async () => {
  const projection = createProjection();
  const events = [];
  projection.subscribe((event) => events.push(event));
  let owner;
  owner = createState((session, state) => projection.onResync(session, state));
  owner.put("p", "thread-0", "/work");
  for (let index = 1; index < 16; index++) owner.put("p", `thread-${index}`, "/work");
  owner.put("p", "thread-16", "/work");
  await flush();
  assert.ok(events.some((entry) => entry.threadId === "thread-0" && entry.event.type === "CUSTOM" && entry.event.name === "brai.agent.resync-required" && entry.event.value.reason === "old-epoch"));
  assert.equal(owner.findThread("thread-0"), undefined);
  projection.close();
});
