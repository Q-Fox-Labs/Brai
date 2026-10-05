// ABOUTME: Проверяет polling, смену аккаунта и безопасную проекцию лимита.
// ABOUTME: Использует fake Codex, управляемые часы и один локальный native socket.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import Ajv from 'ajv';
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
import publicSchema from '../schemas/messages.schema.json' with { type: 'json' };
import { validateLimits } from '../contracts/index.mjs';
import { createLimitsMonitor } from '../dist/limits.js';
import { createCodex } from '../dist/codex.js';

function clock() {
  let now = 0, next = 0;
  const timeouts = new Map(), intervals = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) { const id = ++next; timeouts.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, delay) { const id = ++next; intervals.set(id, { fn, every: delay, at: now + delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const timeout = [...timeouts].map(([id, value]) => ({ id, ...value, kind: 'timeout' })).sort((a, b) => a.at - b.at)[0];
        const interval = [...intervals].map(([id, value]) => ({ id, ...value, kind: 'interval' })).sort((a, b) => a.at - b.at)[0];
        const nextTimer = !timeout ? interval : !interval ? timeout : timeout.at <= interval.at ? timeout : interval;
        if (!nextTimer || nextTimer.at > end) break;
        now = nextTimer.at;
        if (nextTimer.kind === 'timeout') timeouts.delete(nextTimer.id);
        else if (intervals.has(nextTimer.id)) intervals.get(nextTimer.id).at += nextTimer.every;
        nextTimer.fn();
      }
      now = end;
    },
    counts: () => ({ timeouts: timeouts.size, intervals: intervals.size }),
  };
}

function fixture(initial = { generation: 'g1', connection: 'connected', authorization: 'ready' }) {
  let current = initial;
  const listeners = new Set(), calls = [];
  const codex = {
    status: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    call(method, params) { return new Promise((resolve, reject) => calls.push({ method, params, resolve, reject })); },
  };
  return {
    codex, calls,
    emit(event) { for (const listener of listeners) listener(event); },
    status(value) { current = value; },
    listeners,
  };
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const windows = (usedPercent = 38) => ({ accountId: 'private-account', planType: 'pro', rateLimitResetCredits: { availableCount: 3 }, rateLimitUpsell: { title: 'private banner' }, rateLimitsByLimitId: { codex: { primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null } }, rateLimits: { primary: { usedPercent: 99 } } });

test('exported limits validator and owner Status schema accept the same closed projection', () => {
  const ajv = new Ajv({ strict: false });
  ajv.addSchema(publicSchema, 'public');
  const statusValid = ajv.compile({ $ref: 'public#/definitions/Status' });
  const limits = { state: 'ready', revision: 1, observedAt: 1_800_000_000_000, windows: [{ slot: 'primary', remainingPercent: 62, windowDurationMins: 300, resetsAt: 1_900_000_000 }] };
  const status = { generation: 'g1', connection: 'connected', authorization: 'ready', ready: true, limits };
  assert.equal(validateLimits(limits), true);
  assert.equal(statusValid(status), true);
  const duplicate = { ...limits, windows: [...limits.windows, { ...limits.windows[0] }] };
  assert.equal(validateLimits(duplicate), false);
  assert.equal(statusValid({ ...status, limits: duplicate }), false);
  assert.equal(validateLimits({ ...limits, windows: [{ ...limits.windows[0], remainingPercent: 101 }] }), false);
});

test('initial full read projects only codex windows, clamps percentages, and returns an isolated snapshot', async () => {
  const f = fixture(), timers = clock(), monitor = createLimitsMonitor(f.codex, timers);
  assert.equal(monitor.snapshot().state, 'loading');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'account/rateLimits/read');
  assert.deepEqual(f.calls[0].params, { excludeResetCreditDetails: true });
  assert.equal('supportsLunaReserve' in f.calls[0].params, false);
  const response = windows();
  response.rateLimitsByLimitId.codex.secondary = { usedPercent: -4 };
  f.calls[0].resolve(response);
  await flush();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.state, 'ready');
  assert.deepEqual(Object.keys(snapshot).sort(), ['observedAt', 'revision', 'state', 'windows']);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.deepEqual(snapshot.windows, [
    { slot: 'primary', remainingPercent: 62, windowDurationMins: 300, resetsAt: 1_900_000_000 },
    { slot: 'secondary', remainingPercent: 100, windowDurationMins: null, resetsAt: null },
  ]);
  snapshot.windows[0].remainingPercent = 0;
  assert.equal(monitor.snapshot().windows[0].remainingPercent, 62);
  assert.equal(validateLimits(monitor.snapshot()), true);
  monitor.close();
});

test('sparse updates coalesce to one queued full read and a missing codex bucket is unavailable', async () => {
  const f = fixture(), timers = clock(), monitor = createLimitsMonitor(f.codex, timers);
  for (let i = 0; i < 6; i++) monitor.observe({ type: 'notification', method: 'account/rateLimits/updated', params: { rateLimits: {} } });
  assert.equal(f.calls.length, 1);
  timers.advance(5_000);
  f.calls[0].resolve(windows());
  await flush();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ rateLimitsByLimitId: {}, rateLimits: { limitId: null, primary: { usedPercent: 2 } } });
  await flush();
  assert.deepEqual(monitor.snapshot().windows, []);
  assert.equal(monitor.snapshot().state, 'unavailable');
  timers.advance(55_000);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve({ rateLimits: { limitId: 'other', primary: { usedPercent: 2 } } });
  await flush();
  assert.equal(monitor.snapshot().state, 'unavailable');
  monitor.close();
});

test('failed refresh makes a real previous window stale and freshness expiry increments revision', async () => {
  const f = fixture(), timers = clock(), monitor = createLimitsMonitor(f.codex, timers);
  f.calls[0].resolve(windows()); await flush();
  const revision = monitor.snapshot().revision;
  timers.advance(60_000);
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error('temporary failure')); await flush();
  assert.equal(monitor.snapshot().state, 'stale');
  assert.equal(monitor.snapshot().windows[0].remainingPercent, 62);
  assert.ok(monitor.snapshot().revision > revision);
  monitor.close();

  const fresh = fixture(), freshTimers = clock(), freshness = createLimitsMonitor(fresh.codex, freshTimers);
  fresh.calls[0].resolve(windows()); await flush();
  const readyRevision = freshness.snapshot().revision;
  freshTimers.advance(90_000);
  const expired = freshness.snapshot();
  assert.equal(expired.state, 'stale');
  assert.ok(expired.revision > readyRevision);
  freshness.close();
});

test('account switch clears old windows and required-to-ready starts polling; close cleans timers/subscription', async () => {
  const f = fixture(), timers = clock(), monitor = createLimitsMonitor(f.codex, timers);
  f.calls[0].resolve(windows()); await flush();
  const previousRevision = monitor.snapshot().revision;
  f.status({ generation: 'g1', connection: 'connected', authorization: 'required' });
  monitor.observe({ type: 'notification', method: 'account/updated', params: {} });
  assert.deepEqual(monitor.snapshot().windows, []);
  assert.equal(monitor.snapshot().state, 'unavailable');
  assert.ok(monitor.snapshot().revision > previousRevision);
  assert.equal(timers.counts().intervals, 0);
  f.status({ generation: 'g1', connection: 'connected', authorization: 'ready' });
  monitor.observe({ type: 'notification', method: 'account/updated', params: {} });
  assert.equal(monitor.snapshot().state, 'loading');
  timers.advance(5_000);
  assert.equal(f.calls.length, 2);
  timers.advance(60_000);
  f.calls[1].resolve(windows()); await flush();
  assert.equal(f.calls.length, 3);
  monitor.close();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
  assert.equal(f.listeners.size, 0);
  monitor.observe({ type: 'connection', status: { generation: 'g3', connection: 'connected', authorization: 'ready' } });
  monitor.observe({ type: 'notification', method: 'account/rateLimits/updated', params: { rateLimits: {} } });
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(windows(3)); await flush();
  assert.equal(monitor.snapshot().state, 'unavailable');
});

test('late read from an old generation cannot overwrite the new generation snapshot', async () => {
  const f = fixture(), timers = clock(), monitor = createLimitsMonitor(f.codex, timers);
  f.status({ generation: 'g2', connection: 'connected', authorization: 'ready' });
  monitor.observe({ type: 'connection', status: f.codex.status() });
  const revision = monitor.snapshot().revision;
  f.calls[0].resolve(windows()); await flush();
  assert.equal(monitor.snapshot().state, 'loading');
  assert.equal(monitor.snapshot().revision, revision);
  timers.advance(5_000);
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(windows()); await flush();
  assert.equal(monitor.snapshot().state, 'ready');
  monitor.close();
});

test('native Codex boundary validates the new rate-limit request, result, and sparse notification schemas', async t => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  ajv.addSchema(nativeSchema, 'native');
  const paramsValid = ajv.compile({ $ref: 'native#/definitions/GetAccountRateLimitsParams' });
  const resultValid = ajv.compile({ $ref: 'native#/definitions/GetAccountRateLimitsResponse' });
  const notificationValid = ajv.compile({ $ref: 'native#/definitions/AccountRateLimitsUpdatedNotification' });
  assert.equal(paramsValid({ excludeResetCreditDetails: true }), true);
  assert.equal(paramsValid({ excludeResetCreditDetails: 'true' }), false);
  assert.equal(resultValid({ rateLimits: null }), false);
  assert.equal(resultValid({ rateLimits: {}, rateLimitsByLimitId: { codex: { primary: { usedPercent: 38 } } } }), true);
  assert.equal(notificationValid({ rateLimits: {} }), true);
  const dir = mkdtempSync('/tmp/brai-limits-'), socketPath = join(dir, 'native.sock');
  const server = createServer(), wss = new WebSocketServer({ server }), calls = [], wireReplies = [];
  let peer;
  wss.on('error', () => {});
  wss.on('connection', socket => { peer = socket; socket.on('message', raw => {
    const packet = JSON.parse(raw.toString()); calls.push(packet);
    if (typeof packet.method !== 'string') { wireReplies.push(packet); return; }
    if (!Object.hasOwn(packet, 'id')) return;
    const result = packet.method === 'initialize' ? { codexHome: '/tmp/mock', platformFamily: 'unix', platformOs: 'linux', userAgent: 'test' }
      : packet.method === 'account/read' ? { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
        : packet.method === 'account/rateLimits/read' ? { accountId: 'private', ordinaryUsageAllowed: true, rateLimitResetCredits: { availableCount: 3 }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1_900_000_000 } } }, rateLimits: { primary: { usedPercent: 99 } } }
          : undefined;
    assert.ok(result, packet.method);
    socket.send(JSON.stringify({ id: packet.id, result }));
    if (packet.method === 'account/rateLimits/read') socket.send(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: {} } }));
  }); });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) {
    await new Promise(resolve => wss.close(resolve)); rmSync(dir, { recursive: true });
    if (error.code === 'EPERM') { t.skip('Среда запрещает локальные Unix sockets'); return; }
    throw error;
  }
  const codex = createCodex({ socketUrl: `ws+unix:${socketPath}:/` });
  try {
    await codex.connect();
    let receiveNotification;
    const notificationReceived = new Promise(resolve => { receiveNotification = resolve; });
    const unsubscribe = codex.subscribe(event => { if (event.method === 'account/rateLimits/updated') receiveNotification(event); });
    const result = await codex.call('account/rateLimits/read', { excludeResetCreditDetails: true });
    assert.equal(calls.find(call => call.method === 'account/rateLimits/read').params.excludeResetCreditDetails, true);
    assert.equal('supportsLunaReserve' in calls.find(call => call.method === 'account/rateLimits/read').params, false);
    assert.equal(result.accountId, 'private');
    assert.equal(result.rateLimitsByLimitId.codex.primary.usedPercent, 38);
    let timeout;
    const notification = await Promise.race([notificationReceived, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('rate-limit notification timeout')), 1_000); })]);
    clearTimeout(timeout);
    assert.equal(notification.method, 'account/rateLimits/updated');
    assert.deepEqual(notification.params, { rateLimits: {} });
    unsubscribe();
    await assert.rejects(codex.call('account/rateLimits/read', { excludeResetCreditDetails: 'true' }), error => error.code === 'INVALID_ARGUMENT');
    const requestEvent = id => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('server request timeout')); }, 1_000);
      const stop = codex.subscribe(event => {
        if (event.type === 'request' && event.id === id) { clearTimeout(timer); stop(); resolve(event); }
      });
    });
    const sendServerRequest = async packet => {
      const received = requestEvent(packet.id);
      peer.send(JSON.stringify(packet));
      const event = await received;
      for (let attempt = 0; attempt < 20 && !wireReplies.some(reply => reply.id === packet.id); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      return { event, reply: wireReplies.find(reply => reply.id === packet.id) };
    };
    const unknown = await sendServerRequest({ id: 'unknown-method', method: 'item/future/request', params: { threadId: 't', turnId: 't1' } });
    assert.equal(unknown.event.reason, 'unsupported-method');
    assert.deepEqual(unknown.event.params, { threadId: 't', turnId: 't1' });
    assert.equal(unknown.reply.error.code, -32601);
    assert.equal(codex.validateAnswer('unknown-method', {}), false);
    const dynamic = await sendServerRequest({ id: 'dynamic-tool', method: 'item/tool/call', params: { threadId: 't', turnId: 't1', namespace: 'codex_app', tool: 'list_artifacts', arguments: { secret: 'private-input' }, callId: 'private-call' } });
    assert.equal(dynamic.reply.error.code, -32601);
    assert.deepEqual(dynamic.event.params, { threadId: 't', turnId: 't1', namespace: 'codex_app', tool: 'list_artifacts' });
    assert.equal(JSON.stringify(dynamic.event).includes('private-'), false);
    const malformedTool = await sendServerRequest({ id: 'malformed-tool', method: 'item/tool/call', params: { threadId: 't', turnId: 't1', namespace: 'x'.repeat(65), tool: '<script>private-input</script>' } });
    assert.deepEqual(malformedTool.event.params, { threadId: 't', turnId: 't1' });
    const invalid = await sendServerRequest({ id: 'invalid-params', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 't1' } });
    assert.equal(invalid.event.reason, 'invalid-params');
    assert.equal(invalid.reply.error.code, -32602);
    const oversized = await sendServerRequest({ id: 'oversized', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 't1', payload: 'x'.repeat(33000) } });
    assert.equal(oversized.event.reason, 'request-too-large');
    assert.equal(oversized.reply.error.code, -32000);
    assert.deepEqual(oversized.event.params, { threadId: 't', turnId: 't1' });
    assert.equal(JSON.stringify(oversized.event).includes('x'.repeat(128)), false);
  } finally {
    await codex.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true });
  }
});
