// ABOUTME: Проверяет безопасные замеры отдельных вызовов выпуска.
// ABOUTME: Диагностика не меняет результат или ошибку внешнего действия.
import test from 'node:test';
import assert from 'node:assert/strict';
import {measureReleaseStep} from '../src/release-timing.mjs';

test('records elapsed time without arguments or results', async () => {
  const events = [], times = [10, 52.4];
  const result = await measureReleaseStep('op-1', 'github.checks', async () => 'private value', {emit: x => events.push(x), now: () => times.shift()});
  assert.equal(result, 'private value');
  assert.deepEqual(JSON.parse(events[0].replace('CODEWORKS_RELEASE_TIMING ', '')), {operation_id: 'op-1', step: 'github.checks', outcome: 'succeeded', duration_ms: 42});
  assert.equal(events[0].includes('private value'), false);
});

test('preserves failure even if reporting fails', async () => {
  const failure = new Error('private failure');
  await assert.rejects(measureReleaseStep('op-2', 'git.push', async () => { throw failure; }, {emit: () => { throw Error('logger'); }, now: () => 0}), error => error === failure);
});
