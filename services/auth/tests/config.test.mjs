// ABOUTME: Проверяет список доверенных origin службы авторизации.
// ABOUTME: Не обращается к сети или настоящей базе данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../dist/config.js';

const env={AUTH_ORIGIN:'https://dev.example',AUTH_SECRET:'a'.repeat(32),AUTH_DATABASE_URL:'postgres://fixture',AUTH_EMAIL_FROM:'fixture@example.com'};
test('trusted origins extend the default and reject unsafe forms',()=>{
 assert.deepEqual(config(env,'migration').trustedOrigins,['https://dev.example']);
 assert.deepEqual(config({...env,AUTH_TRUSTED_ORIGINS:'https://preview.example, http://localhost:3000'},'migration').trustedOrigins,['https://dev.example','https://preview.example','http://localhost:3000']);
 for(const value of ['https://*.example','https://user:pass@example.com','https://example.com/path','ftp://example.com','https://example.com/','https://example.com,']) {
  assert.throws(()=>config({...env,AUTH_TRUSTED_ORIGINS:value},'migration'),/AUTH_TRUSTED_ORIGINS/);
 }
});
