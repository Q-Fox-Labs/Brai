// ABOUTME: Проверяет native режимы, материалы и многоэтапные мутации целей.
// ABOUTME: Использует управляемый порт; сетевые прогоны фиксируются отдельно в контракте.
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { createApplication } from '../dist/application.js';
import { compact, display } from '../dist/display.js';
import { commandSchema, validateCommand, bytes, limits } from '../contracts/index.mjs';
import schema from '../schemas/messages.schema.json' with { type: 'json' };
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(schema, 'public'); ajv.addSchema(nativeSchema, 'native');
const native = name => ajv.compile({ $ref: `native#/definitions/${name}` });
const goalValue = status => ({ threadId: 't', objective: 'A goal', status, timeUsedSeconds: 10, tokensUsed: 20, tokenBudget: 1000, createdAt: 1, updatedAt: 2 });
function fixture({ initialGoal = null, model = 'gpt-6.1-sol', entries = [] } = {}) {
  let observer, generation = 'g', operation = 0, turn = null, savedGoal = initialGoal, hook;
  const calls = [], snapshots = [];
  const thread = () => ({ id: 't', name: 'Named', preview: '', model, canAcceptDirectInput: true, cwd: '/tmp/modes', updatedAt: 1, status: { type: turn?.status === 'inProgress' ? 'active' : 'idle' } });
  const observe = (method, params) => observer({ type: 'notification', method, params: { threadId: 't', ...params } });
  const port = {
    status: () => ({ generation, connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { observer = fn; return () => {}; },
    call: async (method, params) => {
      if (method === 'account/rateLimits/read') return { rateLimits: null };
      calls.push({ method, params }); await hook?.(method, params);
      if (method === 'model/list') return { data: [{ model: 'gpt-6.1-sol', displayName: 'Sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
      if (method === 'thread/start') return { thread: thread(), model };
      if (method === 'thread/read' || method === 'thread/resume') return { thread: thread(), model, reasoningEffort: 'low' };
      if (method === 'thread/turns/list') return { data: turn ? [turn] : [] };
      if (method === 'thread/items/list') return { data: entries.slice().reverse(), nextCursor: null };
      if (method === 'thread/goal/get') return { goal: savedGoal };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/set') {
        const old = savedGoal;
        savedGoal = { ...(old ?? goalValue('active')), ...(params.objective ? { objective: params.objective } : {}), ...(params.status ? { status: params.status } : {}), ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : old ? {} : { tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 }) };
        observe('thread/goal/updated', { goal: savedGoal });
        if (savedGoal.status === 'active' && turn?.status !== 'inProgress') { turn = { id: 'automatic', status: 'inProgress' }; observe('turn/started', { turn }); }
        return { goal: savedGoal };
      }
      if (method === 'thread/goal/clear') { savedGoal = null; observe('thread/goal/cleared', {}); return { cleared: true }; }
      if (method === 'turn/start') { turn = { id: `turn${calls.length}`, status: 'inProgress' }; observe('turn/started', { turn }); return { turn }; }
      if (method === 'turn/interrupt') { turn = { ...turn, status: 'interrupted' }; observe('turn/completed', { turn }); return {}; }
      throw new Error(method);
    },
  };
  const app = createApplication(port, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/modes' }], allowedModels: ['gpt-6.1-sol'] }, envelope => { assert.ok(ajv.compile({ $ref: 'public#/definitions/EventEnvelope' })(envelope)); snapshots.push(envelope.event.snapshot); });
  const command = (action, extra = {}) => ({ action, projectId: 'p', threadId: 't', generation, operationId: `o${++operation}`, ...extra });
  const open = () => app.request({ action: 'open', projectId: 'p', threadId: 't' });
  return { app, calls, snapshots, command, open, observe, setHook: fn => { hook = fn; }, complete: () => { turn = { ...turn, status: 'completed' }; observe('turn/completed', { turn }); }, rotate: () => { generation = 'g2'; observer({ type: 'connection' }); } };
}

test('closed mode and goal DTO validators agree and reject invalid values without throwing', () => {
  const base = { action: 'start', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', text: 'hello' };
  const validate = ajv.compile(commandSchema);
  const cases = [base, ...['default', 'plan', 'goal', 'bad'].map(agentMode => ({ ...base, agentMode })), { ...base, agentMode: 'goal', tokenBudget: 1000 }, { ...base, tokenBudget: 1000 }, { ...base, agentMode: 'goal', tokenBudget: null }, { ...base, agentMode: 'goal', images: ['data:image/png;base64,YQ=='] }];
  for (const objective of ['Goal', '  ', 123, null, {}, []]) cases.push({ ...base, action: 'goalSet', text: undefined, objective });
  for (const status of ['active', 'paused', 'complete', 'blocked', null, 1]) cases.push({ action: 'goalSet', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', status });
  for (const tokenBudget of [null, 1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000']) cases.push({ action: 'goalSet', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', tokenBudget });
  for (const value of cases) { const clean = Object.fromEntries(Object.entries(value).filter(([_k, v]) => v !== undefined)); assert.equal(validateCommand(clean), validate(clean), JSON.stringify(clean)); }
});

test('default -> plan -> default sends explicit native mode with model/effort in settings', async t => {
  const f = fixture(); t.after(() => f.app.close());
  await f.open();
  for (const agentMode of [undefined, 'plan', 'default']) {
    await f.app.request(f.command('start', { text: 'hello', model: 'gpt-6.1-sol', effort: 'high', ...(agentMode ? { agentMode } : {}) }));
    const params = f.calls.filter(c => c.method === 'turn/start').at(-1).params;
    assert.ok(native('TurnStartParams')(params));
    assert.deepEqual(params.collaborationMode, { mode: agentMode === 'plan' ? 'plan' : 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null } });
    f.complete();
  }
});

test('proposed plan streams independently; completed native content replaces deltas and restores', async t => {
  const plan = 'План\n' + 'подробность\n'.repeat(1000);
  const entry = { turnId: 'done', completedAtMs: 100, item: { id: 'historical', type: 'plan', text: plan } };
  const f = fixture({ entries: [entry] }); t.after(() => f.app.close());
  const initial = await f.open();
  assert.equal(initial.items[0].text, plan); assert.equal(initial.items[0].status, 'completed'); assert.equal(initial.planProgress.state, 'unavailable');
  const history = await f.app.request({ action: 'items', projectId: 'p', threadId: 't' }); assert.equal(history.data[0].text, plan); assert.equal(history.data[0].truncated, false);
  f.observe('item/started', { turnId: 'live', item: { id: 'proposal', type: 'plan', text: 'Draft' } });
  f.observe('item/plan/delta', { turnId: 'live', itemId: 'proposal', delta: ' continued' });
  assert.equal(f.snapshots.at(-1).items.at(-1).text, 'Draft continued'); assert.equal(f.snapshots.at(-1).items.at(-1).status, 'inProgress');
  f.observe('turn/plan/updated', { turnId: 'live', explanation: 'Now execute', plan: [{ step: 'First', status: 'inProgress' }, { step: 'Second', status: 'pending' }] });
  assert.equal(f.snapshots.at(-1).items.filter(i => i.type === 'plan').length, 2);
  assert.deepEqual(f.snapshots.at(-1).planProgress.steps.map(step => step.status), ['inProgress', 'pending']);
  f.observe('item/completed', { turnId: 'live', item: { id: 'proposal', type: 'plan', text: 'Final authoritative plan' } });
  assert.equal(f.snapshots.at(-1).items.at(-1).text, 'Final authoritative plan'); assert.equal(f.snapshots.at(-1).items.at(-1).status, 'completed');
  f.rotate(); assert.equal(f.snapshots.at(-1).planProgress.state, 'stale'); await f.open(); assert.equal(f.snapshots.at(-1).planProgress.state, 'stale');
  const oversized = compact(display({ id: 'large', type: 'plan', text: 'ж'.repeat(40000) }, 't', true)); assert.equal(oversized.truncated, true); assert.ok(bytes(oversized) < 49152);
});

test('goal-mode configures default settings and uses native auto-start once; new goal resets old budget', async t => {
  const f = fixture({ initialGoal: goalValue('complete') }); t.after(() => f.app.close()); await f.open();
  const command = f.command('start', { agentMode: 'goal', text: 'New objective', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'ask' });
  const [a, b] = await Promise.all([f.app.request(command), f.app.request(command)]); assert.deepEqual(a, b);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  const methods = f.calls.slice(f.calls.findIndex(c => c.method === 'thread/goal/clear')).map(c => c.method); assert.deepEqual(methods, ['thread/goal/clear', 'thread/settings/update', 'thread/goal/set']);
  const settings = f.calls.find(c => c.method === 'thread/settings/update').params; assert.ok(native('ThreadSettingsUpdateParams')(settings)); assert.equal(settings.collaborationMode.mode, 'default'); assert.equal(settings.approvalsReviewer, 'user'); assert.equal(settings.collaborationMode.settings.reasoning_effort, 'high');
  assert.equal(a.goal.value.tokenBudget, null); assert.equal(a.goal.value.tokensUsed, 0); assert.equal(a.goal.value.timeUsedSeconds, 0);
  assert.equal((await f.open()).turn.id, 'automatic');
});

test('pause/clear stop confirmed active turn; resume preserves counters and restores default mode', async t => {
  const f = fixture({ initialGoal: goalValue('paused') }); t.after(() => f.app.close()); await f.open();
  await f.app.request(f.command('goalSet', { status: 'active' }));
  assert.equal(f.calls.filter(c => c.method === 'thread/settings/update').length, 1);
  const paused = await f.app.request(f.command('goalSet', { status: 'paused' })); assert.equal(paused.goal.value.status, 'paused'); assert.equal((await f.open()).turn.status, 'interrupted');
  assert.equal(paused.goal.value.tokensUsed, 20); assert.equal(paused.goal.value.tokenBudget, 1000);
  await f.app.request(f.command('goalSet', { status: 'active' }));
  const cleared = await f.app.request(f.command('goalClear')); assert.equal(cleared.goal.value, null); assert.equal((await f.open()).turn.status, 'interrupted');
  assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').length, 2);
});

test('all native goal statuses restore; notification wins over a concurrent stale get response', async t => {
  for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
    const f = fixture({ initialGoal: goalValue(status) }); t.after(() => f.app.close());
    assert.equal((await f.open()).goal.value.status, status);
    f.setHook(method => { if (method === 'thread/goal/get') f.observe('thread/goal/updated', { goal: { ...goalValue('complete'), updatedAt: 9 } }); });
    const read = await f.app.request({ action: 'goalGet', projectId: 'p', threadId: 't' }); assert.equal(read.goal.value.status, 'complete'); assert.equal(read.goal.value.updatedAt, 9);
    f.rotate(); assert.equal(f.snapshots.at(-1).goal.state, 'stale');
    await assert.rejects(f.app.request({ ...f.command('goalClear'), generation: 'g' }), e => e.code === 'STALE_GENERATION' && e.outcome === 'not-sent');
  }
});

test('partial pause/clear/settings outcomes are unknown and never repeat an accepted effect', async t => {
  for (const action of ['pause', 'clear', 'start']) {
    const f = fixture({ initialGoal: goalValue(action === 'start' ? 'complete' : 'paused') }); t.after(() => f.app.close()); await f.open();
    if (action !== 'start') await f.app.request(f.command('goalSet', { status: 'active' }));
    const failing = action === 'start' ? 'thread/goal/set' : 'turn/interrupt';
    f.setHook(method => { if (method === failing) throw Object.assign(new Error('not sent'), { code: 'UPSTREAM_UNAVAILABLE', outcome: 'not-sent' }); });
    const command = action === 'start' ? f.command('start', { agentMode: 'goal', text: 'Another' }) : f.command(action === 'pause' ? 'goalSet' : 'goalClear', action === 'pause' ? { status: 'paused' } : {});
    await assert.rejects(f.app.request(command), e => e.outcome === 'unknown'); const before = f.calls.length;
    await assert.rejects(f.app.request(command), e => e.outcome === 'unknown'); assert.equal(f.calls.length, before);
    const read = await f.open(); assert.equal(read.goal.value?.status ?? null, action === 'pause' ? 'paused' : null);
  }
});

test('ordinary/plan start pauses active goal before turn and rejects a late automatic continuation', async t => {
  for (const mode of ['default', 'plan']) {
    const f = fixture({ initialGoal: goalValue('active') }); t.after(() => f.app.close()); await f.open();
    await f.app.request(f.command('start', { agentMode: mode, text: 'Explicit work' }));
    assert.equal((await f.open()).goal.value.status, 'paused');
    assert.ok(f.calls.findIndex(c => c.method === 'thread/goal/set') < f.calls.findIndex(c => c.method === 'turn/start'));
  }
  const f = fixture({ initialGoal: goalValue('active') }); t.after(() => f.app.close()); await f.open();
  f.setHook(method => { if (method === 'thread/goal/set') f.observe('turn/started', { turn: { id: 'racing', status: 'inProgress' } }); });
  await assert.rejects(f.app.request(f.command('start', { text: 'Explicit' })), e => e.code === 'OPERATION_CONFLICT' && e.outcome === 'unknown');
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('invalid goal start and unconfigured automatic model reject before substantive mutations', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const extra of [{ text: 'objective', images: ['data:image/png;base64,YQ=='] }, { text: ' ' }, { text: 'objective', tokenBudget: 0 }, { text: 'objective', tokenBudget: null }]) await assert.rejects(f.app.request(f.command('start', { agentMode: 'goal', ...extra })), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(f.calls.length, 0);
  const imported = fixture({ model: 'unconfigured', initialGoal: goalValue('paused') }); t.after(() => imported.app.close()); await imported.open();
  const before = imported.calls.length;
  for (const extra of [{ status: 'active' }, { objective: 'New active', status: 'active' }]) await assert.rejects(imported.app.request(imported.command('goalSet', extra)), e => e.code === 'UNSUPPORTED');
  assert.equal(imported.calls.length, before);
  const creation = fixture({ model: 'unconfigured' }); t.after(() => creation.app.close()); await creation.open();
  await assert.rejects(creation.app.request(creation.command('goalSet', { objective: 'New defaults active' })), e => e.code === 'UNSUPPORTED');
  assert.equal(creation.calls.some(c => c.method === 'thread/settings/update' || c.method === 'thread/goal/set'), false);
});

test('active goal between native turns protects its session from eviction', async t => {
  let observer, next = 0;
  const calls = [];
  const thread = id => ({ id, name: id, cwd: '/tmp/capacity', model: 'gpt-6.1-sol', updatedAt: 1, status: { type: 'idle' } });
  const app = createApplication({ status: () => ({ generation: 'g', connection: 'connected', authorization: 'ready' }), subscribe: fn => { observer = fn; return () => {}; }, call: async (method, params) => {
    if (method === 'account/rateLimits/read') return { rateLimits: null };
    calls.push(method);
    if (method === 'thread/start') return { thread: thread(`t${++next}`), model: 'gpt-6.1-sol' };
    if (method === 'thread/read') return { thread: thread(params.threadId) };
    throw new Error(method);
  } }, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/capacity' }] }, () => {});
  t.after(() => app.close());
  for (let i = 1; i <= limits.threads; i++) {
    await app.request({ action: 'create', projectId: 'p', generation: 'g', operationId: `c${i}` });
    observer({ type: 'notification', method: 'thread/goal/updated', params: { threadId: `t${i}`, goal: { ...goalValue('active'), threadId: `t${i}` } } });
  }
  const snapshot = await app.request({ action: 'open', projectId: 'p', threadId: 't1' });
  assert.equal(snapshot.turn, null); assert.equal(snapshot.thread.active, true);
  await assert.rejects(app.request({ action: 'open', projectId: 'p', threadId: 'another' }), e => e.code === 'CAPACITY_EXHAUSTED');
  assert.equal(calls.includes('thread/unsubscribe'), false);
});


test('new goal clears native state when its previous read is unavailable', async t => {
  const f = fixture({ initialGoal: goalValue('paused') }); t.after(() => f.app.close());
  f.setHook(method => { if (method === 'thread/goal/get') throw Object.assign(new Error('read failed'), { outcome: 'query' }); });
  assert.equal((await f.open()).goal.state, 'unavailable');
  f.setHook(null);
  const result = await f.app.request(f.command('start', { agentMode: 'goal', text: 'Fresh objective' }));
  assert.ok(f.calls.some(c => c.method === 'thread/goal/clear'));
  assert.equal(result.goal.value.tokenBudget, null); assert.equal(result.goal.value.tokensUsed, 0);
});


test('goal snapshot notification during open does not discard the native message timestamp', async t => {
  const f = fixture({ entries: [{ turnId: 'done', startedAtMs: 1234, item: { id: 'message', type: 'userMessage', content: [{ type: 'text', text: 'First message' }] } }] }); t.after(() => f.app.close());
  f.setHook(method => { if (method === 'thread/resume') f.observe('thread/goal/cleared', {}); });
  assert.equal((await f.open()).thread.lastMessageAt, 1234);
});


test('context usage projects the last request, follows compaction and clears on reconnect', async t => {
  const f = fixture(); t.after(() => f.app.close());
  assert.equal((await f.open()).contextUsage, undefined);
  const usage = (usedTokens, contextWindow = 258000) => f.observe('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: usedTokens }, total: { totalTokens: 900000 }, modelContextWindow: contextWindow } });
  usage(25000);
  assert.deepEqual(f.snapshots.at(-1).contextUsage, { usedTokens: 25000, contextWindow: 258000 });
  assert.deepEqual((await f.open()).contextUsage, { usedTokens: 25000, contextWindow: 258000 });
  usage(5000);
  assert.equal(f.snapshots.at(-1).contextUsage.usedTokens, 5000);
  usage(0, null);
  assert.deepEqual(f.snapshots.at(-1).contextUsage, { usedTokens: 0, contextWindow: null });
  usage(300000);
  assert.equal(f.snapshots.at(-1).contextUsage.usedTokens, 300000);
  usage(-1);
  assert.equal(f.snapshots.at(-1).contextUsage, null);
  usage(25000); f.rotate();
  assert.equal(f.snapshots.at(-1).contextUsage, null);
  assert.equal((await f.open()).contextUsage, null);
});
