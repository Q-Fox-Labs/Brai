// ABOUTME: Запускает owner migration проверки MemOS в штатном Node test runner.
// ABOUTME: PostgreSQL fixture включается только явным DSN синтетической БД.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('MemOS owner migration preserves provenance and supports safe rollback', () => {
  const path = fileURLToPath(new URL('test_migration.py', import.meta.url));
  const result = spawnSync(process.env.MEMOS_MIGRATION_TEST_PYTHON || 'python3', ['-B', path, '-v'], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stderr);
});
