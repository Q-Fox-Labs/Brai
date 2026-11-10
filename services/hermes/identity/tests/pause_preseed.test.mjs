// ABOUTME: Запускает изолированные Root-preseed boundary/atomic SQLite проверки.
// ABOUTME: Проверяет машинные DTO; реальные operator inputs и UID не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

test('Root-only pause preseed guards, atomicity, idempotency and readback', () => {
  const result = spawnSync(process.env.PYTHON || 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', fileURLToPath(new URL('.', import.meta.url)), '-p', 'test_pause_preseed.py', '-v'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Pause preseed tests failed');
});

test('operator preseed DTO excludes credentials, human identity and unverified receipts', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/pause-preseed.schema.json', import.meta.url)));
  const ajv = new Ajv({ strict: false });
  ajv.addSchema(schema);
  const validate = name => ajv.compile({ $ref: schema.$id + '#/definitions/' + name });
  const config = { version: 1, registryPath: '/protected/registry.json', telegramJournalRoot: '/trusted/chats', ingressUid: 995, ingressGid: 995 };
  const request = { version: 1, operationId: '33333333-3333-4333-8333-333333333333',
    expectedUserId: '11111111-1111-4111-8111-111111111111', expectedProfileId: '22222222-2222-4222-8222-222222222222',
    expectedWorkerUid: 1001, expectedAuthorTelegramId: '123', chat: '123', thread: '77', reason: 'Операторская пауза' };
  const receipt = { status: 'paused', actor: 'os:root', auditId: request.operationId, operationId: request.operationId,
    userId: request.expectedUserId, profileId: request.expectedProfileId, workerUid: 1001, chat: '123', thread: '77', generation: 1, verified: true };
  assert.equal(validate('Config')(config), true);
  assert.equal(validate('Request')(request), true);
  assert.equal(validate('Receipt')(receipt), true);
  assert.equal(validate('Config')({ ...config, adminCookie: 'forbidden' }), false);
  assert.equal(validate('Config')({ ...config, registryPath: '/protected/../other' }), false);
  assert.equal(validate('Request')({ ...request, action: 'resume' }), false);
  assert.equal(validate('Request')({ ...request, actor: 'human' }), false);
  assert.equal(validate('Request')({ ...request, thread: '1' }), false);
  assert.equal(validate('Receipt')({ ...receipt, verified: false }), false);
});
