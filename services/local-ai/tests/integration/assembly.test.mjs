// ABOUTME: Проверяет сборку startup, fail cleanup и shutdown управляющего процесса.
// ABOUTME: Фабрики заменяются только в этом тесте; публичный NATS путь проверяет соседний live peer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalAiProcess, startLocalAi, supportedProfiles, validateLocalAiConfig } from '../../src/main.mjs';
import {
  assertArtifactErrorParity, assertEmbeddingResponse, assertTranscriptionResponse,
  assertEmbeddingOrder, buildLocalAiAcceptancePlan, parseFileUrl, parseUploadUrl,
  connectOwnedNats, drainOwnedNats, runLocalAiPeer, validatePeerConfig, validatePeerMedia,
} from './local-ai-peer.mjs';
import { subjects, validateRequest } from '../../contracts/index.mjs';
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

test('supported profile projection preserves pinned manifest and unknown GigaAM audio limit', () => {
  const projection = supportedProfiles({ runtime: { gigaam_pytorch: { longformMaximumSeconds: null } } });
  const embedding = projection.find(profile => profile.profileId === llamaProfile.profileId);
  const transcription = projection.find(profile => profile.profileId === gigaProfile.profileId);
  assert.equal(embedding.revision, llamaProfile.source.revision);
  assert.equal(embedding.record.limits.vectorDimensions, llamaProfile.encoding.dimensions);
  assert.deepEqual(embedding.files.map(file => [file.path, file.bytes, file.sha256]), llamaProfile.source.files.map(file => [file.path, file.bytes, file.sha256]));
  assert.equal(transcription.revision, gigaProfile.source.revision);
  assert.equal(transcription.record.limits.maxAudioSeconds, null);
  const explicit = supportedProfiles({ runtime: { gigaam_pytorch: { longformMaximumSeconds: 37 } } });
  assert.equal(explicit.find(profile => profile.profileId === gigaProfile.profileId).record.limits.maxAudioSeconds, 37);
});

test('public peer requires verified isolated fixture endpoint, role, and reply inbox; bounded connect failure receipt is metadata-only', async () => {
  const peer = {
    verifiedIsolated: true, phase: 'baseline', servers: ['nats://127.0.0.1:19473'], inboxPrefix: '_INBOX.brai_fixture',
    user: 'fixture', password: 'fixture-secret', token: null, name: 'local-ai-peer-test',
    timeoutMs: 6000, maxRequestMs: 5000, overallTimeoutMs: 20000, cleanupTimeoutMs: 2000,
    outboxPollMs: 100, outboxDrainTimeoutMs: 3000, acceptancePollMs: 100, acceptanceTimeoutMs: 3000,
    embeddingComparisonTolerance: 0.000001,
    artifactUploadOrigin: 'http://172.31.247.1:19470/', artifactFilesOrigin: 'http://172.31.247.1:19474/',
    ownerId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', foreignOwnerId: 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2',
    embeddingModel: { modelId: llamaProfile.modelId, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId },
    transcriptionModel: { modelId: gigaProfile.modelId, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId },
    embeddingTexts: ['synthetic fixture text', 'second synthetic fixture'], purpose: 'symmetric', searchQuery: 'synthetic fixture',
    shortTranscript: 'короткая синтетическая фраза', longTranscript: 'длинная синтетическая фраза',
    maxAudioBytes: 1024, cancelAfterMs: null, deadlineAfterMs: null,
    idleUnloadSeconds: null, idleDisabledObservationMs: null, idlePollMs: null, idleTimeoutMs: null, restartVerified: false, checkpoint: null,
  };
  assert.equal(validatePeerConfig(peer), peer);
  assert.throws(() => validatePeerConfig({ ...peer, verifiedIsolated: false }), /verifiedIsolated/);
  assert.throws(() => validatePeerConfig({ ...peer, servers: ['nats://10.0.0.4:4222'] }), /servers/);
  assert.throws(() => validatePeerConfig({ ...peer, inboxPrefix: '_INBOX' }), /inboxPrefix/);
  assert.throws(() => validatePeerConfig({ ...peer, user: 'local_ai' }), /authentication/);
  assert.throws(() => validatePeerConfig({ ...peer, artifactUploadOrigin: 'http://127.0.0.1:19470/' }), /artifactUploadOrigin/);
  assert.throws(() => validatePeerConfig({ ...peer, overallTimeoutMs: null }), /overallTimeoutMs/);
  assert.throws(() => validatePeerConfig({ ...peer, phase: 'cancel' }), /cancelAfterMs/);
  const boundedPeer = { ...peer, timeoutMs: 20, maxRequestMs: 10, overallTimeoutMs: 50, cleanupTimeoutMs: 10 };
  const media = { short: { bytes: new Uint8Array([1]), mimeType: 'audio/wav' }, long: { bytes: new Uint8Array([2]), mimeType: 'audio/wav' } };
  await assert.rejects(runLocalAiPeer(boundedPeer, media, { connect: () => new Promise(() => {}) }), error => {
    assert.equal(error.message, 'LOCAL_AI_PEER_OVERALL_TIMEOUT');
    assert.deepEqual(Object.keys(error.receipt).sort(), ['artifactIds', 'cleanup', 'eventIds', 'operationIds', 'ownerId', 'phase', 'requestIds', 'runId']);
    assert.equal(error.receipt.phase, 'baseline');
    assert.equal(error.receipt.ownerId, boundedPeer.ownerId);
    for (const key of ['requestIds', 'operationIds', 'artifactIds', 'eventIds']) assert.deepEqual(error.receipt[key], []);
    return true;
  });
  const canary = 'SYNTHETIC_PRIVATE_CANARY';
  const hostileMessages = [
    `LOCAL_AI_PEER_SYNTHETIC_SECRET_${canary}`,
    `LOCAL_AI_PEER_SERVICE_ERROR:CANCELLED_${canary}`,
    `LOCAL_AI_PEER_SERVICE_ERROR:${'X'.repeat(8192)}`,
    'LOCAL_AI_PEER_OVERALL_TIMEOUT',
  ];
  for (const message of hostileMessages) {
    await assert.rejects(runLocalAiPeer(boundedPeer, media, { connect: () => Promise.reject(new Error(message)) }), error => {
      assert.equal(error.message, 'LOCAL_AI_PEER_OPERATION_FAILED');
      assert.ok(!error.message.includes(canary));
      assert.ok(!JSON.stringify(error.receipt).includes(canary));
      return true;
    });
  }
});

test('acceptance plan names external restart and no-content evidence as pending', () => {
  const plan = buildLocalAiAcceptancePlan();
  assert.deepEqual(plan.map(step => step.phase), ['baseline', 'cancel', 'deadline', 'idle', 'pre_restart', 'post_restart']);
  assert.ok(plan.find(step => step.phase === 'post_restart').requiredEvidence.includes('external-no-content-audit-pending'));
  assert.ok(plan.find(step => step.phase === 'pre_restart').requiredEvidence.includes('external-own-container-restart-pending'));
});

test('artifact URL guards normalize pinned slash origins and reject other hosts or paths', () => {
  const uploadOrigin = 'http://172.31.247.1:19470/';
  const filesOrigin = 'http://172.31.247.1:19474/';
  assert.equal(parseUploadUrl('http://172.31.247.1:19470/upload/capability-token', uploadOrigin).pathname, '/upload/capability-token');
  assert.equal(parseFileUrl('http://172.31.247.1:19474/files/abc123', filesOrigin).pathname, '/files/abc123');
  assert.throws(() => parseUploadUrl('http://127.0.0.1:19470/upload/capability-token', uploadOrigin), /UPLOAD_URL_REJECTED/);
  assert.throws(() => parseUploadUrl('http://172.31.247.1:19470/redirect/capability-token', uploadOrigin), /UPLOAD_URL_REJECTED/);
  assert.throws(() => parseUploadUrl('http://172.31.247.1:19470/upload/capability-token', 'http://attacker.invalid/'), /UPLOAD_URL_REJECTED/);
  assert.throws(() => parseFileUrl('http://172.31.247.1:19474/redirect/abc123', filesOrigin), /FILE_URL_REJECTED/);
});

test('configure contract accepts null and maximum integer while rejecting zero', () => {
  const base = {
    modelId: llamaProfile.modelId, revision: llamaProfile.source.revision,
    profileId: llamaProfile.profileId, ownerId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371',
  };
  assert.equal(validateRequest(subjects.modelsConfigure, { ...base, idleUnloadSeconds: null }), true);
  assert.equal(validateRequest(subjects.modelsConfigure, { ...base, idleUnloadSeconds: 2_147_483_647 }), true);
  assert.equal(validateRequest(subjects.modelsConfigure, { ...base, idleUnloadSeconds: 0 }), false);
});

test('media validation accepts only explicit byte buffers with supported audio MIME', () => {
  const peer = {
    verifiedIsolated: true, phase: 'baseline', servers: ['nats://127.0.0.1:19473'], inboxPrefix: '_INBOX.brai_fixture',
    user: 'fixture', password: 'fixture-secret', token: null, name: 'local-ai-peer-test',
    timeoutMs: 6000, maxRequestMs: 5000, overallTimeoutMs: 20000, cleanupTimeoutMs: 2000,
    outboxPollMs: 100, outboxDrainTimeoutMs: 3000, acceptancePollMs: 100, acceptanceTimeoutMs: 3000,
    embeddingComparisonTolerance: 0.000001,
    artifactUploadOrigin: 'http://172.31.247.1:19470/', artifactFilesOrigin: 'http://172.31.247.1:19474/',
    ownerId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', foreignOwnerId: 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2',
    embeddingModel: { modelId: llamaProfile.modelId, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId },
    transcriptionModel: { modelId: gigaProfile.modelId, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId },
    embeddingTexts: ['synthetic fixture text', 'second synthetic fixture'], purpose: 'symmetric', searchQuery: 'synthetic fixture',
    shortTranscript: 'короткая синтетическая фраза', longTranscript: 'длинная синтетическая фраза',
    maxAudioBytes: 8, cancelAfterMs: null, deadlineAfterMs: null,
    idleUnloadSeconds: null, idleDisabledObservationMs: null, idlePollMs: null, idleTimeoutMs: null, restartVerified: false, checkpoint: null,
  };
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(validatePeerMedia({ short: { bytes, mimeType: 'audio/wav' }, long: { bytes, mimeType: 'audio/flac' } }, peer).short.bytes, bytes);
  assert.throws(() => validatePeerMedia({ short: { bytes, mimeType: 'text/plain' }, long: { bytes, mimeType: 'audio/wav' } }, peer), /media\.short\.mimeType/);
  assert.throws(() => validatePeerMedia({ short: { bytes: new Uint8Array(9), mimeType: 'audio/wav' }, long: { bytes, mimeType: 'audio/wav' } }, peer), /media\.short\.bytes/);
});

test('bounded NATS connect preserves a winner and closes a late owned result', async () => {
  let normalClosed = false;
  const normal = { close() { normalClosed = true; } };
  assert.equal(await connectOwnedNats(() => Promise.resolve(normal), {}, Date.now() + 100), normal);
  assert.equal(normalClosed, false);

  let resolveLate;
  let lateClosed = false;
  const late = { close() { lateClosed = true; } };
  const lateConnect = connectOwnedNats(() => new Promise(resolve => { resolveLate = resolve; }), {}, Date.now() + 10);
  await assert.rejects(lateConnect, /LOCAL_AI_PEER_OVERALL_TIMEOUT/);
  resolveLate(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateClosed, true);
});

test('drain expiry requests synchronous close even when the deadline has elapsed', async () => {
  let drainCalls = 0;
  let closeCalls = 0;
  const owned = { drain() { drainCalls += 1; return new Promise(() => {}); }, close() { closeCalls += 1; } };
  assert.deepEqual(await drainOwnedNats(owned, Date.now() - 1), { drainCompleted: false, closeRequested: true });
  assert.equal(drainCalls, 0);
  assert.equal(closeCalls, 1);
});

test('peer assertions cover vector identity, finite normalized values, transcript phrase, and uniform artifact errors', () => {
  const model = { modelId: 'embed', revision: 'a'.repeat(40), profileId: 'llama_cpp' };
  const request = { requestId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', operationId: 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2', model, texts: ['first', 'second'] };
  const vectors = [[1, 0], [0, -1]];
  assert.equal(assertEmbeddingResponse({ requestId: request.requestId, operationId: request.operationId, model, vectors }, request, 2), true);
  assert.equal(assertEmbeddingOrder(vectors, [[1, 0], [0, -1]], 0.000001), true);
  assert.throws(() => assertEmbeddingOrder(vectors, [[0, -1], [1, 0]], 0.000001), /EMBED_ORDER/);
  assert.throws(() => assertEmbeddingOrder(vectors, [[1, 0], [0, -1]], 1), /EMBED_ORDER_UNDISTINGUISHABLE/);
  assert.throws(() => assertEmbeddingOrder(vectors, [[1, 0], [1, 0]], 0.000001), /EMBED_ORDER_UNDISTINGUISHABLE/);
  assert.throws(() => assertEmbeddingResponse({ requestId: request.requestId, operationId: request.operationId, model, vectors: [[2, 0], [0, 1]], }, request, 2), /EMBED_NORM/);
  const transcribeRequest = { requestId: request.requestId, operationId: request.operationId, model: { modelId: 'transcribe', revision: 'b'.repeat(40), profileId: 'gigaam_pytorch' } };
  assert.equal(assertTranscriptionResponse({ ...transcribeRequest, text: 'Это короткая синтетическая фраза.', segments: [{ startSeconds: 0, endSeconds: 1, text: 'Это короткая синтетическая фраза.' }] }, transcribeRequest, 'короткая синтетическая фраза'), true);
  assert.throws(() => assertTranscriptionResponse({ ...transcribeRequest, text: '', segments: null }, transcribeRequest, 'expected'), /TRANSCRIPTION_TEXT/);
  assert.equal(assertArtifactErrorParity([
    { name: 'wrong-owner', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
    { name: 'missing', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
    { name: 'pending', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
    { name: 'deleted', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
  ]), true);
  assert.throws(() => assertArtifactErrorParity([
    { name: 'wrong-owner', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
    { name: 'missing', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
    { name: 'pending', code: 'DEPENDENCY_UNAVAILABLE', status: '503', message: 'DEPENDENCY_UNAVAILABLE', retryable: true },
    { name: 'deleted', code: 'ARTIFACT_NOT_AVAILABLE', status: '404', message: 'ARTIFACT_NOT_AVAILABLE', retryable: false },
  ]), /ARTIFACT_ERROR_PARITY/);
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
