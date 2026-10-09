// ABOUTME: Проверяет конечность очереди и гонки lifecycle с управляемыми runtime fakes.
// ABOUTME: Фейковый процесс разрешает exit отдельно от abort, чтобы обнаруживать преждевременное освобождение ресурсов.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createLifecycleManager } from '../dist/lifecycle/index.js';
import { createCatalog } from '../dist/catalog/index.js';

const selector = (modelId = 'giga-embeddings-480m-q8', profileId = 'llama_cpp') => ({ modelId, revision: 'rev-1', profileId });
const limits = { maxLoadedModels: 2, maxQueuedOperations: 8, maxInputBytes: 1_000_000, maxEmbeddingItems: 8, maxResultBytes: 1_000_000, loadDeadlineMs: 2000 };
const embeddingRecord = (value = selector()) => ({
  modelId: value.modelId, name: value.modelId, description: '', source: 'test', license: 'MIT', revision: value.revision,
  profileId: value.profileId, supported: true, operations: ['embed', 'transcribe'], languages: ['ru'],
  inputKinds: ['text', 'audio_artifact'], outputKinds: ['vector', 'transcription'], files: [],
  hardwareRequirements: { cpuArchitectures: ['x64'], minMemoryBytes: null, accelerator: null },
  limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: 1024 },
  parameters: { embed: { purpose: ['query', 'document', 'symmetric'] }, transcribe: {} },
});
function makeStore(records = [embeddingRecord()], settings = null) {
  const models = new Map(records.map(value => [value.modelId, value]));
  const installations = new Map(records.map(value => [value.modelId, {
    modelId: value.modelId, revision: value.revision, profileId: value.profileId, directory: '/models/' + value.modelId, files: [], installedAt: '2026-01-01T00:00:00Z',
  }]));
  const events = [];
  const store = {
    events,
    async transaction(run) {
      const tx = {
        models: { get: async id => models.get(id) ?? null, list: async () => [...models.values()], put: async value => models.set(value.modelId, value), remove: async id => models.delete(id) },
        installations: { get: async (id, revision) => { const row = installations.get(id); return row?.revision === revision ? row : null; }, list: async () => [...installations.values()], put: async row => installations.set(row.modelId, row), remove: async id => installations.delete(id) },
        settings: { get: async () => settings, put: async (_id, value) => { settings = value; } },

      };
      return run(tx);
    },
    async recoverInterrupted() { return 0; },
  };
  return store;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function localContext(operationId, { ownerId = 'user-1', deadlineMs = 5000, deadlineAt, signal = new AbortController().signal } = {}) {
  return { ownerId, operationId, deadlineAt: deadlineAt ?? new Date(Date.now() + deadlineMs).toISOString(), signal };
}
function invocationContext(input, options = {}) { return localContext(input.operationId, { ownerId: input.ownerId, deadlineAt: input.deadlineAt, ...options }); }
const vectors = () => [Array.from({ length: 1024 }, (_unused, index) => index === 0 ? 1 : 0)];
function embedRequest(operationId, value = selector(), extra = {}) {
  return { requestId: `request-${operationId}`, operationId, model: value, ownerId: 'user-1', deadlineAt: extra.deadlineAt ?? new Date(Date.now() + (extra.deadlineMs ?? 5000)).toISOString(), operation: 'embed', texts: ['hello'], purpose: 'document' };
}
async function waitFor(check, message = 'condition was not reached') {
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    if (check()) return;
    await delay(5);
  }
  assert.fail(message);
}
class FakeRuntime {
  constructor({ embed, transcribe, holdExit = false } = {}) {
    this.closed = false;
    this.closeCalls = 0;
    this.activeCalls = 0;
    this.maxActiveCalls = 0;
    this.exit = deferred();
    this.exited = this.exit.promise;
    this.holdExit = holdExit;
    this.embedHandler = embed;
    this.transcribeHandler = transcribe;
  }
  async embed(input, context) {
    this.activeCalls++;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    try { return this.embedHandler ? await this.embedHandler(input, context) : { vectors: vectors() }; }
    finally { this.activeCalls--; }
  }
  async transcribe(input, context) {
    this.activeCalls++;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    try { return this.transcribeHandler ? await this.transcribeHandler(input, context) : { text: 'ok' }; }
    finally { this.activeCalls--; }
  }
  async close() {
    this.closeCalls++;
    this.closed = true;
    if (!this.holdExit) this.exit.resolve();
    await this.exited;
  }
  finishExit() { this.exit.resolve(); }
}
function factoryFor(createRuntime) {
  const runtimes = [];
  return { runtimes, factory: { async open(_model, context) { const runtime = await createRuntime(context); runtimes.push(runtime); return runtime; } } };
}
const noArtifacts = { async withReadyAudio(_input, _context, use) { return use({ localPath: '/tmp/audio' }); } };
function manager(store, factory, override = {}) {
  return createLifecycleManager({ store, runtimeFactory: factory, artifacts: noArtifacts, limits: { ...limits, ...override } });
}

 test('same model shares one load and serializes its compute slot', async () => {
  const firstCall = deferred();
  const started = deferred();
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime({ embed: async () => { started.resolve(); await firstCall.promise; return { vectors: vectors() }; } }));
  const lifecycle = manager(makeStore(), factory);
  const oneRequest = embedRequest('one');
  const one = lifecycle.invoke(oneRequest, invocationContext(oneRequest));
  await started.promise;
  const twoRequest = embedRequest('two');
  const two = lifecycle.invoke(twoRequest, invocationContext(twoRequest));
  await waitFor(() => lifecycle.status().queued === 1);
  assert.equal(runtimes.length, 1);
  firstCall.resolve();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.operation, 'embed');
  assert.equal(b.operation, 'embed');
  assert.equal(runtimes[0].maxActiveCalls, 1);
  assert.equal(runtimes.length, 1);
  await lifecycle.close();
});

test('deadline returns promptly but keeps the busy slot until the child exits', async () => {
  const started = deferred();
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime({ holdExit: true, embed: (_input, context) => new Promise((_resolve, reject) => {
    started.resolve(); context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
  }) }));
  const lifecycle = manager(makeStore(), factory);
  const request = embedRequest('deadline', selector(), { deadlineMs: 80 });
  const call = lifecycle.invoke(request, invocationContext(request, { deadlineMs: 80 }));
  await started.promise;
  await assert.rejects(call, error => error.code === 'DEADLINE_EXCEEDED');
  await waitFor(() => runtimes[0]?.closeCalls === 1);
  assert.equal(lifecycle.status().active, 1);
  assert.equal(lifecycle.status().loaded, 1);
  runtimes[0].finishExit();
  await waitFor(() => lifecycle.status().active === 0);
  assert.equal(lifecycle.status().loaded, 0);
  assert.equal(runtimes.length, 1);
  await lifecycle.close();
});

test('transcription holds one temporary artifact through actual process exit on cancellation', async () => {
  const started = deferred();
  const runtimeClosed = deferred();
  const runtime = new FakeRuntime({ holdExit: true, transcribe: (_input, context) => new Promise((_resolve, reject) => {
    started.resolve(); context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const opened = { runtimes: [], factory: { async open() { opened.runtimes.push(runtime); return runtime; } } };
  let downloads = 0;
  let cleaned = false;
  const artifacts = { async withReadyAudio(_input, _context, use) { downloads++; try { return await use({ localPath: new URL(import.meta.url).pathname }); } finally { cleaned = true; runtimeClosed.resolve(); } } };
  const lifecycle = createLifecycleManager({ store: makeStore(), runtimeFactory: opened.factory, artifacts, limits });
  const input = { requestId: 'request-audio', operationId: 'audio', model: selector('giga-embeddings-480m-q8', 'llama_cpp'), ownerId: 'user-1', deadlineAt: new Date(Date.now() + 5000).toISOString(), operation: 'transcribe', audioArtifactId: 'artifact-1' };
  const call = lifecycle.invoke(input, invocationContext(input));
  await started.promise;
  assert.equal(downloads, 1);
  await lifecycle.cancel('user-1', 'audio');
  assert.equal(cleaned, false);
  assert.equal(lifecycle.status().active, 1);
  runtime.finishExit();
  await assert.rejects(call, error => error.code === 'CANCELLED');
  await runtimeClosed.promise;
  assert.equal(cleaned, true);
  assert.equal(downloads, 1);
  await lifecycle.close();
});

test('one cancelled load waiter does not poison a second waiter on the shared generation', async () => {
  const openGate = deferred();
  const { factory, runtimes } = factoryFor(async () => { await openGate.promise; return new FakeRuntime(); });
  const lifecycle = manager(makeStore(), factory);
  const value = selector();
  const short = new AbortController();
  const first = lifecycle.load(value, localContext('load-short', { deadlineMs: 60, signal: short.signal }));
  const second = lifecycle.load(value, localContext('load-long', { deadlineMs: 2000 }));
  await assert.rejects(first, error => error.code === 'DEADLINE_EXCEEDED');
  openGate.resolve();
  await second;
  assert.equal(runtimes.length, 1);
  assert.equal(lifecycle.readRuntimeState(value.modelId, value.revision), 'ready');
  await lifecycle.close();
});

test('idle guard rejects occupied models and waits for physical exit before removal callback', async () => {
  const started = deferred();
  const gate = deferred();
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime({ holdExit: true, embed: async () => { started.resolve(); await gate.promise; return { vectors: vectors() }; } }));
  const lifecycle = manager(makeStore(), factory);
  const busy = embedRequest('busy');
  const call = lifecycle.invoke(busy, invocationContext(busy));
  await started.promise;
  await assert.rejects(lifecycle.withModelIdleLock(selector().modelId, async () => undefined), error => error.code === 'MODEL_IN_USE');
  gate.resolve();
  await call;
  await waitFor(() => lifecycle.status().active === 0);
  let entered = false;
  const locked = lifecycle.withModelIdleLock(selector().modelId, async () => { entered = true; });
  await waitFor(() => runtimes[0].closeCalls === 1);
  assert.equal(entered, false);
  runtimes[0].finishExit();
  await locked;
  assert.equal(entered, true);
  assert.equal(lifecycle.readRuntimeState(selector().modelId, selector().revision), 'unloaded');
  await lifecycle.close();
});

test('cancelled invoke waiting for a shared load never owns or closes the surviving runtime', async () => {
  const opening = deferred();
  const entered = deferred();
  const runtime = new FakeRuntime();
  let opens = 0;
  const lifecycle = manager(makeStore(), { async open(_model, context) {
    opens++; entered.resolve(); await opening.promise;
    assert.equal(context.signal.aborted, false);
    return runtime;
  } });
  const cancelled = embedRequest('shared-cancelled');
  const first = lifecycle.invoke(cancelled, invocationContext(cancelled));
  await entered.promise;
  const surviving = embedRequest('shared-survivor');
  const second = lifecycle.invoke(surviving, invocationContext(surviving));
  await waitFor(() => lifecycle.status().queued === 1);
  await lifecycle.cancel(cancelled.ownerId, cancelled.operationId);
  await assert.rejects(first, error => error.code === 'CANCELLED');
  opening.resolve();
  await second;
  assert.equal(opens, 1);
  assert.equal(runtime.closeCalls, 0);
  assert.equal(lifecycle.status().ready, 1);
  await lifecycle.close();
});

test('failed native stop retains active capacity and audio until a later physical exit', async () => {
  const root = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/local-ai-audio-ownership-'));
  const fs = await import('node:fs/promises');
  const audioPath = root + '/audio.wav';
  await fs.writeFile(audioPath, 'fixture');
  const started = deferred(); const exit = deferred();
  let audioRemoved = false;
  const runtime = {
    exited: exit.promise,
    async embed() { assert.fail('unused'); },
    async transcribe(_input, context) {
      started.resolve();
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    async close() { throw new Error('unconfirmed stop'); },
  };
  const lifecycle = createLifecycleManager({ store: makeStore(), runtimeFactory: { async open() { return runtime; } },
    limits: { ...limits, maxQueuedOperations: 1 }, artifacts: { async withReadyAudio(_input, _context, use) {
      try { return await use({ localPath: audioPath }); }
      finally { await fs.rm(root, { recursive: true }); audioRemoved = true; }
    } } });
  const input = { ...embedRequest('failed-stop-audio'), operation: 'transcribe', audioArtifactId: 'fixture' };
  delete input.texts; delete input.purpose;
  const call = lifecycle.invoke(input, invocationContext(input));
  await started.promise;
  await lifecycle.cancel(input.ownerId, input.operationId);
  await assert.rejects(call, error => error.code === 'CANCELLED');
  await delay(20);
  assert.equal(lifecycle.status().active, 1);
  assert.equal(audioRemoved, false);
  assert.equal(await fs.readFile(audioPath, 'utf8'), 'fixture');
  const excess = embedRequest('failed-stop-excess');
  await assert.rejects(lifecycle.invoke(excess, invocationContext(excess)), error => error.code === 'BUSY');
  exit.resolve();
  await waitFor(() => audioRemoved && lifecycle.status().active === 0);
  await lifecycle.close();
});

test('explicit load after cancel or deadline gets a fresh full idle window before unload and reload', async () => {
  for (const terminalMode of ['cancel', 'deadline']) {
    const value = selector();
    const started = deferred();
    let generation = 0;
    const { factory, runtimes } = factoryFor(async () => {
      generation++;
      if (generation !== 1) return new FakeRuntime();
      return new FakeRuntime({ embed: (_input, context) => new Promise((_resolve, reject) => {
        started.resolve();
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true });
      }) });
    });
    let clock = Date.now();
    const lifecycle = createLifecycleManager({ store: makeStore([embeddingRecord(value)]), runtimeFactory: factory,
      artifacts: noArtifacts, limits, now: () => clock });
    const originalSetTimeout = globalThis.setTimeout;
    const heldTimers = [];
    const idleCallbacks = [];
    const deadlineCallbacks = [];
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 600000) {
        const timer = originalSetTimeout(() => undefined, 60000);
        heldTimers.push(timer);
        idleCallbacks.push(() => callback(...args));
        return timer;
      }
      if (terminalMode === 'deadline' && ms === 5000) {
        const timer = originalSetTimeout(() => undefined, 60000);
        heldTimers.push(timer);
        deadlineCallbacks.push(() => callback(...args));
        return timer;
      }
      return originalSetTimeout(callback, ms, ...args);
    };
    try {
      const request = embedRequest(`terminal-${terminalMode}-before-explicit-load`, value, {
        deadlineAt: new Date(clock + 5000).toISOString(),
      });
      const call = lifecycle.invoke(request, invocationContext(request));
      await started.promise;
      if (terminalMode === 'cancel') {
        await lifecycle.cancel('user-1', request.operationId);
        await assert.rejects(call, error => error.code === 'CANCELLED');
      } else {
        assert.ok(deadlineCallbacks.length >= 1);
        clock += 5000;
        deadlineCallbacks.forEach(callback => callback());
        await assert.rejects(call, error => error.code === 'DEADLINE_EXCEEDED');
      }
      await waitFor(() => lifecycle.status().active === 0 && lifecycle.readRuntimeState(value.modelId, value.revision) === 'unloaded');
      assert.equal(runtimes[0].closeCalls, 1);

      clock += 601000;
      const controller = new AbortController();
      await lifecycle.load(value, localContext(`load-after-old-idle-age-${terminalMode}`, {
        deadlineAt: new Date(clock + 5000).toISOString(), signal: controller.signal,
      }));
      controller.abort();
      assert.equal(runtimes.length, 2);
      assert.equal(lifecycle.readRuntimeState(value.modelId, value.revision), 'ready');
      assert.equal(runtimes[1].closeCalls, 0);
      assert.equal(idleCallbacks.length, 1);

      clock += 599999;
      assert.equal(runtimes[1].closeCalls, 0);
      clock += 1;
      idleCallbacks[0]();
      await waitFor(() => lifecycle.readRuntimeState(value.modelId, value.revision) === 'unloaded');
      assert.equal(runtimes[1].closeCalls, 1);

      const reload = embedRequest(`reload-after-fresh-idle-window-${terminalMode}`, value, {
        deadlineAt: new Date(clock + 5000).toISOString(),
      });
      await lifecycle.invoke(reload, invocationContext(reload));
      assert.equal(runtimes.length, 3);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      heldTimers.forEach(timer => clearTimeout(timer));
      await lifecycle.close();
    }
  }
});

test('explicit load arms idle cleanup after its management waiter leaves and the next invoke reloads', async () => {
  const value = selector();
  const store = makeStore([embeddingRecord(value)], { idleUnloadSeconds: 1 });
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime());
  let clock = Date.now();
  const lifecycle = createLifecycleManager({ store, runtimeFactory: factory, artifacts: noArtifacts, limits, now: () => clock });
  const controller = new AbortController();
  const originalSetTimeout = globalThis.setTimeout;
  const heldTimers = [];
  const idleCallbacks = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 1000) {
      const timer = originalSetTimeout(() => undefined, 60000);
      heldTimers.push(timer);
      idleCallbacks.push(() => callback(...args));
      return timer;
    }
    return originalSetTimeout(callback, ms, ...args);
  };
  try {
    await lifecycle.load(value, localContext('explicit-idle-load', { deadlineAt: new Date(clock + 5000).toISOString(), signal: controller.signal }));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    controller.abort();
    heldTimers.forEach(timer => clearTimeout(timer));
  }
  assert.equal(runtimes.length, 1);
  assert.equal(idleCallbacks.length, 1);
  clock += 1000;
  idleCallbacks[0]();
  await waitFor(() => lifecycle.readRuntimeState(value.modelId, value.revision) === 'unloaded');
  assert.equal(runtimes[0].closeCalls, 1);

  const request = embedRequest('after-explicit-idle-load', value, { deadlineAt: new Date(clock + 5000).toISOString() });
  await lifecycle.invoke(request, invocationContext(request));
  assert.equal(runtimes.length, 2);
  await lifecycle.close();
});

test('settingsChanged null cancels an armed timer and re-enabling uses current idle age', async () => {
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime());
  const lifecycle = manager(makeStore(), factory);
  const value = selector();
  const timerRequest = embedRequest('timer');
  await lifecycle.invoke(timerRequest, invocationContext(timerRequest));
  lifecycle.settingsChanged(value.modelId, { idleUnloadSeconds: null });
  await delay(1100);
  assert.equal(runtimes[0].closeCalls, 0);
  lifecycle.settingsChanged(value.modelId, { idleUnloadSeconds: 1 });
  await waitFor(() => runtimes[0].closeCalls === 1, 'idle timer did not unload the runtime');
  await waitFor(() => lifecycle.readRuntimeState(value.modelId, value.revision) === 'unloaded');
  await lifecycle.close();
});

test('new work is rejected during explicit unload and opens a fresh generation afterward', async () => {
  const old = new FakeRuntime({ holdExit: true });
  const next = new FakeRuntime();
  let opens = 0;
  const factory = { async open() { opens++; return opens === 1 ? old : next; } };
  const lifecycle = manager(makeStore(), factory);
  const value = selector();
  await lifecycle.load(value, localContext('initial-load'));
  const unloading = lifecycle.unload(value, localContext('unload-old'));
  await waitFor(() => old.closeCalls === 1);
  const request = embedRequest('after-unload');
  await assert.rejects(lifecycle.invoke(request, invocationContext(request)), error => error.code === 'MODEL_IN_USE');
  assert.equal(opens, 1);
  old.finishExit();
  await unloading;
  const invocation = lifecycle.invoke(request, invocationContext(request));
  const result = await invocation;
  assert.equal(result.operation, 'embed');
  assert.equal(opens, 2);
  assert.equal(lifecycle.readRuntimeState(value.modelId, value.revision), 'ready');
  await lifecycle.close();
});

test('expired queued call is removed without loading or retrying its model', async () => {
  const gate = deferred();
  const started = deferred();
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime({ embed: async () => { started.resolve(); await gate.promise; return { vectors: vectors() }; } }));
  const lifecycle = manager(makeStore(), factory);
  const firstRequest = embedRequest('active');
  const first = lifecycle.invoke(firstRequest, invocationContext(firstRequest));
  await started.promise;
  const queuedRequest = embedRequest('queued-deadline', selector(), { deadlineMs: 60 });
  const queued = lifecycle.invoke(queuedRequest, invocationContext(queuedRequest));
  await waitFor(() => lifecycle.status().queued === 1);
  await assert.rejects(queued, error => error.code === 'DEADLINE_EXCEEDED');
  assert.equal(lifecycle.status().queued, 0);
  assert.equal(lifecycle.status().active, 1);
  assert.equal(runtimes.length, 1);
  gate.resolve();
  await first;
  assert.equal(runtimes.length, 1);
  await lifecycle.close();
});

test('global loaded-model limit rejects a concurrent second load without oversubscription', async () => {
  const values = [selector(), selector('gigaam-v3-e2e-ctc', 'gigaam_pytorch')];
  const store = makeStore(values.map(value => embeddingRecord(value)));
  let opens = 0;
  const gate = deferred();
  const factory = { async open() { opens++; await gate.promise; return new FakeRuntime(); } };
  const lifecycle = manager(store, factory, { maxLoadedModels: 1 });
  const first = lifecycle.load(values[0], localContext('load-a'));
  const second = lifecycle.load(values[1], localContext('load-b'));
  await waitFor(() => lifecycle.status().loading === 1);
  gate.resolve();
  await first;
  await assert.rejects(second, error => error.code === 'BUSY');
  assert.equal(opens, 1);
  assert.equal(lifecycle.status().loaded, 1);
  await lifecycle.close();
});

test('maximum idle setting is chunked instead of overflowing Node timer range', async () => {
  const { factory, runtimes } = factoryFor(async () => new FakeRuntime());
  const lifecycle = manager(makeStore(), factory);
  const request = embedRequest('long-idle');
  await lifecycle.invoke(request, invocationContext(request));
  lifecycle.settingsChanged(request.model.modelId, { idleUnloadSeconds: 2_147_483_647 });
  await delay(40);
  assert.equal(runtimes[0].closeCalls, 0);
  assert.equal(lifecycle.readRuntimeState(request.model.modelId, request.model.revision), 'ready');
  await lifecycle.close();
});

test('unconfirmed close keeps model unavailable until exited later proves cleanup', async () => {
  const exit = deferred();
  const started = deferred();
  const runtime = {
    exited: exit.promise,
    async embed(_input, context) { started.resolve(); return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
    async transcribe() { throw new Error('unused'); },
    async close() { throw new Error('termination not confirmed'); },
  };
  const lifecycle = manager(makeStore(), { async open() { return runtime; } });
  const request = embedRequest('close-unconfirmed', selector(), { deadlineMs: 70 });
  const call = lifecycle.invoke(request, invocationContext(request));
  await started.promise;
  await assert.rejects(call, error => error.code === 'DEADLINE_EXCEEDED');
  assert.equal(lifecycle.status().models[request.model.modelId], 'error');
  assert.equal(lifecycle.status().ready, 0);
  assert.equal(lifecycle.status().loaded, 1);
  exit.resolve();
  await waitFor(() => lifecycle.status().loaded === 0);
  assert.equal(lifecycle.readRuntimeState(request.model.modelId, request.model.revision), 'unloaded');
  await lifecycle.close();
});


test('warm invoke and reload use cached verified metadata while all store transactions throw', async () => {
  const store = makeStore(); const { factory, runtimes } = factoryFor(async () => new FakeRuntime());
  const facts = [];
  const lifecycle = createLifecycleManager({ store, runtimeFactory: factory, artifacts: noArtifacts, limits,
    history: { publish(event) { facts.push(event); throw new Error('history failure'); } } });
  await lifecycle.refreshModel(selector().modelId);
  store.transaction = async () => { throw new Error('SQL on warm invocation'); };
  const a = embedRequest('warm-one'); await lifecycle.invoke(a, invocationContext(a));
  const b = embedRequest('warm-two'); await lifecycle.invoke(b, invocationContext(b));
  await lifecycle.unload(selector(), localContext('warm-unload'));
  const c = embedRequest('warm-reload'); await lifecycle.invoke(c, invocationContext(c));
  assert.equal(runtimes.length, 2);
  assert.equal(facts.filter(fact => fact.data.operation === 'invoke').length, 3);
  assert.ok(facts.every(fact => !('inputBytes' in fact.data) && !('resultBytes' in fact.data)));
  await lifecycle.close();
});

test('audio acquisition is registered and bounded before preparation and cancellation reaches its shared signal', async () => {
  const entered = deferred(); const release = deferred();
  let cleaned = false; let downloads = 0;
  const artifacts = { async withReadyAudio(_input, context) {
    downloads++; entered.resolve();
    await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted preparation')), { once: true }));
    cleaned = true;
  } };
  // Очистка остаётся в finally и при ошибке подготовки.
  const original = artifacts.withReadyAudio;
  artifacts.withReadyAudio = async (...args) => { try { return await original(...args); } finally { await release.promise; cleaned = true; } };
  const lifecycle = createLifecycleManager({ store: makeStore(), runtimeFactory: { async open() { assert.fail('cancelled preparation must not load'); } }, artifacts,
    limits: { ...limits, maxQueuedOperations: 1 } });
  const input = { ...embedRequest('prep'), operation: 'transcribe', audioArtifactId: 'fixture' }; delete input.texts; delete input.purpose;
  const call = lifecycle.invoke(input, invocationContext(input)); await entered.promise;
  const excess = embedRequest('excess'); await assert.rejects(lifecycle.invoke(excess, invocationContext(excess)), error => error.code === 'BUSY');
  await assert.rejects(lifecycle.withModelIdleLock(selector().modelId, async () => undefined), error => error.code === 'MODEL_IN_USE');
  assert.equal(await lifecycle.cancel(input.ownerId, input.operationId), 'cancellation_requested');
  await assert.rejects(call, error => error.code === 'CANCELLED'); assert.equal(downloads, 1); assert.equal(cleaned, false);
  release.resolve(); await lifecycle.close(); assert.equal(cleaned, true);
});

test('late old metadata refresh cannot republish an installation after a newer removal refresh', async () => {
  const value = selector(); const record = embeddingRecord(value); const gate = deferred(); const oldRead = deferred();
  let reads = 0;
  const store = { async transaction(run) {
    const read = ++reads;
    const old = { modelId: value.modelId, revision: value.revision, profileId: value.profileId, directory: '/old', files: [], installedAt: '2026-01-01T00:00:00Z' };
    return run({ models: { get: async () => record }, installations: { get: async () => { if (read === 1) { oldRead.resolve(); await gate.promise; return old; } return null; } }, settings: { get: async () => null } });
  } };
  const lifecycle = manager(store, { async open() { assert.fail('removed metadata must not start runtime'); } });
  const old = lifecycle.refreshModel(value.modelId); await oldRead.promise;
  await lifecycle.refreshModel(value.modelId); gate.resolve(); await old;
  const input = embedRequest('after-remove'); await assert.rejects(lifecycle.invoke(input, invocationContext(input)), error => error.code === 'MODEL_NOT_INSTALLED');
  await lifecycle.close();
});

test('a rejected revision cannot poison the model slot for the correct selector', async () => {
  const { factory } = factoryFor(async () => new FakeRuntime()); const lifecycle = manager(makeStore(), factory);
  const invalid = embedRequest('wrong-revision', { ...selector(), revision: 'wrong' });
  await assert.rejects(lifecycle.invoke(invalid, invocationContext(invalid)), error => error.code === 'REVISION_CONFLICT');
  const valid = embedRequest('correct-revision'); await lifecycle.invoke(valid, invocationContext(valid)); await lifecycle.close();
});

test('deadline during audio preparation aborts the operation before loading and retains capacity until cleanup', async () => {
  const entered = deferred(); const release = deferred();
  const artifacts = { async withReadyAudio(_input, context) {
    entered.resolve();
    try { await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('deadline preparation')), { once: true })); }
    finally { await release.promise; }
  } };
  const lifecycle = createLifecycleManager({ store: makeStore(), runtimeFactory: { async open() { assert.fail('expired prep must not load'); } }, artifacts, limits: { ...limits, maxQueuedOperations: 1 } });
  const input = { ...embedRequest('prep-deadline', selector(), { deadlineMs: 60 }), operation: 'transcribe', audioArtifactId: 'fixture' }; delete input.texts; delete input.purpose;
  const call = lifecycle.invoke(input, invocationContext(input)); await entered.promise;
  await assert.rejects(call, error => error.code === 'DEADLINE_EXCEEDED');
  const excess = embedRequest('prep-retained'); await assert.rejects(lifecycle.invoke(excess, invocationContext(excess)), error => error.code === 'BUSY');
  release.resolve(); await lifecycle.close();
});

test('successful durable configure updates cached metadata and failed configure leaves its verified snapshot usable', async () => {
  const store = makeStore(); const { factory, runtimes } = factoryFor(async () => new FakeRuntime());
  const lifecycle = manager(store, factory); await lifecycle.refreshModel(selector().modelId);
  const catalog = createCatalog(store, lifecycle);
  await catalog.configure({ ...selector(), idleUnloadSeconds: null }, localContext('configure-cache'));
  const original = store.transaction;
  store.transaction = run => original(tx => run({ ...tx, settings: { ...tx.settings, put: async () => { throw new Error('durable write failed'); } } }));
  await assert.rejects(catalog.configure({ ...selector(), idleUnloadSeconds: 1 }, localContext('configure-failed')), /durable write failed/);
  store.transaction = async () => { assert.fail('configure must refresh the actual warm cache before returning'); };
  const request = embedRequest('configured-warm'); await lifecycle.invoke(request, invocationContext(request));
  await delay(1100); assert.equal(runtimes[0].closeCalls, 0, 'failed durable mutation must not arm an idle timer');
  await lifecycle.close();
});


test('multimodal cancellation retains artifact ownership until physical runtime exit', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const root = await mkdtemp('/tmp/local-ai-media-lifecycle-');
  const file = root + '/image';
  await writeFile(file, 'synthetic');
  const selected = selector('gemma', 'embeddinggemma2_llama_cpp');
  const record = { ...embeddingRecord(selected), inputKinds: ['text','image_artifact'] };
  const called = deferred();
  const runtime = new FakeRuntime({ holdExit: true, embed: async () => { called.resolve(); await runtime.exited; throw new Error('stopped'); } });
  let held = false;
  const lifecycle = createLifecycleManager({ store: makeStore([record]), runtimeFactory: factoryFor(() => runtime).factory, limits, artifacts: {
    async withReadyAudio() { assert.fail('unused'); },
    async withReadyMedia(input, context, use) { assert.equal(input.ownerId, context.ownerId); held = true; try { return await use({ localPath: file, mimeType: 'image/png' }); } finally { held = false; } },
  } });
  try {
    const input = { ...embedRequest('media-cancel', selected), inputs: [{ type: 'image_artifact', artifactId: 'f2d85bb3-9a74-48ca-ae1f-1fb140d2cb7f' }] };
    delete input.texts;
    const result = lifecycle.invoke(input, invocationContext(input));
    await called.promise;
    await lifecycle.cancel(input.ownerId, input.operationId);
    await assert.rejects(result, error => error.code === 'CANCELLED');
    assert.equal(held, true);
    assert.equal(lifecycle.status().active, 1);
    runtime.finishExit();
    await waitFor(() => !held && lifecycle.status().active === 0);
  } finally { runtime.finishExit(); await lifecycle.close(); await rm(root, { recursive: true }); }
});

test('text-only Giga rejects media before artifact acquisition or runtime load', async () => {
  const selected = selector();
  const record = { ...embeddingRecord(selected), inputKinds: ['text'] };
  const lifecycle = createLifecycleManager({ store: makeStore([record]), limits, runtimeFactory: {
    async open() { assert.fail('unsupported media must not load Giga'); },
  }, artifacts: {
    async withReadyAudio() { assert.fail('unused'); },
    async withReadyMedia() { assert.fail('unsupported media must not read artifacts'); },
  } });
  const input = { ...embedRequest('giga-media', selected), inputs: [{ type: 'image_artifact', artifactId: 'f2d85bb3-9a74-48ca-ae1f-1fb140d2cb7f' }] };
  delete input.texts;
  try { await assert.rejects(lifecycle.invoke(input, invocationContext(input)), error => error.code === 'UNSUPPORTED_OPERATION'); }
  finally { await lifecycle.close(); }
});
