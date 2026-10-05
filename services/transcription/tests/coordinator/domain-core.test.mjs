// ABOUTME: Проверяет решения coordinator domain через синтетические owner-порты.
// ABOUTME: Проверки не запускают NATS, HTTP, PostgreSQL или настоящий local-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator } from '../../dist/coordinator/domain/core.js';

const ids = {
  request: '00000000-0000-4000-8000-000000000001',
  artifact: '00000000-0000-4a00-8000-000000000002',
  key: '00000000-0000-4000-8000-000000000003',
  claim: '00000000-0000-4000-8000-000000000004',
  attempt: '00000000-0000-4000-8000-000000000005',
};
const selector = { modelId: 'local/whisper', revision: 'r1', profileId: 'transcribe' };
const principal = { scopeType: 'user', scopeId: 'user-a', ownerId: 'user-a', permissions: ['transcription:use'] };
const admin = { ...principal, permissions: ['transcription:use', 'transcription:settings:write'] };
const at = '2026-10-05T21:00:00.000Z';

function request(overrides = {}) {
  return {
    requestId: ids.request,
    scope: { scopeType: 'user', scopeId: 'user-a' },
    ownerId: 'user-a',
    audioArtifactId: ids.artifact,
    clientIdempotencyKey: ids.key,
    normalizedInputSha256: 'a'.repeat(64),
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId },
    selectedModel: selector,
    policySnapshot: { version: 1, sha256: 'b'.repeat(64), defaultLocalModel: selector, externalEnabled: false, allowReplacement: false },
    taskState: 'accepted',
    resultState: 'not_ready',
    revision: 1,
    currentAttemptId: null,
    fenceGeneration: 0,
    deadlineAt: null,
    resultExpiresAt: null,
    bufferOwnerInstanceId: null,
    actualModel: null,
    usage: null,
    cost: null,
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    inputMetadata: { mimeType: 'audio/wav', sizeBytes: 12, audioDurationSeconds: null },
    ...overrides,
  };
}

function attemptRecord(state, overrides = {}) {
  return {
    requestId: ids.request,
    attemptId: ids.attempt,
    fenceGeneration: 1,
    state,
    selectedModel: selector,
    actualModel: null,
    usage: null,
    cost: null,
    errorCode: null,
    startedAt: at,
    finishedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    instanceId: 'coordinator-a', workerId: 'worker-a', maxExecuteConcurrency: 1,
    leaseRenewIntervalMs: 60_000, defaultExecutionTimeoutMs: 30_000,
    resultTtlMs: 60_000, maxResultCount: 4, maxResultBytes: 4096,
    maxTotalResultBytes: 8192, ...overrides,
  };
}

function basePorts(helperCall, overrides = {}) {
  return {
    helper: { call: helperCall },
    artifacts: { get: async () => ({ artifactId: ids.artifact, ownerId: 'user-a', state: 'ready', mimeType: 'audio/wav', sizeBytes: 12 }) },
    localCatalog: { list: async () => [{ selector, supported: true, installed: true, ready: true }] },
    local: { call: async () => { throw new Error('unexpected local call'); } },
    external: { call: async () => ({ errorCode: 'EXTERNAL_ROUTE_UNAVAILABLE' }) },
    ...overrides,
  };
}

test('idempotency hit returns the stored request before settings, artifact, or model lookup', async () => {
  const calls = [];
  const stored = request({ taskState: 'succeeded', actualModel: selector });
  const ports = basePorts(async (method, params) => {
    calls.push({ method, params });
    if (method === 'request.lookup') return { request: stored };
    assert.fail(`unexpected helper method ${method}`);
  }, {
    artifacts: { get: async () => assert.fail('duplicate checked artifact') },
    localCatalog: { list: async () => assert.fail('duplicate looked up model') },
  });
  const core = createCoordinator({ ports, config: config() });
  const result = await core.invoke('request.submit', {
    clientIdempotencyKey: ids.key, audioArtifactId: ids.artifact.toUpperCase(),
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null,
  }, principal);
  assert.equal(result.request.requestId, ids.request);
  assert.deepEqual(calls.map((entry) => entry.method), ['request.lookup']);
  assert.equal(calls[0].params.normalizedInputSha256.length, 64);
  assert.equal(calls[0].params.normalizedInputSha256, '5d1956821d2522a7e555170e996b94bb086351b31a0beb5fd048a0685769eea1');
});

test('in-flight cancellation preserves the running attempt and does not claim executor stop', async () => {
  const current = request({ taskState: 'running', revision: 7, currentAttemptId: ids.attempt, fenceGeneration: 1 });
  const calls = [];
  const core = createCoordinator({
    ports: basePorts(async (method, params) => {
      calls.push({ method, params });
      if (method === 'request.get') return { request: current };
      if (method === 'request.cancel') {
        assert.equal(params.expectedRevision, 7);
        return { accepted: false, stopConfirmed: false, request: current };
      }
      assert.fail(`unexpected helper method ${method}`);
    }, { local: { call: async () => assert.fail('cancel must not invent an owner stop') } }),
    config: config(),
  });
  const result = await core.invoke('request.cancel', { requestId: ids.request }, principal);
  assert.equal(result.accepted, false);
  assert.equal(result.stopConfirmed, false);
  assert.equal(result.request.taskState, 'running');
  assert.deepEqual(calls.map(({ method }) => method), ['request.get', 'request.cancel']);
});

test('unavailable requested model is accepted as metadata then fails before local invoke', async () => {
  let current = request({ selectedModel: null });
  const seen = [];
  const settings = { defaultLocalModel: null, allowReplacement: false, policyVersion: 1 };
  const ports = basePorts(async (method, params) => {
    seen.push({ method, params });
    if (method === 'request.lookup') return { request: null };
    if (method === 'settings.get') return { settings, revision: 1 };
    if (method === 'request.accept') {
      assert.equal(params.selectedModel, null);
      current = request({ taskState: 'accepted', selectedModel: null });
      return { created: true, request: current };
    }
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ ...current, taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      assert.equal(params.errorCode, 'MODEL_UNAVAILABLE');
      current = request({ ...current, taskState: 'failed', revision: 3, errorCode: params.errorCode });
      return { request: current, attempt: attemptRecord('failed', { errorCode: params.errorCode }) };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, {
    localCatalog: { list: async () => [] },
    local: { call: async () => assert.fail('unavailable model reached executor') },
  });
  const core = createCoordinator({ ports, config: config() });
  const accepted = await core.invoke('request.submit', {
    clientIdempotencyKey: ids.key, audioArtifactId: ids.artifact,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null,
  }, principal);
  assert.equal(accepted.request.taskState, 'accepted');
  assert.equal(await core.pumpOnce(), true);
  assert.equal(current.taskState, 'failed');
  assert.deepEqual(seen.map(({ method }) => method), ['request.lookup', 'settings.get', 'request.accept', 'request.claim', 'attempt.start', 'attempt.finish']);
});

test('default model selection pins the full policy selector and snapshot hash', async () => {
  let acceptedRequest;
  const settings = { defaultLocalModel: selector, allowReplacement: false, policyVersion: 1 };
  const alternate = { ...selector, revision: 'r2' };
  const ports = basePorts(async (method, params) => {
    if (method === 'request.lookup') return { request: null };
    if (method === 'settings.get') return { settings, revision: 2 };
    if (method === 'request.accept') {
      assert.deepEqual(params.selectedModel, selector);
      assert.equal(params.policySnapshot.sha256, '6a1653fcd0e69649798f0596349e9cde0ad3f654ae1aafc888b07fd09cf593de');
      acceptedRequest = request({ requestedModel: null, policySnapshot: params.policySnapshot, selectedModel: params.selectedModel });
      return { created: true, request: acceptedRequest };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, { localCatalog: { list: async () => [
    { selector: alternate, supported: true, installed: true, ready: true },
    { selector, supported: true, installed: true, ready: true },
  ] } });
  const core = createCoordinator({ ports, config: config() });
  const result = await core.invoke('request.submit', {
    clientIdempotencyKey: ids.key, audioArtifactId: ids.artifact, requestedModel: null, deadlineAt: null,
  }, principal);
  assert.equal(result.request.taskState, 'accepted');
  assert.deepEqual(acceptedRequest.selectedModel, selector);
});

test('settings mutation requires its separate permission and forwards the current revision', async () => {
  const expected = { settings: { defaultLocalModel: selector, allowReplacement: false, policyVersion: 2 }, revision: 4 };
  const calls = [];
  const core = createCoordinator({
    ports: basePorts(async (method, params) => { calls.push({ method, params }); return expected; }),
    config: config(),
  });
  const body = { settings: expected.settings, expectedRevision: 3 };
  await assert.rejects(core.invoke('settings.set', body, principal), (error) => error.errorCode === 'FORBIDDEN');
  assert.equal(calls.length, 0);
  assert.deepEqual(await core.invoke('settings.set', body, admin), expected);
  assert.equal(calls[0].params.expectedRevision, 3);
});

test('a lost executor reply closes as outcome_unknown and never automatically invokes again', async () => {
  let current = request();
  let localCalls = 0;
  const helperCalls = [];
  const ports = basePorts(async (method, params) => {
    helperCalls.push({ method, params });
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      current = request({ taskState: params.outcome, resultState: params.resultState, errorCode: params.errorCode, revision: 4, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord(params.outcome, { attemptId: params.attemptId, errorCode: params.errorCode }) };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, {
    local: { call: async () => { localCalls += 1; throw new Error('connection lost after dispatch'); } },
  });
  const core = createCoordinator({ ports, config: config() });
  assert.equal(await core.pumpOnce(), true);
  assert.equal(localCalls, 1);
  assert.equal(current.taskState, 'outcome_unknown');
  const finish = helperCalls.find((entry) => entry.method === 'attempt.finish');
  assert.equal(finish.params.outcome, 'outcome_unknown');
  assert.equal(finish.params.errorCode, 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(JSON.stringify(helperCalls).includes('connection lost'), false);
});

test('RPC_REMOTE preserves a valid closed error code without claiming a definite failure', async () => {
  let current = request();
  let finishParams;
  const ports = basePorts(async (method, params) => {
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      finishParams = params;
      current = request({ ...current, taskState: params.outcome, resultState: params.resultState, errorCode: params.errorCode, revision: 4 });
      return { request: current, attempt: attemptRecord(params.outcome, { attemptId: params.attemptId, errorCode: params.errorCode }) };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, {
    local: { call: async () => {
      throw Object.assign(new Error('remote execution outcome is unknown'), {
        code: 'RPC_REMOTE', rpcCode: -32000, errorCode: 'MODEL_UNAVAILABLE', outcome: 'unknown',
      });
    } },
  });
  const core = createCoordinator({ ports, config: config(), uuid: () => ids.attempt });
  assert.equal(await core.pumpOnce(), true);
  assert.equal(finishParams.outcome, 'outcome_unknown');
  assert.equal(finishParams.errorCode, 'MODEL_UNAVAILABLE');
  assert.equal(current.taskState, 'outcome_unknown');
});

test('a mismatched executor correlation is unknown and contributes no attempt usage metadata', async () => {
  let current = request();
  let finishParams;
  const helperCalls = [];
  const ports = basePorts(async (method, params) => {
    helperCalls.push({ method, params });
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      finishParams = params;
      throw Object.assign(new Error('stale fence'), { errorCode: 'STALE_CLAIM' });
    }
    if (method === 'request.get') return { request: current };
    assert.fail(`unexpected helper method ${method}`);
  }, {
    local: { call: async (_method, params) => ({
      requestId: ids.request, operationId: ids.claim, actualModel: selector,
      text: 'must never be attributed', segments: null, durationMs: 99, usage: { inputUnits: 1, outputUnits: 1, unit: 'token' }, cost: null,
    }) },
  });
  const core = createCoordinator({ ports, config: config(), uuid: () => ids.attempt });
  await assert.rejects(core.pumpOnce());
  assert.equal(finishParams.outcome, 'outcome_unknown');
  assert.equal(finishParams.errorCode, 'REQUEST_OUTCOME_UNKNOWN');
  assert.equal(finishParams.actualModel, null);
  assert.equal(finishParams.usage, null);
  assert.equal(finishParams.cost, null);
  assert.equal(finishParams.durationMs, null);
  assert.equal(JSON.stringify(helperCalls).includes('must never be attributed'), false);
  assert.equal((await core.invoke('result.get', { requestId: ids.request }, principal)).state, 'not_ready');
});

test('active executions reserve worst-case result bytes before another claim', async () => {
  let current = request();
  let claimCalls = 0;
  let resolveExecution;
  const execution = new Promise((resolve) => { resolveExecution = resolve; });
  const ports = basePorts(async (method, params) => {
    if (method === 'request.claim') {
      claimCalls += 1;
      return claimCalls === 1 ? { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current } : null;
    }
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      current = request({ taskState: 'succeeded', resultState: 'available', revision: 4, currentAttemptId: params.attemptId, fenceGeneration: 1, actualModel: params.actualModel, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId });
      return { request: current, attempt: attemptRecord('succeeded', { attemptId: params.attemptId, actualModel: params.actualModel }) };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, { local: { call: async (_method, params) => execution.then(() => ({
    requestId: params.requestId, operationId: params.operationId, actualModel: selector,
    text: 'answer', segments: null, durationMs: 1, usage: null, cost: null,
  })) } });
  const core = createCoordinator({ ports, config: config({ maxExecuteConcurrency: 2, maxResultCount: 2, maxResultBytes: 1024, maxTotalResultBytes: 1024 }), uuid: () => ids.attempt });
  const first = core.pumpOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await core.pumpOnce(), false);
  assert.equal(claimCalls, 1);
  resolveExecution();
  assert.equal(await first, true);
});

test('the volatile transcript is absent from helper DTOs and expires without truncation', async () => {
  let current = request();
  const helperCalls = [];
  let now = Date.parse(at);
  let executorCalls = 0;
  const ports = basePorts(async (method, params) => {
    helperCalls.push({ method, params });
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      current = request({ taskState: params.outcome, resultState: params.resultState, revision: 4, currentAttemptId: params.attemptId, fenceGeneration: 1, actualModel: params.actualModel, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId });
      return { request: current, attempt: attemptRecord(params.outcome, { attemptId: params.attemptId, actualModel: params.actualModel }) };
    }
    if (method === 'request.get') return { request: current };
    if (method === 'result.setState') {
      current = request({ ...current, resultState: params.state, revision: current.revision + 1, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId });
      return { request: current };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, {
    local: { call: async (method, params) => {
      executorCalls += 1;
      assert.equal(method, 'execute');
      return { requestId: params.requestId, operationId: params.operationId, actualModel: selector, text: 'secret transcript', segments: null, durationMs: 4, usage: null, cost: null };
    } },
  });
  const core = createCoordinator({ ports, config: config({ resultTtlMs: 500, maxResultCount: 1 }), now: () => now, uuid: () => ids.attempt });
  assert.equal(await core.pumpOnce(), true);
  assert.equal(current.resultState, 'available');
  assert.equal(JSON.stringify(helperCalls).includes('secret transcript'), false);
  const live = await core.invoke('result.get', { requestId: ids.request.toUpperCase() }, principal);
  assert.equal(live.result.text, 'secret transcript');
  assert.equal(current.resultState, 'delivery_unknown');
  const claimsBeforeFullBuffer = helperCalls.filter((entry) => entry.method === 'request.claim').length;
  assert.equal(await core.pumpOnce(), false);
  assert.equal(helperCalls.filter((entry) => entry.method === 'request.claim').length, claimsBeforeFullBuffer);
  now += 501;
  const expired = await core.invoke('result.get', { requestId: ids.request }, principal);
  assert.deepEqual(expired, { state: 'expired', errorCode: 'RESULT_UNAVAILABLE' });
  assert.equal(executorCalls, 1);
  assert.equal(current.taskState, 'succeeded');
});

test('result.get refuses text when delivery-state CAS returns after the volatile TTL', async () => {
  let current = request();
  let now = Date.parse(at);
  let resolveCas;
  let casStarted;
  const started = new Promise((resolve) => { casStarted = resolve; });
  const delayedCas = new Promise((resolve) => { resolveCas = resolve; });
  const ports = basePorts(async (method, params) => {
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: current.revision, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.markRunning') {
      current = request({ taskState: 'running', revision: 3, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { request: current, attempt: attemptRecord('running', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      current = request({ ...current, taskState: 'succeeded', resultState: params.resultState, revision: 4, actualModel: params.actualModel, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId });
      return { request: current, attempt: attemptRecord('succeeded', { attemptId: params.attemptId, actualModel: params.actualModel }) };
    }
    if (method === 'request.get') return { request: current };
    if (method === 'result.setState') {
      assert.equal(params.state, 'delivery_unknown');
      casStarted();
      await delayedCas;
      current = request({ ...current, resultState: 'delivery_unknown', revision: current.revision + 1 });
      return { request: current };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, { local: { call: async (_method, params) => ({
    requestId: params.requestId, operationId: params.operationId, actualModel: selector,
    text: 'must not escape after TTL', segments: null, durationMs: 1, usage: null, cost: null,
  }) } });
  const core = createCoordinator({ ports, config: config({ resultTtlMs: 500 }), now: () => now, uuid: () => ids.attempt });
  assert.equal(await core.pumpOnce(), true);

  const pending = core.invoke('result.get', { requestId: ids.request }, principal);
  await started;
  now += 501;
  resolveCas();
  await assert.rejects(pending, (error) => error.errorCode === 'RESULT_UNAVAILABLE');
  assert.equal(current.resultState, 'delivery_unknown');
});

test('result.get does not return cached text when failed CAS reconciliation remains available', async () => {
  const current = request({
    taskState: 'succeeded', resultState: 'available', revision: 8,
    currentAttemptId: ids.attempt, fenceGeneration: 1,
    actualModel: selector, resultExpiresAt: '2026-10-05T22:00:00Z', bufferOwnerInstanceId: 'coordinator-a',
  });
  const core = createCoordinator({
    ports: basePorts(async (method) => {
      if (method === 'request.get') return { request: current };
      if (method === 'result.setState') throw Object.assign(new Error('CAS conflict'), { errorCode: 'STALE_REVISION' });
      assert.fail(`unexpected helper method ${method}`);
    }),
    config: config(),
    now: () => Date.parse(at),
  });
  await assert.rejects(
    core.invoke('result.get', { requestId: ids.request }, principal),
    (error) => error.errorCode === 'RESULT_UNAVAILABLE',
  );
});

test('timer and resource limits reject unsafe integers and Node timer overflow', () => {
  const ports = basePorts(async () => assert.fail('config validation called a port'));
  assert.throws(() => createCoordinator({ ports, config: config({ resultTtlMs: 2_147_483_648 }) }), /timer config/);
  assert.throws(() => createCoordinator({ ports, config: config({ leaseRenewIntervalMs: 1.5 }) }), /leaseRenewIntervalMs/);
  assert.throws(() => createCoordinator({ ports, config: config({ maxResultCount: Number.MAX_SAFE_INTEGER + 1 }) }), /maxResultCount/);
});

test('a result owned by another coordinator is marked lost without pretending the text crossed instances', async () => {
  let current = request({
    taskState: 'succeeded', resultState: 'available', revision: 8,
    currentAttemptId: ids.attempt, fenceGeneration: 1,
    actualModel: selector, resultExpiresAt: '2026-10-05T22:00:00Z', bufferOwnerInstanceId: 'coordinator-other',
  });
  const core = createCoordinator({
    ports: basePorts(async (method, params) => {
      if (method === 'request.get') return { request: current };
      if (method === 'result.setState') {
        assert.equal(params.state, 'lost');
        assert.equal(params.resultExpiresAt, null);
        assert.equal(params.bufferOwnerInstanceId, null);
        current = request({ ...current, resultState: 'lost', resultExpiresAt: null, bufferOwnerInstanceId: null, revision: current.revision + 1 });
        return { request: current };
      }
      assert.fail(`unexpected helper method ${method}`);
    }),
    config: config(),
    now: () => Date.parse(at),
  });
  assert.deepEqual(await core.invoke('result.get', { requestId: ids.request }, principal), {
    state: 'lost', errorCode: 'RESULT_UNAVAILABLE',
  });
  assert.equal(current.resultState, 'lost');
});

test('an expired request closes the reserved attempt without contacting an executor', async () => {
  let current = request({ deadlineAt: at });
  const seen = [];
  const ports = basePorts(async (method, params) => {
    seen.push(method);
    if (method === 'request.claim') return { claimToken: ids.claim, fenceGeneration: 1, revision: 1, leaseExpiresAt: '2026-10-05T22:00:00Z', request: current };
    if (method === 'attempt.start') {
      current = request({ ...current, taskState: 'dispatching', revision: 2, currentAttemptId: params.attemptId, fenceGeneration: 1 });
      return { created: true, request: current, attempt: attemptRecord('dispatching', { attemptId: params.attemptId }) };
    }
    if (method === 'attempt.finish') {
      assert.equal(params.outcome, 'failed');
      assert.equal(params.errorCode, 'DEADLINE_EXCEEDED');
      current = request({ ...current, taskState: 'failed', resultState: 'not_ready', errorCode: params.errorCode, revision: 3 });
      return { request: current, attempt: attemptRecord('failed', { errorCode: params.errorCode }) };
    }
    assert.fail(`unexpected helper method ${method}`);
  }, {
    local: { call: async () => assert.fail('expired request reached executor') },
  });
  const core = createCoordinator({ ports, config: config(), now: () => Date.parse(at) + 1 });
  assert.equal(await core.pumpOnce(), true);
  assert.deepEqual(seen, ['request.claim', 'attempt.start', 'attempt.finish']);
});
