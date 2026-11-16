// ABOUTME: Запускает регрессионные проверки блокировки native redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('native redaction resolves profile outside its registry lock', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('.', import.meta.url)), '-p', 'test_redaction_lock.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
