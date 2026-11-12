// ABOUTME: Запускает постоянные regression tests ролей Hermes через unittest.
// ABOUTME: Все пути берутся от этого файла; suite не зависит от временных исходников.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const result = spawnSync('python3', [
  '-B', '-m', 'unittest', 'discover',
  '-s', 'services/hermes/identity/tests',
  '-p', 'test_roles_*.py',
], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
process.stdout.write(result.stdout);
