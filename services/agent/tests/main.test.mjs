// ABOUTME: Проверяет композицию программы и её ограниченный Codex reconnect lifecycle.
// ABOUTME: Использует только воспроизводимые фабрики и не подключается к живым службам.

import test from "node:test";
import assert from "node:assert/strict";
import { startAgent } from "../dist/main.js";
import { subjects } from "../contracts/index.mjs";

const config = {
  codex: { socketUrl: "ws+unix:/tmp/codex.sock:/" },
  nats: { servers: ["nats://127.0.0.1:4222"], inboxPrefix: "_INBOX.brai_agent" },
  projects: [{ projectId: "p", name: "Project", cwd: "/work" }],
};

function fixture(options = {}) {
  const listeners = new Set();
  const endpoints = new Map();
  let connection = "disconnected";
  let generation = null;
  let connectCalls = 0;
  let releaseReconnect;
  let codexClosed = false;
  let ncClosed = false;
  let unsubscribeCalls = 0;
  let releaseUnsubscribe;
  const emit = () => {
    const event = { type: "connection", status: { generation, connection, authorization: connection === "connected" ? "ready" : "unknown", eventOverflow: false } };
    for (const listener of listeners) listener(event);
  };
  const codex = {
    async connect() {
      connectCalls++;
      if (connectCalls === 1) {
        connection = "connected";
        generation = "00000000-0000-4000-8000-000000000001";
        emit();
        return;
      }
      await new Promise((resolve) => { releaseReconnect = resolve; });
      connection = "connected";
      generation = "00000000-0000-4000-8000-000000000002";
      emit();
    },
    status: () => ({ generation, connection, authorization: connection === "connected" ? "ready" : "unknown", eventOverflow: false }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async call(method, params) {
      if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/work" } };
      if (method === "thread/resume") return { thread: { id: params.threadId, cwd: "/work", status: { type: "idle" }, canAcceptDirectInput: true }, cwd: "/work", model: "gpt-6-astra" };
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      if (method === "thread/unsubscribe") {
        unsubscribeCalls++;
        if (options.delayFirstUnsubscribe && unsubscribeCalls === 1) await new Promise((resolve) => { releaseUnsubscribe = resolve; });
        return { status: "unsubscribed" };
      }
      throw new Error(`unexpected Codex call: ${method}`);
    },
    async respond() {},
    async close() { codexClosed = true; connection = "disconnected"; },
  };
  const nc = {
    services: { async add() { return { addEndpoint(name, value) { endpoints.set(value.subject, value.handler); }, info() { return { id: "instance" }; }, async stop() {} }; } },
    async *status() {},
    isClosed: () => ncClosed,
    publish() {}, async flush() {},
    async close() { ncClosed = true; },
  };
  const serviceRequest = async (subject, body) => new Promise((resolve) => {
    const handler = endpoints.get(subject);
    assert.ok(handler, `unknown NATS subject ${subject}`);
    handler(null, { reply: "_INBOX.test", data: Buffer.from(JSON.stringify(body)), respond(payload, options) { resolve({ body: JSON.parse(payload.toString()), headers: options?.headers }); return true; } });
  });
  return {
    codex, nc, serviceRequest,
    get connectCalls() { return connectCalls; },
    get codexClosed() { return codexClosed; },
    get ncClosed() { return ncClosed; },
    get unsubscribeCalls() { return unsubscribeCalls; },
    disconnect() { connection = "disconnected"; emit(); },
    reconnect() { releaseReconnect?.(); },
    setGeneration(value) { generation = value; connection = "connected"; emit(); },
    releaseUnsubscribe() { releaseUnsubscribe?.(); },
  };
}

test("Codex disconnect reconnects only the handshake, and close waits for an in-flight connect", async () => {
  const f = fixture();
  const runtime = await startAgent(config, { factories: { codex: () => f.codex, nats: async () => f.nc } });
  assert.equal(runtime.status().ready, true);
  f.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.connectCalls, 2);
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  f.reconnect();
  await closing;
  assert.equal(f.codexClosed, true);
  assert.equal(f.ncClosed, true);
});

test("generation pruning preserves a new subscription when old unsubscribe completes late", async () => {
  const f = fixture({ delayFirstUnsubscribe: true });
  const runtime = await startAgent(config, { factories: { codex: () => f.codex, nats: async () => f.nc } });
  const open = (threadId) => f.serviceRequest(subjects.thread, { projectId: "p", threadId });
  for (let i = 0; i < 16; i++) {
    const response = await open(`thread-${i}`);
    assert.equal(response.body.threadId, `thread-${i}`);
  }

  const staleAdmission = open("thread-17");
  while (f.unsubscribeCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  f.disconnect();
  f.setGeneration("00000000-0000-4000-8000-000000000002");
  assert.equal((await open("thread-0")).body.threadId, "thread-0");
  f.releaseUnsubscribe();
  const staleResponse = await staleAdmission;
  assert.equal(staleResponse.body.code, "STALE_GENERATION");

  for (let i = 1; i < 16; i++) assert.equal((await open(`thread-${i}`)).body.threadId, `thread-${i}`);
  assert.equal((await open("thread-17")).body.threadId, "thread-17");
  assert.equal(f.unsubscribeCalls, 2, "new-generation subscription still receives its own cleanup");
  await runtime.close();
});
