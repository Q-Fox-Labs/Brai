// ABOUTME: Запускает проверку большого spool в отдельном процессе.
// ABOUTME: Не обращается к живой памяти или пользовательским данным.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
test('300 МиБ и отказ при неполном или чужом потоке', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-spool-'));
  try {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s',
      'services/hermes/identity/tests', '-p', 'test_memory_spool.py'], {
      cwd: root, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', BRAI_MEMORY_GATEWAY_TMP: directory },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
