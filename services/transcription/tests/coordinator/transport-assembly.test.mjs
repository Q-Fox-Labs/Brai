// ABOUTME: Проверяет конфигурацию, реальные isolated children и owner adapter ошибки без внешних providers.
// ABOUTME: Подставленные NATS replies обозначают только protocol boundary, а не настоящие artifacts/history.
import assert from 'node:assert/strict';
import test from 'node:test';
import { headers } from 'nats';
import { loadCoordinatorConfig } from '../../dist/coordinator/config.js';
import { spawnCoordinatorChildren } from '../../dist/coordinator/childspawn.js';
import { createDependencyPorts } from '../../dist/coordinator/transport/dependencies.js';
import { validateDto } from '../../contracts/index.mjs';

function environment() {
  const env = {
    TRANSCRIPTION_INSTANCE_ID: 'fixture-instance', TRANSCRIPTION_WORKER_ID: 'fixture-worker',
    TRANSCRIPTION_AUTH_BINDINGS_JSON: JSON.stringify([{ token: 'synthetic-secret', principal: { scopeType: 'user', scopeId: 'scope', ownerId: 'owner', permissions: ['transcription:use'] } }]),
    TRANSCRIPTION_HTTP_HOST: '127.0.0.1', TRANSCRIPTION_HTTP_PORT: '19681', TRANSCRIPTION_ALLOWED_HOSTS_JSON: '["fixture.test"]', TRANSCRIPTION_ALLOWED_ORIGINS_JSON: '["https://fixture.test"]',
    TRANSCRIPTION_NATS_URL: 'nats://127.0.0.1:19680', TRANSCRIPTION_NATS_USER: 'synthetic-app', TRANSCRIPTION_NATS_PASSWORD: 'synthetic-app-secret', TRANSCRIPTION_NATS_INBOX_PREFIX: '_INBOX.brai_transcription',
    TRANSCRIPTION_HELPER_PGHOST: '127.0.0.1', TRANSCRIPTION_HELPER_PGPORT: '19679', TRANSCRIPTION_HELPER_PGDATABASE: 'fixture', TRANSCRIPTION_HELPER_PGUSER: 'synthetic-app', TRANSCRIPTION_HELPER_PGPASSWORD: 'synthetic-pg-secret',
  };
  for (const name of ['MAX_EXECUTE_CONCURRENCY', 'LEASE_RENEW_INTERVAL_MS', 'DEFAULT_EXECUTION_TIMEOUT_MS', 'RESULT_TTL_MS', 'MAX_RESULT_COUNT', 'MAX_RESULT_BYTES', 'MAX_TOTAL_RESULT_BYTES',
    'HTTP_HEADER_BYTES', 'HTTP_REQUEST_BYTES', 'HTTP_RESPONSE_BYTES', 'HTTP_REQUEST_TIMEOUT_MS', 'HTTP_CONCURRENT_REQUESTS', 'HTTP_MAX_CONNECTIONS',
    'NATS_REQUEST_BYTES', 'NATS_RESPONSE_BYTES', 'DEPENDENCY_REQUEST_TIMEOUT_MS', 'MAX_CATALOG_ITEMS', 'CATALOG_PAGE_SIZE',
    'PG_POOL_MAX', 'HISTORY_CAPACITY', 'REQUEST_LEASE_MS', 'HISTORY_LEASE_MS', 'TRANSACTION_TIMEOUT_MS', 'RECOVERY_BATCH_SIZE',
    'RPC_CONTROL_TIMEOUT_MS', 'CHILD_SHUTDOWN_TIMEOUT_MS', 'RECOVERY_MAX_BATCHES', 'RECOVERY_CYCLE_TIMEOUT_MS', 'RECOVERY_POLL_INTERVAL_MS', 'HISTORY_MAX_DELIVERIES', 'HISTORY_POLL_INTERVAL_MS', 'PUMP_POLL_INTERVAL_MS']) env[`TRANSCRIPTION_${name}`] = '10';
  Object.assign(env, { TRANSCRIPTION_MAX_EXECUTE_CONCURRENCY: '1', TRANSCRIPTION_RPC_FRAME_BYTES: '4096', TRANSCRIPTION_RPC_BATCH_ITEMS: '10', TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '4', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '2' });
  return env;
}

test('explicit finite config rejects every missing field, invalid limits/prefixes without disclosing values', () => {
  const base = environment();
  const config = loadCoordinatorConfig(base);
  assert.equal(config.nats.inboxPrefix, '_INBOX.brai_transcription');
  for (const key of Object.keys(base).filter((key) => !['TRANSCRIPTION_NATS_USER', 'TRANSCRIPTION_NATS_PASSWORD'].includes(key))) {
    const env = { ...base }; delete env[key];
    assert.throws(() => loadCoordinatorConfig(env), /Invalid transcription coordinator configuration/);
  }
  for (const invalid of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => loadCoordinatorConfig({ ...base, TRANSCRIPTION_HTTP_REQUEST_BYTES: invalid }));
  for (const invalid of ['_INBOX.*', '_INBOX.>', '_INBOX..bad', '_INBOX.bad space', '_INBOX.bad\nsecret']) assert.throws(() => loadCoordinatorConfig({ ...base, TRANSCRIPTION_NATS_INBOX_PREFIX: invalid }));
  assert.throws(() => loadCoordinatorConfig({ ...base, TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '4' }));
  try { loadCoordinatorConfig({ ...base, TRANSCRIPTION_AUTH_BINDINGS_JSON: 'credential-sentinel' }); assert.fail(); }
  catch (error) { assert.equal(error.message.includes('credential-sentinel'), false); }
});

test('child projections exclude ambient/owner/migration secrets and localAI config remains explicit', () => {
  const base = environment();
  const config = loadCoordinatorConfig({ ...base, PGPASSWORD: 'foreign-owner-secret', DATABASE_URL: 'foreign-secret-url', TRANSCRIPTION_MIGRATION_TIMEOUT_MS: '9', TRANSCRIPTION_APP_ROLE: 'owner', OPENAI_API_KEY: 'foreign-provider-secret' });
  assert.deepEqual(Object.keys(config.children.external).sort(), ['BATCH_ITEMS', 'CONCURRENT_EXECUTE', 'CONCURRENT_REQUESTS', 'FRAME_BYTES'].map((key) => `TRANSCRIPTION_RPC_${key}`).sort());
  for (const projection of Object.values(config.children)) assert.equal(JSON.stringify(projection).includes('foreign'), false);
  assert.equal(config.children.helper.PGPASSWORD, base.TRANSCRIPTION_HELPER_PGPASSWORD);
  assert.equal(config.localAi, undefined);
  const configured = { ...base, TRANSCRIPTION_LOCAL_AI_NATS_URL: 'nats://127.0.0.1:19680', TRANSCRIPTION_LOCAL_AI_NATS_USER: 'local-app', TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD: 'local-secret',
    TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX: '_INBOX.brai_transcription_local', TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS: '50', TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS: '100', TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES: '2048' };
  const local = loadCoordinatorConfig(configured);
  assert.equal(local.children.local.TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX, '_INBOX.brai_transcription_local');
  assert.equal(local.children.local.TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS, '100');
  for (const key of ['TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX', 'TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS', 'TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES']) {
    const env = { ...configured }; delete env[key]; assert.throws(() => loadCoordinatorConfig(env));
  }
});

test('actual three child programs isolate env, validate methods and close idempotently without restart', { timeout: 20000 }, async (t) => {
  const rpc = { TRANSCRIPTION_RPC_FRAME_BYTES: '4096', TRANSCRIPTION_RPC_BATCH_ITEMS: '4', TRANSCRIPTION_RPC_CONCURRENT_REQUESTS: '4', TRANSCRIPTION_RPC_CONCURRENT_EXECUTE: '2' };
  const children = spawnCoordinatorChildren({ children: { helper: rpc, local: rpc, external: rpc }, rpcFrameBytes: 4096, rpcConcurrentRequests: 4, rpcControlTimeoutMs: 15000, childShutdownTimeoutMs: 1000 });
  t.after(() => children.close());
  assert.deepEqual(await children.external.call('health', {}), { available: false });
  assert.deepEqual(await children.local.call('health', {}), { configured: false, verified: false, available: false });
  await assert.rejects(children.local.call('execute', { requestId: '11111111-1111-4111-8111-111111111111', audioArtifactId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222', ownerId: 'fixture-owner', model: { modelId: 'whisper', revision: 'v1', profileId: 'cpu' },
    deadlineAt: new Date(Date.now() + 15000).toISOString() }), (error) => error.code === 'RPC_REMOTE' && error.rpcCode === -32000 && error.errorCode === 'DEPENDENCY_UNAVAILABLE' && error.outcome === 'unknown');
  await assert.rejects(children.external.call('health', { ownerId: 'attacker' }), (error) => error.errorCode === 'INVALID_ARGUMENT' && error.outcome === 'not_started');
  await assert.rejects(children.helper.call('health', {}), (error) => error.code === 'RPC_CLOSED' && error.outcome === 'not_started');
  await children.close(); await children.close();
  await assert.rejects(children.external.call('health', {}), (error) => error.code === 'RPC_CLOSED' && error.outcome === 'not_started');
});

const bounds = { dependencyTimeoutMs: 1000, natsRequestBytes: 4096, natsResponseBytes: 4096, maxCatalogItems: 3, catalogPageSize: 2 };
const id = '11111111-1111-4111-8111-111111111111';
const event = { id, type_id: 1201, occurred_at: '2026-10-05T01:00:00Z', scope_type: 'user', scope_id: 'owner', data: { requestId: id, phase: 'accepted', outcome: null } };
function reply(value, errorCode, status) {
  const h = headers(); if (errorCode) { h.set('Nats-Service-Error', errorCode); h.set('Nats-Service-Error-Code', status); }
  return { headers: h, data: Buffer.from(value === undefined ? '' : JSON.stringify(value)) };
}

test('mocked history owner error DTO classifies permanent rejection; malformed/transient outcomes remain unknown', async () => {
  assert.equal(validateDto('HistoryAppendRequest', event), true);
  for (const [code, status] of [['EVENT_ID_CONFLICT', '409'], ['INVALID_ARGUMENT', '400'], ['REQUEST_TOO_LARGE', '413']]) {
    let sends = 0;
    const ports = await createDependencyPorts({ request: async () => { sends++; return reply({ code, message: 'private-message', retryable: false }, code, status); } }, undefined, bounds);
    await assert.rejects(ports.history.append(event), (error) => error.errorCode === 'HISTORY_REJECTED' && error.outcome === 'failed' && !JSON.stringify(error).includes('private-message'));
    assert.equal(sends, 1);
  }
  for (const response of [reply({ code: 'EVENT_ID_CONFLICT', message: 'private', retryable: false, extra: true }, 'EVENT_ID_CONFLICT', '409'),
    reply({ code: 'EVENT_ID_CONFLICT', message: 'private', retryable: false }, 'EVENT_ID_CONFLICT', '500'),
    reply({ code: 'DATABASE_UNAVAILABLE', message: 'private', retryable: true }, 'DATABASE_UNAVAILABLE', '503')]) {
    const ports = await createDependencyPorts({ request: async () => response }, undefined, bounds);
    await assert.rejects(ports.history.append(event), (error) => error.errorCode === 'HISTORY_DELIVERY_FAILED' && error.outcome === 'unknown');
  }
});

test('mocked owner artifact NOT_FOUND preserves safe code; absent catalog and malformed/oversize replies are outages', async () => {
  const missing = await createDependencyPorts({ request: async () => reply(undefined, 'NOT_FOUND', '404') }, undefined, bounds);
  await assert.rejects(missing.artifacts.get({ artifactId: id }), (error) => error.errorCode === 'NOT_FOUND');
  await assert.rejects(missing.localCatalog.list(), (error) => error.errorCode === 'MODEL_CATALOG_UNAVAILABLE');
  const malformed = await createDependencyPorts({ request: async () => ({ data: Buffer.from('{private'), headers: headers() }) }, undefined, bounds);
  await assert.rejects(malformed.artifacts.get({ artifactId: id }), (error) => error.errorCode === 'DEPENDENCY_UNAVAILABLE');
  const huge = await createDependencyPorts({ request: async () => ({ data: Buffer.alloc(4097), headers: headers() }) }, undefined, bounds);
  await assert.rejects(huge.artifacts.get({ artifactId: id }), (error) => error.errorCode === 'DEPENDENCY_UNAVAILABLE');
});

test('mocked localAI catalog omits unsupported null profile, keeps full selector and bounds pagination without success truncation', async () => {
  const card = { modelId: 'whisper', name: 'model', description: '', source: 'fixture', license: null, revision: 'v1', profileId: 'cpu', supported: true,
    operations: ['transcribe'], languages: [], inputKinds: ['audio_artifact'], outputKinds: ['transcription'], files: [],
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null }, limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: null, transcribe: {} }, installationState: 'installed', runtimeState: 'ready' };
  const unsupported = { ...card, profileId: null, supported: false, installationState: 'unsupported', runtimeState: null };
  const local = { request: async () => reply({ items: [unsupported, card], nextCursor: null }) };
  const ports = await createDependencyPorts({}, local, bounds);
  assert.deepEqual(await ports.localCatalog.list(), [{ selector: { modelId: 'whisper', revision: 'v1', profileId: 'cpu' }, supported: true, installed: true, ready: true }]);
  const broken = await createDependencyPorts({}, { request: async () => reply({ items: [{ ...card, profileId: null }], nextCursor: null }) }, bounds);
  await assert.rejects(broken.localCatalog.list(), (error) => error.errorCode === 'MODEL_CATALOG_UNAVAILABLE');
  let pages = 0;
  const cycling = await createDependencyPorts({}, { request: async () => { pages++; return reply({ items: [card], nextCursor: 'same' }); } }, bounds);
  await assert.rejects(cycling.localCatalog.list(), (error) => error.errorCode === 'MODEL_CATALOG_UNAVAILABLE');
  assert.equal(pages, 2);
});
