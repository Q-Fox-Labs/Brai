// ABOUTME: Проверяет единый display статус ошибок native действий.
// ABOUTME: Ошибки не добавляют публичные поля и сохраняются в summaries и компактной истории.
import assert from 'node:assert/strict';
import test from 'node:test';
import { display, compact, summary } from '../dist/display.js';

test('native error, success=false and nonzero exit code override completed status', () => {
  for (const native of [
    { type: 'mcpToolCall', server: 'test', tool: 'read', error: { message: 'native failure' } },
    { type: 'dynamicToolCall', tool: 'read', success: false },
    { type: 'commandExecution', command: 'false', exitCode: 1 },
    { type: 'commandExecution', command: 'missing', exitCode: 127 },
    { type: 'commandExecution', command: 'signal', exitCode: -1 },
    { type: 'fileChange', changes: [], status: 'failed' },
  ]) {
    const item = display({ id: 'action', status: 'completed', ...native }, 'turn');
    for (const view of [item, compact(item), summary(item)]) {
      assert.equal(view.status, 'failed', native.type);
      assert.equal(view.error, undefined);
      assert.equal(view.success, undefined);
    }
  }
});

test('null native errors and successful exit codes preserve lifecycle status', () => {
  for (const status of ['inProgress', 'completed', 'interrupted']) {
    const item = display({ id: 'action', type: 'commandExecution', status, exitCode: null, error: null }, 'turn');
    assert.equal(item.status, status);
  }
  assert.equal(display({ id: 'action', type: 'commandExecution', status: 'completed', exitCode: 0 }, 'turn').status, 'completed');
  assert.equal(display({ id: 'action', type: 'dynamicToolCall', tool: 'read', status: 'completed', success: true }, 'turn').status, 'completed');
});
