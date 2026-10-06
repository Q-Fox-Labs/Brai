// ABOUTME: Проверяет обязательные параметры, отдельные роли и стабильный ключ курсоров.
// ABOUTME: Использует синтетический secret reader, не читает файлы секретов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../dist/config.js';
const env = { ALERTS_APP_DATABASE_URL: 'postgresql://app:fixture@localhost/brai_alerts_test', ALERTS_WEB_DATABASE_URL: 'postgresql://web:fixture@localhost/brai_alerts_test', ALERTS_CURSOR_HMAC_KEY_FILE: '/fixture/cursor-key', NATS_URL: 'nats://localhost:4222', NATS_USER: 'alerts', NATS_PASSWORD: 'fixture', NATS_INBOX_PREFIX: '_INBOX.brai_alerts' };
test('runtime has explicit parameters and no owner credentials', () => {
  const result = config(env, path => { assert.equal(path, '/fixture/cursor-key'); return Buffer.alloc(32); });
  assert.equal(result.cursorKey.length, 32);
  assert.equal('ownerDatabaseURL' in result, false);
  for (const name of Object.keys(env)) {
    const missing = { ...env }; delete missing[name];
    assert.throws(() => config(missing, () => Buffer.alloc(32)), new RegExp(`MISSING_${name}`));
  }
  assert.throws(() => config(env, () => Buffer.alloc(31)), /ALERTS_CURSOR_KEY_TOO_SHORT/);
  assert.throws(() => config({ ...env, NATS_INBOX_PREFIX: '_INBOX' }, () => Buffer.alloc(32)), /INVALID_NATS_INBOX_PREFIX/);
  assert.throws(() => config({ ...env, ALERTS_APP_DATABASE_URL: 'https://localhost' }, () => Buffer.alloc(32)), /INVALID_ALERTS_APP_DATABASE_URL/);
});
