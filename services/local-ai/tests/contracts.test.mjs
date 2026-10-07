// ABOUTME: Проверяет closed DTO, различие embed/transcribe и приватность history facts.
// ABOUTME: Только компилирует и проверяет owner schemas без runtime и внешних вызовов.
import assert from 'node:assert/strict';
import test from 'node:test';
import { subjects, validateMetadataEvent, validateRequest, validateResponse } from '../contracts/index.mjs';

const base = {
  requestId: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182',
  operationId: 'd6bbdb48-8c60-47ac-9252-3ab3d846c183',
  model: { modelId: 'giga-embeddings-480m-q8', revision: 'pinned', profileId: 'llama_cpp' },
  ownerId: 'user-1', deadlineAt: '2026-10-05T20:00:00Z',
};

test('DTO rejects unknown fields and invalid configured values', () => {
  assert.equal(validateRequest(subjects.modelsList, { filter: {}, surprise: true }), false);
  const configure = { modelId: 'm', revision: 'r', profileId: 'p', ownerId: 'u', idleUnloadSeconds: 0 };
  assert.equal(validateRequest(subjects.modelsConfigure, configure), false);
  assert.equal(validateRequest(subjects.modelsConfigure, { ...configure, idleUnloadSeconds: 2147483648 }), false);
});

test('embed takes memory-only text while transcribe takes an artifact ID', () => {
  assert.equal(validateRequest(subjects.invokeEmbed, { ...base, texts: ['привет'], purpose: 'query' }), true);
  assert.equal(validateRequest(subjects.invokeEmbed, { ...base, audioArtifactId: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182', purpose: 'query' }), false);
  assert.equal(validateRequest(subjects.invokeTranscribe, { ...base, audioArtifactId: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182' }), true);
  assert.equal(validateRequest(subjects.invokeTranscribe, { ...base, audioPath: '/tmp/private.wav' }), false);
});

test('embedding response rejects non-finite vector values', () => {
  const response = {
    requestId: base.requestId, operationId: base.operationId, model: base.model,
    durationMs: 1, vectors: [[0.1, Number.NaN, Number.POSITIVE_INFINITY]],
  };
  assert.equal(validateResponse(subjects.invokeEmbed, response), false);
});

test('metadata facts reject invocation content and unknown envelope properties', () => {
  const event = {
    id: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182', type_id: 1201,
    occurred_at: '2026-10-05T20:00:00Z', actor_id: null, scope_type: 'user', scope_id: 'user-1',
    object_type: 'operation', object_id: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182',
    data: { operation: 'invoke', modelId: 'giga-embeddings-480m-q8', outcome: 'succeeded', durationMs: 42 },
  };
  assert.equal(validateMetadataEvent(event), true);
  assert.equal(validateMetadataEvent({ ...event, data: { ...event.data, text: 'секретный текст' } }), false);
  assert.equal(validateMetadataEvent({ ...event, extra: true }), false);
  assert.equal(validateMetadataEvent({ ...event, occurred_at: '2026-02-30T20:00:00Z' }), false);
  assert.equal(validateMetadataEvent({ ...event, scope_id: `user\u0000suffix` }), false);
  assert.equal(validateMetadataEvent({ ...event, scope_id: 'u'.repeat(256) }), false);
});

test('known unsupported models can be returned without local paths', () => {
  const model = {
    modelId: 'external/model', name: 'External', description: '', source: 'huggingface', license: null,
    revision: 'pinned', profileId: null, supported: false, operations: ['embed'], languages: ['ru'],
    inputKinds: ['text'], outputKinds: ['vector'], files: [],
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: { purpose: ['query', 'document', 'symmetric'] }, transcribe: null },
    installationState: 'unsupported', runtimeState: null,
  };
  assert.equal(validateResponse(subjects.modelsGet, model), true);
  assert.equal(validateResponse(subjects.modelsGet, { ...model, localPath: '/srv/private/weights' }), false);
});
