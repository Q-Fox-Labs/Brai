// ABOUTME: Включает проверки command STT личного профиля в общий тестовый вход Hermes.
// ABOUTME: Не запускает реальный broker, модель или Telegram.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
  '-s', 'services/hermes/identity/tests', '-p', 'test_transcribe.py'],
  { cwd: root, encoding: 'utf8' });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
