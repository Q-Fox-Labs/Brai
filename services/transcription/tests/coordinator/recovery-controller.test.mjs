// ABOUTME: Проверяет recovery, dispatch gating и replay history на синтетических портах.
// ABOUTME: Не запускает PostgreSQL, NATS, HTTP или transcription executor.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryController } from '../../dist/coordinator/recovery/controller.js';
import { validateDto } from '../../contracts/index.mjs';

const ids = {
  delivery: '00000000-0000-4000-8000-000000000001',
  token1: '00000000-0000-4000-8000-000000000002',
  token2: '00000000-0000-4000-8000-000000000003',
  request: '00000000-0000-4000-8000-000000000004',
};
const zero = { dispatchingExpired: 0, runningExpired: 0, succeededBufferLost: 0, resultsExpired: 0 };
const changed = { dispatchingExpired: 1, runningExpired: 0, succeededBufferLost: 0, resultsExpired: 0 };
const event = {
  id: ids.delivery, type_id: 1201, occurred_at: '2026-10-05T21:00:00Z', actor_id: 'owner-a',
  scope_type: 'user', scope_id: 'scope-a', object_type: 'transcription_request', object_id: ids.request,
  data: { requestId: ids.request, attemptId: null, phase: 'accepted', outcome: null, route: 'local', requestedModelId: null, actualModelId: null, errorCode: null },
};
const claim = token => ({ deliveryId: ids.delivery, claimToken: token, leaseExpiresAt: '2026-10-05T21:01:00Z', requestId: ids.request, source: 'transcription', event });
const config = (overrides = {}) => ({
  instanceId: 'coordinator-a', workerId: 'worker-a', recoveryMaxBatches: 4, recoveryCycleTimeoutMs: 500,
  recoveryPollIntervalMs: 10_000, historyMaxDeliveries: 1, historyPollIntervalMs: 10_000,
  pumpPollIntervalMs: 10_000, ...overrides,
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('condition did not become true');
}
function helperPort(handler, calls = []) {
  return { calls, async call(method, params) { calls.push({ method, params }); return handler(method, params); } };
}

test('initialize clears volatile state and drains owner recovery batches before enabling pump', async () => {
  const order = [];
  let recoveryCalls = 0;
  const helper = helperPort(method => {
    if (method === 'history.claim') return null;
    assert.equal(method, 'recovery.run');
    recoveryCalls += 1;
    return recoveryCalls === 1 ? changed : zero;
  });
  const controller = createRecoveryController({ helper, history: { append: async () => {} },
    clearVolatileResults: () => order.push('clear'), config: config() });
  await controller.initialize();
  order.push('initialized');
  assert.deepEqual(order, ['clear', 'initialized']);
  assert.equal(recoveryCalls, 2);
  assert.ok(helper.calls.every(call => validateDto('HelperRecoveryRunParams', call.params)));
  assert.equal(controller.ready, true);
  let pumps = 0;
  controller.start(async () => { pumps += 1; return false; });
  try {
    await until(() => pumps === 1);
    assert.equal(controller.status().ready, true);
    assert.deepEqual(helper.calls.map(call => call.method), ['recovery.run', 'recovery.run', 'history.claim']);
  } finally { await controller.close(); }
});

test('bounded startup recovery that remains nonzero rejects readiness and never starts pump', async () => {
  const helper = helperPort(() => changed);
  const controller = createRecoveryController({ helper, history: { append: async () => {} },
    clearVolatileResults: () => {}, config: config({ recoveryMaxBatches: 1 }) });
  await assert.rejects(controller.initialize(), error => error.message === 'RECOVERY_UNAVAILABLE');
  assert.equal(controller.ready, false);
  assert.equal(controller.status().recoveryAvailable, false);
  assert.throws(() => controller.start(async () => assert.fail('pump must remain gated')), error => error.message === 'RECOVERY_NOT_READY');
  await controller.close();
});

test('ambiguous append retries identical event and acknowledges only the fresh claim token', async () => {
  let claimCount = 0;
  const helper = helperPort((method, params) => {
    if (method === 'recovery.run') return zero;
    if (method === 'history.claim') { claimCount += 1; return claimCount === 1 ? claim(ids.token1) : claimCount === 2 ? claim(ids.token2) : null; }
    if (method === 'history.fail') return { failed: true };
    if (method === 'history.ack') return { acknowledged: true };
    assert.fail(`unexpected helper method ${method}`);
  });
  const appended = [];
  let appendCount = 0;
  const controller = createRecoveryController({ helper, history: { append: async fact => {
    appended.push(fact);
    appendCount += 1;
    if (appendCount === 1) throw Object.assign(new Error('hidden transport detail'), { code: 'DATABASE_UNAVAILABLE' });
  } }, clearVolatileResults: () => {}, config: config({ historyPollIntervalMs: 2, historyMaxDeliveries: 2 }) });
  await controller.initialize();
  controller.start(async () => false);
  try {
    await until(() => helper.calls.some(call => call.method === 'history.ack'));
    assert.equal(appendCount, 2);
    assert.deepEqual(appended, [event, event]);
    assert.ok(helper.calls.some(call => call.method === 'history.fail' && call.params.errorCode === 'HISTORY_DELIVERY_FAILED'));
    assert.deepEqual(helper.calls.filter(call => call.method === 'history.ack').map(call => call.params.claimToken), [ids.token2]);
    assert.equal(controller.status().historyAvailable, true);
  } finally { await controller.close(); }
});

test('stale ack leaves stable event for replay under a new claim token', async () => {
  let claims = 0;
  let acks = 0;
  const helper = helperPort((method) => {
    if (method === 'recovery.run') return zero;
    if (method === 'history.claim') {
      claims += 1;
      return claims === 1 ? claim(ids.token1) : claims === 2 ? claim(ids.token2) : null;
    }
    if (method === 'history.ack') {
      acks += 1;
      if (acks === 1) throw Object.assign(new Error('stale lease'), { errorCode: 'STALE_CLAIM' });
      return { acknowledged: true };
    }
    assert.fail(`unexpected helper method ${method}`);
  });
  const appended = [];
  const controller = createRecoveryController({ helper, history: { append: async fact => { appended.push(fact); } },
    clearVolatileResults: () => {}, config: config({ historyPollIntervalMs: 2, historyMaxDeliveries: 1 }) });
  await controller.initialize();
  controller.start(async () => false);
  try {
    await until(() => acks === 2);
    assert.deepEqual(appended, [event, event]);
    assert.deepEqual(helper.calls.filter(call => call.method === 'history.ack').map(call => call.params.claimToken), [ids.token1, ids.token2]);
    assert.equal(helper.calls.some(call => call.method === 'history.fail'), false);
    await until(() => controller.status().historyAvailable);
  } finally { await controller.close(); }
});

test('history delivery work per cycle stops at the configured maximum', async () => {
  let claims = 0;
  let acks = 0;
  const helper = helperPort(method => {
    if (method === 'recovery.run') return zero;
    if (method === 'history.claim') { claims += 1; return claim(claims % 2 ? ids.token1 : ids.token2); }
    if (method === 'history.ack') { acks += 1; return { acknowledged: true }; }
    assert.fail(`unexpected helper method ${method}`);
  });
  const controller = createRecoveryController({ helper, history: { append: async () => {} }, clearVolatileResults: () => {},
    config: config({ historyMaxDeliveries: 2, historyPollIntervalMs: 10_000 }) });
  await controller.initialize();
  controller.start(async () => false);
  try {
    await until(() => acks === 2);
    assert.equal(claims, 2);
  } finally { await controller.close(); }
});

test('permanent owner rejection is recorded as HISTORY_REJECTED and keeps readiness degraded after empty claim', async () => {
  let claims = 0;
  const helper = helperPort(method => {
    if (method === 'recovery.run') return zero;
    if (method === 'history.claim') return claims++ === 0 ? claim(ids.token1) : null;
    if (method === 'history.fail') return { failed: true };
    assert.fail(`unexpected helper method ${method}`);
  });
  const controller = createRecoveryController({ helper, history: { append: async () => {
    throw Object.assign(new Error('private owner response'), { errorCode: 'EVENT_ID_CONFLICT' });
  } }, clearVolatileResults: () => {}, config: config({ historyPollIntervalMs: 2 }) });
  await controller.initialize();
  controller.start(async () => false);
  try {
    await until(() => helper.calls.some(call => call.method === 'history.fail'));
    assert.equal(helper.calls.find(call => call.method === 'history.fail').params.errorCode, 'HISTORY_REJECTED');
    await until(() => helper.calls.filter(call => call.method === 'history.claim').length >= 2);
    assert.equal(controller.status().historyAvailable, false);
    assert.equal(controller.ready, false);
  } finally { await controller.close(); }
});

test('delivery count is bounded per cycle and shutdown waits for in-flight append before ack', async () => {
  let claims = 0;
  let releaseAppend;
  let enteredAppend;
  const appendEntered = new Promise(resolve => { enteredAppend = resolve; });
  const heldAppend = new Promise(resolve => { releaseAppend = resolve; });
  const helper = helperPort(method => {
    if (method === 'recovery.run') return zero;
    if (method === 'history.claim') { claims += 1; return claims === 1 ? claim(ids.token1) : null; }
    if (method === 'history.ack') return { acknowledged: true };
    assert.fail(`unexpected helper method ${method}`);
  });
  const controller = createRecoveryController({ helper, history: { append: async () => { enteredAppend(); await heldAppend; } },
    clearVolatileResults: () => {}, config: config({ historyMaxDeliveries: 1 }) });
  await controller.initialize();
  controller.start(async () => false);
  await appendEntered;
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  await delay(5);
  assert.equal(closed, false);
  releaseAppend();
  await closing;
  assert.equal(closed, true);
  assert.equal(claims, 1);
  assert.equal(helper.calls.filter(call => call.method === 'history.ack').length, 1);
});

test('invalid helper recovery response cannot enable readiness', async () => {
  const helper = helperPort(() => ({ ...zero, text: 'private transcript' }));
  const controller = createRecoveryController({ helper, history: { append: async () => {} },
    clearVolatileResults: () => {}, config: config() });
  await assert.rejects(controller.initialize(), error => error.message === 'RECOVERY_UNAVAILABLE');
  assert.equal(controller.ready, false);
  await controller.close();
});


test('an empty claim does not close a history outage; only successful append recovers silently', async () => {
  let claims=0, allowNext=false, appends=0;
  const observations=[];
  const helper=helperPort(method=>{
    if(method==='recovery.run')return zero;
    if(method==='health')return {available:true,storageAvailable:true,historyRejected:false};
    if(method==='history.claim'){
      claims++;
      if(claims===1)return claim(ids.token1);
      if(allowNext){allowNext=false;return claim(ids.token2);}
      return null;
    }
    if(method==='history.fail')return {failed:true};
    if(method==='history.ack')return {acknowledged:true};
    assert.fail(method);
  });
  const controller=createRecoveryController({helper,history:{append:async()=>{
    if(++appends===1)throw new Error('synthetic outage');
  }},observe:(key,available)=>{if(key==='history')observations.push(available);},
    clearVolatileResults:()=>{},config:config({historyPollIntervalMs:2})});
  await controller.initialize();controller.start(async()=>false);
  try{
    await until(()=>claims>=4);
    assert.ok(observations.length>0&&observations.every(value=>value===false));
    assert.equal(controller.status().historyAvailable,false);
    allowNext=true;await until(()=>observations.includes(true));
    assert.equal(appends,2);assert.equal(controller.status().historyAvailable,true);
  }finally{await controller.close();}
});
