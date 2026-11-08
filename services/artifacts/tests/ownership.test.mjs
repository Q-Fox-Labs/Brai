// ABOUTME: Запускает автономную проверку owner migration Artifacts.
// ABOUTME: Не подключается к live PostgreSQL, не читает пользовательские данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('artifact owner migration preserves identities and rejects unproven bindings', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_ownership.py', import.meta.url))],
    {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
