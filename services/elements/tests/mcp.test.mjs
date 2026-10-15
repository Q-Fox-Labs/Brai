// ABOUTME: Проверяет MCP-контракт Elements без запуска HTTP listener.
// ABOUTME: Инструменты не получают owner_id от модели и имеют явные входные схемы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolInputs, toolNames } from '../dist/mcp.js';

test('MCP публикует полный набор инструментов Elements', () => {
  assert.deepEqual(toolNames, [
    'elements_structure_create',
    'elements_element_create',
    'elements_element_revise',
    'elements_move_create',
    'elements_move_link',
    'elements_element_activate',
    'elements_graph_get',
    'elements_timeline_get',
    'elements_moves_available',
    'elements_move_claim',
    'elements_move_complete',
    'elements_move_fail',
  ]);
  for (const name of toolNames) {
    const schema = toolInputs[name];
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties ?? {}, 'user_id'), false);
  }
});

test('MCP требует JSON Schema результата для элементов и ходов', () => {
  assert.deepEqual(toolInputs.elements_element_create.required, ['kind', 'title', 'description', 'result_spec']);
  assert.deepEqual(toolInputs.elements_move_create.required, ['kind', 'title', 'instructions', 'result_schema']);
  assert.equal(toolInputs.elements_move_complete.required.includes('result'), true);
});
