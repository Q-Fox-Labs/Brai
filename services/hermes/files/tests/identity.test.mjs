// ABOUTME: Запускает автономные проверки owner-bound файлового порта.
// ABOUTME: Использует временные fixtures без сети, модели и live-профилей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('owner-bound file snapshots, cache copies and Telegram provenance', { timeout: 30000 }, () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_identity.py', import.meta.url))],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
