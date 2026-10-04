// ABOUTME: Проверяет native архивирование, изоляцию проектов и повтор команды.
// ABOUTME: Подставляет Codex port без сети и сверяет публичный машинный контракт.
import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { createApplication } from '../dist/application.js';
import { validateCommand } from '../contracts/index.mjs';
import schema from '../schemas/messages.schema.json' with { type: 'json' };
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
const command = { action: 'archive', projectId: 'p', threadId: 't', generation: 'g', operationId: 'archive-1' };
function fixture({ cwd = '/tmp/p', error } = {}) {
  const calls = [];
  const app = createApplication({
    status: () => ({ generation: 'g', connection: 'connected', authorization: 'ready' }),
    subscribe: () => () => {},
    call: async (method, params, options) => {
      if (method === "account/rateLimits/read") return {};
      calls.push({ method, params, options });
      if (method === "thread/start") return { thread: { id: "t", cwd: "/tmp/p", name: "Fresh", preview: "", updatedAt: 1 }, model: null };
      if (method === 'thread/read') return { thread: { id: 't', cwd } };
      if (method === 'thread/archive') { if (error) throw error; return {}; }
      throw new Error(method);
    },
  }, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }] }, () => {});
  return { app, calls };
}
test('archive validates the closed command and calls native once without resume', async t => {
  const validate = new Ajv({ strict: false }).compile(schema.definitions.Command);
  for (const value of [command, { ...command, turnId: 'extra' }, { ...command, generation: undefined }]) assert.equal(validate(value), validateCommand(value));
  assert.equal(validateCommand(command), true);
  const f = fixture(); t.after(() => f.app.close());
  const [first, repeated] = await Promise.all([f.app.request(command), f.app.request({ ...command })]);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first, { generation: 'g', operationId: 'archive-1', outcome: 'accepted', threadId: 't' });
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/archive']);
  const ajv = new Ajv({ strict: false, validateFormats: false }); ajv.addSchema(nativeSchema, 'native');
  assert.equal(ajv.compile({ $ref: 'native#/definitions/ThreadArchiveParams' })(f.calls[1].params), true);
  assert.deepEqual(f.calls[1], { method: 'thread/archive', params: { threadId: 't' }, options: { mutation: true } });
});
test('archive rejects another project and stale generation before mutation', async t => {
  const f = fixture({ cwd: '/tmp/other' }); t.after(() => f.app.close());
  await assert.rejects(f.app.request(command), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.app.request({ ...command, generation: 'old' }), e => e.code === 'STALE_GENERATION');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read']);
});
test('unknown native outcome is preserved and repeated operation never sends again', async t => {
  const error = Object.assign(new Error('native failure'), { outcome: 'unknown' });
  const f = fixture({ error }); t.after(() => f.app.close());
  await assert.rejects(f.app.request(command), e => e === error);
  await assert.rejects(f.app.request(command), e => e === error);
  assert.equal(f.calls.filter(c => c.method === 'thread/archive').length, 1);
});

test('fresh chat archives without native read before its first turn', async t => {
  const f = fixture(); t.after(() => f.app.close());
  await f.app.request({ action: 'create', projectId: 'p', generation: 'g', operationId: 'create-1' });
  await f.app.request(command);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/start', 'thread/archive']);
});
