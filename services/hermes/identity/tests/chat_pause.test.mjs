// ABOUTME: Запускает проверки устойчивой паузы и её Unix duplex границы.
// ABOUTME: Фикстуры изолированы от рабочих профилей, Auth и Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('trusted chat pause persistence, races, cancellation and duplex startup', () => {
  const result = spawnSync(process.env.PYTHON || 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('.', import.meta.url)), '-p', 'test_chat_pause.py', '-v'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Chat pause tests failed');
});
