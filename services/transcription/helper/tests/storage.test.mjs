// ABOUTME: Проверяет owner validation и согласованные канонические хеши storage без БД.
// ABOUTME: Эти локальные проверки не подтверждают SQL транзакции или права рабочих ролей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHash, createPolicySnapshot, createPostgresStore, StorageFault } from '../storage/index.ts';

const config = { historyCapacity: 10, requestLeaseMs: 10000, historyLeaseMs: 10000, transactionTimeoutMs: 5000, recoveryBatchSize: 10 };
test('canonical hash ignores object key order, preserves arrays and exact values', () => {
  assert.equal(canonicalHash({ b: 2, a: { y: 1, x: null } }), canonicalHash({ a: { x: null, y: 1 }, b: 2 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.notEqual(canonicalHash({ amount: '0.0100' }), canonicalHash({ amount: '0.01' }));
  assert.match(canonicalHash({ a: 1 }), /^[0-9a-f]{64}$/);
  const settings = { policyVersion: 1, defaultLocalModel: null, allowReplacement: false };
  const snapshot = createPolicySnapshot(settings);
  const { sha256, ...facts } = snapshot;
  assert.equal(sha256, canonicalHash(facts));
  assert.equal(snapshot.version, 1);
});
test('finite config and invalid DTO are rejected before any database access', async () => {
  let calls = 0;
  const pool = { connect() { calls++; throw new Error('private URL'); }, async end() {} };
  for (const invalid of [0, -1, Infinity, 0.5]) assert.throws(() => createPostgresStore(pool, { ...config, historyCapacity: invalid }), error => error instanceof StorageFault && error.code === 'INVALID_ARGUMENT');
  const store = createPostgresStore(pool, config);
  await assert.rejects(store.execute('request.accept', { ownerId: 'client', text: 'private' }), error => error instanceof StorageFault && error.code === 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
  await assert.rejects(store.execute('request.claim', { workerId: 'worker' }), error => error instanceof StorageFault && error.code === 'STORAGE_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(calls, 1);
  await store.close();
});
