// ABOUTME: Проверяет ограничение параллелизма, очереди и времени ответа.
// ABOUTME: Активный слот остаётся занят, пока операция не завершилась.
import test from "node:test";
import assert from "node:assert/strict";
import { createLoadGate } from "../dist/load.js";
import { HistoryFault } from "../dist/domain.js";

const fault = code => error => error instanceof HistoryFault && error.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("gate enforces active and queued bounds and stops accepting", async () => {
  const gate = createLoadGate({ active: 2, queue: 1, deadlineMs: 2_000 });
  const first = deferred(), second = deferred(), queued = deferred();
  const started = [];
  const a = gate.run(async () => { started.push("a"); await first.promise; return "a"; });
  const b = gate.run(async () => { started.push("b"); await second.promise; return "b"; });
  const c = gate.run(async () => { started.push("c"); await queued.promise; return "c"; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b"]);
  await assert.rejects(gate.run(async () => "overflow"), fault("BUSY"));

  first.resolve();
  await a;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"]);
  gate.stopAccepting();
  await assert.rejects(gate.run(async () => "stopped"), fault("BUSY"));
  second.resolve(); queued.resolve();
  assert.deepEqual(await Promise.all([b, c]), ["b", "c"]);
  await gate.drain();
});

test("deadline rejects the response but retains its active slot until work settles", async () => {
  const gate = createLoadGate({ active: 1, queue: 1, deadlineMs: 30 });
  const work = deferred();
  let started = 0;
  const timedOut = gate.run(async () => { started++; await work.promise; return "late"; });
  await assert.rejects(timedOut, fault("DEADLINE_EXCEEDED"));

  const next = gate.run(async () => { started++; return "next"; });
  await assert.rejects(gate.run(async () => "overflow"), fault("BUSY"));
  assert.equal(started, 1);
  work.resolve();
  assert.equal(await next, "next");
  assert.equal(started, 2);
  await gate.drain();
});

test("queued requests consume the same deadline and leave no stale queue entry", async () => {
  const gate = createLoadGate({ active: 1, queue: 1, deadlineMs: 30 });
  const work = deferred();
  const active = gate.run(async () => work.promise).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  const queued = gate.run(async () => "must not start");
  await assert.rejects(queued, fault("DEADLINE_EXCEEDED"));
  const replacement = gate.run(async () => "replacement");
  work.resolve();
  assert.ok(await active instanceof HistoryFault);
  assert.equal(await replacement, "replacement");
  gate.stopAccepting();
  await gate.drain();
});

test("an HTTP deadline is shared with the gate queue and expired work never starts", async () => {
  const gate = createLoadGate({ active: 1, queue: 1, deadlineMs: 5_000 });
  const blocker = deferred();
  const active = gate.run(() => blocker.promise);
  await new Promise(resolve => setImmediate(resolve));

  let invoked = false;
  await assert.rejects(gate.run(async () => { invoked = true; }, { deadlineAt: performance.now() - 1 }), fault("DEADLINE_EXCEEDED"));
  assert.equal(invoked, false);

  const partialBudget = gate.run(async () => { invoked = true; }, { deadlineAt: performance.now() + 30 });
  await assert.rejects(partialBudget, fault("DEADLINE_EXCEEDED"));
  assert.equal(invoked, false);

  const next = gate.run(async () => "next");
  blocker.resolve("done");
  assert.equal(await active, "done");
  assert.equal(await next, "next");
  await gate.drain();
});
