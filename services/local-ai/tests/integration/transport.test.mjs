// ABOUTME: Проверяет local-ai transport через настоящий NATS Services broker.
// ABOUTME: Использует отдельный local-ai client и auth client, не заменяет broker mock.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connect } from 'nats';
import { subjects } from '../../contracts/index.mjs';
import { startLocalAiNats } from '../../dist/transport/index.js';

const required = process.env.BRAI_LOCAL_AI_TEST_REQUIRED === '1';
const url = process.env.BRAI_LOCAL_AI_TEST_NATS_URL;
const serviceUser = process.env.BRAI_LOCAL_AI_TEST_NATS_USER;
const servicePassword = process.env.BRAI_LOCAL_AI_TEST_NATS_PASSWORD;
const clientUser = process.env.BRAI_LOCAL_AI_TEST_NATS_CLIENT_USER;
const clientPassword = process.env.BRAI_LOCAL_AI_TEST_NATS_CLIENT_PASSWORD;
const encode = value => Buffer.from(JSON.stringify(value));
const decode = message => JSON.parse(new TextDecoder().decode(message.data));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function finishConnection(connection, label) {
  if (!connection) return;
  try {
    await withTimeout(connection.drain(), 2000, `${label} drain`);
  } catch {
    try {
      await withTimeout(connection.close(), 1000, `${label} close`);
    } catch {
      // Cleanup must stay bounded if the broker or connection is already unhealthy.
    }
  }
}

function loadFixtureUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'nats:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '19473'
    || parsed.username || parsed.password) {
    throw new Error('Local-ai transport acceptance requires the isolated 127.0.0.1:19473 NATS fixture');
  }
  return parsed.href;
}

async function connectFixture(server, user, password, inboxPrefix) {
  try {
    return await connect({ servers: server, user, pass: password, inboxPrefix, name: 'brai-local-ai-transport-test' });
  } catch {
    throw new Error('Could not connect to the configured local-ai NATS acceptance fixture');
  }
}

test('real NATS service validates DTOs, bounds work, and drains without closing its connection', {
  timeout: 30000,
  skip: !required && !url && 'Set BRAI_LOCAL_AI_TEST_REQUIRED for the protected acceptance wrapper',
}, async t => {
  assert.ok(url, 'BRAI_LOCAL_AI_TEST_NATS_URL is required');
  assert.ok(serviceUser && servicePassword, 'protected local-ai service credentials are required');
  assert.ok(clientUser && clientPassword, 'protected fixture client credentials are required');
  const server = loadFixtureUrl(url);
  const suffix = randomUUID();
  const serviceNc = await connectFixture(server, serviceUser, servicePassword, `_INBOX.brai_local_ai.transport.${suffix}`);
  let clientNc;
  let transport;
  t.after(async () => {
    releaseSlow?.();
    if (transport) {
      try {
        await withTimeout(transport.close(), 3000, 'transport close');
      } catch {
        try {
          await withTimeout(serviceNc.close(), 1000, 'service connection close');
        } catch {
          // The test runner has a finite timeout if even hard close cannot complete.
        }
      }
    }
    await finishConnection(clientNc, 'fixture client');
    await finishConnection(serviceNc, 'local-ai service');
  });
  clientNc = await connectFixture(server, clientUser, clientPassword, `_INBOX.brai_fixture.local_ai.${suffix}`);
  const serverInfo = serviceNc.info;
  assert.ok(serverInfo?.host);
  assert.equal(serverInfo?.port, 4222, 'NATS INFO must report the broker listen port, not its host-mapped target');
  assert.ok(serverInfo?.server_name);
  assert.ok(serverInfo?.server_id);
  assert.equal(clientNc.info?.server_id, serverInfo.server_id);
  assert.equal(clientNc.info?.server_name, serverInfo.server_name);
  t.diagnostic(`TRANSPORT_FIXTURE_BODY_ENTERED ${JSON.stringify({
    target: '127.0.0.1:19473', advertisedHost: serverInfo.host, advertisedPort: serverInfo.port,
    serverName: serverInfo.server_name, serverId: serverInfo.server_id,
  })}`);

  let releaseSlow;
  let startedSlow;
  let abortedSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const slowStarted = new Promise(resolve => { startedSlow = resolve; });
  const slowAborted = new Promise(resolve => { abortedSlow = resolve; });
  let seenContext;
  let seenStatusContext;
  const responseFor = request => ({
    modelId: request.modelId,
    revision: request.revision,
    profileId: request.profileId,
    state: 'loaded',
  });
  const statusResponse = {
    state: 'ready',
    components: Object.fromEntries(['database', 'nats', 'executables', 'weights']
      .map(name => [name, { state: 'ready', errorCode: null }])),
  };
  transport = await startLocalAiNats(serviceNc, {
    maxConcurrentRequests: 1,
    maxRequestBytes: 512,
    maxReplyBytes: 512,
    maxRequestMs: 900,
  }, {
    [subjects.modelsLoad]: async (request, context) => {
      seenContext = context;
      if (request.modelId === 'slow') {
        context.signal.addEventListener('abort', abortedSlow, { once: true });
        startedSlow();
        await slowGate;
      }
      if (request.modelId === 'failure') throw new Error('private implementation detail');
      if (request.modelId === 'large') return { ...responseFor(request), extra: 'x'.repeat(600) };
      return responseFor(request);
    },
    [subjects.status]: async (_request, context) => {
      seenStatusContext = context;
      return statusResponse;
    },
  });
  assert.equal(transport.connected(), true);
  for (const verb of ['PING', 'INFO', 'STATS']) {
    const response = await clientNc.request(`$SRV.${verb}.brai_local_ai`, new Uint8Array(), { timeout: 3000 });
    const value = decode(response);
    assert.equal(value.name, 'brai_local_ai');
    assert.equal(value.id, transport.service.id);
    if (verb === 'INFO') {
      assert.equal(value.endpoints.length, 2);
      assert.deepEqual(new Set(value.endpoints.map(endpoint => endpoint.subject)), new Set([subjects.modelsLoad, subjects.status]));
      assert.ok(value.endpoints.every(endpoint => endpoint.queue_group === 'brai_local_ai'));
    }
  }

  const statusResult = await clientNc.request(subjects.status, encode({}), { timeout: 3000 });
  assert.deepEqual(decode(statusResult), statusResponse);
  assert.ok(Date.parse(seenStatusContext.deadlineAt) > Date.now());
  assert.equal(seenStatusContext.ownerId, undefined);
  assert.ok(seenStatusContext.operationId);

  const request = (modelId, deadlineAt = new Date(Date.now() + 700).toISOString()) => ({
    modelId, revision: 'revision-1', profileId: 'profile-1', ownerId: randomUUID(), deadlineAt,
  });
  const successRequest = request('fast');
  const success = await clientNc.request(subjects.modelsLoad, encode(successRequest), { timeout: 3000 });
  assert.deepEqual(decode(success), responseFor(successRequest));
  assert.equal(seenContext.deadlineAt, successRequest.deadlineAt);

  const unknownField = await clientNc.request(subjects.modelsLoad, encode({ ...request('fast'), unexpected: true }), { timeout: 3000 });
  assert.equal(unknownField.headers.get('Nats-Service-Error'), 'INVALID_ARGUMENT');
  assert.equal(unknownField.headers.get('Nats-Service-Error-Code'), '400');
  assert.equal(decode(unknownField).code, 'INVALID_ARGUMENT');

  const invalidUtf8 = await clientNc.request(subjects.modelsLoad, Buffer.from([0xff]), { timeout: 3000 });
  assert.equal(invalidUtf8.headers.get('Nats-Service-Error'), 'INVALID_ARGUMENT');
  const tooLarge = await clientNc.request(subjects.modelsLoad, Buffer.alloc(513, 0x20), { timeout: 3000 });
  assert.equal(tooLarge.headers.get('Nats-Service-Error-Code'), '413');
  assert.equal(decode(tooLarge).code, 'INPUT_TOO_LARGE');

  const privateFailure = await clientNc.request(subjects.modelsLoad, encode(request('failure')), { timeout: 3000 });
  assert.equal(privateFailure.headers.get('Nats-Service-Error'), 'INTERNAL');
  assert.equal(decode(privateFailure).message, 'INTERNAL');
  assert.doesNotMatch(JSON.stringify(decode(privateFailure)), /private implementation detail/);

  const largeReply = await clientNc.request(subjects.modelsLoad, encode(request('large')), { timeout: 3000 });
  assert.equal(largeReply.headers.get('Nats-Service-Error'), 'RESULT_TOO_LARGE');
  assert.equal(decode(largeReply).code, 'RESULT_TOO_LARGE');

  const expired = await clientNc.request(subjects.modelsLoad, encode(request('expired', new Date(Date.now() - 1000).toISOString())), { timeout: 3000 });
  assert.equal(expired.headers.get('Nats-Service-Error'), 'DEADLINE_EXCEEDED');
  const overPolicy = await clientNc.request(subjects.modelsLoad, encode(request('over-policy', new Date(Date.now() + 5000).toISOString())), { timeout: 3000 });
  assert.equal(overPolicy.headers.get('Nats-Service-Error'), 'INVALID_ARGUMENT');

  const suppliedDeadline = new Date(Date.now() + 300).toISOString();
  const slowReplyPromise = clientNc.request(subjects.modelsLoad, encode(request('slow', suppliedDeadline)), { timeout: 3000 });
  await slowStarted;
  const slowReply = await slowReplyPromise;
  assert.equal(slowReply.headers.get('Nats-Service-Error'), 'DEADLINE_EXCEEDED');
  await slowAborted;
  assert.equal(seenContext.deadlineAt, suppliedDeadline);
  assert.equal(seenContext.signal.aborted, true);

  const busy = await clientNc.request(subjects.modelsLoad, encode(request('fast')), { timeout: 3000 });
  assert.equal(busy.headers.get('Nats-Service-Error'), 'BUSY');
  assert.deepEqual(decode(await clientNc.request(subjects.status, encode({}), { timeout: 3000 })), statusResponse, 'status has reserved capacity while compute admission is full');
  const draining = transport.drainHandlers();
  assert.equal(await Promise.race([draining.then(() => true), delay(25).then(() => false)]), false);
  releaseSlow();
  await draining;

  const stats = await clientNc.request('$SRV.STATS.brai_local_ai', new Uint8Array(), { timeout: 3000 });
  const statsValue = decode(stats);
  assert.ok(statsValue.endpoints[0].data.rejectedRequests >= 1);
  assert.ok(statsValue.endpoints[0].data.timedOutRequests >= 1);
  assert.ok(statsValue.endpoints[0].data.failedRequests >= 1);
  assert.ok(statsValue.endpoints[0].data.settledHandlers >= 1);

  await transport.service.stop();
  assert.equal(transport.connected(), false);
  assert.equal(serviceNc.isClosed(), false);
  await withTimeout(transport.stopAdmission(), 3000, 'stop admission');
  await withTimeout(transport.drainHandlers(), 3000, 'handler drain');
  assert.equal(transport.connected(), false);
  assert.equal(serviceNc.isClosed(), false);
});
