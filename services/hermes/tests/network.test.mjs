// ABOUTME: Запускает проверки сетевой границы в штатном наборе Hermes.
// ABOUTME: Python-тесты используют только временные данные и локальные сокеты.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('сетевой прокси проверяет UID и ограничения соединений', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync('python3', [
    '-B', '-m', 'unittest', 'discover', '-s', 'identity/tests', '-p', 'test_network.py',
  ], { cwd, encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
