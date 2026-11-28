// ABOUTME: Запускает автономные проверки owner-bound файлового порта.
// ABOUTME: Использует временные fixtures без сети, модели и live-профилей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startProcess } from '../../tests/cli-process.mjs';

test('owner-bound file snapshots, cache copies and Telegram provenance', async t => {
  const { result: pending } = startProcess('python3', ['-B', fileURLToPath(new URL('./test_identity.py', import.meta.url))], { signal: t.signal });
  const result = await pending;
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
