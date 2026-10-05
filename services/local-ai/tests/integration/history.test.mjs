// ABOUTME: Проверяет защищённое преобразование фактов local-ai и доставку через append service_history.
// ABOUTME: Подменяет только NATS request и fenced outbox port; не изображает стендовую приёмку соседей.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendHistoryMetadataEvent,
  createHistoryDeliveryWorker,
  projectHistoryAppendRequest,
} from '../../dist/adapters/history/index.js';

const event = {
  id: '4C8EAC73-55DE-4414-8B0E-4A7A495A0891',
  type_id: 1201,
  occurred_at: '2026-10-05T20:15:30.123456+02:00',
  actor_id: 'user-1',
  scope_type: 'user',
  scope_id: 'user-1',
  object_type: 'operation',
  object_id: 'operation-1',
  data: {
    operation: 'invoke',
    modelId: 'embedder',
    outcome: 'accepted',
    phase: 'accepted',
    operationId: '73D2A4EF-6559-45BD-A1B3-CE822AD11D92',
    inputBytes: 24,
  },
};
const claim = { event, claimToken: 'lease-1' };
const options = { batchSize: 8, leaseMs: 90_000, retryDelayMs: 5_000, pollIntervalMs: 1_000, now: () => 1_800_000_000_000 };

function headers(values = {}) {
  return {
    has: name => Object.hasOwn(values, name),
    get: name => values[name],
  };
}
function response(body, responseHeaders) {
  return { data: Buffer.from(JSON.stringify(body)), headers: responseHeaders };
}
function acknowledged(input = projectHistoryAppendRequest(event), overrides = {}) {
  return {
    event: {
      id: input.id, source: 'local_ai', type_id: input.type_id,
      occurred_at: input.occurred_at, recorded_at: '2026-10-05T18:15:30.500000Z',
      actor_id: input.actor_id, scope_type: input.scope_type, scope_id: input.scope_id,
      object_type: input.object_type, object_id: input.object_id, data: input.data,
      ...overrides,
    },
  };
}
function outbox(claims = [claim]) {
  return {
    acknowledgements: [],
    failures: [],
    requested: [],
    async claimBatch(limit, leaseMs) {
      this.requested.push({ limit, leaseMs });
      return claims;
    },
    async acknowledge(id, token) { this.acknowledgements.push({ id, token }); },
    async fail(id, token, retryAt, errorCode) { this.failures.push({ id, token, retryAt, errorCode }); },
    async status() { return { pending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null }; },
  };
}
function worker(transport, store, extra = {}) {
  return createHistoryDeliveryWorker({ ...options, nats: transport, outbox: store, ...extra });
}

test('projection normalizes the owner DTO, omits source and rejects data outside the metadata allowlist', () => {
  const dto = projectHistoryAppendRequest(event);
  assert.equal(dto.id, event.id.toLowerCase());
  assert.equal(dto.occurred_at, '2026-10-05T18:15:30.123456Z');
  assert.equal(Object.hasOwn(dto, 'source'), false);
  assert.deepEqual(Object.keys(dto.data), ['operation', 'modelId', 'outcome', 'operationId', 'phase', 'inputBytes']);
  assert.throws(() => projectHistoryAppendRequest({ ...event, text: 'private prompt' }), /DELIVERY_INTERNAL/);
  assert.throws(() => projectHistoryAppendRequest({ ...event, data: { ...event.data, prompt: 'private prompt' } }), /DELIVERY_INTERNAL/);
  assert.throws(() => projectHistoryAppendRequest({ ...event, data: { ...event.data, vectorDimensions: 0 } }), /DELIVERY_INTERNAL/);
  assert.throws(() => projectHistoryAppendRequest({ ...event, data: { ...event.data, requestId: 'request-1' } }), /DELIVERY_INTERNAL/);
  assert.throws(() => projectHistoryAppendRequest({ ...event, scope_type: 'system', scope_id: 'other' }), /DELIVERY_INTERNAL/);
});

test('append requests use the fixed source subject and require the complete matching event before success', async () => {
  let call;
  await appendHistoryMetadataEvent({
    async request(subject, payload, requestOptions) {
      call = { subject, payload: JSON.parse(payload), requestOptions };
      return response(acknowledged(), headers());
    },
  }, event, 4_000);
  assert.deepEqual(call, {
    subject: 'brai.history.v1.append.local_ai',
    payload: projectHistoryAppendRequest(event),
    requestOptions: { timeout: 4_000 },
  });
  assert.throws(() => projectHistoryAppendRequest({ ...event, scope_id: 'x'.repeat(256) }), /DELIVERY_INTERNAL/);
  assert.throws(() => projectHistoryAppendRequest({ ...event, occurred_at: '2026-02-30T12:00:00Z' }), /DELIVERY_INTERNAL/);
  assert.equal(projectHistoryAppendRequest({ ...event, occurred_at: '2026-10-05T20:15:30.000001+05:30' }).occurred_at, '2026-10-05T14:45:30.000001Z');
});

test('permanent history errors fail the claim without retry; retryable body governs even INTERNAL', async () => {
  for (const [code, status, retryable, expectedCode, expectedRetryAt] of [
    ['EVENT_ID_CONFLICT', '409', false, 'HISTORY_REJECTED', null],
    ['INTERNAL', '500', true, 'HISTORY_UNAVAILABLE', '2027-01-15T08:00:05.000Z'],
  ]) {
    const store = outbox();
    const transport = { async request() {
      return response({ code, message: code, retryable }, headers({
        'Nats-Service-Error': code, 'Nats-Service-Error-Code': status,
      }));
    } };
    await worker(transport, store).runOnce();
    assert.deepEqual(store.acknowledgements, []);
    assert.deepEqual(store.failures, [{
      id: claim.event.id, token: claim.claimToken, retryAt: expectedRetryAt, errorCode: expectedCode,
    }]);
  }
});

test('network failure retains an event for a stable retry and records no event contents', async () => {
  const store = outbox();
  const bodies = [];
  const transport = { async request(_subject, payload) { bodies.push(Buffer.from(payload)); throw new Error('socket offline'); } };
  await worker(transport, store).runOnce();
  assert.equal(store.failures[0].errorCode, 'HISTORY_UNAVAILABLE');
  assert.equal(store.failures[0].retryAt, '2027-01-15T08:00:05.000Z');
  assert.deepEqual(store.acknowledgements, []);
  await worker(transport, store).runOnce();
  assert.deepEqual(bodies[0], bodies[1]);
});

test('reply error headers are checked before the body is read', async () => {
  const store = outbox();
  let checkedHeaders = false;
  const message = {
    headers: {
      has(name) { checkedHeaders = true; return name === 'Nats-Service-Error' || name === 'Nats-Service-Error-Code'; },
      get(name) { return name === 'Nats-Service-Error' ? 'EVENT_ID_CONFLICT' : '409'; },
    },
    get data() {
      assert.equal(checkedHeaders, true);
      return Buffer.from('not-json');
    },
  };
  const transport = { async request() { return message; } };
  await worker(transport, store).runOnce();
  assert.equal(store.failures[0].errorCode, 'DELIVERY_INTERNAL');
  assert.equal(store.failures[0].retryAt, null);
  assert.deepEqual(store.acknowledgements, []);
});

test('acknowledgement ID, source and content must match before the claim is acknowledged', async () => {
  for (const overrides of [
    { id: '67f524a1-c178-47b0-9748-e04e8659838a' },
    { source: 'other_source' },
    { data: { ...event.data, resultText: 'private' } },
  ]) {
    const store = outbox();
    const transport = { async request() {
      return response(acknowledged(undefined, overrides), headers());
    } };
    await worker(transport, store).runOnce();
    assert.deepEqual(store.acknowledgements, []);
    assert.equal(store.failures[0].errorCode, 'DELIVERY_INTERNAL');
    assert.equal(store.failures[0].retryAt, null);
  }
});

test('claims are processed sequentially with their original fencing tokens', async () => {
  const second = { ...claim, claimToken: 'lease-2', event: { ...event, id: '67f524a1-c178-47b0-9748-e04e8659838a' } };
  const store = outbox([claim, second]);
  let active = 0;
  let maxActive = 0;
  const transport = { async request(_subject, payload) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return response(acknowledged(JSON.parse(payload)), headers());
  } };
  const sender = worker(transport, store, { batchSize: 2 });
  assert.equal(await sender.runOnce(), 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(store.acknowledgements, [
    { id: claim.event.id, token: claim.claimToken },
    { id: second.event.id, token: second.claimToken },
  ]);
  assert.deepEqual(store.requested, [{ limit: 2, leaseMs: options.leaseMs }]);
});

test('stop waits for the in-flight request and leaves its claim untouched for lease replay', async () => {
  const store = outbox();
  let requestStarted;
  let finishRequest;
  const transport = {
    request() {
      requestStarted();
      return new Promise(resolve => { finishRequest = resolve; });
    },
  };
  const started = new Promise(resolve => { requestStarted = resolve; });
  const sender = worker(transport, store);
  const delivery = sender.runOnce();
  await started;
  const stopping = sender.stop();
  finishRequest(response(acknowledged(), headers()));
  await Promise.all([delivery, stopping]);
  assert.deepEqual(store.acknowledgements, []);
  assert.deepEqual(store.failures, []);
});
