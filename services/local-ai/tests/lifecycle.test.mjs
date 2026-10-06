// ABOUTME: Проверяет конечность очереди и гонки lifecycle с управляемыми runtime fakes.
// ABOUTME: Фейковый процесс разрешает exit отдельно от abort, чтобы обнаруживать преждевременное освобождение ресурсов.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createLifecycleManager } from '../dist/lifecycle/index.js';

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
  let admissionGate;
  let rejectNextAdmission = false;
  const store = {
    events,
    rejectNextAdmission() { rejectNextAdmission = true; },
    blockAdmission() { admissionGate = new Promise(resolve => { store.releaseAdmission = resolve; }); store.admissionWaiting = deferred(); },
    async transaction(run) {
      const tx = {
        models: { get: async id => models.get(id) ?? null, list: async () => [...models.values()], put: async value => models.set(value.modelId, value), remove: async id => models.delete(id) },
        installations: { get: async (id, revision) => { const row = installations.get(id); return row?.revision === revision ? row : null; }, list: async () => [...installations.values()], put: async row => installations.set(row.modelId, row), remove: async id => installations.delete(id) },
        settings: { get: async () => settings, put: async () => undefined },
        outbox: {
          append: async event => { events.push(event); },
          appendAdmission: async (event, reservation) => { if (admissionGate) { store.admissionWaiting.resolve(); await admissionGate; } if (rejectNextAdmission) { rejectNextAdmission = false; throw new Error('OUTBOX_FULL'); } events.push({ event, reservation }); },
          appendCompletion: async (operationId, event) => { events.push({ operationId, event }); },
        },
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

test('idle removal guard blocks a durable admission in flight', async () => {
  const store = makeStore();
  store.blockAdmission();
  const { factory } = factoryFor(async () => new FakeRuntime());
  const lifecycle = manager(store, factory);
  const pendingRequest = embedRequest('pending');
  const pending = lifecycle.invoke(pendingRequest, invocationContext(pendingRequest));
  await store.admissionWaiting.promise;
  await assert.rejects(lifecycle.withModelIdleLock(selector().modelId, async () => undefined), error => error.code === 'MODEL_IN_USE');
  store.releaseAdmission();
  await pending;
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

test('explicit unload locks admission before its outbox reservation and through actual process exit', async () => {
  const store = makeStore();
  const old = new FakeRuntime({ holdExit: true });
  const next = new FakeRuntime();
  let opens = 0;
  const lifecycle = manager(store, { async open() { opens++; return opens === 1 ? old : next; } });
  const value = selector();
  await lifecycle.load(value, localContext('unload-gate-load'));
  store.blockAdmission();
  const unloading = lifecycle.unload(value, localContext('unload-gate'));
  await store.admissionWaiting.promise;
  const duringReservation = embedRequest('invoke-during-unload-reservation');
  await assert.rejects(lifecycle.invoke(duringReservation, invocationContext(duringReservation)), error => error.code === 'MODEL_IN_USE');
  store.releaseAdmission();
  await waitFor(() => old.closeCalls === 1);
  const duringExit = embedRequest('invoke-during-unload-exit');
  await assert.rejects(lifecycle.invoke(duringExit, invocationContext(duringExit)), error => error.code === 'MODEL_IN_USE');
  old.finishExit();
  await unloading;
  const afterUnload = embedRequest('invoke-after-unload');
  await lifecycle.invoke(afterUnload, invocationContext(afterUnload));
  assert.equal(opens, 2);
  await lifecycle.close();
});

test('close joins a pending invocation admission and writes its reserved terminal event without loading', async () => {
  const store = makeStore();
  store.blockAdmission();
  let opens = 0;
  const lifecycle = manager(store, { async open() { opens++; return new FakeRuntime(); } });
  const request = embedRequest('admission-close-race');
  const invoking = lifecycle.invoke(request, invocationContext(request));
  await store.admissionWaiting.promise;
  const closing = lifecycle.close();
  store.releaseAdmission();
  await assert.rejects(invoking, error => error.code === 'CANCELLED');
  await closing;
  assert.equal(opens, 0);
  assert.ok(store.events.some(entry => entry.operationId === request.operationId && entry.event.data.outcome === 'cancelled'));
});

test('close joins pending management admission and finalizes it without starting a runtime', async () => {
  const store = makeStore();
  store.blockAdmission();
  let opens = 0;
  const lifecycle = manager(store, { async open() { opens++; return new FakeRuntime(); } });
  const loading = lifecycle.load(selector(), localContext('load-close-race'));
  await store.admissionWaiting.promise;
  const closing = lifecycle.close();
  store.releaseAdmission();
  await assert.rejects(loading, error => error.code === 'CANCELLED');
  await closing;
  assert.equal(opens, 0);
  const accepted = store.events.find(entry => entry.event?.data.operation === 'load')?.event;
  assert.ok(accepted);
  assert.ok(store.events.some(entry => entry.operationId === accepted.data.operationId && entry.event.data.outcome === 'cancelled'));
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

test('management reserves bounded history capacity before load or unload effects', async () => {
  const store = makeStore();
  let opens = 0;
  let closes = 0;
  const runtime = new FakeRuntime();
  const lifecycle = createLifecycleManager({ store, artifacts: { withReadyAudio: async () => { throw new Error('unused'); } }, runtimeFactory: { open: async () => { opens++; return runtime; } }, limits });
  store.rejectNextAdmission();
  await assert.rejects(lifecycle.load(selector(), localContext('load-full')));
  assert.equal(opens, 0);

  await lifecycle.load(selector(), localContext('load-admitted'));
  const originalClose = runtime.close.bind(runtime);
  runtime.close = async () => { closes++; await originalClose(); };
  store.rejectNextAdmission();
  await assert.rejects(lifecycle.unload(selector(), localContext('unload-full')));
  assert.equal(closes, 0);
  assert.equal(lifecycle.status().ready, 1);
  await lifecycle.unload(selector(), localContext('unload-admitted'));
  assert.equal(closes, 1);
  await lifecycle.close();
});

test('idle removal guard rejects while management admission is pending', async () => {
  const store = makeStore();
  store.blockAdmission();
  const runtime = new FakeRuntime();
  const lifecycle = createLifecycleManager({ store, artifacts: { withReadyAudio: async () => { throw new Error('unused'); } }, runtimeFactory: { open: async () => runtime }, limits });
  const loading = lifecycle.load(selector(), localContext('load-admission-pending'));
  await store.admissionWaiting.promise;
  await assert.rejects(lifecycle.withModelIdleLock(selector().modelId, async () => undefined), error => error.code === 'MODEL_IN_USE');
  store.releaseAdmission();
  await loading;
  await lifecycle.close();
});
