// ABOUTME: Проверяет машинные DTO, неизменность схем и сигналы без содержимого.
// ABOUTME: Не подключает внешние ресурсы; потребители используют ровно owner-схемы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schema, subjects, validateIngest, validateChanged, validateRequest, validateResponse, validateError } from '../contracts/index.mjs';
const event = { id: '11111111-1111-4111-8111-111111111111', service_id: 'source opaque.ID', type_id: 5, scope_type: 'system', scope_id: 'global', title: 'Готово', text: '', occurred_at: '2026-10-06T12:00:00.123456+03:00' };
test('Draft07 input scopes, opaque IDs and strict request DTOs', () => {
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(validateIngest(event), true);
  assert.equal(validateIngest({ ...event, recorded_at: event.occurred_at }), false);
  assert.equal(validateIngest({ ...event, scope_id: 'another' }), false);
  assert.equal(validateIngest({ ...event, data: [] }), false);
  assert.equal(validateIngest({ ...event, occurred_at: '2026-10-06T12:00:00' }), false);
  assert.equal(validateIngest({ ...event, occurred_at: '2026-10-06T12:00:00.1234567Z' }), false);
  assert.equal(validateRequest('list', { user_id: 'BetterAuth-ID' }), true);
  assert.equal(validateRequest('list', { user_id: 'BetterAuth-ID', limit: 101 }), false);
  assert.equal(validateRequest('read_all', { user_id: 'u', before: event.occurred_at }), false);
});
test('summary has semantic importance and changed signal only contains recipient', () => {
  const category = { id: 1, code: 'critical', name: 'Критические', color: '#123456', importance: 3 };
  assert.equal(validateResponse('summary', { unread_count: 3, category }), true);
  assert.equal(validateResponse('read_all', { unread_count: 0, category: null }), true);
  assert.equal(validateResponse('read', { unread_count: -1, category }), false);
  assert.equal(validateChanged({ user_id: null }), true);
  assert.equal(validateChanged({ user_id: 'u' }), true);
  assert.equal(validateChanged({ user_id: 'u', title: 'secret' }), false);
  assert.equal(validateError({ code: 'DATABASE_UNAVAILABLE', message: 'DATABASE_UNAVAILABLE', retryable: true }), true);
});
test('AsyncAPI declares all actual subjects, native replies and resolvable owner schema refs', () => {
  const api = JSON.parse(readFileSync(new URL('../asyncapi.yaml', import.meta.url), 'utf8').replace(/^#.*\n/gm, ''));
  assert.equal(api.asyncapi, '3.1.0');
  function pointer(root, path) { return path.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root); }
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const local = value.$ref.startsWith('#');
      assert.ok(local || value.$ref.startsWith('./schemas/messages.schema.json#/definitions/'));
      assert.ok(pointer(local ? api : schema, local ? value.$ref : value.$ref.split('.json')[1]), value.$ref);
    }
    for (const item of Object.values(value)) check(item);
  }
  check(api);
  for (const [operation, subject] of Object.entries(subjects)) {
    assert.equal(api.channels[operation].address, subject);
    assert.equal(api.operations[operation].action, operation === 'changed' ? 'send' : 'receive');
    if (!['ingest', 'changed'].includes(operation)) {
      assert.equal(api.operations[operation].reply['x-nats-reply-subject'], 'message.reply');
      assert.equal(api.operations[operation].bindings.nats.queue, 'service_alerts');
    }
  }
  assert.equal(api.operations.ingest['x-jetstream'].max_bytes, 268435456);
  assert.equal(api.operations.ingest['x-jetstream'].ack_policy, 'explicit');
});
