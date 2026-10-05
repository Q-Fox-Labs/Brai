// ABOUTME: Проверяет сборку startup, fail cleanup и shutdown управляющего процесса.
// ABOUTME: Фабрики заменяются только в этом тесте; публичный NATS путь проверяет соседний live peer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalAiProcess, startLocalAi, validateLocalAiConfig } from '../../src/main.mjs';
import { validatePeerConfig } from './local-ai-peer.mjs';
import llamaProfile from '../../profiles/llama_cpp.json' with { type: 'json' };
import gigaProfile from '../../profiles/gigaam_pytorch.json' with { type: 'json' };

const config = () => ({
  postgres: { connectionString: 'postgres://fixture.invalid/local_ai', maxConnections: 3, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, outboxCapacity: 8, queryTimeoutMs: 1000 },
  nats: { servers: ['nats://127.0.0.1:19473'], user: 'local_ai', password: 'fixture-secret', token: null, name: 'local-ai-assembly-test', inboxPrefix: '_INBOX.brai_local_ai' },
  transport: { maxConcurrentRequests: 4, maxRequestBytes: 65536, maxReplyBytes: 1048576, maxRequestMs: 5000, shutdownTimeoutMs: 5000, serviceVersion: '1.0.0', serviceDescription: 'isolated test' },
  artifacts: { internalBaseUrl: 'http://127.0.0.1:19474/', tempRoot: '/tmp/local-ai-assembly-artifacts', maxAudioBytes: 10485760 },
  history: { batchSize: 2, leaseMs: 30000, retryDelayMs: 1000, pollIntervalMs: 1000, requestTimeoutMs: 10000 },
  installer: { rootDirectory: '/tmp/local-ai-assembly-models', seedDirectories: { llama_cpp: `/tmp/local-ai-assembly-models/${llamaProfile.modelId}/${llamaProfile.source.revision}/llama_cpp`, gigaam_pytorch: `/tmp/local-ai-assembly-models/${gigaProfile.modelId}/${gigaProfile.source.revision}/gigaam_pytorch` }, maxDownloadBytes: 1048576, maxFiles: 8, maxParallel: 2, maxOperationMs: 30000, hubRequestTimeoutMs: 5000, maxQueryLength: 200, maxPageSize: 20 },
  lifecycle: { maxLoadedModels: 2, maxQueuedOperations: 4, maxInputBytes: 1000000, maxEmbeddingItems: 8, maxResultBytes: 1000000, loadDeadlineMs: 30000 },
  runtime: {
    llama_cpp: { executable: '/opt/local-ai/bin/llama-server', cwd: '/opt/local-ai', args: llamaProfile.engine.args, env: {}, startupTimeoutMs: 10000, requestTimeoutMs: 5000, stopGraceMs: 1000, maxLineBytes: 1048576, host: '127.0.0.1', port: 19476, dimensions: llamaProfile.encoding.dimensions, contextTokens: llamaProfile.limits.contextTokens, maxBatchTokens: llamaProfile.limits.batchTokens, queryInstruction: llamaProfile.encoding.queryInstruction },
    gigaam_pytorch: { executable: '/opt/local-ai/bin/python', cwd: '/opt/local-ai', args: gigaProfile.engine.args, env: {}, startupTimeoutMs: 30000, requestTimeoutMs: 30000, stopGraceMs: 1000, maxLineBytes: 1048576, vadModelPath: '/opt/local-ai/vad', vadRevision: 'fixture-revision', threads: 2, longformMaximumSeconds: 120, audioDecodeTimeoutSeconds: 30 },
  },
});

function dependencies(order, hooks = {}) {
  const pool = {
    async query() { order.push('database.probe'); return { rows: [{ ok: 1 }] }; },
    async end() { order.push('database.close'); },
  };
  const store = {
    async recoverInterrupted() { order.push('recovery'); },
    async transaction(run) { return run({}); },
    async status() { return { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null }; },
  };
  const installer = { async cleanupAbandonedStaging() { order.push('staging.cleanup'); }, async close() { order.push('installer.close'); } };
  const lifecycle = { async close() { order.push('lifecycle.close'); if (hooks.lifecycleFailure) throw new Error('fixture failure'); if (hooks.lifecycleHang) return new Promise(() => {}); }, status() { return {}; } };
  const history = { start() { order.push('history.start'); }, async stop() { order.push('history.stop'); } };
  const transport = {
    connected() { return true; },
    async stopAdmission() { order.push('transport.stopAdmission'); },
    async drainHandlers() { order.push('transport.drainHandlers'); },
  };
  const nc = { async drain() { order.push('nats.close'); } };
  return {
    Pool: class { constructor() { return pool; } },
    connect: hooks.connect ?? (async options => { assert.equal(options.inboxPrefix, '_INBOX.brai_local_ai'); order.push('nats.connect'); return nc; }),
    factories: {
      createPostgresStore() { order.push('store.create'); return store; },
      registerSupportedProfiles() { order.push('catalog.seed'); },
      createModelInstaller() { order.push('installer.create'); return installer; },
      createProfileRuntimeFactory() { order.push('runtime.create'); return {}; },
      createArtifactsAdapter() { order.push('artifacts.create'); return {}; },
      createLifecycleManager() { order.push('lifecycle.create'); return lifecycle; },
      createCatalog() { order.push('catalog.create'); return {}; },
      createHuggingFaceCatalog() { order.push('hub.create'); return {}; },
      createHistoryDeliveryWorker() { order.push('history.create'); return history; },
      startLocalAiNats(_nc, _config, handlers) {
        assert.equal(Object.keys(handlers).length, 13, 'all public subjects must be wired');
        order.push('transport.start');
        if (hooks.transportFailure) throw new Error('fixture failure');
        return transport;
      },
    },
  };
}

test('configuration rejects omitted or unmeasured runtime limits before resources open', () => {
  const valid = config();
  assert.equal(validateLocalAiConfig(valid), valid);
  assert.throws(() => validateLocalAiConfig({ ...valid, runtime: { ...valid.runtime, gigaam_pytorch: { ...valid.runtime.gigaam_pytorch, longformMaximumSeconds: null } } }), /runtime\.gigaam_pytorch\.longformMaximumSeconds/);
  assert.throws(() => validateLocalAiConfig({ ...valid, postgres: { ...valid.postgres, outboxCapacity: 1 } }), /postgres\.outboxCapacity/);
  assert.throws(() => validateLocalAiConfig({ ...valid, runtime: { ...valid.runtime, llama_cpp: { ...valid.runtime.llama_cpp, env: { ...valid.runtime.llama_cpp.env, SECRET_KEY: 'never-accepted' } } } }), /runtime\.llama_cpp\.env\.SECRET_KEY/);
  assert.throws(() => validateLocalAiConfig({ ...valid, nats: { ...valid.nats, inboxPrefix: '_INBOX' } }), /nats\.inboxPrefix/);
});

test('public peer requires verified isolated fixture endpoint, role, and reply inbox', () => {
  const peer = {
    verifiedIsolated: true, servers: ['nats://127.0.0.1:19473'], inboxPrefix: '_INBOX.brai_fixture',
    user: 'fixture', password: 'fixture-secret', token: null, name: 'local-ai-peer-test', timeoutMs: 5000,
    ownerId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371',
    embeddingModel: { modelId: 'embed', revision: 'a'.repeat(40), profileId: 'llama_cpp' },
    transcriptionModel: { modelId: 'transcribe', revision: 'b'.repeat(40), profileId: 'gigaam_pytorch' },
    audioArtifactId: 'c6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', embeddingTexts: ['synthetic fixture text'],
    purpose: 'symmetric', searchQuery: 'synthetic fixture',
  };
  assert.equal(validatePeerConfig(peer), peer);
  assert.throws(() => validatePeerConfig({ ...peer, verifiedIsolated: false }), /verifiedIsolated/);
  assert.throws(() => validatePeerConfig({ ...peer, servers: ['nats://10.0.0.4:4222'] }), /servers/);
  assert.throws(() => validatePeerConfig({ ...peer, inboxPrefix: '_INBOX' }), /inboxPrefix/);
  assert.throws(() => validatePeerConfig({ ...peer, user: 'local_ai' }), /authentication/);
});

test('startup failure closes the database without echoing connection inputs', async () => {
  const order = [];
  const input = config();
  let createdPool;
  class FailedPool {
    constructor() { createdPool = this; }
    async query() { order.push('database.probe'); return {}; }
    async end() { order.push('database.close'); }
  }
  await assert.rejects(startLocalAi(input, {
    Pool: FailedPool,
    connect: async () => { throw new Error(input.postgres.connectionString); },
  }), /LOCAL_AI_STARTUP_FAILED/);
  assert.deepEqual(order, ['database.probe', 'database.close']);
  assert.ok(createdPool);
});

test('startup recovers before admission and shutdown closes owned resources in order', async () => {
  const order = [];
  const runtime = await startLocalAi(config(), dependencies(order));
  assert.ok(order.indexOf('recovery') < order.indexOf('catalog.seed'));
  assert.ok(order.indexOf('staging.cleanup') < order.indexOf('history.start'));
  assert.ok(order.indexOf('history.start') < order.indexOf('transport.start'));
  await runtime.close();
  await runtime.close();
  assert.deepEqual(order.slice(-7), [
    'transport.stopAdmission', 'installer.close', 'lifecycle.close', 'transport.drainHandlers',
    'history.stop', 'nats.close', 'database.close',
  ]);
});

test('transport startup failure unwinds initialized resources', async () => {
  const order = [];
  await assert.rejects(startLocalAi(config(), dependencies(order, { transportFailure: true })));
  assert.deepEqual(order.slice(-5), [
    'installer.close', 'lifecycle.close', 'history.stop', 'nats.close', 'database.close',
  ]);
});

test('signal during startup closes the service as soon as resources become available', async () => {
  let signalHandler;
  let releaseStartup;
  let closeCalls = 0;
  let closedWaitCalls = 0;
  const starting = new Promise(resolve => { releaseStartup = resolve; });
  const run = runLocalAiProcess(() => starting, callback => { signalHandler = callback; });
  signalHandler();
  releaseStartup({
    async close() { closeCalls++; },
    nc: { async closed() { closedWaitCalls++; } },
  });
  await run;
  assert.equal(closeCalls, 1);
  assert.equal(closedWaitCalls, 0);
});

test('failed runtime closure skips handler drain and still closes independent connections', async () => {
  const order = [];
  const runtime = await startLocalAi(config(), dependencies(order, { lifecycleFailure: true }));
  await assert.rejects(runtime.close(), /LOCAL_AI_SHUTDOWN_FAILED/);
  assert.ok(order.includes('installer.close'));
  assert.ok(order.includes('lifecycle.close'));
  assert.ok(!order.includes('transport.drainHandlers'));
  assert.ok(order.includes('history.stop'));
  assert.ok(order.includes('nats.close'));
  assert.ok(order.includes('database.close'));
});

test('shutdown timeout skips handler drain and still invokes bounded independent cleanup', async () => {
  const order = [];
  const input = config();
  input.transport.shutdownTimeoutMs = 40;
  const runtime = await startLocalAi(input, dependencies(order, { lifecycleHang: true }));
  const startedAt = Date.now();
  await assert.rejects(runtime.close(), /LOCAL_AI_SHUTDOWN_FAILED/);
  assert.ok(Date.now() - startedAt < 500, 'shutdown respects one overall deadline');
  assert.ok(order.includes('lifecycle.close'));
  assert.ok(!order.includes('transport.drainHandlers'));
  assert.ok(order.includes('history.stop'));
  assert.ok(order.includes('nats.close'));
  assert.ok(order.includes('database.close'));
});
