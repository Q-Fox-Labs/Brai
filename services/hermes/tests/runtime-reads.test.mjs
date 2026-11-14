// ABOUTME: Запускает проверки runtime spill и package-relative справочников.
// ABOUTME: Не использует модель, внешние сервисы или личные профили.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('runtime outputs and skill references remain readable without publication', () => {
  const script = fileURLToPath(new URL('../files/tests/test_runtime_reads.py', import.meta.url));
  const result = spawnSync('python3', ['-B', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
