// ABOUTME: Проверяет фазовые guards business acceptance harness без живых сервисов.
// ABOUTME: Синтетические inputs упражняют доказательство BUSY, события, селекторы и media fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  BUSINESS_MEDIA_TYPES, assertBusinessOperationLedger, assertRuntimeBusyCapacity, buildBusinessCleanupReceipt,
  buildSelectorNegativeCases, connectWithinBound, drainOwnedConnection, markArtifactOperationTerminal, runLocalAiBusinessPeer,
  validateBusinessConfig, validateBusinessMedia, validateBusinessMediaSample, validateInvalidBusinessMediaSample,
} from './local-ai-business-peer.mjs';
import { subjects, validateRequest } from '../../contracts/index.mjs';
import llamaProfile from '../../profiles/llama_cpp.json' with { type: 'json' };
import gigaProfile from '../../profiles/gigaam_pytorch.json' with { type: 'json' };

function config(phase = 'selectors') {
  const proof = {
    sourceRevision: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, configDigest: `sha256:${'c'.repeat(64)}`,
    controllerServers: ['nats://127.0.0.1:19473'], controllerUser: 'local_ai', controllerInboxPrefix: '_INBOX.brai_local_ai',
    maxQueuedOperations: phase === 'overload' ? 1 : ['queued', 'idle'].includes(phase) ? 2 : 2,
    outboxCapacity: 8, maxConcurrentRequests: phase === 'queued' || phase === 'idle' ? 5 : phase === 'overload' ? 4 : 3,
    maxRequestMs: 5000, maxInputBytes: 10, maxAudioBytes: 15, maxAudioSeconds: 8, providerMaxUploadBytes: 20,
    outboxCounts: { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0 },
  };
  return {
    verifiedIsolated: true, phase,
    nats: { servers: ['nats://127.0.0.1:19473'], user: 'fixture', password: 'fixture-secret', token: null,
      inboxPrefix: '_INBOX.brai_fixture', name: 'local-ai-business-unit' },
    proof, expectedProof: { sourceRevision: proof.sourceRevision, imageDigest: proof.imageDigest, configDigest: proof.configDigest },
    ownerId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', foreignOwnerId: 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2',
    timeoutMs: 6000, overallTimeoutMs: 15000, cleanupTimeoutMs: 1000, pollMs: 20,
    acceptanceTimeoutMs: 1000, completionTimeoutMs: 4000, outboxDrainTimeoutMs: 1000, requestDeadlineMarginMs: 100,
    embeddingModel: { modelId: llamaProfile.modelId, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId },
    transcriptionModel: { modelId: gigaProfile.modelId, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId },
    operation: phase === 'media' ? 'transcribe' : 'embed', texts: ['one synthetic input', 'another synthetic input'], purpose: 'document', comparisonTolerance: 0.00001,
    positiveIdleSeconds: phase === 'idle' ? 2 : null, nullObservationMs: phase === 'idle' ? 2001 : null,
    queueObservationMs: ['idle', 'queued'].includes(phase) ? (phase === 'idle' ? 2000 : 50) : null,
    idlePollMs: phase === 'idle' ? 20 : null, idleTimeoutMs: phase === 'idle' ? 3000 : null,
    idleBoundaryLeadMs: phase === 'idle' ? 500 : null,
    maxInputBytes: 10, maxAudioBytes: 15, maxAudioSeconds: 8, providerMaxUploadBytes: 20,
    artifactUploadOrigin: 'http://172.31.247.1:19470/', artifactFilesOrigin: 'http://172.31.247.1:19474/',
  };
}

function bytes(values) { return new Uint8Array(values); }
function sample(mimeType, fixtureId, values, extras = {}) {
  const data = bytes(values);
  return { fixtureId, bytes: data, mimeType, sha256: createDigest(data), durationSeconds: 1,
    expectedText: 'synthetic reference phrase', ...extras };
}
function createDigest(value) { return createHash('sha256').update(value).digest('hex'); }

test('protected phase proof binds source, image, config, fixture ACL and clean own outbox', () => {
  const value = config();
  assert.equal(validateBusinessConfig(value), value);
  assert.equal(value.nats.user, 'fixture');
  assert.equal(value.proof.controllerUser, 'local_ai');
  assert.equal(value.proof.controllerInboxPrefix, '_INBOX.brai_local_ai');
});

test('lifecycle and artifact byte caps and the two NATS identities stay distinct', () => {
  const value = config('media');
  assert.equal(value.maxInputBytes, 10);
  assert.equal(value.maxAudioBytes, 15);
  assert.equal(value.nats.user, 'fixture');
  assert.equal(value.proof.controllerUser, 'local_ai');
  assert.equal(validateBusinessConfig(value), value);
  assert.throws(() => validateBusinessConfig({ ...value, maxInputBytes: 11 }), /CONFIG_AUDIO_LIMIT/);
  assert.throws(() => validateBusinessConfig({ ...value, proof: { ...value.proof, controllerInboxPrefix: '_INBOX.>' } }), /CONFIG_PROOF_CONTROLLER_NATS/);
});

test('overload and queued policies use actual outstanding-operation semantics', () => {
  const overload = config('overload');
  assert.equal(validateBusinessConfig(overload), overload);
  assert.throws(() => validateBusinessConfig({ ...overload, proof: { ...overload.proof, maxQueuedOperations: 2 } }), /CONFIG_OVERLOAD_LIMIT/);
  const queued = config('queued');
  assert.equal(validateBusinessConfig(queued), queued);
  assert.throws(() => validateBusinessConfig({ ...queued, proof: { ...queued.proof, maxQueuedOperations: 1 } }), /CONFIG_QUEUED_LIMIT/);
  assert.throws(() => validateBusinessConfig({ ...queued, proof: { ...queued.proof, maxConcurrentRequests: 4 } }), /CONFIG_TRANSPORT_HEADROOM/);
  assert.throws(() => validateBusinessConfig({ ...queued, proof: { ...queued.proof, outboxCapacity: 7 } }), /CONFIG_OUTBOX_CAPACITY/);
});

test('runtime BUSY attribution requires transport headroom and two durable slots remaining', () => {
  const queued = validateBusinessConfig(config('queued'));
  const status = { state: 'ready', components: Object.fromEntries(['database', 'nats', 'executables', 'weights', 'history', 'outbox'].map(key => [key, { state: 'ready' }])),
    outboxCounts: { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0 } };
  assert.deepEqual(assertRuntimeBusyCapacity(queued, status, 3), { transportHeadroom: 2, freeOutboxRows: 8 });
  assert.throws(() => assertRuntimeBusyCapacity(queued, { ...status, outboxCounts: { ...status.outboxCounts, pending: 7 } }, 3), /BUSY_CAUSE_OUTBOX_AMBIGUOUS/);
  assert.throws(() => assertRuntimeBusyCapacity(queued, { ...status, outboxCounts: { ...status.outboxCounts, permanentlyFailed: 1 } }, 3), /BUSY_CAUSE_OUTBOX_UNAVAILABLE/);
  assert.throws(() => assertRuntimeBusyCapacity({ ...queued, proof: { ...queued.proof, maxConcurrentRequests: 4 } }, status, 3), /BUSY_CAUSE_TRANSPORT_AMBIGUOUS/);
  assert.throws(() => assertRuntimeBusyCapacity(queued, { ...status, components: { ...status.components, database: { state: 'unavailable' } } }, 3), /DEPENDENCY_NOT_READY/);
});

test('negative public selector probes stay schema-valid and are limited to the pinned models', () => {
  const value = validateBusinessConfig(config());
  const cases = buildSelectorNegativeCases(value);
  assert.deepEqual(cases.map(item => item.expected), ['REVISION_CONFLICT', 'REVISION_CONFLICT', 'MODEL_NOT_FOUND', 'UNSUPPORTED_OPERATION']);
  assert.deepEqual(cases.map(item => item.subject), [subjects.modelsConfigure, subjects.modelsConfigure, subjects.modelsGet, subjects.invokeEmbed]);
  for (const item of cases) assert.equal(validateRequest(item.subject, item.request), true);
  assert.equal(cases[0].request.modelId, llamaProfile.modelId);
  assert.equal(cases[1].request.modelId, llamaProfile.modelId);
  assert.equal(cases[3].request.model.modelId, gigaProfile.modelId);
});

test('history ledger rejects duplicate admissions, missing terminals, and outcomes that changed', () => {
  const operationId = 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371';
  const events = [
    { id: 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2', operationId, outcome: 'accepted', phase: 'accepted' },
    { id: 'e0c36c8e-7f56-4f32-a338-150cb6a39ef2', operationId, outcome: 'succeeded', phase: null },
  ];
  assert.deepEqual(assertBusinessOperationLedger(events, operationId, 'succeeded'), {
    acceptedEventId: events[0].id, terminalEventId: events[1].id, outcome: 'succeeded',
  });
  assert.throws(() => assertBusinessOperationLedger(events.slice(0, 1), operationId), /LEDGER_DUPLICATE_OR_MISSING/);
  assert.throws(() => assertBusinessOperationLedger([events[0], events[1], events[0]], operationId), /LEDGER_DUPLICATE_OR_MISSING/);
  assert.throws(() => assertBusinessOperationLedger(events, operationId, 'failed'), /LEDGER_DUPLICATE_OR_MISSING/);
  assert.throws(() => assertBusinessOperationLedger(events, operationId, 'cancelled'), /LEDGER_DUPLICATE_OR_MISSING/);
});

test('shared audio remains protected until all operations settle and receipt reports deferred IDs', () => {
  const entry = { pendingOperationIds: new Set(['a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2']), terminalConfirmed: false };
  assert.equal(markArtifactOperationTerminal(entry, 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371'), false);
  assert.equal(entry.terminalConfirmed, false);
  assert.equal(markArtifactOperationTerminal(entry, 'd0c36c8e-7f56-4f32-a338-150cb6a39ef2'), true);
  const artifacts = new Map([['e0c36c8e-1234-4b1a-a1e1-9a4b4c7ef371', { deleted: false }]]);
  const summary = { phase: 'queued', artifactIds: [...artifacts.keys()] };
  const receipt = buildBusinessCleanupReceipt(summary, [...artifacts.keys()], artifacts);
  assert.deepEqual(receipt.cleanupDeferredArtifactIds, [...artifacts.keys()]);
  assert.equal(receipt.artifactsCleanupComplete, false);
  assert.throws(() => markArtifactOperationTerminal(entry, 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371'), /ARTIFACT_OPERATION_NOT_TRACKED/);
});

test('idle policy outlives the old positive interval and spans accepted active-plus-queued work', () => {
  const idle = config('idle');
  assert.equal(validateBusinessConfig(idle), idle);
  assert.throws(() => validateBusinessConfig({ ...idle, nullObservationMs: 2000 }), /CONFIG_IDLE_RELATION/);
  assert.throws(() => validateBusinessConfig({ ...idle, queueObservationMs: 1999 }), /CONFIG_IDLE_ACTIVITY_WINDOW/);
  assert.throws(() => validateBusinessConfig({ ...idle, idleBoundaryLeadMs: 2000 }), /CONFIG_IDLE_RELATION/);
});

test('media matrix validates bytes hash, each public MIME, measured size, duration and references', () => {
  const value = config('media');
  const validSamples = BUSINESS_MEDIA_TYPES.map((mime, index) => sample(mime,
    `a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef37${index}`, [index + 1]));
  const invalidSamples = ['corrupt', 'playlist', 'concatenated', 'network_container'].map((kind, index) => {
    const { expectedText: _expectedText, ...base } = sample(BUSINESS_MEDIA_TYPES[index], `d0c36c8e-7f56-4f32-a338-150cb6a39ef${index}`, [index + 9]);
    return { ...base, durationSeconds: null, kind, expectedErrorCode: 'NOT_SUPPORTED', expectedAccepted: true };
  });
  const matrix = validateBusinessMedia({ samples: validSamples, invalidSamples }, value);
  assert.equal(matrix.valid.length, 4);
  assert.deepEqual(matrix.valid.map(item => item.mimeType), BUSINESS_MEDIA_TYPES);
  assert.equal(matrix.invalid.length, 4);
  assert.throws(() => validateBusinessMedia({ samples: [validSamples[0], ...validSamples.slice(0, 3)], invalidSamples }, value), /MEDIA_MIME_MATRIX/);
  assert.throws(() => validateBusinessMedia({ samples: validSamples.map((item, index) => index === 0 ? { ...item, sha256: 'f'.repeat(64) } : item), invalidSamples }, value), /MEDIA_HASH/);
  assert.throws(() => validateBusinessMedia({ samples: validSamples, invalidSamples: invalidSamples.slice(1) }, value), /MEDIA_INVALID_MATRIX/);
  assert.throws(() => validateBusinessMedia({ samples: validSamples, invalidSamples: invalidSamples.map((item, index) => index === 0
    ? { ...item, expectedErrorCode: 'ENGINE_UNAVAILABLE' } : item) }, value), /INVALID_MEDIA_EXPECTATION/);
  assert.throws(() => validateBusinessMedia({ samples: validSamples, invalidSamples: invalidSamples.map((item, index) => index === 0
    ? { ...item, durationSeconds: 1 } : item) }, value), /INVALID_MEDIA_EXPECTATION/);
});

test('oversize public media case is admitted only when bounded by provider upload capacity', () => {
  const value = config('media');
  const raw = new Uint8Array(16).fill(7);
  const oversize = { fixtureId: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', bytes: raw,
    mimeType: 'audio/wav', sha256: createDigest(raw), durationSeconds: 1, kind: 'oversize',
    expectedErrorCode: 'INPUT_TOO_LARGE', expectedAccepted: false };
  assert.equal(validateInvalidBusinessMediaSample(oversize, value), oversize);
  assert.throws(() => validateInvalidBusinessMediaSample({ ...oversize, bytes: new Uint8Array(21), sha256: createDigest(new Uint8Array(21)) }, value), /INVALID_MEDIA_SIZE/);
  assert.throws(() => validateInvalidBusinessMediaSample({ ...oversize, expectedAccepted: true }, value), /OVERSIZE_MEDIA_EXPECTATION/);
  assert.throws(() => validateBusinessMediaSample(sample('audio/wav', 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371', new Array(11).fill(1)), value), /MEDIA_SIZE/);
});

test('bounded connection preserves a winning client and closes only a late result', async () => {
  let normalClosed = false;
  const normal = { close: async () => { normalClosed = true; } };
  assert.equal(await connectWithinBound(() => Promise.resolve(normal), {}, Date.now() + 100), normal);
  assert.equal(normalClosed, false);

  let resolveLate;
  let lateClosed = false;
  const late = { close: async () => { lateClosed = true; } };
  const pending = connectWithinBound(() => new Promise(resolve => { resolveLate = resolve; }), {}, Date.now() + 10);
  await assert.rejects(pending, /NATS_CONNECT_TIMEOUT/);
  resolveLate(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateClosed, true);
});

test('a timed-out drain force-closes only its owned NATS connection', async () => {
  let closeCalls = 0;
  const connection = { drain: () => new Promise(() => {}), close: () => { closeCalls += 1; } };
  assert.deepEqual(await drainOwnedConnection(connection, Date.now() + 10), { drained: false, closeRequested: true });
  assert.equal(closeCalls, 1);
});

test('hanging NATS connect has an overall bound and returns only safe receipt metadata', async () => {
  const value = config('selectors');
  Object.assign(value, { timeoutMs: 100, overallTimeoutMs: 100, cleanupTimeoutMs: 20,
    completionTimeoutMs: 10, acceptanceTimeoutMs: 10, outboxDrainTimeoutMs: 10, pollMs: 1 });
  await assert.rejects(runLocalAiBusinessPeer(value, null, { connect: () => new Promise(() => {}) }), error => {
    assert.equal(error.message, 'LOCAL_AI_BUSINESS_NATS_CONNECT_TIMEOUT');
    assert.equal(error.receipt.phase, 'selectors');
    assert.deepEqual(error.receipt.operationIds, []);
    assert.deepEqual(error.receipt.artifactIds, []);
    assert.equal(error.receipt.artifactsCleanupComplete, true);
    assert.deepEqual(error.receipt.connectionCleanup, { drained: true, closeRequested: false });
    return true;
  });
});
