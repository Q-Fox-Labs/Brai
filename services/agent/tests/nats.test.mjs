// ABOUTME: Проверяет NATS boundary и поток событий через подставленный broker port.
// ABOUTME: Валидаторы, байтовые лимиты и service error headers остаются production-кодом.

import test from "node:test";
import assert from "node:assert/strict";
import { createNats } from "../dist/nats.js";
import { subjects, validateDto, validateEventEnvelope } from "../contracts/index.mjs";

const generation = "00000000-0000-4000-8000-000000000000";

function fixture(overrides = {}) {
  const endpoints = new Map();
  const published = [];
  const replies = [];
  let listener;
  let closeListener;
  let closed = false;
  const service = {
    addEndpoint(name, options) { endpoints.set(options.subject, { name, options }); },
    info() { return { id: "nats-instance-1" }; },
    async stop() { closed = true; },
  };
  const nc = {
    services: { async add(config) { assert.equal(config.name, "brai_agent"); assert.equal(config.version, "1.0.0"); return service; } },
    isClosed: () => closed,
    async *status() {},
    publish(subject, data) { published.push({ subject, value: JSON.parse(data.toString()) }); },
    async flush() {},
  };
  const app = {
    projects() { return { generation, projects: [{ projectId: "p", name: "Project", available: true }] }; },
    status() { return { generation, ready: true, connection: "connected", authorization: "ready" }; },
    async threads() { return { generation, threads: [], nextCursor: null }; },
    async thread() { throw Object.assign(new Error("No such thread"), { code: "NOT_FOUND", outcome: "not-sent" }); },
    async history() { return { generation, threadId: "t", items: [], nextCursor: null }; },
    async threadCreate() { throw Object.assign(new Error("Unexpected mutation"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
    async turnStart() { throw new Error("oversized input reached application"); },
    async turnSteer() { throw new Error("Unexpected steer"); },
    async turnInterrupt() { throw new Error("Unexpected interrupt"); },
    async requestRespond() { throw new Error("Unexpected response"); },
    ...overrides,
  };
  const projection = {
    subscribe(fn, onClose) { listener = fn; closeListener = onClose; return () => { closeListener?.("closed"); }; },
  };
  return {
    nc, app, projection, endpoints, published, replies,
    event(value) { listener(value); },
    projectionClosed(reason) { closeListener?.(reason); },
    async request(subject, data) {
      const endpoint = endpoints.get(subject);
      assert.ok(endpoint, `missing ${subject}`);
      let response;
      const reply = {
        reply: "_INBOX.reply",
        data: Buffer.from(data),
        respond(payload, options) { response = { payload: JSON.parse(payload.toString()), headers: options?.headers }; replies.push(response); return true; },
      };
      endpoint.options.handler(null, reply);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return response;
    },
    async requestWithoutReply(subject, data) {
      const endpoint = endpoints.get(subject);
      assert.ok(endpoint, `missing ${subject}`);
      endpoint.options.handler(null, { data: Buffer.from(data) });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    options(extra = {}) { return { nc, application: app, projection, ...extra }; },
  };
}

test("NATS service exposes contract endpoints and replies through native reply envelope", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  assert.equal(runtime.instanceId, "nats-instance-1");
  assert.deepEqual([...f.endpoints.keys()], [subjects.projects, subjects.status, subjects.threads, subjects.thread, subjects.history, subjects.threadCreate, subjects.turnStart, subjects.turnSteer, subjects.turnInterrupt, subjects.requestRespond]);

  const result = await f.request(subjects.projects, "{}");
  assert.equal(result.payload.projects[0].projectId, "p");
  assert.equal(result.headers, undefined);
  assert.equal(validateDto("ProjectsResponse", result.payload), true);

  const status = await f.request(subjects.status, "{}");
  assert.equal(status.payload.ready, true);
  assert.equal(validateDto("StatusResponse", status.payload), true);
  await runtime.close();
});

test("raw oversized start returns REQUEST_TOO_LARGE before generic DTO validation", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  const response = await f.request(subjects.turnStart, `{"padding":"${"x".repeat(65536)}"}`);
  assert.equal(response.payload.code, "REQUEST_TOO_LARGE");
  assert.equal(response.payload.outcome, "not-sent");
  assert.equal(response.headers.get("Nats-Service-Error"), "REQUEST_TOO_LARGE");
  assert.equal(response.headers.get("Nats-Service-Error-Code"), "413");
  await runtime.close();
});

test("query errors carry both NATS service headers before their safe payload", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  const response = await f.request(subjects.thread, JSON.stringify({ projectId: "p", threadId: "t" }));
  assert.equal(response.payload.code, "NOT_FOUND");
  assert.equal(response.payload.outcome, "not-sent");
  assert.equal(response.headers.get("Nats-Service-Error"), "NOT_FOUND");
  assert.equal(response.headers.get("Nats-Service-Error-Code"), "404");
  await runtime.close();
});

test("Core NATS publishes only validated envelopes and overflow recovery remains explicit", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  const marker = {
    projectId: "p", threadId: "t", turnId: "turn", generation,
    streamEpoch: generation, seq: 1,
    event: { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "gap" } },
  };
  assert.equal(validateEventEnvelope(marker), true);
  f.event(marker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.published[0].subject, subjects.event);
  assert.deepEqual(f.published[0].value, marker);
  await runtime.close();
});

test("status query reports unready after projection listeners exhaust resubscribe attempts", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  for (let i = 0; i < 4; i++) {
    f.projectionClosed("listener-error");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.status().ready, false);
  const status = await f.request(subjects.status, "{}");
  assert.equal(status.payload.ready, false);
  assert.equal(validateDto("StatusResponse", status.payload), true);
  await runtime.close();
});

test("concurrent close calls share the same shutdown promise", async () => {
  let releaseStop;
  const f = fixture();
  f.nc.services.add = async () => ({
    addEndpoint(name, options) { f.endpoints.set(options.subject, { name, options }); },
    info() { return { id: "nats-instance-1" }; },
    stop() { return new Promise((resolve) => { releaseStop = resolve; }); },
  });
  const runtime = await createNats(f.options());
  let settled = false;
  const first = runtime.close().then(() => { settled = true; });
  const second = runtime.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseStop();
  await Promise.all([first, second]);
  assert.equal(settled, true);
});

test("rejected NATS flush suppresses later requests until a verified empty probe succeeds", async () => {
  let mutationCalls = 0;
  const f = fixture({ async turnStart() { mutationCalls++; throw new Error("must not run while send is unhealthy"); } });
  const runtime = await createNats(f.options());
  let flushCalls = 0;
  f.nc.flush = async () => {
    flushCalls++;
    if (flushCalls === 1) throw new Error("fixture flush failure");
  };
  const initial = await f.request(subjects.projects, "{}");
  assert.equal(validateDto("ProjectsResponse", initial.payload), true);
  assert.equal(runtime.status().ready, false);
  const turn = { projectId: "p", threadId: "t", generation, operationId: "no-send", text: "hello" };
  const suppressed = await f.request(subjects.turnStart, JSON.stringify(turn));
  assert.equal(suppressed, undefined);
  assert.equal(mutationCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(flushCalls, 2);
  assert.equal(runtime.status().ready, true);
  await runtime.close();
});

test("rejected flush prevents already queued replies from entering the SDK buffer", async () => {
  let release;
  let arrivals = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    async threads() {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
      return { generation, threads: [], nextCursor: null };
    },
  });
  const runtime = await createNats(f.options());
  let flushCalls = 0;
  f.nc.flush = async () => { if (++flushCalls === 1) throw new Error("first flush rejected"); };
  const [first, second] = await Promise.all([
    f.request(subjects.threads, JSON.stringify({ projectId: "p" })),
    f.request(subjects.threads, JSON.stringify({ projectId: "p" })),
  ]);
  assert.ok(first);
  assert.equal(arrivals, 2);
  assert.equal(validateDto("ThreadsResponse", first.payload), true);
  assert.equal(second, undefined);
  assert.equal(f.replies.length, 1);
  assert.equal(runtime.status().ready, false);
  await runtime.close();
});

test("a pending flush serializes queued replies and events until success", async () => {
  const f = fixture();
  const runtime = await createNats(f.options());
  let release;
  let flushCalls = 0;
  f.nc.flush = () => {
    flushCalls++;
    if (flushCalls === 1) return new Promise((resolve) => { release = resolve; });
    return Promise.resolve();
  };
  const first = await f.request(subjects.projects, "{}");
  assert.ok(first);
  const second = f.request(subjects.threads, JSON.stringify({ projectId: "p" }));
  const envelope = {
    projectId: "p", threadId: "t", turnId: null, generation,
    streamEpoch: generation, seq: 1,
    event: { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "gap" } },
  };
  f.event(envelope);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.replies.length, 1);
  assert.equal(f.published.length, 0);
  release();
  await second;
  for (let i = 0; i < 10 && f.replies.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.replies.length, 2);
  assert.equal(validateDto("ThreadsResponse", f.replies[1].payload), true);
  assert.deepEqual(f.published[0].value, envelope);
  assert.equal(flushCalls, 3);
  assert.equal(runtime.status().ready, true);
  await runtime.close();
});
