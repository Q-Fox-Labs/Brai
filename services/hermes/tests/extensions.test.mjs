// ABOUTME: Запускает автономные проверки комплекта расширений Hermes.
// ABOUTME: Не требует сети, установленного движка или пользовательского профиля.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('extensions connect and codex owner', { timeout: 60000 }, () => {
  for (const name of ['test_connect.py', 'test_codex_cli_owner.py', 'test_memory_quality.py']) {
    const script = fileURLToPath(new URL(`../extensions/tests/${name}`, import.meta.url));
    const result = spawnSync('python3', ['-B', script], { encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
