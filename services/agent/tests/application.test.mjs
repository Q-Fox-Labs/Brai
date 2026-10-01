// ABOUTME: Проверяет сценарии приложения через fake CodexPort.
// ABOUTME: Не запускает daemon и не подменяет проверки DTO контрактами теста.
import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import codexSchema from "../contracts/codex/schema.json" with { type: "json" };
import { validateDto } from "../contracts/index.mjs";
import { createApplication, toErrorResponse } from "../dist/application.js";
import { createState } from "../dist/state.js";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(codexSchema, "codex-schema.json");
const validateUpstream = (definition, value) => {
  const validate = ajv.compile({
    $ref: `codex-schema.json#/definitions/${definition}`,
  });
  assert.ok(
    validate(value),
    `${definition}: ${JSON.stringify(validate.errors)}`,
  );
  return value;
};
const valid = validateUpstream;
const threadFixture = (id = "t", cwd = "/work") => ({
  cliVersion: "1.0",
  createdAt: 1,
  cwd,
  ephemeral: false,
  id,
  model: "gpt-6-astra",
  modelProvider: "openai",
  preview: "",
  projectId: "p",
  sessionId: "session-1",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 1,
});
const startFixture = (id = "t", model = "gpt-6-astra") => ({
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: "/work",
  model,
  modelProvider: "openai",
  sandbox: { type: "readOnly", networkAccess: false },
  thread: threadFixture(id),
});
const readFixture = (id = "t", cwd = "/work") => ({
  thread: threadFixture(id, cwd),
});
const approvalFixture = (itemId, startedAtMs = 1) =>
  valid("CommandExecutionRequestApprovalParams", {
    threadId: "t",
    turnId: "turn-1",
    itemId,
    startedAtMs,
    command: "echo ok",
  });

test("fake upstream fixtures match the accepted Codex schemas", () => {
  const thread = threadFixture();
  validateUpstream("ThreadReadResponse", { thread });
  const start = startFixture();
  validateUpstream("ThreadStartResponse", start);
  validateUpstream("ThreadResumeResponse", start);
  validateUpstream("TurnStartResponse", {
    turn: { id: "turn-1", status: "inProgress", items: [] },
  });
  validateUpstream("CommandExecutionRequestApprovalParams", {
    threadId: "t",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1,
    command: "echo ok",
  });
});

test("upstream errors become safe ErrorResponse DTOs and HTTP status", () => {
  const result = toErrorResponse(
    Object.assign(new Error("secret raw params"), {
      code: "upstream-error",
      outcome: "unknown",
      upstreamCode: -32600,
    }),
    generation,
    "operation-1",
  );
  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(result.body.outcome, "unknown");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.ok(validateDto("ErrorResponse", result.body));
  assert.equal(toErrorResponse({ code: "UNSUPPORTED", outcome: "not-sent" }, generation).httpStatus, 501);
});

function port(overrides = {}) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status() {
      return {
        generation: "g1",
        connection: "connected",
        authorization: "ready",
        eventOverflow: false,
      };
    },
    emit(e) {
      for (const fn of listeners) fn(e);
    },
    async respond() {},
    async close() {},
    async call(method, params, opts) {
      calls.push({ method, params, opts });
      if (overrides[method]) return overrides[method](params, opts, calls);
      if (method === "thread/read")
        return valid("ThreadReadResponse", readFixture(params.threadId));
      if (method === "thread/resume")
        return valid("ThreadResumeResponse", startFixture(params.threadId));
      if (method === "turn/start")
        return valid("TurnStartResponse", {
          turn: { id: "turn-1", status: "inProgress", items: [] },
        });
      if (method === "thread/turns/list")
        return valid("ThreadTurnsListResponse", { data: [], nextCursor: null });
      if (method === "thread/items/list")
        return valid("ThreadItemsListResponse", { data: [], nextCursor: null });
      if (method === "turn/steer")
        return valid("TurnSteerResponse", { turnId: "turn-1" });
      if (method === "turn/interrupt")
        return valid("TurnInterruptResponse", {});
      return { data: [], nextCursor: null };
    },
  };
}
const appPort = (codex, extra = {}) =>
  createApplication({
    codex,
    projects: [
      { projectId: "p", name: "Project", cwd: "/work", available: true },
    ],
    allowedModels: ["gpt-6-astra"],
    ...extra,
  });
const generation = "00000000-0000-4000-8000-000000000001";
const startReq = (operationId = "op") => ({
  projectId: "p",
  threadId: "t",
  generation,
  operationId,
  text: "hello",
});
const connected = (codex) =>
  codex.emit({
    type: "connection",
    status: {
      generation,
      connection: "connected",
      authorization: "ready",
      eventOverflow: false,
    },
  });

test("same immutable operation id shares one Codex effect; changed body conflicts", async () => {
  let release;
  const codex = port({
    "thread/read": async () => valid("ThreadReadResponse", readFixture()),
    "thread/resume": async () => {
      await new Promise((r) => (release = r));
      return valid("ThreadResumeResponse", startFixture());
    },
  });
  const app = appPort(codex);
  connected(codex);
  const first = app.turnStart(startReq());
  const second = app.turnStart(startReq());
  await new Promise((r) => setImmediate(r));
  assert.equal(
    codex.calls.filter((c) => c.method === "thread/resume").length,
    1,
  );
  release();
  assert.deepEqual(await first, await second);
  assert.equal(codex.calls.filter((c) => c.method === "turn/start").length, 1);
  await assert.rejects(
    app.turnStart({ ...startReq(), text: "different" }),
    (e) => e.code === "OPERATION_CONFLICT",
  );
});

test("a simultaneous distinct start cannot reserve the same thread twice", async () => {
  let release;
  const codex = port({
    "thread/read": async () => valid("ThreadReadResponse", readFixture()),
    "thread/resume": async () => {
      await new Promise((r) => (release = r));
      return valid("ThreadResumeResponse", startFixture());
    },
  });
  const app = appPort(codex);
  connected(codex);
  const first = app.turnStart(startReq("one"));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    app.turnStart(startReq("two")),
    (e) => e.code === "OPERATION_CONFLICT",
  );
  release();
  await first;
});

test("metadata cwd mismatch rejects before resume or turn start", async () => {
  const codex = port({
    "thread/read": async () =>
      valid("ThreadReadResponse", readFixture("t", "/elsewhere")),
  });
  const app = appPort(codex);
  connected(codex);
  await assert.rejects(
    app.turnStart(startReq()),
    (e) => e.code === "INVALID_ARGUMENT",
  );
  assert.equal(
    codex.calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("new thread disables provider fallback and does not read its empty history", async () => {
  const codex = port({
    "thread/start": async () =>
      valid("ThreadStartResponse", startFixture("new")),
  });
  const app = appPort(codex);
  connected(codex);
  const r = await app.threadCreate({
    projectId: "p",
    generation,
    operationId: "create",
  });
  assert.equal(r.threadId, "new");
  assert.deepEqual(codex.calls[0].params, {
    cwd: "/work",
    allowProviderModelFallback: false,
  });
  assert.equal(
    codex.calls.some((c) => c.method === "thread/read"),
    false,
  );
});

test("serialized request cap is checked before DTO validation", async () => {
  const codex = port();
  const app = appPort(codex);
  connected(codex);
  await assert.rejects(
    app.turnStart({ ...startReq(), text: "é".repeat(33000) }),
    (e) => e.code === "REQUEST_TOO_LARGE",
  );
});

test("a reconnect invalidates a delayed resume result before it can start a turn", async () => {
  let release;
  const codex = port({
    "thread/read": async () => valid("ThreadReadResponse", readFixture()),
    "thread/resume": async () => {
      await new Promise((r) => (release = r));
      return valid("ThreadResumeResponse", startFixture());
    },
  });
  const app = appPort(codex);
  connected(codex);
  const pending = app.turnStart(startReq());
  await new Promise((r) => setImmediate(r));
  const next = "00000000-0000-4000-8000-000000000002";
  codex.emit({
    type: "connection",
    status: {
      generation: next,
      connection: "connected",
      authorization: "ready",
      eventOverflow: false,
    },
  });
  release();
  await assert.rejects(pending, (e) => e.code === "STALE_GENERATION");
  assert.equal(
    codex.calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("a delayed metadata query cannot create a session in the new generation", async () => {
  let release;
  const codex = port({
    "thread/read": async () => {
      await new Promise((resolve) => (release = resolve));
      return valid("ThreadReadResponse", readFixture());
    },
  });
  const app = appPort(codex);
  connected(codex);
  const pending = app.turnStart(startReq());
  await new Promise((resolve) => setImmediate(resolve));
  const next = "00000000-0000-4000-8000-000000000003";
  codex.emit({
    type: "connection",
    status: {
      generation: next,
      connection: "connected",
      authorization: "ready",
      eventOverflow: false,
    },
  });
  release();
  await assert.rejects(pending, (e) => e.code === "STALE_GENERATION");
  assert.equal(codex.calls.some((c) => c.method === "thread/resume"), false);
  assert.equal(app.status().generation, next);
});

test("a delayed thread creation cannot commit into a later generation", async () => {
  let release;
  const codex = port({
    "thread/start": async () => {
      await new Promise((resolve) => (release = resolve));
      return valid("ThreadStartResponse", startFixture("new"));
    },
  });
  const app = appPort(codex);
  connected(codex);
  const pending = app.threadCreate({
    projectId: "p",
    generation,
    operationId: "create-delayed",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const next = "00000000-0000-4000-8000-000000000004";
  codex.emit({
    type: "connection",
    status: {
      generation: next,
      connection: "connected",
      authorization: "ready",
      eventOverflow: false,
    },
  });
  release();
  await assert.rejects(pending, (e) => e.code === "STALE_GENERATION");
  assert.equal(codex.calls.some((c) => c.method === "thread/read"), false);
});

test("status limits are configured caps and thread timestamps map from Unix seconds", async () => {
  const codex = port({
    "thread/list": async () =>
      valid("ThreadListResponse", {
        data: [
          valid("Thread", {
            ...threadFixture("listed"),
            name: null,
            preview: "Preview title",
            updatedAt: 1_790_000_000,
            status: { type: "active", activeFlags: [] },
          }),
        ],
        nextCursor: null,
      }),
  });
  const app = appPort(codex);
  connected(codex);
  const status = app.status();
  assert.deepEqual(status.limits, {
    loadedThreads: 16,
    activeTurns: 4,
    pendingRpc: 64,
    pendingForms: 64,
    ledgerEntries: 4096,
    upstreamFrameBytes: 2097152,
    natsSseFrameBytes: 1048576,
    historyResponseBytes: 786432,
  });
  const listed = await app.threads({ projectId: "p", limit: 10 });
  assert.deepEqual(listed.threads[0], {
    threadId: "listed",
    title: "Preview title",
    updatedAt: new Date(1_790_000_000 * 1000).toISOString(),
    active: true,
  });
});

test("live turn event during open bootstrap is not overwritten by stale turn metadata", async () => {
  let release;
  const codex = port({
    "thread/turns/list": async () => {
      await new Promise((resolve) => (release = resolve));
      return valid("ThreadTurnsListResponse", {
        data: [
          {
            id: "turn-old",
            status: "completed",
            items: [],
            error: null,
          },
        ],
        nextCursor: null,
      });
    },
  });
  const app = appPort(codex);
  connected(codex);
  const opening = app.thread({ projectId: "p", threadId: "t" });
  await new Promise((resolve) => setImmediate(resolve));
  codex.emit({
    type: "notification",
    method: "turn/started",
    params: { threadId: "t", turn: { id: "turn-live", status: "inProgress" } },
  });
  release();
  const snapshot = await opening;
  assert.equal(snapshot.state, "working");
  assert.equal(snapshot.activeTurnId, "turn-live");
});

test("a disallowed model releases the active slot before any turn is sent", async () => {
  const codex = port({
    "thread/read": async () => valid("ThreadReadResponse", readFixture()),
    "thread/resume": async () =>
      valid("ThreadResumeResponse", startFixture("t", "unlisted-model")),
  });
  let owner;
  const app = appPort(codex, {
    onObservation: (_event, _session, state) => (owner = state),
  });
  connected(codex);
  await assert.rejects(
    app.turnStart(startReq()),
    (e) => e.code === "UNSUPPORTED",
  );
  assert.equal(owner.activeCount(), 0);
  assert.equal(
    codex.calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("only the first local decision for a pending form reaches Codex", async () => {
  let release;
  let sends = 0;
  const codex = port();
  codex.respond = async () => {
    sends++;
    await new Promise((r) => (release = r));
  };
  const app = appPort(codex);
  connected(codex);
  const snap = await app.thread({ projectId: "p", threadId: "t" });
  codex.emit({
    type: "request",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "t",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      command: "echo ok",
    },
    id: 7,
    supported: true,
  });
  const withForm = await app.thread({ projectId: "p", threadId: "t" });
  assert.equal(withForm.pendingRequests.length, 1);
  assert.equal(withForm.state, "waiting");
  const form = withForm.pendingRequests[0];
  const answer = {
    projectId: "p",
    threadId: "t",
    generation,
    operationId: "answer-1",
    requestId: form.requestId,
    kind: "command-approval",
    answer: { decision: "decline" },
  };
  const first = app.requestRespond(answer);
  await new Promise((r) => setImmediate(r));
  assert.equal(sends, 1);
  await assert.rejects(
    app.requestRespond({
      ...answer,
      operationId: "answer-2",
      answer: { decision: "accept" },
    }),
    (e) => e.code === "STALE_REQUEST",
  );
  release();
  await first;
  assert.equal(sends, 1);
  assert.equal(snap.pendingRequests.length, 0);
});

test("opening an existing thread resumes after registration and never starts a turn", async () => {
  const codex = port({
    "thread/resume": async (params) => {
      assert.equal(params.excludeTurns, true);
      codex.emit({
        type: "request",
        method: "item/commandExecution/requestApproval",
        params: approvalFixture("item-1"),
        id: 12,
        supported: true,
      });
      return valid("ThreadResumeResponse", startFixture());
    },
  });
  const app = appPort(codex);
  connected(codex);
  const snap = await app.thread({ projectId: "p", threadId: "t" });
  assert.equal(snap.pendingRequests.length, 1);
  assert.equal(
    codex.calls.some((c) => c.method === "turn/start"),
    false,
  );
});

test("unknown mutation outcome is cached and never automatically retried", async () => {
  let resumes = 0;
  const error = Object.assign(new Error("timeout"), {
    code: "timeout",
    outcome: "unknown",
  });
  const codex = port({
    "thread/read": async () => valid("ThreadReadResponse", readFixture()),
    "thread/resume": async () => {
      resumes++;
      throw error;
    },
  });
  let owner;
  const app = appPort(codex, {
    onObservation: (_event, _session, state) => (owner = state),
  });
  connected(codex);
  await assert.rejects(app.turnStart(startReq()), (e) => e === error);
  await assert.rejects(app.turnStart(startReq()), (e) => e === error);
  assert.equal(resumes, 1);
  assert.equal(owner.activeCount(), 1);
});

test("ledger keeps 4096 entries, canonicalizes object keys, and refuses the next entry", async () => {
  const state = createState(),
    gen = state.generation();
  let effects = 0;
  const left = state.runOperation(
    gen,
    "same",
    { a: 1, b: 2 },
    async () => ++effects,
  );
  const right = state.runOperation(
    gen,
    "same",
    { b: 2, a: 1 },
    async () => ++effects,
  );
  assert.equal(await left, await right);
  assert.equal(effects, 1);
  const all = Array.from({ length: 4095 }, (_, i) =>
    state.runOperation(gen, `op-${i}`, { i }, async () => i),
  );
  await Promise.all(all);
  await assert.rejects(
    state.runOperation(gen, "overflow", {}, async () => ++effects),
    (e) => e.code === "CAPACITY_EXHAUSTED",
  );
  assert.equal(
    await state.runOperation(
      gen,
      "same",
      { b: 2, a: 1 },
      async () => ++effects,
    ),
    1,
  );
});

test("owner rejects a session handle from the previous connection generation", () => {
  const state = createState();
  const oldSession = state.put("p", "t", "/work");
  state.syncGeneration("00000000-0000-4000-8000-000000000099");
  assert.throws(
    () => state.appendMessage(oldSession, { id: "stale" }),
    (error) => error.code === "NOT_FOUND",
  );
  const current = state.get("p", "t");
  assert.ok(current);
  assert.notEqual(current, oldSession);
  assert.equal(current.messages.length, 0);
});

test("active turn and pending form limits apply across sessions", () => {
  const state = createState();
  for (let i = 0; i < 4; i++)
    state.reserveTurn(state.put("p", `t${i}`, "/work"));
  assert.throws(
    () => state.reserveTurn(state.put("p", "t4", "/work")),
    (e) => e.code === "CAPACITY_EXHAUSTED",
  );
  const forms = createState(),
    sessions = [forms.put("p", "a", "/work"), forms.put("p", "b", "/work")];
  for (let i = 0; i < 64; i++)
    assert.equal(
      forms.addPending(sessions[i % 2], {
        requestId: `r${i}`,
        rawId: i,
        method: "x",
        kind: "unsupported",
        params: {},
        bytes: 1,
        decision: false,
      }),
      true,
    );
  assert.equal(
    forms.addPending(sessions[0], {
      requestId: "too-many",
      rawId: 65,
      method: "x",
      kind: "unsupported",
      params: {},
      bytes: 1,
      decision: false,
    }),
    false,
  );
  const bytes = createState(),
    one = bytes.put("p", "a", "/work");
  for (let i = 0; i < 4; i++)
    assert.equal(
      bytes.addPending(one, {
        requestId: `b${i}`,
        rawId: i,
        method: "x",
        kind: "unsupported",
        params: {},
        bytes: 32768,
        decision: false,
      }),
      true,
    );
  assert.equal(
    bytes.addPending(one, {
      requestId: "over",
      rawId: 5,
      method: "x",
      kind: "unsupported",
      params: {},
      bytes: 1,
      decision: false,
    }),
    false,
  );
});

test("LRU announces resync before removing only an idle session", () => {
  let state;
  const resync = [];
  state = createState((session) => {
    resync.push(state.findThread(session.threadId) === session);
  });
  for (let i = 0; i < 16; i++) state.put("p", `thread-${i}`, "/work");
  const protectedSession = state.put("p", "thread-0", "/work");
  state.reserveTurn(protectedSession);
  state.put("p", "thread-16", "/work");
  assert.deepEqual(resync, [true]);
  assert.equal(state.findThread("thread-0"), protectedSession);
  assert.equal(state.findThread("thread-1"), undefined);
});

test("resolved server request maps the original number ID without string coercion", () => {
  const state = createState(),
    s = state.put("p", "t", "/work");
  state.observe({
    type: "request",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t", itemId: "i", turnId: "turn-1", startedAtMs: 1 },
    id: 1,
    supported: true,
  });
  assert.equal(state.pendingView(s).length, 1);
  const localId = state.pendingView(s)[0].requestId;
  state.observe({
    type: "request",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t", itemId: "i", turnId: "turn-1", startedAtMs: 1 },
    id: 1,
    supported: true,
  });
  assert.equal(state.pendingView(s).length, 1);
  assert.equal(state.pendingView(s)[0].requestId, localId);
  state.observe({
    type: "notification",
    method: "serverRequest/resolved",
    params: { threadId: "t", requestId: "1" },
  });
  assert.equal(state.pendingView(s).length, 1);
  state.observe({
    type: "notification",
    method: "serverRequest/resolved",
    params: { threadId: "t", requestId: 1 },
  });
  assert.equal(state.pendingView(s).length, 0);
});

test("a proven not-sent answer can be retried explicitly; unknown keeps the decision reserved", async () => {
  let failure = "not-sent",
    sends = 0;
  const codex = port();
  codex.respond = async () => {
    sends++;
    if (failure)
      throw Object.assign(new Error(failure), {
        code: failure,
        outcome: failure,
      });
  };
  const app = appPort(codex);
  connected(codex);
  await app.thread({ projectId: "p", threadId: "t" });
  codex.emit({
    type: "request",
    method: "item/commandExecution/requestApproval",
    params: approvalFixture("i"),
    id: 9,
    supported: true,
  });
  const form = (await app.thread({ projectId: "p", threadId: "t" }))
    .pendingRequests[0];
  const request = {
    projectId: "p",
    threadId: "t",
    generation,
    operationId: "send-one",
    requestId: form.requestId,
    kind: "command-approval",
    answer: { decision: "decline" },
  };
  await assert.rejects(
    app.requestRespond(request),
    (e) => e.outcome === "not-sent",
  );
  failure = "";
  await app.requestRespond({ ...request, operationId: "send-two" });
  assert.equal(sends, 2);
  codex.emit({
    type: "request",
    method: "item/commandExecution/requestApproval",
    params: approvalFixture("i2", 2),
    id: 10,
    supported: true,
  });
  const other = (
    await app.thread({ projectId: "p", threadId: "t" })
  ).pendingRequests.find((item) => item.requestId !== form.requestId);
  failure = "unknown";
  await assert.rejects(
    app.requestRespond({
      ...request,
      operationId: "send-unknown",
      requestId: other.requestId,
    }),
    (e) => e.outcome === "unknown",
  );
  failure = "";
  await assert.rejects(
    app.requestRespond({
      ...request,
      operationId: "send-again",
      requestId: other.requestId,
    }),
    (e) => e.code === "STALE_REQUEST",
  );
  assert.equal(sends, 3);
});
