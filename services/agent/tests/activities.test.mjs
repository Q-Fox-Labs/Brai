// ABOUTME: Проверяет двухуровневое чтение действий и время сообщений.
// ABOUTME: Подставляет native порт, чтобы воспроизвести гонки и страницы без сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../dist/application.js';
import { validateCommand } from '../contracts/index.mjs';
import Ajv from 'ajv';
import artifactSchemas from '../../artifacts/schemas/messages.schema.json' with { type: 'json' };
import schema from '../schemas/messages.schema.json' with { type: 'json' };
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
import { summary, messageAttention } from '../dist/display.js';
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
    reject: async (id, reason) => { calls.push({ method: 'reject', id, reason }); },
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
        const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
        return { data: data.slice(offset, offset + params.limit), nextCursor: offset + params.limit < data.length ? String(offset + params.limit) : null };
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
test('reasoning headings distinguish empty summaries and detail preserves public content', async () => {
  const f = fixture();
  for (const [id, content] of [['empty', []], ['spaces', ['  ', '\n\t']], ['public', ['\n  First line', 'Second line']]]) {
    f.entries.push({ turnId: 'turn', item: { id, type: 'reasoning', summary: content, content: ['private reasoning'] } });
  }
  const headers = await f.read('activities', { turnId: 'turn', itemIds: ['empty', 'spaces', 'public'] });
  assert.deepEqual(headers.data.map(item => item.summary), ['', '', 'First line']);
  assert.ok(headers.data.every(item => item.text === ''));
  for (const action of ['open', 'items']) {
    const result = await f.read(action);
    const items = result.items ?? result.data;
    assert.deepEqual(items.filter(item => item.type === 'reasoning').map(item => item.hasContent), [false, false, true]);
    assert.ok(items.filter(item => item.type === 'reasoning').every(item => item.text === ''));
    assert.ok(items.every(item => new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] }).compile({ ...schema, $ref: '#/definitions/DisplayItem' })(item)));
  }
  f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'empty', type: 'reasoning', summary: ['Now visible'] } } });
  assert.equal(f.events.at(-1).event.snapshot.items.find(item => item.id === 'empty').hasContent, true);
  const detail = await f.read('item', { turnId: 'turn', itemId: 'public' });
  assert.equal(detail.item.text, '\n  First line\nSecond line');
  assert.ok(!JSON.stringify(detail).includes('private reasoning'));
  f.app.close();
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
test('turn failures stay visible and rejected server requests never wait for a user answer', async t => {
  const f = fixture(); t.after(() => f.app.close());
  await f.read('open');
  f.observe({ type: 'request', id: 41, method: 'item/new/request', params: { threadId: 't', turnId: 'turn', privatePayload: 'discard' }, supported: false, reason: 'invalid-params' });
  let snapshot = f.events.at(-1).event.snapshot;
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.thread.awaitingReply, false);
  assert.deepEqual(snapshot.requests[0], { requestId: 'number:41', turnId: 'turn', method: 'item/new/request', kind: 'unsupported', params: {}, answered: false, reason: 'invalid-params' });

  f.observe({ type: 'request', id: 42, method: 'item/new/client-ui', params: { threadId: 't', turnId: 'turn' }, supported: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(call => call.method === 'reject' && call.id === 42 && call.reason === 'unsupported-method'));

  f.observe({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'failed-turn', status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded', additionalDetails: 'private upstream data' } } } });
  snapshot = f.events.at(-1).event.snapshot;
  assert.deepEqual(snapshot.turn, { id: 'failed-turn', status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.', code: 'serverOverloaded' } });
  assert.equal(snapshot.thread.awaitingReply, false);
  assert.equal(snapshot.requests.length, 2);
  assert.equal(JSON.stringify(snapshot).includes('private upstream data'), false);
  const snapshotAjv = new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] });
  snapshotAjv.addSchema(schema, 'https://brai.local/schemas/messages.schema.json');
  const snapshotValid = snapshotAjv.compile({ $ref: 'https://brai.local/schemas/messages.schema.json#/definitions/NativeSnapshot' });
  assert.equal(snapshotValid(snapshot), true, JSON.stringify(snapshotValid.errors));

  f.observe({ type: 'request', id: 43, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'failed-turn' }, supported: true });
  snapshot = f.events.at(-1).event.snapshot;
  assert.equal(snapshot.state, 'waiting');
  assert.equal(snapshot.thread.awaitingReply, true);
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
  const ajv = new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] });
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

test('history counts ten messages across native pages without gaps or duplicates', async () => {
  const f = fixture();
  await f.read('open');
  f.entries.splice(0);
  for (let i = 0; i < 23; i++) {
    f.entries.push({ turnId: 'turn', item: { id: `message-${i}`, type: i % 2 ? 'agentMessage' : 'userMessage', text: `answer-${i}`, content: [{ type: 'text', text: `request-${i}` }] } });
    for (let j = 0; j < 12; j++) f.entries.push({ turnId: 'turn', item: { id: `action-${i}-${j}`, type: 'commandExecution', get aggregatedOutput() { throw new Error('hidden body accessed'); } } });
  }
  const pages = [], all = [];
  let cursor;
  do {
    const page = await f.read('items', cursor ? { cursor } : {});
    pages.push(page.data.filter(item => ['userMessage', 'agentMessage'].includes(item.type)).length);
    all.unshift(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, [10, 10, 3]);
  assert.deepEqual(all.map(item => item.id), f.entries.map(entry => entry.item.id));
  assert.ok(f.calls.filter(call => call.method === 'thread/items/list').every(call => call.params.limit <= 10));
});

test('history bounds action-only pages and rejects a generation change mid-page', async () => {
  const f = fixture();
  f.entries.splice(0, f.entries.length, ...Array.from({ length: 1011 }, (_, i) => ({ turnId: 'turn', item: { id: `action-${i}`, type: 'sleep' } })));
  const page = await f.read('items');
  assert.equal(page.data.length, 1000);
  assert.ok(page.nextCursor);
  assert.equal((await f.read('items', { cursor: page.nextCursor })).data.length, 11);
  let calls = 0;
  f.settings.beforeCall = method => { if (method === 'thread/items/list' && ++calls === 2) f.rotate(); };
  await assert.rejects(f.read('items'), e => e.code === 'STALE_GENERATION' && e.outcome === 'query');
});


test('legacy image indicators survive reopening without raw media in any projection', async () => {
  const f = fixture();
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  f.entries[0].item.content.push({ type: 'image', url });
  const opened = await f.read('open');
  assert.equal(opened.items.find(item => item.id === 'user').imageCount, 1);
  assert.equal(JSON.stringify(opened).includes(url), false);
  const history = await f.read('items');
  assert.equal(JSON.stringify(history).includes(url), false);
  const detail = await f.read('item', { turnId: 'turn', itemId: 'user' });
  assert.equal(detail.item.images, undefined);
  assert.equal(detail.item.imageCount, 1);
  assert.equal(new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] }).compile({ ...schema, $ref: '#/definitions/DisplayItem' })(detail.item), true);
  f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: f.entries[0].item } });
  assert.equal(JSON.stringify(f.events).includes(url), false);
  assert.equal((await f.read('item', { turnId: 'turn', itemId: 'user' })).item.images, undefined);
  await assert.rejects(f.read('item', { turnId: 'other', itemId: 'user' }), error => error.code === 'NOT_FOUND');
  f.app.close();
});

test('link query parameters do not ask for a reply, but visible questions still do', async t => {
  const f = fixture(); t.after(() => f.app.close());
  f.entries.at(-1).item = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Проверено. [Каталог](https://openrouter.ai/api/v1/models?output_modalities=all)' };
  const listed = (await f.app.request({ action: 'threads', projectId: 'p' })).data.find(thread => thread.id === 't');
  assert.equal(listed.awaitingReply, false);
  assert.equal((await f.read('open')).thread.awaitingReply, false);
  for (const text of ['https://example.com/?q=1', '<https://example.com/?q=1>', '[Каталог](/models?all=1)', '[Каталог][models]\n\n[models]: /models?all=1']) {
    assert.equal(messageAttention({ ...f.entries.at(-1).item, text }).awaitingReply, false, text);
  }
  for (const text of ['Какой вариант выбрать? [Каталог](https://example.com/?q=1)', '[Какой вариант?](https://example.com/?q=1)', 'Продолжить？']) {
    assert.equal(messageAttention({ ...f.entries.at(-1).item, text }).awaitingReply, true, text);
  }
});

test('final attention survives reading and tool updates, clears on reply, and returns in native list', async t => {
  const f = fixture(); t.after(() => f.app.close());
  f.entries.at(-1).item = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Какой вариант выбрать?' };
  const listed = (await f.app.request({ action: 'threads', projectId: 'p' })).data.find(thread => thread.id === 't');
  assert.equal(listed.finalMessageId, 'final'); assert.equal(listed.awaitingReply, true);
  assert.equal((await f.read('open')).thread.awaitingReply, true);
  f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'tool', type: 'commandExecution' } } });
  assert.equal(f.events.at(-1).event.snapshot.thread.awaitingReply, true);
  f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'next', item: { id: 'reply', type: 'userMessage', content: [{ type: 'text', text: 'Первый' }] } } });
  assert.equal(f.events.at(-1).event.snapshot.thread.awaitingReply, false);
  assert.equal(f.events.at(-1).event.snapshot.thread.finalMessageId, null);
  f.observe({ method: 'item/completed', params: { threadId: 't', turnId: 'next', item: { id: 'done', type: 'agentMessage', phase: 'final_answer', text: 'Готово. Код: `value ? a : b`' } } });
  assert.equal(f.events.at(-1).event.snapshot.thread.finalMessageId, 'done');
  assert.equal(f.events.at(-1).event.snapshot.thread.awaitingReply, false);
});

test('messages are read completely through bounded pages, including truncated live cache and UTF-16 boundaries', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const original = 'я'.repeat(8191) + '😀' + '\n| Поле | Значение |\n'.repeat(12000) + '\nПоследняя строка';
  f.entries.at(-1).item.text = original;
  await f.read('open');
  assert.equal((await f.read('items')).data.find(i => i.id === 'agent').truncated, true);
  const ajv = new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] }), valid = ajv.compile({ ...schema, $ref: '#/definitions/Item' });
  let cursor, restored = '', pages = 0;
  do {
    const command = { turnId: 'turn', itemId: 'agent', ...(cursor ? { cursor } : {}) };
    assert.equal(validateCommand({ action: 'item', projectId: 'p', threadId: 't', ...command }), true);
    const reply = await f.read('item', command);
    assert.equal(valid(reply), true, JSON.stringify(valid.errors));
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 50000);
    assert.ok(!reply.item.text.includes('[содержимое сокращено]'));
    assert.ok(!reply.item.text.includes('\uFFFD'));
    restored += reply.item.text; cursor = reply.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages > 10); assert.equal(restored, original);
  assert.ok(!f.calls.some(call => call.method === 'turn/start'));
});

test('continuation rejects changed text and invalid cursors; user input parts remain ordered', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const original = 'Первая часть\n' + 'ю'.repeat(20000) + '\nПоследняя часть';
  f.entries[0].item.content = [{ type: 'text', text: 'Первая часть' }, { type: 'inputText', text: 'ю'.repeat(20000) }, { type: 'text', text: 'Последняя часть' }];
  const first = await f.read('item', { turnId: 'turn', itemId: 'user' });
  let reply = first, result = reply.item.text;
  while (reply.nextCursor) { reply = await f.read('item', { turnId: 'turn', itemId: 'user', cursor: reply.nextCursor }); result += reply.item.text; }
  assert.equal(result, original);
  f.entries[0].item.content[1].text += 'изменено';
  await assert.rejects(f.read('item', { turnId: 'turn', itemId: 'user', cursor: first.nextCursor }), { code: 'STALE_ITEM', outcome: 'query' });
  await assert.rejects(f.read('item', { turnId: 'turn', itemId: 'user', cursor: 'invalid' }), { code: 'STALE_ITEM' });
  f.settings.beforeCall = method => { if (method === 'thread/items/list') f.rotate(); };
  await assert.rejects(f.read('item', { turnId: 'turn', itemId: 'user' }), { code: 'STALE_GENERATION' });
});
