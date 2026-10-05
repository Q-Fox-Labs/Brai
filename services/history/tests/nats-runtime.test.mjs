// ABOUTME: Проверяет безопасное преобразование исключений в NATS Service ошибки.
// ABOUTME: Вызовы адаптера изолированы от брокера, а wire-поведение проверяется отдельно.
import test from "node:test";
import assert from "node:assert/strict";
import { createLoadGate } from "../dist/load.js";
import { runNats } from "../dist/nats.js";

function harness(appendEvent) {
  const endpoints = new Map();
  const service = {
    info: () => ({ id: "synthetic-instance" }),
    addEndpoint: (name, options) => endpoints.set(name, options.handler),
    stop: async () => null,
  };
  const connection = { flush: async () => {}, services: { add: async () => service } };
  const handlers = { ready: async () => {}, appendEvent };
  return { endpoints, service, connection, handlers };
}

function message(data) {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  return {
    subject: "brai.history.v1.append.service_history",
    data,
    response,
    respond: payload => { resolve({ payload: Buffer.from(payload), headers: null }); return true; },
    respondError: (status, code, payload) => { resolve({ status, code, payload: Buffer.from(payload) }); return true; },
  };
}

test("JSON parsing errors are INVALID_ARGUMENT and core failures are INTERNAL", async () => {
  const h = harness(async () => { throw new TypeError("sensitive synthetic failure"); });
  const gate = createLoadGate({ deadlineMs: 1_000, active: 1, queue: 1 });
  const runtime = await runNats(h.connection, h.handlers, gate);
  try {
    const invalid = message(Buffer.from("{"));
    h.endpoints.get("append")(null, invalid);
    const invalidReply = await invalid.response;
    assert.equal(invalidReply.status, 400);
    assert.equal(invalidReply.code, "INVALID_ARGUMENT");

    const internal = message(Buffer.from(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001" })));
    h.endpoints.get("append")(null, internal);
    const internalReply = await internal.response;
    assert.equal(internalReply.status, 500);
    assert.equal(internalReply.code, "INTERNAL");
    assert.deepEqual(JSON.parse(internalReply.payload.toString("utf8")), { code: "INTERNAL", message: "INTERNAL", retryable: false });
    assert.equal(internalReply.payload.toString("utf8").includes("sensitive synthetic failure"), false);
  } finally {
    gate.stopAccepting();
    await runtime.stop();
    await gate.drain();
  }
});
