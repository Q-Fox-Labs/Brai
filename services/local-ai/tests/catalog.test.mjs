// ABOUTME: Проверяет прикладные правила каталога и атомарные metadata-изменения.
// ABOUTME: Использует транзакционный fake store; PostgreSQL гарантии проверяются отдельным интеграционным тестом.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog } from '../dist/catalog/index.js';
import { validateMetadataEvent } from '../contracts/index.mjs';

const model = (modelId = 'embedder') => ({
  modelId, name: modelId, description: 'test metadata', source: 'fixture', license: null,
  revision: 'revision-1', profileId: 'llama_cpp', supported: true, operations: ['embed'],
  languages: ['ru'], inputKinds: ['text'], outputKinds: ['vector'], files: [],
  hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
  limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
  parameters: { embed: { purpose: ['query'] }, transcribe: {} },
});
const context = { ownerId: 'trusted-owner', operationId: 'd6bbdb48-8c60-47ac-9252-3ab3d846c182', deadlineAt: '2026-10-05T20:00:00Z', signal: new AbortController().signal };
const installation = (modelId = 'embedder', revision = 'revision-1') => ({
  modelId, revision, profileId: 'llama_cpp', directory: '/private/models/embedder/revision-1', files: [], installedAt: '2026-10-05T20:00:00Z',
});

function memoryStore({ failOutbox = false } = {}) {
  const state = { models: new Map([['embedder', model()], ['other', model('other')]]), installations: new Map([['embedder/revision-1', installation()]]), settings: new Map(), events: [] };
  const key = (modelId, revision) => `${modelId}/${revision}`;
  return {
    state,
    async transaction(run) {
      const snapshot = { models: new Map(state.models), installations: new Map(state.installations), settings: new Map(state.settings), events: [...state.events] };
      const tx = {
        models: {
          async get(id) { return state.models.get(id) ?? null; },
          async list(filter) {
            return [...state.models.values()].filter(value =>
              (!filter.modelId || value.modelId === filter.modelId)
              && (!filter.operation || value.operations.includes(filter.operation))
              && (!filter.inputKind || value.inputKinds.includes(filter.inputKind))
              && (!filter.outputKind || value.outputKinds.includes(filter.outputKind))
              && (!filter.language || value.languages.includes(filter.language))
              && (filter.installed === undefined || state.installations.has(key(value.modelId, value.revision)) === filter.installed));
          },
        },
        installations: {
          async get(id, revision) { return state.installations.get(key(id, revision)) ?? null; },
          async list() { return [...state.installations.values()]; },
          async remove(id, revision) { state.installations.delete(key(id, revision)); },
        },
        settings: {
          async get(id) { return state.settings.get(id) ?? null; },
          async put(id, value) { state.settings.set(id, value); },
        },
        outbox: {
          async append(event) { if (failOutbox) throw new Error('capacity'); state.events.push(event); },
        },
      };
      try { return await run(tx); }
      catch (error) {
        state.models = snapshot.models; state.installations = snapshot.installations; state.settings = snapshot.settings; state.events = snapshot.events;
        throw error;
      }
    },
  };
}

function dependencies() {
  const guarded = [];
  const changed = [];
  return {
    guarded,
    changed,
    async withModelIdleLock(modelId, callback) { guarded.push(modelId); return callback(); },
    readRuntimeState(modelId) { return modelId === 'embedder' ? 'ready' : 'unloaded'; },
    settingsChanged(modelId, setting) { changed.push({ modelId, setting }); },
    now: () => '2026-10-05T20:00:00.000Z',
  };
}

test('catalog derives install/runtime state and applies runtime readiness only in memory', async () => {
  const store = memoryStore();
  const deps = dependencies();
  const catalog = createCatalog(store, deps);
  const ready = await catalog.list({ ready: true });
  assert.deepEqual(ready.map(value => value.modelId), ['embedder']);
  assert.equal(ready[0].installationState, 'installed');
  assert.equal(ready[0].runtimeState, 'ready');
  const absent = await catalog.list({ installed: false });
  assert.deepEqual(absent.map(value => value.modelId), ['other']);
  assert.equal(absent[0].installationState, 'not_installed');
  assert.equal(store.state.models.get('embedder').runtimeState, undefined);
});

test('settings default to 600 seconds and configure commits one closed history fact', async () => {
  const store = memoryStore();
  const deps = dependencies();
  const catalog = createCatalog(store, deps);
  assert.deepEqual(await catalog.settings('embedder'), { idleUnloadSeconds: 600 });
  const configured = await catalog.configure({ modelId: 'embedder', revision: 'revision-1', profileId: 'llama_cpp', idleUnloadSeconds: null }, context);
  assert.deepEqual(configured, { modelId: 'embedder', revision: 'revision-1', profileId: 'llama_cpp', idleUnloadSeconds: null });
  assert.deepEqual(await catalog.settings('embedder'), { idleUnloadSeconds: null });
  assert.deepEqual(deps.changed, [{ modelId: 'embedder', setting: { idleUnloadSeconds: null } }]);
  assert.equal(store.state.events.length, 1);
  assert.equal(validateMetadataEvent(store.state.events[0]), true);
  assert.deepEqual(store.state.events[0].data, {
    operation: 'configure', modelId: 'embedder', outcome: 'succeeded', revision: 'revision-1',
    profileId: 'llama_cpp', operationId: context.operationId, phase: 'configure',
  });
  assert.equal(store.state.events[0].actor_id, context.ownerId);
  assert.equal(store.state.events[0].scope_id, 'local_ai');
  assert.equal('directory' in store.state.events[0].data, false);
});

test('settings update rolls back when metadata outbox rejects the transaction', async () => {
  const store = memoryStore({ failOutbox: true });
  const deps = dependencies();
  const catalog = createCatalog(store, deps);
  await assert.rejects(catalog.configure({ modelId: 'embedder', revision: 'revision-1', profileId: 'llama_cpp', idleUnloadSeconds: 30 }, context), /capacity/);
  assert.equal(store.state.settings.has('embedder'), false);
  assert.equal(store.state.events.length, 0);
  assert.deepEqual(deps.changed, []);
});

test('configure rejects a stale revision or profile before persisting settings', async () => {
  const store = memoryStore();
  const catalog = createCatalog(store, dependencies());
  await assert.rejects(catalog.configure({ modelId: 'embedder', revision: 'stale', profileId: 'llama_cpp', idleUnloadSeconds: 30 }, context), /MODEL_SELECTOR_MISMATCH/);
  await assert.rejects(catalog.configure({ modelId: 'embedder', revision: 'revision-1', profileId: 'other_profile', idleUnloadSeconds: 30 }, context), /MODEL_SELECTOR_MISMATCH/);
  assert.equal(store.state.settings.has('embedder'), false);
  assert.equal(store.state.events.length, 0);
});

test('remove holds idle guard and returns the private installation for filesystem cleanup', async () => {
  const store = memoryStore();
  const deps = dependencies();
  const catalog = createCatalog(store, deps);
  const removed = await catalog.remove('embedder', 'revision-1', 'llama_cpp', context);
  assert.deepEqual(deps.guarded, ['embedder']);
  assert.equal(removed.directory, '/private/models/embedder/revision-1');
  assert.equal(store.state.installations.has('embedder/revision-1'), false);
  assert.equal(store.state.events.length, 1);
  assert.equal(validateMetadataEvent(store.state.events[0]), true);
  assert.equal(store.state.events[0].data.operation, 'remove');
  assert.equal(store.state.events[0].data.revision, 'revision-1');
});

test('remove rejects an untrusted model selector while holding the idle guard', async () => {
  const store = memoryStore();
  const deps = dependencies();
  const catalog = createCatalog(store, deps);
  await assert.rejects(catalog.remove('embedder', 'revision-1', 'other_profile', context), /MODEL_SELECTOR_MISMATCH/);
  assert.deepEqual(deps.guarded, ['embedder']);
  assert.equal(store.state.installations.has('embedder/revision-1'), true);
  assert.equal(store.state.events.length, 0);
});
