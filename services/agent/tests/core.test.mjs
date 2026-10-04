// ABOUTME: Проверяет эффекты, конфликты, формы и admission без живого Codex.
// ABOUTME: Использует явный fake port; ни один тест не открывает соединение.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../dist/application.js';
import { createCodex } from '../dist/codex.js';
import { EventSchema } from '@ag-ui/core/schemas';
import { validateEnvelope } from '../contracts/index.mjs';
function fixture() {
  let observer, generation = 'g1', creates = 0, starts = 0, answers = 0;
  const settings = { rejectStart: false, rejectAnswer: false };
  const thread = id => ({ id, name: id, preview: '', model: 'gpt-6-luna', canAcceptDirectInput: true, updatedAt: 1, cwd: '/tmp/demo', status: { type: 'idle' } });
  const port = {
    status: () => ({ generation, connection: 'connected', authorization: 'ready' }),
    subscribe: listener => { observer = listener; return () => {}; },
    validateAnswer: (_id, answer) => ['accept', 'decline'].includes(answer?.decision) || Object.values(answer?.answers ?? {}).length > 0 && Object.values(answer.answers).every(value => Array.isArray(value.answers)),
    respond: async () => { if (settings.rejectAnswer) throw Object.assign(new Error('not-sent'), { outcome: 'not-sent' }); answers++; },
    call: async (method, params) => {
      if (method === 'thread/start') return { thread: thread('t' + (++creates)), model: 'gpt-6-luna' };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      if (method === 'turn/start') {
        starts++;
        if (settings.rejectStart) throw Object.assign(new Error('not-sent'), { outcome: 'not-sent' });
        observer({ type: 'notification', method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn1', status: 'inProgress' } } });
        return { turn: { id: 'turn1', status: 'inProgress' } };
      }
      throw new Error('Unexpected fake method');
    },
  };
  const app = createApplication(port, { projects: [{ projectId: 'demo', name: 'Demo', cwd: '/tmp/demo' }], allowedModels: ['gpt-6-luna'] }, envelope => {
    assert.ok(validateEnvelope(envelope));
    assert.ok(EventSchema.safeParse(envelope.event).success);
  });
  const command = (action, extra = {}) => ({ action, projectId: 'demo', threadId: 't1', generation, operationId: action + '-1', ...extra });
  const open = () => app.request({ action: 'open', projectId: 'demo', threadId: 't1' });
  const create = operationId => app.request({ action: 'create', projectId: 'demo', generation, operationId });
  return { app, command, open, create, settings, observe: event => observer(event), counts: () => ({ creates, starts, answers }), changeGeneration: () => { generation = 'g2'; observer({ type: 'connection', status: port.status() }); } };
}
test('one operation has one effect; busy/stale/different-body commands are rejected', async () => {
  const f = fixture();
  await Promise.all([f.create('create1'), f.create('create1')]);
  assert.equal(f.counts().creates, 1);
  const start = f.command('start', { text: 'hello' });
  await Promise.all([f.app.request(start), f.app.request({ ...start })]);
  assert.equal(f.counts().starts, 1);
  await assert.rejects(f.app.request({ ...start, text: 'different' }), error => error.code === 'OPERATION_CONFLICT');
  await assert.rejects(f.app.request({ ...start, operationId: 'start2' }), error => error.code === 'OPERATION_CONFLICT');
  await assert.rejects(f.app.request(f.command('steer', { expectedTurnId: 'old', text: 'more' })), error => error.code === 'OPERATION_CONFLICT');
  f.changeGeneration();
  await assert.rejects(f.app.request({ ...start, operationId: 'stale' }), error => error.code === 'STALE_GENERATION');
});
test('not-sent start releases the local reservation', async () => {
  const f = fixture();
  await f.create('create1');
  f.settings.rejectStart = true;
  await assert.rejects(f.app.request(f.command('start', { text: 'hello' })));
  assert.equal((await f.open()).turn, null);
  f.settings.rejectStart = false;
  await f.app.request(f.command('start', { operationId: 'start2', text: 'hello' }));
  assert.equal((await f.open()).turn.id, 'turn1');
});
test('native schema rejection never claims; not-sent releases; accepted answer wins', async () => {
  const f = fixture();
  await f.create('create1');
  f.observe({ type: 'request', method: 'item/commandExecution/requestApproval', id: 1, supported: true, params: { threadId: 't1', turnId: 'turn1' } });
  const answer = f.command('answer', { requestId: 'number:1', answer: { decision: 'bad' } });
  await assert.rejects(f.app.request(answer), error => error.code === 'INVALID_ARGUMENT');
  assert.equal((await f.open()).requests[0].answered, false);
  f.settings.rejectAnswer = true;
  await assert.rejects(f.app.request({ ...answer, operationId: 'answer2', answer: { decision: 'decline' } }));
  assert.equal((await f.open()).requests[0].answered, false);
  f.settings.rejectAnswer = false;
  const results = await Promise.allSettled(['answer3', 'answer4'].map(operationId => f.app.request({ ...answer, operationId, answer: { decision: 'decline' } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.counts().answers, 1);
});
test('question without Other rejects unoffered values', async () => {
  const f = fixture();
  await f.create('create1');
  f.observe({ type: 'request', method: 'item/tool/requestUserInput', id: 2, supported: true, params: { threadId: 't1', turnId: 'turn1', questions: [{ id: 'q', options: [{ label: 'Yes' }], isOther: false }] } });
  const answer = f.command('answer', { requestId: 'number:2', answer: { answers: { q: { answers: ['Injected'] } } } });
  await assert.rejects(f.app.request(answer), error => error.code === 'INVALID_ARGUMENT');
  assert.equal((await f.open()).requests[0].answered, false);
  assert.equal((await f.open()).thread.awaitingReply, true);
  await f.app.request({ ...answer, operationId: 'answer2', answer: { answers: { q: { answers: ['Yes'] } } } });
  assert.equal((await f.open()).thread.awaitingReply, false);
});
test('sixteen concurrent admissions fit; seventeenth has no native effect', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 16 }, (_, i) => f.create('create' + i)));
  assert.equal(f.counts().creates, 16);
  assert.equal((await f.open()).threadId, 't1');
  await assert.rejects(f.create('overcap'), error => error.code === 'CAPACITY_EXHAUSTED');
  assert.equal(f.counts().creates, 16);
});
test('connection loss rotates generation; module imports have no side effects', async () => {
  const codex = createCodex({ socketUrl: 'ws+unix:/tmp/unused.sock:/' });
  const generation = codex.status().generation;
  codex.invalidate();
  assert.notEqual(codex.status().generation, generation);
  await codex.close();
  await import('../dist/main.js');
  await import('../dist/health.js');
});

test('four other active threads do not block starting an idle native chat', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (let i = 1; i <= 5; i++) {
    await f.create('parallel-create-' + i);
    const reply = await f.app.request(f.command('start', { threadId: 't' + i, operationId: 'parallel-start-' + i, text: 'task' }));
    assert.equal(reply.outcome, 'accepted');
  }
  assert.equal(f.counts().starts, 5);
});
