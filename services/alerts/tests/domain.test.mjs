// ABOUTME: Проверяет чистое ядро через порт: replay, commit и курсоры без SQL/NATS.
// ABOUTME: Подмена хранения не заменяет отдельную проверку PostgreSQL и брокера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAlertsHandlers, normalizeTimestamp } from '../dist/domain.js';
const key = Buffer.alloc(32, 1);
const event = { id: 'AAAAAAAA-1111-4111-8111-111111111111', service_id: 'source', type_id: 5, scope_type: 'user', scope_id: 'u', title: 'Готово', text: '', occurred_at: '2026-10-06T12:00:00.123456+03:00' };
function fixture() {
  let saved;
  let committed = false;
  const signals = [];
  const tx = { async insert(e) { if (saved) return false; saved = { ...e, recorded_at: '2026-10-06T09:00:00.123456Z', category: {}, type: {}, read_at: null }; return true; }, async typeByCode() { return 5; }, async get() { return saved; }, async list() { return saved ? [saved, { ...saved, id: 'bbbbbbbb-1111-4111-8111-111111111111' }] : []; }, async summary() { return { unread_count: 1, category: null }; }, async read() { return true; }, async readAll() { return true; } };
  const store = { async ready() {}, async transaction(user, context, work) { committed = false; const value = await work(tx); committed = true; return value; } };
  return { handlers: createAlertsHandlers(store, { cursorKey: key, changed(user) { assert.equal(committed, true); signals.push(user); } }), signals, tx };
}
test('replay normalizes timestamps and object key order; conflicting content rejects', async () => {
  const f = fixture();
  await f.handlers.ingest({ ...event, data: { z: 2, a: 1 } });
  assert.deepEqual(await f.handlers.ingest({ ...event, occurred_at: '2026-10-06T09:00:00.123456Z', data: { a: 1, z: 2 } }), { inserted: false, user_id: 'u' });
  assert.deepEqual(f.signals, ['u']);
  await assert.rejects(f.handlers.ingest({ ...event, text: 'changed', data: { a: 1, z: 2 } }), { code: 'EVENT_ID_CONFLICT' });
  assert.equal(normalizeTimestamp('2026-10-06T12:00:00.123456+03:00'), '2026-10-06T09:00:00.123456Z');
});
test('get/list do not mark read; cursor cannot cross users or be edited', async () => {
  const f = fixture(); await f.handlers.ingest(event);
  f.signals.length = 0;
  await f.handlers.execute('get', { user_id: 'u', service_id: 'source', id: event.id });
  const page = await f.handlers.execute('list', { user_id: 'u', limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(typeof page.next_cursor, 'string');
  assert.deepEqual(f.signals, []);
  await assert.rejects(f.handlers.execute('list', { user_id: 'other', cursor: page.next_cursor }), { code: 'INVALID_CURSOR' });
  await assert.rejects(f.handlers.execute('list', { user_id: 'u', cursor: page.next_cursor + 'x' }), { code: 'INVALID_CURSOR' });
  await f.handlers.execute('read', { user_id: 'u', service_id: 'source', id: event.id });
  assert.deepEqual(f.signals, ['u']);
});
test('data NUL and event byte limit are rejected before external operations', async () => {
  const f = fixture();
  await assert.rejects(f.handlers.ingest({ ...event, data: { bad: '\0' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.handlers.ingest({ ...event, data: { big: 'x'.repeat(65536) } }), { code: 'REQUEST_TOO_LARGE' });
  await assert.rejects(f.handlers.ingest(undefined), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.handlers.ingest({ ...event, occurred_at: '2026-10-06T09:00:60Z' }), { code: 'INVALID_ARGUMENT' });
  const deep = JSON.parse('{"child":'.repeat(8000) + '{}' + '}'.repeat(8000));
  await assert.rejects(f.handlers.ingest({ ...event, data: deep }), { code: 'INVALID_ARGUMENT' });
});
test('valid legacy HMAC cursors remain readable after the compact cursor upgrade', async () => {
  const f = fixture(); await f.handlers.ingest(event);
  const position = ['2026-10-06T09:00:00.123456Z', event.service_id, event.id.toLowerCase()];
  const body = Buffer.from(JSON.stringify({ v: 1, user_id: 'u', position })).toString('base64url');
  const token = body + '.' + createHmac('sha256', key).update(body).digest('base64url');
  let received;
  f.tx.list = async after => { received = after; return []; };
  await f.handlers.execute('list', { user_id: 'u', cursor: token });
  assert.deepEqual(received, position);
  await assert.rejects(f.handlers.execute('list', { user_id: 'other', cursor: token }), { code: 'INVALID_CURSOR' });
});
test('GameCore notification envelope resolves local type and repeats safely', async () => {
  const f = fixture(); const event = { event_id: 'aaaaaaaa-1111-4111-8111-111111111111', event_version: 1, event_type: 'element.completed', occurred_at: '2026-10-15T20:00:00.000Z', owner_id: 'u', actor: { kind: 'agent', id: 'agent-1' }, aggregate: { kind: 'element', id: 'bbbbbbbb-1111-4111-8111-111111111111' }, data: {}, notification: { type_code: 'completed', title: 'Завершено', text: 'Ход принят', data: {} } };
  assert.deepEqual(await f.handlers.ingestGameCoreEvent(event), { inserted: true, user_id: 'u' });
  assert.deepEqual(await f.handlers.ingestGameCoreEvent(event), { inserted: false, user_id: 'u' });
  assert.deepEqual(f.signals, ['u']);
});
