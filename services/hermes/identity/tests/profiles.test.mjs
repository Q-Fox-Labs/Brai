// ABOUTME: Запускает semantic tests личных профилей в общем тестовом входе Hermes.
// ABOUTME: Python работает без bytecode и без системных изменений.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
  '-s', 'services/hermes/identity/tests', '-p', 'test_profiles.py'],
  { cwd: root, encoding: 'utf8' });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
