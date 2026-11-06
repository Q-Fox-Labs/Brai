// ABOUTME: Запускает тесты пользовательского Hermes в общем Node test runner.
// ABOUTME: Не подключается к установленным сервисам и пользовательским данным.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
test('Hermes worker IPC and tools', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_worker*.py', '-v'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Worker tests failed');
});

test('Hermes Telegram ingress', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_telegram_runtime.py', '-v'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Telegram tests failed');
});
