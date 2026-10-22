// ABOUTME: Проверяет прикладные правила Elements без PostgreSQL и NATS.
// ABOUTME: Интеграционные гарантии транспорта и транзакций проверяются отдельным стендом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canActivate, hierarchyChild, hierarchyParent, validateElementDraft, validateLink, validateMoveDraft, ElementsFault } from '../dist/domain.js';
import { validateResult, validateSchema } from '../dist/contracts.js';

const element = (kind = 'task') => ({ id: '00000000-0000-4000-8000-000000000001', owner_id: 'u', kind, parent_id: null, status: 'draft', current_revision: { id: '00000000-0000-4000-8000-000000000002', element_id: '00000000-0000-4000-8000-000000000001', revision: 1, title: 'x', description: '', result_spec: {}, created_by: 'u', created_at: '2026-01-01T00:00:00.000Z' } });
const move = (kind = 'operation') => ({ id: '00000000-0000-4000-8000-000000000003', owner_id: 'u', kind, title: 'x', instructions: '', result_schema: { type: 'object' }, status: 'planned', created_at: '2026-01-01T00:00:00.000Z' });

test('иерархия имеет только разрешённые родительские и дочерние типы', () => {
  assert.equal(hierarchyParent('level'), null);
  assert.equal(hierarchyParent('mission'), 'level');
  assert.equal(hierarchyChild('goal'), 'task');
  assert.equal(hierarchyChild('task'), null);
  assert.throws(() => validateElementDraft({ kind: 'task', parent_id: null, title: 'x', description: '', result_spec: {} }), ElementsFault);
});

test('активация требует 2–6 детей и ровно один accept', () => {
  assert.throws(() => canActivate('quest', 1, 1), /INVALID_STATE/);
  assert.throws(() => canActivate('quest', 7, 1), /INVALID_STATE/);
  assert.throws(() => canActivate('quest', 2, 0), /INVALID_STATE/);
  assert.doesNotThrow(() => canActivate('quest', 2, 1));
  assert.doesNotThrow(() => canActivate('task', 0, 1));
});

test('launch и accept принадлежат только operation', () => {
  assert.throws(() => validateLink(move('action'), element(), { move_id: 'm', element_id: 'e', role: 'accept' }), /INVALID_ARGUMENT/);
  assert.doesNotThrow(() => validateLink(move('operation'), element(), { move_id: 'm', element_id: 'e', role: 'accept' }));
});

test('JSON Schema результата принимает только согласованный результат', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false };
  assert.equal(validateSchema(schema), true);
  assert.equal(validateResult(schema, { ok: true }), true);
  assert.equal(validateResult(schema, { ok: 'yes' }), false);
});

test('некорректная схема Move отклоняется до хранения', () => {
  assert.throws(() => validateMoveDraft({ kind: 'operation', title: 'x', instructions: '', result_schema: { type: 'unknown' } }), /INVALID_ARGUMENT/);
});
