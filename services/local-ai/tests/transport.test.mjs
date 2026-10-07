// ABOUTME: Проверяет startup subscription barrier и независимый bounded control admission.
// ABOUTME: Проверяет таймер реального transport вместе с lifecycle без сети и собственных таймеров artifacts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startLocalAiNats } from '../dist/transport/index.js';
import { createLifecycleManager } from '../dist/lifecycle/index.js';
import { subjects } from '../contracts/index.mjs';
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const endpoints = new Map(); const stopped = deferred(); const events = deferred();
  const service = { isStopped: false, stopped: stopped.promise, addEndpoint(_name, endpoint) { endpoints.set(endpoint.subject, endpoint.handler); },
    async stop() { this.isStopped = true; stopped.resolve(); } };
  const nc = { services: { async add() { return service; } }, isClosed: () => false, isDraining: () => false,
    async flush() {}, closed: () => new Promise(() => {}), status: () => ({ stop() { events.resolve({ done: true }); },
      [Symbol.asyncIterator]() { return { next: () => events.promise }; } }) };
  return { nc, endpoints, send(subject, request) {
    const reply = deferred();
    endpoints.get(subject)(null, { data: Buffer.from(JSON.stringify(request)), respond(data) { reply.resolve(JSON.parse(Buffer.from(data).toString())); },
      respondError(_status, _code, data) { reply.resolve(JSON.parse(Buffer.from(data).toString())); } });
    return reply.promise;
  } };
}
const config = { maxConcurrentRequests: 1, maxRequestBytes: 10000, maxReplyBytes: 10000, maxRequestMs: 5000 };
const status = { state: 'ready', components: Object.fromEntries(['database', 'nats', 'executables', 'weights'].map(name => [name, { state: 'ready', errorCode: null }])) };

test('startup returns only after NATS subscription flush and status/cancel stay available under compute saturation', async () => {
  const f = fixture(); const barrier = deferred(); const entered = deferred(); const release = deferred();
  f.nc.flush = () => { entered.resolve(); return barrier.promise; };
  let returned = false;
  const starting = startLocalAiNats(f.nc, config, {
    [subjects.modelsLoad]: async request => { await release.promise; return { modelId: request.modelId, revision: request.revision, profileId: request.profileId, state: 'loaded' }; },
    [subjects.status]: async () => status,
    [subjects.cancel]: async request => ({ operationId: request.operationId, status: 'not_found' }),
  }).then(value => { returned = true; return value; });
  await entered.promise; assert.equal(returned, false); barrier.resolve(); const transport = await starting;
  const load = { modelId: 'm', revision: 'r', profileId: 'p', ownerId: 'u', deadlineAt: new Date(Date.now() + 4000).toISOString() };
  const held = f.send(subjects.modelsLoad, load);
  assert.equal((await f.send(subjects.modelsLoad, load)).code, 'BUSY');
  assert.deepEqual(await f.send(subjects.status, {}), status);
  assert.equal((await f.send(subjects.cancel, { requestId: randomUUID(), ownerId: 'u', operationId: randomUUID() })).status, 'not_found');
  release.resolve(); await held; await transport.close();
});

test('transport owns the single invoke deadline and aborts audio preparation without adapter timers', async () => {
  const f = fixture(); const prepared = deferred(); const aborted = deferred();
  const selector = { modelId: 'm', revision: 'r', profileId: 'p' };
  const record = { ...selector, supported: true, operations: ['transcribe'], limits: { maxInputBytes: null, maxItems: null, vectorDimensions: null } };
  const store = { async transaction(run) { return run({ models: { get: async () => record }, installations: { get: async () => ({ ...selector, directory: '/fixture', files: [] }) }, settings: { get: async () => null } }); } };
  const lifecycle = createLifecycleManager({ store, limits: { maxLoadedModels: 1, maxQueuedOperations: 1, maxInputBytes: 1000, maxEmbeddingItems: 1, maxResultBytes: 1000, loadDeadlineMs: 1000 },
    runtimeFactory: { async open() { assert.fail('preparation must not reach runtime'); } }, artifacts: { async withReadyAudio(_input, context) {
      prepared.resolve(context.signal);
      await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('aborted')); }, { once: true }));
    } } });
  await lifecycle.refreshModel('m');
  const transport = await startLocalAiNats(f.nc, config, { [subjects.invokeTranscribe]: (request, context) => lifecycle.invoke({ ...request, operation: 'transcribe' }, context) });
  const response = f.send(subjects.invokeTranscribe, { requestId: randomUUID(), operationId: randomUUID(), ownerId: 'u', model: selector, audioArtifactId: randomUUID(), deadlineAt: new Date(Date.now() + 70).toISOString() });
  const signal = await prepared.promise; assert.equal((await response).code, 'DEADLINE_EXCEEDED'); await aborted.promise; assert.equal(signal.aborted, true);
  await lifecycle.close(); await transport.close();
});

test('control admission is separately bounded and startup flush failure closes registered subscriptions', async () => {
  const f = fixture(); const release = deferred();
  const transport = await startLocalAiNats(f.nc, config, { [subjects.status]: async () => { await release.promise; return status; } });
  const held = Array.from({ length: 4 }, () => f.send(subjects.status, {}));
  assert.equal((await f.send(subjects.status, {})).code, 'BUSY');
  release.resolve(); await Promise.all(held); await transport.close();
  const failed = fixture(); failed.nc.flush = async () => { throw new Error('flush failed'); };
  await assert.rejects(startLocalAiNats(failed.nc, config, { [subjects.status]: async () => status }), error => error.code === 'DEPENDENCY_UNAVAILABLE');
});
