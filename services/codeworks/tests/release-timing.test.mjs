// ABOUTME: Проверяет безопасные замеры отдельных вызовов выпуска.
// ABOUTME: Диагностика не меняет результат или ошибку внешнего действия.
import test from 'node:test';
import assert from 'node:assert/strict';
import {measureReleaseStep, recordReleaseState} from '../src/release-timing.mjs';

test('records elapsed time without arguments or results', async () => {
  const events = [], times = [10, 52.4];
  const result = await measureReleaseStep('op-1', 'github.checks', async () => 'private value', {emit: x => events.push(x), now: () => times.shift()});
  assert.equal(result, 'private value');
  const event=JSON.parse(events[0].replace('CODEWORKS_RELEASE_TIMING ', ''));
  assert.equal(Number.isNaN(Date.parse(event.at)), false);
  delete event.at;
  assert.deepEqual(event, {operation_id: 'op-1', step: 'github.checks', outcome: 'succeeded', duration_ms: 42});
  assert.equal(events[0].includes('private value'), false);
});

test('preserves failure even if reporting fails', async () => {
  const failure = new Error('private failure');
  await assert.rejects(measureReleaseStep('op-2', 'git.push', async () => { throw failure; }, {emit: () => { throw Error('logger'); }, now: () => 0}), error => error === failure);
});

test('reports waiting transition with timestamp and never fails the operation', () => {
  const events = [];
  recordReleaseState('op-3', 'awaiting_ci', 'MERGE_CHECKS_REQUIRED', {emit: x => events.push(x), now: () => new Date('2026-01-01T00:00:00Z')});
  assert.deepEqual(JSON.parse(events[0].replace('CODEWORKS_RELEASE_STATE ', '')), {operation_id: 'op-3', status: 'awaiting_ci', step: 'MERGE_CHECKS_REQUIRED', at: '2026-01-01T00:00:00.000Z'});
  assert.doesNotThrow(() => recordReleaseState('op-3', 'running', 'intent', {emit: () => { throw Error('logger'); }}));
});
