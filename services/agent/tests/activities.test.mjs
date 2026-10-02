// ABOUTME: Проверяет двухуровневое чтение действий и время сообщений.
// ABOUTME: Подставляет native порт, чтобы воспроизвести гонки и страницы без сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../dist/application.js';
import { validateCommand } from '../contracts/index.mjs';
import Ajv from 'ajv';
import schema from '../schemas/messages.schema.json' with { type: 'json' };
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
import { summary } from '../dist/display.js';
function fixture() {
  let observer, generation = 'g1';
  const settings = { beforeCall: null };
  const calls = [], events = [], entries = [
    { turnId: 'turn', startedAtMs: 1000, item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] } },
    { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'run command', aggregatedOutput: 'large output', status: 'completed', exitCode: 0 } },
    { turnId: 'turn', startedAtMs: 2000, item: { id: 'agent', type: 'agentMessage', text: 'answer' } },
  ];
  const thread = (id = 't') => ({ id, name: id, preview: '', updatedAt: 99, cwd: '/demo', status: { type: 'idle' } });
  const port = {
    status: () => ({ generation, connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { observer = fn; return () => {}; },
    call: async (method, params) => {
      calls.push({ method, params });
      settings.beforeCall?.(method, params);
      if (method === 'thread/read' || method === 'thread/resume') return { thread: thread(), model: 'm' };
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] };
      if (method === 'thread/list') return { data: [thread('tools'), thread()], nextCursor: null };
      if (method === 'thread/items/list') {
        let data = params.threadId === 'tools' ? [{ ...entries[0], startedAtMs: 500 }, entries[1]] : entries;
        if (params.turnId) data = data.filter(e => e.turnId === params.turnId);
        if (params.cursor?.type === 'item') {
          const index = data.findIndex(e => e.item.id === params.cursor.itemId);
          data = params.sortDirection === 'desc' ? data.slice(0, index) : data.slice(index + 1);
        }
        if (params.sortDirection === 'desc') data = data.slice().reverse();
        return { data: data.slice(0, params.limit), nextCursor: null };
      }
      throw new Error(method);
    },
  };
  const app = createApplication(port, { projects: [{ projectId: 'p', name: 'P', cwd: '/demo' }] }, e => events.push(e));
  const read = (action, extra = {}) => app.request({ action, projectId: 'p', threadId: 't', ...extra });
  return { read, app, entries, calls, events, settings, observe: e => observer({ type: 'notification', ...e }), rotate: () => { generation = 'g2'; observer({ type: 'connection' }); } };
}
test('open/history/SSE hide bodies; summaries and detail require explicit reads', async () => {
  const f = fixture(), snapshot = await f.read('open');
  const hidden = snapshot.items.find(i => i.id === 'cmd');
  assert.equal(hidden.text, '');
  for (const key of ['command', 'output', 'diff', 'summary']) assert.equal(hidden[key], undefined);
  assert.equal(snapshot.thread.lastMessageAt, 2000);
  const history = await f.read('items');
  assert.equal(history.data.find(i => i.id === 'cmd').output, undefined);
  const headings = await f.read('activities', { turnId: 'turn', itemIds: ['cmd'] });
  assert.equal(headings.data[0].summary, 'run command');
  assert.equal(headings.data[0].command, undefined);
  assert.equal(headings.data[0].output, undefined);
  assert.equal((await f.read('item', { turnId: 'turn', itemId: 'cmd' })).item.output, 'large output');
  f.observe({ method: 'item/commandExecution/outputDelta', params: { threadId: 't', itemId: 'cmd', delta: ' MORE' } });
  assert.equal(f.events.at(-1).event.snapshot.items.find(i => i.id === 'cmd').output, undefined);
  assert.equal(f.events.at(-1).event.snapshot.thread.lastMessageAt, 2000);
  const updated = await f.read('item', { turnId: 'turn', itemId: 'cmd' });
  assert.equal(updated.item.output, 'large output MORE');
  assert.ok(updated.item.revision > headings.data[0].revision);
});
test('targeted native lookup handles the first item, scope and generation', async () => {
  const f = fixture();
  await f.read('open');
  // Live window eviction forces the native anchor path.
  for (let i = 0; i < 130; i++) f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'new' + i, type: 'sleep' } } });
  assert.equal((await f.read('item', { turnId: 'turn', itemId: 'user' })).item.text, 'hello');
  assert.equal((await f.read('item', { turnId: 'turn', itemId: 'cmd' })).item.output, 'large output');
  await assert.rejects(f.read('item', { turnId: 'other', itemId: 'cmd' }), e => e.code === 'NOT_FOUND');
  assert.ok(f.calls.some(c => c.params.cursor?.type === 'item'));
});
test('message timestamps stay fixed across delta; activity follows turn lifecycle', async () => {
  const f = fixture(); await f.read('open');
  f.observe({ method: 'turn/started', params: { threadId: 't', turn: { id: 'live', status: 'inProgress' } } });
  assert.equal(f.events.at(-1).event.snapshot.thread.active, true);
  f.observe({ method: 'item/started', params: { threadId: 't', turnId: 'live', item: { id: 'live-message', type: 'agentMessage', text: '' } } });
  const at = f.events.at(-1).event.snapshot.thread.lastMessageAt;
  f.observe({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'live-message', delta: 'hello' } });
  assert.equal(f.events.at(-1).event.snapshot.thread.lastMessageAt, at);
  f.observe({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'live', status: 'completed' } } });
  assert.equal(f.events.at(-1).event.snapshot.thread.active, false);
});
test('thread order uses messages despite later tool updates; command bounds are closed', async () => {
  const f = fixture(), page = await f.app.request({ action: 'threads', projectId: 'p' });
  assert.deepEqual(page.data.map(t => t.id), ['t', 'tools']);
  assert.deepEqual(page.data.map(t => t.lastMessageAt), [2000, 500]);
  const command = { action: 'activities', projectId: 'p', threadId: 't', turnId: 'turn', itemIds: ['cmd'] };
  assert.equal(validateCommand(command), true);
  for (const ids of [[], ['x', 'x'], Array.from({ length: 101 }, (_, i) => '' + i), [42]]) assert.equal(validateCommand({ ...command, itemIds: ids }), false);
  assert.ok(Buffer.byteLength(summary({ id: 'x', turnId: 't', type: 'commandExecution', text: '', command: 'ж'.repeat(400) }).summary) <= 256);
});

test('late historical response is rejected after generation rotation', async () => {
  const f = fixture(); await f.read('open');
  for (let i = 0; i < 130; i++) f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'new' + i, type: 'sleep' } } });
  f.settings.beforeCall = (method, params) => { if (params.cursor?.type === 'item') { f.settings.beforeCall = null; f.rotate(); } };
  await assert.rejects(f.read('item', { turnId: 'turn', itemId: 'cmd' }), e => e.code === 'STALE_GENERATION' && e.outcome === 'query');
});
test('older message fallback does not override latest native message timestamp', async () => {
  const f = fixture(); delete f.entries[0].startedAtMs;
  assert.equal((await f.read('open')).thread.lastMessageAt, 2000);
});
test('public response schemas and native anchor parameters match runtime', async () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  ajv.addSchema(nativeSchema, 'https://brai.local/contracts/codex/schema.json');
  ajv.addSchema(schema, 'https://brai.local/schemas/messages.schema.json');
  const response = ajv.compile({ $ref: 'https://brai.local/schemas/messages.schema.json#/definitions/Response' });
  const f = fixture();
  for (const [action, extra] of [['open', {}], ['items', {}], ['activities', { turnId: 'turn', itemIds: ['cmd'] }], ['item', { turnId: 'turn', itemId: 'cmd' }]]) {
    const value = await f.read(action, extra);
    assert.ok(response(value), JSON.stringify(response.errors));
  }
  for (let i = 0; i < 130; i++) f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'new' + i, type: 'sleep' } } });
  await f.read('item', { turnId: 'turn', itemId: 'cmd' });
  const validateNative = ajv.compile({ $ref: 'https://brai.local/contracts/codex/schema.json#/definitions/ThreadItemsListParams' });
  for (const call of f.calls.filter(c => c.method === 'thread/items/list')) assert.ok(validateNative(call.params), JSON.stringify(validateNative.errors));
});

test('history projects hidden actions without reading their large bodies', async () => {
  const f = fixture(); await f.read('open');
  const command = f.entries.find(e => e.item.id === 'cmd').item;
  for (const key of ['command', 'aggregatedOutput', 'changes', 'text']) Object.defineProperty(command, key, { get() { throw new Error('hidden body accessed: ' + key); }, configurable: true });
  const page = await f.read('items');
  assert.deepEqual(page.data.find(i => i.id === 'cmd'), { id: 'cmd', turnId: 'turn', type: 'commandExecution', text: '', revision: 0, status: 'completed', exitCode: 0 });
});
