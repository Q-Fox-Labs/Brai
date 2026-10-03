// ABOUTME: Проверяет восстановление при опережающих native запросах и сообщениях.
// ABOUTME: Fake port проверяет ядро; модель, NATS и сервер не запускаются.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../dist/application.js';
function fixture(event) {
  let observe;
  const thread = { id: 't', name: 'Test', cwd: '/tmp/recovery', model: 'gpt-6-luna', preview: '', updatedAt: 1, canAcceptDirectInput: true, status: { type: 'active', activeFlags: [] } };
  const older = { id: 'before', type: 'agentMessage', text: 'Before', phase: 'commentary' };
  const port = {
    status: () => ({ generation: 'g', connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { observe = fn; return () => {}; },
    call: async method => {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/resume') { observe(event); return { thread, model: 'gpt-6-luna' }; }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'inProgress' }] };
      if (method === 'thread/items/list') return { data: [{ turnId: 'turn', item: older }] };
      throw new Error('Unexpected call ' + method);
    },
  };
  return createApplication(port, { projects: [{ projectId: 'test', name: 'Test', cwd: thread.cwd }] }, () => {});
}
test('request replay before hydration retains active turn and waiting state', async () => {
  const app = fixture({ type: 'request', method: 'item/tool/requestUserInput', id: 7, supported: true, params: { threadId: 't', turnId: 'turn', questions: [{ id: 'q', question: 'Choose' }] } });
  try {
    const view = await app.request({ action: 'open', projectId: 'test', threadId: 't' });
    assert.equal(view.requests.length, 1);
    assert.deepEqual(view.turn, { id: 'turn', status: 'inProgress' });
    assert.equal(view.state, 'waiting');
  } finally { app.close(); }
});
test('replayed current message remains after older hydrated items', async () => {
  const app = fixture({ type: 'notification', method: 'item/started', params: { threadId: 't', turnId: 'turn', item: { id: 'after', type: 'agentMessage', text: 'After', phase: 'commentary' } } });
  try {
    const view = await app.request({ action: 'open', projectId: 'test', threadId: 't' });
    assert.deepEqual(view.items.map(i => i.id), ['before', 'after']);
    assert.deepEqual(view.turn, { id: 'turn', status: 'inProgress' });
  } finally { app.close(); }
});

test('a terminal notification during hydration wins over an older turns reply', async () => {
  const app = fixture({ type: 'notification', method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
  try {
    const view = await app.request({ action: 'open', projectId: 'test', threadId: 't' });
    assert.deepEqual(view.turn, { id: 'turn', status: 'completed' });
    assert.equal(view.state, 'completed');
  } finally { app.close(); }
});
