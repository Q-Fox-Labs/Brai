// ABOUTME: Проверяет корреляцию и ограничения CodexPort через подменённый WebSocket.
// ABOUTME: Не открывает локальные сокеты и не требует daemon, чатов или токенов.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CodexError } from '../dist/errors.js';
import { createCodex } from '../dist/codex.js';

const initResult = {
  codexHome: '/tmp/codex-test', platformFamily: 'unix', platformOs: 'linux', userAgent: 'test',
};

function socketHarness({ account = null, hold = new Set(), errors = new Set(), reverse = false } = {}) {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() {
      super();
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    send(data, callback) {
      const packet = JSON.parse(data);
      this.sent.push(packet);
      callback?.(null);
      if (!Object.hasOwn(packet, 'id') || hold.has(packet.method)) return;
      if (errors.has(packet.method)) {
        queueMicrotask(() => this.receive({ id: packet.id, error: { code: -32600, message: 'private upstream detail' } }));
        return;
      }
      const result = packet.method === 'initialize' ? initResult
        : packet.method === 'account/read' ? account
        : packet.method === 'thread/turns/list' ? { data: [], nextCursor: packet.params.threadId, backwardsCursor: null }
        : packet.method === 'thread/archive' ? {}
        : {};
      const deliver = () => this.receive({ id: packet.id, result });
      if (reverse && packet.method === 'thread/turns/list') setTimeout(deliver, packet.params.threadId === 'first' ? 20 : 1);
      else queueMicrotask(deliver);
    }
    receive(packet) { this.emit('message', Buffer.from(JSON.stringify(packet))); }
    close() { this.readyState = 2; queueMicrotask(() => { this.readyState = 3; this.emit('close'); }); }
    terminate() { this.readyState = 3; queueMicrotask(() => this.emit('close')); }
  }
  return {
    sockets,
    factory: (_url, _options) => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('handshake, auth redaction, schema checks, correlation and raw server request IDs', async (t) => {
  const harness = socketHarness({
    account: { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'secret@example.invalid', planType: 'plus' } },
    reverse: true,
  });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/' }, harness.factory);
  t.after(() => port.close());
  const events = [];
  port.subscribe((event) => events.push(event));
  await port.connect();

  assert.equal(port.status().connection, 'connected');
  assert.equal(port.status().authorization, 'ready');
  const initialGeneration = port.status().generation;
  assert.equal(initialGeneration?.length, 36);
  const account = await port.call('account/read', { refreshToken: false }, { mutation: false });
  assert.deepEqual(account, { authorization: 'ready' });
  assert.equal(JSON.stringify(events).includes('secret@example.invalid'), false);
  assert.ok(harness.sockets[0].sent.some((packet) => packet.method === 'initialized' && !Object.hasOwn(packet, 'id')));

  const results = await Promise.all([
    port.call('thread/turns/list', { threadId: 'first' }, { mutation: false }),
    port.call('thread/turns/list', { threadId: 'second' }, { mutation: false }),
  ]);
  assert.deepEqual(results.map((item) => item.nextCursor), ['first', 'second']);
  await assert.rejects(port.call('thread/turns/list', {}, { mutation: false }), (error) =>
    error instanceof CodexError && error.code === 'invalid-params' && error.outcome === 'not-sent');
  await assert.rejects(port.call('account/read', { refreshToken: true }, { mutation: false }), (error) =>
    error instanceof CodexError && error.code === 'unsafe-account-read');
  await assert.rejects(port.call('unknown/method', {}, { mutation: false }), (error) => error.code === 'unsupported-method');

  harness.sockets[0].receive({ id: 91, method: 'item/commandExecution/requestApproval', params: {
    itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1',
  } });
  await tick();
  const observed = events.find((event) => event.type === 'request');
  assert.equal(observed?.id, 91);
  assert.equal(observed?.supported, true);
  await port.respond(91, { decision: 'decline' });
  assert.deepEqual(harness.sockets[0].sent.at(-1), { id: 91, result: { decision: 'decline' } });
  await assert.rejects(port.respond(91, { decision: 'decline' }), (error) => error.code === 'unknown-server-request');
  harness.sockets[0].receive({ method: 'serverRequest/resolved', params: { requestId: 91, threadId: 'thread-1' } });
  harness.sockets[0].receive({ id: 'resolved-before-answer', method: 'item/commandExecution/requestApproval', params: {
    itemId: 'item-2', startedAtMs: 2, threadId: 'thread-1', turnId: 'turn-1',
  } });
  await tick();
  harness.sockets[0].receive({ method: 'serverRequest/resolved', params: { requestId: 'resolved-before-answer', threadId: 'thread-1' } });
  await tick();
  await assert.rejects(port.respond('resolved-before-answer', { decision: 'decline' }), (error) => error.code === 'unknown-server-request');

  harness.sockets[0].receive({ id: 'replayed', method: 'item/future/request', params: {
    threadId: 'own-thread', turnId: 'own-turn', privateText: 'do not retain this payload',
  } });
  await tick();
  const unsupported = events.find((event) => event.type === 'request' && event.id === 'replayed');
  assert.deepEqual(unsupported.params, { threadId: 'own-thread', turnId: 'own-turn' });
  assert.equal(unsupported.supported, false);
  await assert.rejects(port.respond('replayed', {}), (error) => error.code === 'invalid-response-params');
  harness.sockets[0].receive({ id: {}, method: 'item/commandExecution/requestApproval', params: {} });
  await tick();
  assert.ok(events.some((event) => event.type === 'connection' && event.code === 'invalid-server-request'));

  const invalidResult = port.call('thread/turns/list', { threadId: 'invalid-result' }, { mutation: false });
  const rawCall = harness.sockets[0].sent.at(-1);
  harness.sockets[0].receive({ id: rawCall.id, result: { data: 'wrong-type' } });
  await assert.rejects(invalidResult, (error) => error.code === 'invalid-result' && error.outcome === 'query');

  const invalidShape = port.call('thread/turns/list', { threadId: 'invalid-shape' }, { mutation: false });
  const malformedCall = harness.sockets[0].sent.at(-1);
  harness.sockets[0].receive({ id: malformedCall.id, error: { code: -32600 }, result: {} });
  await assert.rejects(invalidShape, (error) => error.code === 'invalid-response-shape' && error.outcome === 'query');
});

test('mutation timeout has unknown outcome; pending and outbound buffers stay bounded', async (t) => {
  const harness = socketHarness({ account: { requiresOpenaiAuth: false, account: null }, hold: new Set(['thread/archive', 'thread/turns/list']) });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/', maxPending: 1 }, harness.factory);
  t.after(() => port.close());
  await port.connect();
  const mutation = port.call('thread/archive', { threadId: 'own-thread' }, { mutation: true, timeoutMs: 30 });
  await assert.rejects(port.call('thread/turns/list', { threadId: 'own-thread' }, { mutation: false }), (error) =>
    error.code === 'pending-limit' && error.outcome === 'not-sent');
  await assert.rejects(mutation, (error) => error.code === 'timeout' && error.outcome === 'unknown');
  assert.equal(port.status().authorization, 'ready');

  harness.sockets[0].bufferedAmount = 2 * 1024 * 1024;
  await assert.rejects(port.call('thread/turns/list', { threadId: 'own-thread' }, { mutation: false }), (error) =>
    error.code === 'send-capacity' && error.outcome === 'not-sent');
  harness.sockets[0].bufferedAmount = 0;
  const oldGeneration = port.status().generation;
  const pendingRead = port.call('thread/turns/list', { threadId: 'disconnect-read' }, { mutation: false });
  const pendingReadRejected = assert.rejects(pendingRead, (error) => error.code === 'disconnected' && error.outcome === 'query');
  harness.sockets[0].terminate();
  await tick();
  await pendingReadRejected;
  assert.equal(port.status().connection, 'disconnected');
  assert.equal(port.status().generation, oldGeneration);
  await assert.rejects(port.call('thread/turns/list', { threadId: 'own-thread' }, { mutation: false }), (error) =>
    error.code === 'disconnected' && error.outcome === 'not-sent');
  await port.connect();
  assert.notEqual(port.status().generation, oldGeneration);
  harness.sockets[1].receive({ id: 91, method: 'item/commandExecution/requestApproval', params: {
    itemId: 'replayed-item', startedAtMs: 2, threadId: 'own-thread', turnId: 'own-turn',
  } });
  await tick();
  await port.respond(91, { decision: 'decline' });
  assert.deepEqual(harness.sockets[1].sent.at(-1), { id: 91, result: { decision: 'decline' } });
  await port.close();
});

test('upstream invalid-request error leaves mutation outcome unknown without exposing message', async (t) => {
  const harness = socketHarness({
    account: { requiresOpenaiAuth: false, account: null },
    errors: new Set(['thread/archive']),
  });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/' }, harness.factory);
  t.after(() => port.close());
  await port.connect();
  await assert.rejects(port.call('thread/archive', { threadId: 'own-thread' }, { mutation: true }), (error) =>
    error instanceof CodexError && error.upstreamCode === -32600 && error.outcome === 'unknown' && error.message === 'upstream-error' && !error.message.includes('private'));
});

test('unsupported methods, invalid endpoints and invalid limits fail before sending', () => {
  const harness = socketHarness();
  assert.throws(() => createCodex({ socketUrl: 'ws://127.0.0.1:1' }, harness.factory), /explicit ws\+unix/);
  assert.throws(() => createCodex({ socketUrl: 'ws+unix:/tmp/test:/', maxPending: 0 }, harness.factory), /positive safe integers/);
});

test('slow subscribers do not block RPC reads and queue overflow is explicit', async (t) => {
  const harness = socketHarness({ account: { requiresOpenaiAuth: true, account: null } });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/', maxEvents: 1 }, harness.factory);
  t.after(() => port.close());
  await port.connect();
  assert.equal(port.status().authorization, 'required');
  const seen = [];
  let unblock;
  let entered;
  const firstStarted = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  port.subscribe(async (event) => {
    seen.push(event);
    if (event.type === 'notification' && event.method === 'thread/archived' && seen.filter((item) => item.type === 'notification').length === 1) {
      entered();
      await blocked;
    }
  });
  const socket = harness.sockets[0];
  socket.receive({ method: 'thread/archived', params: { threadId: 'one' } });
  await firstStarted;
  socket.receive({ method: 'thread/archived', params: { threadId: 'two' } });
  socket.receive({ method: 'thread/archived', params: { threadId: 'three' } });
  const read = port.call('thread/turns/list', { threadId: 'read-while-listener-is-blocked' }, { mutation: false });
  assert.equal((await read).data.length, 0);
  unblock();
  await tick(20);
  assert.ok(seen.some((event) => event.type === 'connection' && event.code === 'event-overflow'));
  assert.equal(port.status().eventOverflow, true);
});

test('oversized frame closes only the current transport and diagnoses the bound', async (t) => {
  const harness = socketHarness({ account: { requiresOpenaiAuth: false, account: null } });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/', maxFrameBytes: 256 }, harness.factory);
  t.after(() => port.close());
  const events = [];
  port.subscribe((event) => events.push(event));
  await port.connect();
  harness.sockets[0].emit('message', Buffer.alloc(257));
  await tick();
  assert.equal(port.status().connection, 'disconnected');
  assert.ok(events.some((event) => event.type === 'connection' && event.code === 'frame-too-large'));
});

test('server request retention is bounded and overflow remains observable', async (t) => {
  const harness = socketHarness({ account: { requiresOpenaiAuth: false, account: null } });
  const port = createCodex({ socketUrl: 'ws+unix:/tmp/codex-test.sock:/' }, harness.factory);
  t.after(() => port.close());
  const events = [];
  port.subscribe((event) => events.push(event));
  await port.connect();
  for (let id = 1; id <= 65; id++) {
    harness.sockets[0].receive({ id, method: 'item/future/request', params: { threadId: 'own-thread' } });
  }
  await tick(25);
  assert.equal(events.filter((event) => event.type === 'request').length, 64);
  assert.ok(events.some((event) => event.type === 'connection' && event.code === 'server-request-overflow'));
  await assert.rejects(port.respond(65, {}), (error) => error.code === 'unknown-server-request');
});
