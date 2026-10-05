// ABOUTME: Проверяет устойчивые DTO локального и отключённого внешнего исполнителя.
// ABOUTME: Проверки закрытых схем не подтверждают реальную интеграцию с local-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDto, methodMap, schemas, validateDto } from '../../contracts/index.mjs';

const selector = { modelId: 'whisper/local:large-v3', revision: 'sha256:0123456789abcdef', profileId: 'transcribe/ggml' };
const timestamp = '2026-10-05T12:34:56.123456Z';
const requestId = 'c7bd3fa1-376b-49e8-badf-8c2d1eac1c00';
const operationId = 'acaf5b10-5ee4-4c4b-9332-8d3a7c1f2f19';
const audioArtifactId = '27a817b6-2030-4ae1-8831-441886f02062';

test('owner schemas and every method mapping resolve to DTO definitions', () => {
  assert.ok(Object.keys(schemas.definitions).length > 50);
  for (const [program, methods] of Object.entries(methodMap)) {
    assert.ok(Object.keys(methods).length > 0, `${program} methods`);
    for (const [method, pair] of Object.entries(methods)) {
      assert.ok(schemas.definitions[pair[0]], `${program}.${method} params`);
      assert.ok(schemas.definitions[pair[1]], `${program}.${method} result`);
    }
  }
});

test('local executor accepts artifact references and reports nullable output metadata', () => {
  assert.equal(validateDto('LocalExecuteParams', {
    requestId, operationId, audioArtifactId, ownerId: 'user_123', model: selector, deadlineAt: timestamp,
  }), true);
  assert.equal(validateDto('LocalExecuteResult', {
    requestId, operationId, actualModel: selector, text: 'recognized words', segments: null,
    durationMs: 12, usage: null, cost: null,
  }), true);
  assert.equal(validateDto('LocalExecuteResult', {
    requestId, operationId, actualModel: selector, text: 'recognized words', segments: null,
    durationMs: null, usage: null, cost: null,
  }), true);
  assert.equal(validateDto('LocalExecuteResult', {
    requestId, operationId, actualModel: selector, text: 'recognized words', segments: null,
    durationMs: null, usage: null, cost: { amount: '0.0010', currency: 'USD' },
  }), false);
});

test('local cancel cannot claim acceptance or a confirmed stop', () => {
  assert.equal(validateDto('LocalCancelParams', { requestId, operationId }), true);
  assert.equal(validateDto('ExecutorCancelResult', { accepted: false, stopConfirmed: false }), true);
  assert.equal(validateDto('ExecutorCancelResult', { accepted: true, stopConfirmed: true }), false);
});

test('external executor is explicitly unavailable and has no provider error detail', () => {
  assert.equal(validateDto('ExternalExecuteParams', {
    requestId, operationId, audioArtifactId, ownerId: 'user_123', model: null, deadlineAt: timestamp,
  }), true);
  assert.equal(validateDto('ExternalExecuteResult', { errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' }), true);
  assert.equal(validateDto('ExternalExecuteResult', { errorCode: 'PROVIDER_TIMEOUT', message: 'secret' }), false);
  assert.equal(validateDto('ExternalHealthResult', { available: false }), true);
});

test('opaque identifiers, timestamps, and exact decimal costs reject unsafe values', () => {
  assert.equal(validateDto('OwnerId', 'user_123'), true);
  assert.equal(validateDto('OwnerId', 'owner with arbitrary prose'), false);
  assert.equal(validateDto('Timestamp', '2026-02-30T12:00:00Z'), false);
  assert.equal(validateDto('Cost', { amount: '0.0100', currency: 'USD' }), true);
  assert.equal(validateDto('Cost', { amount: '1e-3', currency: 'USD' }), false);
  assert.equal(validateDto('Cost', { amount: '1.0', currency: 'USD', details: 'private' }), false);
  assert.equal(assertDto('ModelSelector', selector), selector);
});
