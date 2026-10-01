// ABOUTME: Проверяет собранный сервис через настоящий NATS, native Codex и AG-UI SDK.
// ABOUTME: Явный opt-in и loopback обязательны; владеет одним consumer и только собственными threads/cwd.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";
import { connect } from "nats";
import { AbstractAgent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { startAgent } from "../../dist/main.js";
import { createCodex } from "../../dist/codex.js";
import { subjects, validateDto, validateEventEnvelope } from "../../contracts/index.mjs";
import { createNativeSeed, releaseNativeSeed } from "./native-seed.mjs";

const optedIn = process.env.BRAI_AGENT_TEST_ACCEPTANCE === "1";
const socketUrl = process.env.BRAI_AGENT_TEST_SOCKET_URL;
const servers = (process.env.BRAI_AGENT_TEST_NATS_SERVERS ?? "").split(",").filter(Boolean);
const loopback = servers.length > 0 && servers.every((value) => {
  try { const url = new URL(value); return url.protocol === "nats:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); } catch { return false; }
});

const credentials = {
  serviceUser: process.env.BRAI_AGENT_TEST_NATS_SERVICE_USER,
  servicePassword: process.env.BRAI_AGENT_TEST_NATS_SERVICE_PASSWORD,
  callerUser: process.env.BRAI_AGENT_TEST_NATS_CALLER_USER,
  callerPassword: process.env.BRAI_AGENT_TEST_NATS_CALLER_PASSWORD,
};
const enabled = optedIn && loopback && socketUrl?.startsWith("ws+unix:") && Object.values(credentials).every(Boolean);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(50); }
  throw new Error("bounded acceptance condition timed out");
}

test("assembled live service: authoritative tools/phases, steer, ledger, interrupt, socket recovery and native forms", { skip: !enabled, timeout: 720000 }, async (t) => {
  const cwd = await mkdtemp("/tmp/brai-agent-service-op5-");
  console.log(JSON.stringify({ event: "acceptance.own-cwd", cwd }));
  const projectId = "fixture";
  const config = { codex: { socketUrl }, nats: { servers, user: credentials.serviceUser, password: credentials.servicePassword, inboxPrefix: "_INBOX.brai_agent" }, projects: [{ projectId, name: "Fixture", cwd }], allowedModels: ["gpt-6.1-sol"], newThread: { approvalsReviewer: "user" } };
  const native = [];
  const events = [];
  const sockets = [];
  const owned = new Map();
  let nativePort, runtime, nc, subscription, reading, seed;
  let provenCleanup = false;
  let nativeBytes = 0;
  let eventBytes = 0;
  const diagnostics = [];
  try {
    runtime = await startAgent(config, { factories: { codex: (options) => {
      nativePort = createCodex(options, (url, opts) => { const ws = new WebSocket(url, opts); sockets.push(ws); return ws; });
      nativePort.subscribe((event) => {
        if (event.type === "connection") return;
        if (event.method === "thread/started" && event.params.thread?.cwd === cwd) owned.set(event.params.thread.id, { turnId: null, terminal: true });
        const id = event.params.threadId;
        if (!owned.has(id)) return;
        if (event.method === "turn/started") { owned.get(id).turnId = event.params.turn.id; owned.get(id).terminal = false; owned.get(id).interruptSent = false; }
        if (event.method === "turn/completed" && event.params.turn.id === owned.get(id).turnId) owned.get(id).terminal = true;
        const size = Buffer.byteLength(JSON.stringify(event));
        assert.ok(native.length < 2000 && nativeBytes + size < 4 * 1024 * 1024, "native test observation bound exceeded");
        nativeBytes += size; native.push(event);
      });
      return nativePort;
    } }, onError: (error) => diagnostics.push(error.code ?? error.name) });
    nc = await connect({ servers, user: credentials.callerUser, pass: credentials.callerPassword, inboxPrefix: "_INBOX.brai_web", timeout: 5000 });
    subscription = nc.subscribe(subjects.event);
    reading = (async () => { for await (const message of subscription) {
      const value = JSON.parse(message.string());
      if (value.projectId !== projectId || !owned.has(value.threadId)) continue;
      assert.ok(validateEventEnvelope(value), "actual AG-UI envelope failed validation");
      assert.ok(events.length < 3000 && eventBytes + message.data.length < 6 * 1024 * 1024, "test Core event bound exceeded");
      eventBytes += message.data.length; events.push(value);
    } })();
    await nc.flush();
    const request = async (endpoint, value = {}, responseType) => {
      const message = await nc.request(subjects[endpoint], JSON.stringify(value), { timeout: 15000 });
      const result = JSON.parse(message.string());
      if (message.headers?.get("Nats-Service-Error-Code")) {
        assert.ok(message.headers.get("Nats-Service-Error"));
        throw Object.assign(new Error(result.code), result);
      }
      if (responseType) assert.ok(validateDto(responseType, result), `actual ${responseType} failed validation`);
      return result;
    };
    const snapshot = (threadId) => request("thread", { projectId, threadId }, "ThreadSnapshot");
    const terminal = (threadId, turnId) => until(() => events.find((e) => e.threadId === threadId && e.turnId === turnId && ["RUN_FINISHED", "RUN_ERROR"].includes(e.event.type)), 120000);
    const created = await request("threadCreate", { projectId, generation: (await request("status")).generation, operationId: randomUUID() });
    const threadId = created.threadId;
    console.log(JSON.stringify({ event: "acceptance.own-thread", cwd, threadId }));
    owned.set(threadId, { turnId: null, terminal: true });
    let view = await snapshot(threadId);
    const startBody = { projectId, threadId, generation: view.generation, operationId: randomUUID(), text: "Use exec_command to run exactly: printf 'BRAI_FIRST\\n'; sleep 2; printf 'BRAI_LAST\\n'. Then run a separate command: printf 'BRAI_NONZERO\\n'; exit 7. Use apply_patch to add acceptance.txt with the text BRAI_PATCH_OK. All operations stay in the current directory; no escalated permissions. Then reply BRAI_ACCEPTANCE_DONE. Do not delegate or spawn subagents. Only gpt-6.1-sol is permitted; other models and any fallback are forbidden." };
    const started = await request("turnStart", startBody);
    assert.deepEqual(await request("turnStart", startBody), started, "same operation returns its prior result");
    await assert.rejects(request("turnStart", { ...startBody, text: "different" }), (error) => error.code === "OPERATION_CONFLICT");
    await terminal(threadId, started.turnId);
    view = await snapshot(threadId);
    const completed = native.filter((e) => e.method === "item/completed" && e.params.threadId === threadId && e.params.turnId === started.turnId).map((e) => e.params.item);
    const command = completed.find((item) => item.type === "commandExecution" && item.aggregatedOutput?.includes("BRAI_FIRST"));
    assert.ok(command && command.exitCode === 0 && command.status === "completed", "native successful stdout command required");
    assert.ok(command.aggregatedOutput.includes("BRAI_LAST"));
    assert.ok(completed.some((item) => item.type === "commandExecution" && item.exitCode === 7), "native nonzero command required");
    const output = events.filter((e) => e.threadId === threadId && e.event.type === "CUSTOM" && e.event.name === "brai.agent.output" && e.event.value.itemId === command.id);
    assert.equal(output.at(-1).event.value.text, command.aggregatedOutput, "final output replaces partial projection");
    const nativeDeltas = native.filter((e) => e.method === "item/commandExecution/outputDelta" && e.params.itemId === command.id);
    assert.ok(nativeDeltas.length, "native stdout delta required");
    assert.notEqual(nativeDeltas.map((e) => e.params.delta).join(""), command.aggregatedOutput, "native partial stdout must differ from authoritative final");
    assert.ok(completed.some((item) => item.type === "fileChange" && item.changes.some((change) => change.diff.includes("BRAI_PATCH_OK"))));
    assert.match(await readFile(`${cwd}/acceptance.txt`, "utf8"), /BRAI_PATCH_OK/);
    for (const item of completed.filter((item) => item.type === "agentMessage" && item.phase)) {
      assert.equal(view.messagePhases[item.id], item.phase);
      const phase = events.findIndex((e) => e.threadId === threadId && e.event.type === "CUSTOM" && e.event.name === "brai.agent.message.phase" && e.event.value.itemId === item.id);
      const messageStart = events.findIndex((e) => e.threadId === threadId && e.event.type === "TEXT_MESSAGE_START" && e.event.messageId === item.id);
      assert.ok(phase > messageStart);
    }
    const history = await request("history", { projectId, threadId, turnId: started.turnId, limit: 100 }, "HistoryResponse");
    for (const item of completed.filter((item) => item.type === "agentMessage" && item.phase)) assert.equal(history.items.find((entry) => entry.itemId === item.id).trace.phase, item.phase);
    class ReplayAgent extends AbstractAgent {
      connect() { return new Observable((subscriber) => { for (const e of events.filter((entry) => entry.threadId === threadId && entry.turnId === started.turnId)) subscriber.next(e.event); subscriber.complete(); }); }
      run() { throw new Error("connect must not execute another native turn"); }
    }
    const sdk = new ReplayAgent({ threadId });
    await sdk.connectAgent();
    assert.ok(sdk.messages.some((message) => message.content?.includes("BRAI_ACCEPTANCE_DONE")));
    assert.ok(sdk.messages.some((message) => message.role === "tool" && message.content.includes("exitCode=7")));
    t.diagnostic(`native success=${command.id}; stdout deltas=${nativeDeltas.length}; final replacement exact; SDK tools/phases/history passed`);

    const active = await request("turnStart", { projectId, threadId, generation: view.generation, operationId: randomUUID(), text: "Use exec_command now to run sleep 15 in the current directory. Then reply WAIT_DONE. Do not delegate or spawn subagents. Only gpt-6.1-sol is permitted; all other models and any fallback are forbidden." });
    await until(() => native.find((e) => e.method === "item/started" && e.params.threadId === threadId && e.params.turnId === active.turnId && e.params.item.type === "commandExecution"));
    await assert.rejects(request("turnSteer", { projectId, threadId, generation: view.generation, operationId: randomUUID(), expectedTurnId: "stale-turn", text: "stale" }), (error) => error.code === "OPERATION_CONFLICT" && error.outcome === "not-sent");
    await request("turnSteer", { projectId, threadId, generation: view.generation, operationId: randomUUID(), expectedTurnId: active.turnId, text: "After the waiting command, reply STEER_ACCEPTED. Do not delegate or spawn subagents. Only gpt-6.1-sol is permitted; other models and any fallback are forbidden." });
    owned.get(threadId).interruptSent = true;
    await request("turnInterrupt", { projectId, threadId, generation: view.generation, operationId: randomUUID(), turnId: active.turnId });
    await terminal(threadId, active.turnId);
    assert.ok(native.some((e) => e.method === "turn/completed" && e.params.turn.id === active.turnId && e.params.turn.status === "interrupted"));
    view = await snapshot(threadId);
    assert.equal(view.turnStatus, "interrupted");
    assert.equal(view.state, "interrupted");
    t.diagnostic("successful steer, stale steer and matching native interrupted terminal passed");

    const alone = await request("turnStart", { projectId, threadId, generation: view.generation, operationId: randomUUID(), text: "Use exec_command to run sleep 30 in the current directory, then reply SOCKET_DONE. Do not delegate or spawn subagents. Only gpt-6.1-sol is permitted; other models and any fallback are forbidden." });
    await until(() => native.find((e) => e.method === "item/started" && e.params.threadId === threadId && e.params.turnId === alone.turnId && e.params.item.type === "commandExecution"));
    const before = await nativePort.call("thread/read", { threadId, includeTurns: false }, { mutation: false });
    assert.equal(before.thread.status.type, "active");
    const disconnectedGeneration = view.generation;
    sockets.at(-1).terminate();
    await until(() => runtime.status().ready === true && runtime.status().generation !== disconnectedGeneration);
    view = await snapshot(threadId);
    const after = await nativePort.call("thread/read", { threadId, includeTurns: false }, { mutation: false });
    const latest = await nativePort.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, { mutation: false });
    assert.equal(latest.data[0].id, alone.turnId);
    if (after.thread.status.type === "active" && latest.data[0].status === "inProgress") {
      assert.equal(view.state, "working");
      assert.equal(view.activeTurnId, alone.turnId);
      owned.get(threadId).interruptSent = true;
      await request("turnInterrupt", { projectId, threadId, generation: view.generation, operationId: randomUUID(), turnId: alone.turnId });
      await terminal(threadId, alone.turnId);
    } else if (latest.data[0].status === "inProgress") {
      assert.notEqual(after.thread.status.type, "active");
      assert.equal(view.state, "executor-unavailable");
      assert.equal(view.activeTurnId, null);
      owned.get(threadId).terminal = true; // Native inactive execution proof, not a terminal turn status.
    } else {
      assert.notEqual(view.state, "working");
      owned.get(threadId).terminal = true;
    }
    t.diagnostic(`service-only socket loss: native=${JSON.stringify({ status: after.thread.status, canAcceptDirectInput: after.thread.canAcceptDirectInput, originalTurn: alone.turnId, latestStatus: latest.data[0].status })}; DTO=${JSON.stringify({ state: view.state, activeTurnId: view.activeTurnId, turnStatus: view.turnStatus })}`);

    await assert.rejects(request("turnStart", { projectId, threadId, generation: view.generation, operationId: randomUUID(), text: "x".repeat(65536) }), (error) => error.code === "REQUEST_TOO_LARGE" && error.outcome === "not-sent");

    const observedKinds = new Set();
    for (const kind of ["question", "command-approval", "file-change-approval", "permissions"]) {
      try { seed = await createNativeSeed({ socketUrl, cwd, projectId, kind, timeoutMs: 60000, onThreadCreated: (metadata) => { owned.set(metadata.threadId, { turnId: null, terminal: false }); console.log(JSON.stringify({ event: "acceptance.own-seed", ...metadata })); } }); }
      catch (error) {
        if (error.nativeEvidence?.released === true && error.nativeEvidence.threadId && owned.has(error.nativeEvidence.threadId)) {
          owned.set(error.nativeEvidence.threadId, { turnId: error.nativeEvidence.turnId, terminal: true });
        }
        if (error.code !== "NATIVE_CAPABILITY_NOT_OBSERVED" || !error.nativeEvidence?.released) throw error;
        t.diagnostic(`native capability limit ${kind}: ${error.message}; evidence=${JSON.stringify(error.nativeEvidence)}`);
        continue;
      }
      owned.set(seed.threadId, { turnId: seed.turnId, terminal: false });
      let pendingView = await snapshot(seed.threadId);
      pendingView = await until(async () => { const next = await snapshot(seed.threadId); return next.pendingRequests.find((p) => p.kind === kind) ? next : null; });
      const original = pendingView.pendingRequests.find((p) => p.kind === kind);
      assert.deepEqual(original.params, seed.params);
      const oldGeneration = pendingView.generation;
      sockets.at(-1).terminate();
      await until(() => runtime.status().ready === true && runtime.status().generation !== oldGeneration);
      pendingView = await snapshot(seed.threadId);
      pendingView = await until(async () => { const next = await snapshot(seed.threadId); return next.pendingRequests.find((p) => p.kind === kind) ? next : null; });
      const recovered = pendingView.pendingRequests.find((p) => p.kind === kind);
      const replay = native.filter((e) => e.type === "request" && e.params.threadId === seed.threadId);
      assert.ok(replay.length >= 2 && replay.every((e) => e.id === seed.rawRequestId), "native raw RPC ID unchanged after own socket reconnect");
      assert.deepEqual(recovered.params, seed.params);
      assert.notEqual(pendingView.generation, oldGeneration);
      const answer = kind === "question" ? { answers: Object.fromEntries(seed.params.questions.map((q) => [q.id, { answers: [q.options[0].label] }])) }
        : kind === "permissions" ? { permissions: {}, scope: "turn" }
        : { decision: "accept" };
      const responseBody = { projectId, threadId: seed.threadId, generation: pendingView.generation, operationId: randomUUID(), requestId: recovered.requestId, kind, answer };
      await request("requestRespond", responseBody);
      await seed.waitResolved();
      await assert.rejects(request("requestRespond", { ...responseBody, operationId: randomUUID() }), (error) => error.code === "STALE_REQUEST");
      await seed.wait((e) => e.type === "notification" && e.method === "turn/completed" && e.params.threadId === seed.threadId && e.params.turn.id === seed.turnId, 90000);
      await releaseNativeSeed(seed);
      observedKinds.add(kind);
      owned.get(seed.threadId).terminal = true;
      t.diagnostic(`native ${kind}: same rawRPC=${seed.rawRequestId}; recovered generation; service answer and matching terminal confirmed`);
      seed = null;
    }
    assert.deepEqual([...observedKinds], ["question", "command-approval", "file-change-approval", "permissions"], "all four forms require actual native proof");
    assert.equal(diagnostics.length, 0, `transport diagnostics: ${diagnostics.join(",")}`);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (action) => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    if (seed && !seed.released) await cleanup(() => releaseNativeSeed(seed));
    if (nativePort && nativePort.status().connection !== "connected") await cleanup(() => until(() => nativePort.status().connection === "connected", 30000));
    if (nativePort?.status().connection === "connected") {
      for (const [threadId, info] of owned) {
        await cleanup(async () => {
          if (!info.terminal) {
            const page = await nativePort.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, { mutation: false });
            const turn = page.data[0];
            if (turn && turn.status !== "inProgress") info.terminal = true;
            else if (turn?.status === "inProgress") {
              info.turnId = turn.id;
              if (!info.interruptSent) {
                info.interruptSent = true;
                try { await nativePort.call("turn/interrupt", { threadId, turnId: info.turnId }, { mutation: true }); } catch { /* Never repeat an unknown mutation. */ }
              }
              await until(() => owned.get(threadId).terminal, 30000);
            } else throw new Error(`own thread has no proven terminal: ${threadId}`);
          }
          assert.ok(info.terminal);
          try { await nativePort.call("thread/archive", { threadId }, { mutation: true }); } catch { /* A -32600 may mean applied; reconcile by own filtered API once. */ }
          const page = await nativePort.call("thread/list", { cwd, archived: true, limit: 100, useStateDbOnly: true }, { mutation: false });
          assert.ok(page.data.some((thread) => thread.id === threadId), `own archive not confirmed: ${threadId}`);
          info.archived = true;
          const unsubscribed = await nativePort.call("thread/unsubscribe", { threadId }, { mutation: true });
          assert.ok(["notLoaded", "notSubscribed", "unsubscribed"].includes(unsubscribed.status));
        });
      }
      provenCleanup = [...owned.values()].every((info) => info.terminal && info.archived);
    } else provenCleanup = owned.size === 0;
    await cleanup(async () => subscription?.unsubscribe());
    await cleanup(async () => reading);
    await cleanup(async () => runtime?.close());
    await cleanup(async () => nc?.close());
    if (provenCleanup) await rm(cwd, { recursive: true, force: true });
    else cleanupErrors.push(new Error(`own native stop/archive cleanup unknown; cwd retained: ${cwd}`));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "independent fixture cleanup failures");
    console.log(JSON.stringify({ event: "acceptance.cleanup", cwd, threads: owned.size, stopped: true, archived: true, removed: true }));
  }
});

test("native seed AbortSignal confirms terminal and shared cleanup after prepare", { skip: !enabled, timeout: 120000 }, async () => {
  const cwd = await mkdtemp("/tmp/brai-agent-service-op5-");
  const controller = new AbortController();
  let seed, threadId, cleaned = false;
  const api = createCodex({ socketUrl });
  const errors = [];
  const cleanup = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
  try {
    seed = await createNativeSeed({ socketUrl, cwd, projectId: "fixture", kind: "question", signal: controller.signal, timeoutMs: 60000, onThreadCreated: (metadata) => { threadId = metadata.threadId; console.log(JSON.stringify({ event: "acceptance.abort-own-seed", ...metadata })); } });
    controller.abort();
    assert.ok(seed.abortCleanup, "abort after prepare must start bounded release");
    await seed.abortCleanup;
    await releaseNativeSeed(seed);
    assert.equal(seed.terminal.status, "interrupted");
    assert.equal(seed.released, true);
  } finally {
    if (seed && !seed.released) await cleanup(() => releaseNativeSeed(seed));
    if (threadId) await cleanup(async () => {
      assert.ok(seed?.released, "terminal cleanup must precede archive");
      await api.connect();
      try { await api.call("thread/archive", { threadId }, { mutation: true }); } catch { /* Verify once; never repeat a mutation. */ }
      const page = await api.call("thread/list", { cwd, archived: true, limit: 100, useStateDbOnly: true }, { mutation: false });
      assert.ok(page.data.some((thread) => thread.id === threadId));
      const result = await api.call("thread/unsubscribe", { threadId }, { mutation: true });
      assert.ok(["notLoaded", "notSubscribed", "unsubscribed"].includes(result.status));
      cleaned = true;
    });
    await cleanup(() => api.close());
    if (cleaned || !threadId) await rm(cwd, { recursive: true, force: true });
    else errors.push(new Error(`own AbortSignal cleanup unknown; cwd retained: ${cwd}`));
    if (errors.length) throw new AggregateError(errors, "AbortSignal fixture cleanup failed");
    console.log(JSON.stringify({ event: "acceptance.abort-cleanup", threadId, cwd, archived: true, removed: true }));
  }
});

test("native seed abort before turn preserves own cleanup evidence for a primitive reason", { skip: !enabled, timeout: 60000 }, async () => {
  const cwd = await mkdtemp("/tmp/brai-agent-service-op5-");
  const controller = new AbortController();
  const api = createCodex({ socketUrl });
  let threadId, failure, archived = false;
  const errors = [];
  const cleanup = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
  try {
    await assert.rejects(createNativeSeed({ socketUrl, cwd, projectId: "fixture", kind: "question", signal: controller.signal, onThreadCreated: (metadata) => {
      threadId = metadata.threadId;
      console.log(JSON.stringify({ event: "acceptance.abort-before-turn-own", ...metadata }));
      controller.abort("own-before-turn");
    } }), (error) => {
      failure = error;
      return error instanceof Error && error.cause === "own-before-turn" && error.nativeEvidence.threadId === threadId && error.nativeEvidence.turnId === null && error.nativeEvidence.released === true && error.nativeEvidence.terminalStatus === "no-turn-sent";
    });
  } finally {
    if (threadId) await cleanup(async () => {
      assert.ok(failure?.nativeEvidence?.released === true, "unknown helper cleanup does not permit archive");
      await api.connect();
      const native = await api.call("thread/read", { threadId, includeTurns: false }, { mutation: false });
      assert.equal(native.thread.cwd, cwd);
      assert.ok(["idle", "notLoaded"].includes(native.thread.status.type), "known empty own thread must have no active execution");
      try { await api.call("thread/archive", { threadId }, { mutation: true }); } catch { /* Reconcile the single attempt with own API. */ }
      const page = await api.call("thread/list", { cwd, archived: true, limit: 100, useStateDbOnly: true }, { mutation: false });
      assert.ok(page.data.some((thread) => thread.id === threadId));
      const unarchived = await api.call("thread/list", { cwd, archived: false, limit: 100, useStateDbOnly: true }, { mutation: false });
      assert.ok(!unarchived.data.some((thread) => thread.id === threadId));
      const result = await api.call("thread/unsubscribe", { threadId }, { mutation: true });
      assert.ok(["notLoaded", "notSubscribed", "unsubscribed"].includes(result.status));
      archived = true;
    });
    await cleanup(() => api.close());
    if (!threadId || archived) await rm(cwd, { recursive: true, force: true });
    else errors.push(new Error(`own pre-turn abort cleanup unknown; cwd retained: ${cwd}`));
    if (errors.length) throw new AggregateError(errors, "pre-turn abort cleanup failed");
    console.log(JSON.stringify({ event: "acceptance.abort-before-turn-cleanup", threadId, cwd, turns: 0, archived, removed: true }));
  }
});
