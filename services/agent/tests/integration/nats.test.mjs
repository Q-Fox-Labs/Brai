// ABOUTME: Проверяет NATS Services discovery, headers и Core NATS на выделенном локальном broker.
// ABOUTME: По умолчанию пропускается; не подключается к произвольному или production broker.

import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "nats";
import { subjects, validateDto } from "../../contracts/index.mjs";
import { createNats } from "../../dist/nats.js";

const url = process.env.BRAI_AGENT_TEST_NATS_URL;
const serviceUser = process.env.BRAI_AGENT_TEST_NATS_SERVICE_USER;
const servicePassword = process.env.BRAI_AGENT_TEST_NATS_SERVICE_PASSWORD;
const serviceInboxPrefix = process.env.BRAI_AGENT_TEST_NATS_SERVICE_INBOX_PREFIX;
const callerUser = process.env.BRAI_AGENT_TEST_NATS_CALLER_USER;
const callerPassword = process.env.BRAI_AGENT_TEST_NATS_CALLER_PASSWORD;
const callerInboxPrefix = process.env.BRAI_AGENT_TEST_NATS_CALLER_INBOX_PREFIX;
let loopback = false;
try { const parsed = new URL(url); loopback = parsed.protocol === "nats:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname); } catch { /* explicit opt-in validation below */ }
const enabled = process.env.BRAI_AGENT_TEST_NATS === "1" && loopback && Boolean(serviceUser && servicePassword && serviceInboxPrefix && callerUser && callerPassword && callerInboxPrefix);
const generation = "00000000-0000-4000-8000-000000000000";

async function nextWithin(iterator, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("NATS iterator response timed out")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("dedicated NATS broker serves native discovery, contract replies and Core NATS events", { skip: !enabled }, async () => {
  const serviceNc = await connect({ servers: [url], user: serviceUser, pass: servicePassword, inboxPrefix: serviceInboxPrefix, timeout: 5000 });
  let callerNc;
  let eventListener;
  let runtime;
  let eventSub;
  try {
    callerNc = await connect({ servers: [url], user: callerUser, pass: callerPassword, inboxPrefix: callerInboxPrefix, timeout: 5000 });
    const application = {
      projects: () => ({ generation, projects: [{ projectId: "fixture", name: "Fixture", available: true }] }),
      status: () => ({ generation, ready: true, connection: "connected", authorization: "ready" }),
      threads: async () => ({ generation, threads: [], nextCursor: null }),
      thread: async () => { throw Object.assign(new Error("No such thread"), { code: "NOT_FOUND", outcome: "not-sent" }); },
      history: async () => ({ generation, threadId: "thread-live-probe", items: [], nextCursor: null, truncation: { truncated: false, reason: "none" } }),
      threadCreate: async () => { throw Object.assign(new Error("read-only integration probe"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
      turnStart: async () => { throw Object.assign(new Error("read-only integration probe"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
      turnSteer: async () => { throw Object.assign(new Error("read-only integration probe"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
      turnInterrupt: async () => { throw Object.assign(new Error("read-only integration probe"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
      requestRespond: async () => { throw Object.assign(new Error("read-only integration probe"), { code: "UNSUPPORTED", outcome: "not-sent" }); },
    };
    const projection = {
      subscribe(listener) { eventListener = listener; return () => {}; },
    };
    runtime = await createNats({ nc: serviceNc, application, projection });

    for (const method of ["ping", "info", "stats"]) {
      const iterator = await callerNc.services.client()[method]("brai_agent", runtime.instanceId);
      try {
        const response = await nextWithin(iterator[Symbol.asyncIterator]());
        assert.equal(response.done, false, `native ${method} returned no service response`);
        assert.equal(response.value.name, "brai_agent");
        assert.equal(response.value.id, runtime.instanceId);
      } finally { iterator.stop(); }
    }

    const response = await callerNc.request(subjects.projects, Buffer.from("{}"), { timeout: 5000 });
    assert.equal(response.headers?.has("Nats-Service-Error") ?? false, false);
    const projects = JSON.parse(response.data.toString("utf8"));
    assert.equal(validateDto("ProjectsResponse", projects), true);

    const error = await callerNc.request(subjects.thread, Buffer.from(JSON.stringify({ projectId: "fixture", threadId: "missing" })), { timeout: 5000 });
    assert.equal(error.headers.get("Nats-Service-Error"), "NOT_FOUND");
    assert.equal(error.headers.get("Nats-Service-Error-Code"), "404");

    eventSub = callerNc.subscribe(subjects.event, { max: 1 });
    const envelope = { projectId: "fixture", threadId: "thread-live-probe", turnId: null, generation, streamEpoch: generation, seq: 1, event: { type: "CUSTOM", name: "brai.agent.resync-required", value: { reason: "gap" } } };
    eventListener(envelope);
    const published = await nextWithin(eventSub[Symbol.asyncIterator]());
    assert.equal(published.done, false);
    assert.equal(JSON.parse(published.value.data.toString("utf8")).threadId, envelope.threadId);
  } finally {
    eventSub?.unsubscribe();
    try { await runtime?.close(); } finally {
      if (callerNc && !callerNc.isClosed()) await callerNc.close();
      if (!serviceNc.isClosed()) await serviceNc.close();
    }
  }
});
