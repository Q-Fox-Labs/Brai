// ABOUTME: Проверяет каталог, closed настройки и native mapping без соединения или inference.
// ABOUTME: Доказывает default auto_review, validation до эффекта и неизменность steer.
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import schema from '../contracts/codex/schema.json' with { type: 'json' };
import { validateCommand, commandSchema } from '../contracts/index.mjs';
import { createApplication } from '../dist/application.js';
const choices = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(model => ({ model, displayName: model, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }));
function fixture() {
  const calls = []; let generation = 'g1', observer, index = 0, operation = 0;
  const port = { status: () => ({ generation, connection: 'connected', authorization: 'ready' }), subscribe: fn => { observer = fn; return () => {}; }, call: async (method, params) => {
    if (method === 'account/rateLimits/read') return { rateLimits: null };
    calls.push({ method, params });
    if (method === 'model/list') return { data: [...choices, { ...choices[0], model: 'unconfigured' }] };
    if (method === 'thread/start') return { thread: { id: `t${++index}`, model: params.model ?? choices[0].model, status: { type: 'idle' }, updatedAt: 1 }, model: params.model ?? choices[0].model };
    if (method === 'turn/start') return { turn: { id: 'turn1', status: 'inProgress' } };
    if (method === 'turn/steer') return { turnId: 'turn1' };
    throw new Error(`Unexpected ${method}`);
  } };
  const app = createApplication(port, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }], allowedModels: choices.map(value => value.model), newThread: { model: choices[0].model, approvalsReviewer: 'user' } }, () => {});
  const command = (action, extra = {}) => ({ action, generation, operationId: `${action}-${++operation}`, projectId: 'p', ...(action !== 'create' ? { threadId: 't1', text: 'hello' } : {}), ...extra });
  return { app, calls, command, changeGeneration: () => { generation = 'g2'; observer({ type: 'connection' }); } };
}
const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(schema, 'schema.json');
const native = type => ajv.compile({ $ref: `schema.json#/definitions/${type}` });
test('native catalogue is filtered, shared and reset per generation without inference', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.app.request({ action: 'models' }), f.app.request({ action: 'models' })]);
  assert.deepEqual(a, b); assert.equal(a.defaultModel, 'gpt-6.1-sol'); assert.equal(a.data.length, 3);
  assert.deepEqual(a.data[0].efforts, ['low', 'high']); assert.equal(f.calls.length, 1);
  assert.ok(native('ModelListParams')(f.calls[0].params));
  f.changeGeneration(); assert.equal((await f.app.request({ action: 'models' })).generation, 'g2'); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.method === 'model/list'));
});
test('default auto_review and explicit modes use exact native schemas and roots', async () => {
  for (const mode of [undefined, 'auto', 'ask', 'full']) {
    const f = fixture(), extra = mode ? { permissionMode: mode } : {};
    await f.app.request(f.command('create', extra));
    const created = f.calls.find(value => value.method === 'thread/start').params;
    assert.ok(native('ThreadStartParams')(created)); assert.equal(created.approvalsReviewer, mode === 'ask' || mode === 'full' ? 'user' : 'auto_review');
    assert.equal(created.sandbox, mode === 'full' ? 'danger-full-access' : 'workspace-write');
    await f.app.request(f.command('start', { model: 'gpt-6-luna', effort: 'high', ...extra }));
    const started = f.calls.find(value => value.method === 'turn/start').params;
    assert.ok(native('TurnStartParams')(started)); assert.equal(started.model, 'gpt-6-luna'); assert.equal(started.effort, 'high');
    assert.equal(started.approvalPolicy, mode === 'full' ? 'never' : 'on-request');
    assert.deepEqual(started.sandboxPolicy, mode === 'full' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: ['/tmp/p'], networkAccess: false });
    await f.app.request(f.command('steer', { expectedTurnId: 'turn1' }));
    assert.deepEqual(f.calls.at(-1), { method: 'turn/steer', params: { threadId: 't1', input: [{ type: 'text', text: 'hello' }], expectedTurnId: 'turn1' } });
  }
});
test('invalid choices and arbitrary permissions never reach native mutation', async () => {
  const f = fixture(); await f.app.request(f.command('create'));
  for (const extra of [{ model: 'unconfigured' }, { effort: 'unannounced' }, { permissionMode: 'bad' }, { sandboxPolicy: { type: 'dangerFullAccess' } }]) {
    const before = f.calls.filter(value => value.method === 'turn/start').length;
    await assert.rejects(f.app.request(f.command('start', extra)), error => ['UNSUPPORTED', 'INVALID_ARGUMENT'].includes(error.code));
    assert.equal(f.calls.filter(value => value.method === 'turn/start').length, before);
  }
  const results = await Promise.allSettled(['one', 'two'].map(operationId => f.app.request(f.command('start', { operationId, model: 'gpt-6.1-sol' }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.calls.filter(value => value.method === 'turn/start').length, 1);
});
test('owner validator and JSON schema agree for closed permission choices', () => {
  const validate = ajv.compile(commandSchema);
  const base = { action: 'start', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', text: 'hi' };
  for (const permissionMode of ['auto', 'ask', 'full', 'other', 1]) assert.equal(validateCommand({ ...base, permissionMode }), validate({ ...base, permissionMode }));
  assert.equal(validateCommand({ ...base, action: 'steer', expectedTurnId: 'turn1', permissionMode: 'full' }), false);
});
