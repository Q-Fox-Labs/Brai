// ABOUTME: Запускает isolated private identity route regressions в штатном наборе Hermes.
// ABOUTME: Python проверяет реальные incoming/guard без сети и фонового factory recovery.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('identity worker accepts only Root-bound private routes for its canonical owner', { timeout: 15000 }, () => {
  const cwd = fileURLToPath(new URL('../telegram/tests/', import.meta.url));
  const result = spawnSync('python3', [
    '-B', '-m', 'unittest', 'test_plugin.PrivateIdentityRouteTests', '-v',
  ], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 3 tests\b/);
  assert.doesNotMatch(result.stderr, /\bskipped\b/i);
});
