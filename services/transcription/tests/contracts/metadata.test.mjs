// ABOUTME: Проверяет метаданные admission, fenced lease, завершения и истории transcription.
// ABOUTME: Проверки DTO не подменяют тесты PostgreSQL, транспорта или реального local-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDto, validateDto } from '../../contracts/index.mjs';

const requestId = 'c7bd3fa1-376b-49e8-badf-8c2d1eac1c00';
const attemptId = 'acaf5b10-5ee4-4c4b-9332-8d3a7c1f2f19';
const timestamp = '2026-10-05T12:34:56.123456Z';
const selector = { modelId: 'whisper/local:large-v3', revision: 'sha256:0123456789abcdef', profileId: 'transcribe/ggml' };
const principal = { scopeType: 'user', scopeId: 'user_123', ownerId: 'user_123', permissions: ['transcription:use'] };
const input = { clientIdempotencyKey: requestId, audioArtifactId: attemptId, requestedModel: null, deadlineAt: null };
const policySnapshot = { version: 1, sha256: 'a'.repeat(64), defaultLocalModel: selector, externalEnabled: false, allowReplacement: false };
const request = {
  requestId, scope: { scopeType: 'user', scopeId: 'user_123' }, ownerId: 'user_123', audioArtifactId: attemptId,
  clientIdempotencyKey: requestId, normalizedInputSha256: 'b'.repeat(64), requestedModel: null, selectedModel: selector,
  inputMetadata: { mimeType: 'audio/wav', sizeBytes: 128, audioDurationSeconds: null }, policySnapshot,
  taskState: 'accepted', resultState: 'not_ready', revision: 1, currentAttemptId: null, fenceGeneration: 0,
  deadlineAt: null, resultExpiresAt: null, bufferOwnerInstanceId: null, actualModel: null, usage: null, cost: null,
  errorCode: null, createdAt: timestamp, updatedAt: timestamp,
};
const fence = { requestId, attemptId, claimToken: attemptId, fenceGeneration: 1, expectedRevision: 1 };
const event = { id: requestId, type_id: 1201, occurred_at: timestamp, scope_type: 'user', scope_id: 'user_123',
  actor_id: 'user_123', object_type: 'transcription_request', object_id: requestId,
  data: { requestId, phase: 'accepted', outcome: null } };

test('metadata-only admission and claims preserve complete request and policy', () => {
  assert.equal(validateDto('HelperRequestAcceptParams', { principal, input, artifact: {
    artifactId: attemptId, ownerId: 'user_123', state: 'ready', mimeType: 'audio/wav', sizeBytes: 128,
  }, selectedModel: selector, policySnapshot }), true);
  assert.equal(validateDto('RequestRecord', request), true);
  assert.equal(validateDto('RequestClaim', { claimToken: attemptId, fenceGeneration: 1, revision: 1, leaseExpiresAt: timestamp, request }), true);
  assert.equal(validateDto('HelperRequestRenewParams', { requestId, claimToken: attemptId, fenceGeneration: 1, expectedRevision: 1 }), true);
  assert.equal(validateDto('HelperRecoveryRunParams', { coordinatorInstanceId: 'coordinator_1' }), true);
  assert.equal(validateDto('HelperRecoveryRunParams', { coordinatorInstanceId: 'coordinator_1', now: timestamp }), false);
  assert.equal(validateDto('HelperAttemptStartParams', fence), true);
  assert.equal(validateDto('HelperAttemptFinishParams', { ...fence, outcome: 'succeeded', actualModel: selector, usage: null,
    cost: null, errorCode: null, durationMs: 123, resultState: 'available', resultExpiresAt: timestamp, bufferOwnerInstanceId: 'coordinator_1' }), true);
  assert.equal(validateDto('HelperAttemptFinishParams', { ...fence, outcome: 'succeeded', text: 'private' }), false);
});

test('history owner envelope is narrowed to closed facts with genuine phases', () => {
  assert.equal(validateDto('HistoryAppendRequest', event), true);
  assert.equal(validateDto('HistoryClaim', { deliveryId: attemptId, claimToken: attemptId, leaseExpiresAt: timestamp,
    requestId, source: 'transcription', event }), true);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, data: { ...event.data, text: 'private' } }), false);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, data: { ...event.data, secret: 'private' } }), false);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, data: { requestId, phase: 'terminal', outcome: null } }), false);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, data: { requestId, phase: 'terminal', outcome: 'outcome_unknown' } }), true);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, type_id: 1301, object_type: 'transcription_settings', object_id: 'policy',
    data: { requestId: null, phase: 'settings', policyVersion: 2, policySha256: 'c'.repeat(64) } }), true);
  assert.equal(validateDto('HistoryAppendRequest', { ...event, scope_id: 'arbitrary private prose' }), false);
});

test('public input rejects identity, secrets and unrestricted parameters; exceptions carry no validation detail', () => {
  for (const privateField of ['ownerId', 'params', 'errorMessage', 'url', 'bytes', 'text', 'policySnapshot']) {
    assert.equal(validateDto('PublicSubmitParams', { ...input, [privateField]: 'private' }), false, privateField);
  }
  assert.equal(validateDto('TrustedPrincipal', { ...principal, ownerId: 'private prose' }), false);
  assert.equal(validateDto('PublicSubmitParams', { ...input, requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId } }), true);
  assert.equal(validateDto('PublicSubmitParams', { ...input, requestedModel: { route: 'external', selection: 'required' } }), true);
  assert.equal(validateDto('PublicSubmitParams', { ...input, requestedModel: { route: 'local', selection: 'required' } }), false);
  assert.equal(validateDto('PublicResult', { requestId, text: 'read in memory', segments: null, actualModel: selector }), true);
  assert.throws(() => assertDto('PublicSubmitParams', { ...input, text: 'private' }), error => {
    assert.equal(Object.hasOwn(error, 'validationErrors'), false);
    assert.equal(error.message.includes('private'), false);
    return error instanceof TypeError;
  });
});

test('request.lookup DTO is metadata-only, accepts a nullable record, and rejects arbitrary fields', () => {
  const lookupParams = { principal, clientIdempotencyKey: requestId, normalizedInputSha256: 'b'.repeat(64) };
  assert.equal(validateDto('HelperRequestLookupParams', lookupParams), true);
  assert.equal(validateDto('RequestLookupResult', { request: null }), true);
  assert.equal(validateDto('RequestLookupResult', { request }), true);
  assert.equal(validateDto('RequestLookupResult', { request: { ...request, text: 'private' } }), false);
  assert.equal(validateDto('HelperRequestLookupParams', { ...lookupParams, text: 'private' }), false);
  assert.equal(validateDto('HelperRequestLookupParams', { ...lookupParams, arbitrary: { secret: 'private' } }), false);
  assert.equal(validateDto('HelperRequestLookupParams', { ...lookupParams, normalizedInputSha256: 'B'.repeat(64) }), false);
  assert.equal(validateDto('HelperRequestLookupParams', { ...lookupParams, normalizedInputSha256: 'b'.repeat(63) + 'g' }), false);
});
