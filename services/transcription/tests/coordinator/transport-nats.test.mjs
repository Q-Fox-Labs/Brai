// ABOUTME: Проверяет настоящий изолированный NATS broker и Services API с явно mock предметным портом.
// ABOUTME: Credentials вводятся machine-only; эта проверка не заявляет integration artifacts/history providers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, headers } from 'nats';
import { createPublicGateway } from '../../dist/coordinator/transport/boundary.js';
import { startNatsTransport } from '../../dist/coordinator/transport/nats.js';

test('real NATS Services exposes six metadata endpoints, safe errors and shared capacity; no result subject', { timeout: 30000 }, async (t) => {
  assert.equal(process.env.TRANSCRIPTION_TEST_NATS, '1', 'explicit isolated fixture activation required');
  const url = new URL(process.env.NATS_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '19680', 'isolated fixture only');
  const nc = await connect({ servers: process.env.NATS_URL, user: process.env.NATS_USER, pass: process.env.NATS_PASSWORD,
    reconnect: false, timeout: 5000, ...(process.env.NATS_INBOX_PREFIX ? { inboxPrefix: process.env.NATS_INBOX_PREFIX } : {}) });
  t.after(() => nc.close());
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const settings = { settings: { defaultLocalModel: null, allowReplacement: false, policyVersion: 1 }, revision: 1 };
  const gateway = createPublicGateway({ maxConcurrent: 1, bindings: [{ token: 'fixture-public-token', principal: { scopeType: 'user', scopeId: 'fixture', ownerId: 'fixture-owner', permissions: ['transcription:use'] } }],
    invoke: async (method) => { calls++; if (method === 'models.list') { began(); await held; return { localCatalogState: 'available', localItems: [], externalAvailable: false, externalItems: [], catalogErrorCode: null }; } return settings; },
  });
  const listener = await startNatsTransport(nc, gateway, { requestBytes: 100, responseBytes: 600 });
  t.after(async () => { release(); await listener.close(); await listener.settled(); });
  const auth = headers(); auth.set('Authorization', 'Bearer fixture-public-token');
  const call = (subject, body = {}, requestHeaders = auth) => nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout: 3000, headers: requestHeaders });
  const decode = (message) => JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(message.data));
  const prefix = 'brai.transcription.v1.';
  const ping = decode(await nc.request('$SRV.PING.brai_transcription', undefined, { timeout: 3000 }));
  assert.equal(ping.name, 'brai_transcription');
  const info = decode(await nc.request('$SRV.INFO.brai_transcription', undefined, { timeout: 3000 }));
  assert.equal(info.endpoints.length, 6);
  assert.deepEqual(info.endpoints.map((endpoint) => endpoint.subject).sort(), ['request.submit', 'request.get', 'request.cancel', 'models.list', 'settings.get', 'settings.set'].map((method) => prefix + method).sort());
  for (const endpoint of info.endpoints) assert.equal(endpoint.queue_group, 'brai_transcription');
  const okay = await call(prefix + 'settings.get');
  assert.deepEqual(decode(okay), settings);
  for (const [body, requestHeaders, code, status] of [[{}, headers(), 'UNAUTHENTICATED', '401'], [{ ownerId: 'attacker' }, auth, 'INVALID_ARGUMENT', '400'], [{ private: 'x'.repeat(120) }, auth, 'INPUT_TOO_LARGE', '413']]) {
    const error = await call(prefix + 'settings.get', body, requestHeaders);
    assert.equal(error.headers.get('Nats-Service-Error'), code);
    assert.equal(error.headers.get('Nats-Service-Error-Code'), status);
    assert.deepEqual(decode(error), { errorCode: code });
  }
  const blocked = call(prefix + 'models.list');
  await started;
  const busy = await call(prefix + 'settings.get');
  assert.deepEqual(decode(busy), { errorCode: 'OVERLOADED' });
  release(); await blocked;
  const stats = decode(await nc.request('$SRV.STATS.brai_transcription', undefined, { timeout: 3000 }));
  assert.equal(stats.endpoints.length, 6);
  assert.equal(JSON.stringify(stats).includes('attacker'), false);
  assert.equal(JSON.stringify(info).includes('result.get'), false);
  await assert.rejects(nc.request(prefix + 'result.get', Buffer.from('{}'), { timeout: 3000, headers: auth }), (error) => error.code === '503');
  assert.equal(calls, 2);
});
