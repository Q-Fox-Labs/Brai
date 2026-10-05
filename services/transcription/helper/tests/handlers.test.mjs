// ABOUTME: Проверяет helper policy/admission handling без PostgreSQL и сетевых соседей.
// ABOUTME: Подтверждает dedup до проверки новых artifact facts; не проверяет SQL транзакции.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash } from '../storage/index.ts';
import { createHelperHandlers, toRpcError } from '../../dist/helper/handlers.js';

const principal = { scopeType: 'user', scopeId: 'scope-a', ownerId: 'owner-a', permissions: ['transcription:use', 'transcription:settings:write'] };
const input = {
  clientIdempotencyKey: 'c7bd3fa1-376b-49e8-badf-8c2d1eac1c00',
  audioArtifactId: '27a817b6-2030-4ae1-8831-441886f02062',
  requestedModel: null,
  deadlineAt: null,
};
const artifact = { artifactId: input.audioArtifactId, ownerId: principal.ownerId, state: 'ready', mimeType: 'audio/wav', sizeBytes: 12 };
const expectedHash = canonicalHash({ audioArtifactId: input.audioArtifactId, requestedModel: null, deadlineAt: null });

function fakeStore(results = {}) {
  const calls = [];
  return {
    calls,
    async execute(method, params) {
      calls.push({ method, params });
      const result = results[method];
      return typeof result === 'function' ? result(params) : result;
    },
  };
}

test('request.accept looks up the trusted idempotency key before checking fresh artifact facts', async () => {
  const prior = { requestId: '9bb13d3e-fc76-4c20-b827-bbb78499c4ca', taskState: 'accepted' };
  const store = fakeStore({ 'request.lookup': { request: prior } });
  const handlers = createHelperHandlers(store);
  const result = await handlers['request.accept']({ principal, input: { ...input, clientIdempotencyKey: input.clientIdempotencyKey.toUpperCase() }, artifact: { ...artifact, ownerId: 'changed-owner' } });
  assert.deepEqual(result, { created: false, request: prior });
  assert.deepEqual(store.calls, [{ method: 'request.lookup', params: {
    principal, clientIdempotencyKey: input.clientIdempotencyKey, normalizedInputSha256: expectedHash,
  } }]);
});

test('request.accept checks the artifact on a miss then passes facts to atomic admission', async () => {
  const policySnapshot = { version: 1, sha256: 'a'.repeat(64), defaultLocalModel: null, externalEnabled: false, allowReplacement: false };
  const params = { principal, input, artifact, selectedModel: null, policySnapshot };
  const store = fakeStore({ 'request.lookup': { request: null }, 'request.accept': { created: true, request: { requestId: '9bb13d3e-fc76-4c20-b827-bbb78499c4ca' } } });
  const result = await createHelperHandlers(store)['request.accept'](params);
  assert.equal(result.created, true);
  assert.deepEqual(store.calls.map(call => call.method), ['request.lookup', 'request.accept']);
  assert.deepEqual(store.calls[1].params, params);
});

test('request.accept rejects mismatched owner or artifact ID after a lookup miss', async () => {
  for (const changed of [{ ...artifact, ownerId: 'owner-b' }, { ...artifact, artifactId: '6ac4ebc7-38fb-4cba-8d68-130ad6641f8e' }]) {
    const store = fakeStore({ 'request.lookup': { request: null } });
    await assert.rejects(createHelperHandlers(store)['request.accept']({ principal, input, artifact: changed }), error => error.errorCode === 'ARTIFACT_OWNER_MISMATCH');
    assert.deepEqual(store.calls.map(call => call.method), ['request.lookup']);
  }
});

test('settings.set accepts an operator-only principal and closes unknown storage errors', async () => {
  const store = fakeStore();
  const params = { principal: { ...principal, permissions: ['transcription:settings:write'] }, expectedRevision: 1, settings: {} };
  await createHelperHandlers(store)['settings.set'](params);
  assert.deepEqual(store.calls, [{ method: 'settings.set', params }]);
  const mapped = toRpcError(new Error('private SQL and payload'));
  assert.equal(mapped.errorCode, 'INTERNAL');
  assert.equal(mapped.message, 'INTERNAL');
});
