// ABOUTME: Проверяет реальный PostgreSQL adapter и SQL-free cached invoke через lifecycle.
// ABOUTME: Пул запрещает outbox SQL и после подготовки запрещает любые обращения к БД.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresStore } from '../dist/storage/postgres.js';
import { createLifecycleManager } from '../dist/lifecycle/index.js';

const selector = { modelId: 'm', revision: 'r', profileId: 'p' };
const model = { ...selector, supported: true, operations: ['embed'], inputKinds: ['text'], limits: { maxInputBytes: null, maxItems: null, vectorDimensions: 1 } };
function poolFixture() {
  const queries = []; let forbidden = false;
  const operation = { operationId: 'install', ownerId: 'u', modelId: 'm', revision: 'r', profileId: 'p', status: 'running', phase: 'downloading', progressPercent: 0, errorCode: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  let recovered;
  return { queries, forbid() { forbidden = true; }, get recovered() { return recovered; },
    async connect() {
      if (forbidden) assert.fail('any SQL access after cache preparation is forbidden');
      return { on() {}, removeListener() {}, release() {}, async query(input, values) {
        const sql = typeof input === 'string' ? input : input.text; queries.push(sql);
        assert.doesNotMatch(sql, /outbox|advisory|lease|claim/);
        if (sql.includes("record->>'status'")) return { rows: recovered ? [] : [{ record: operation }] };
        if (sql.startsWith('UPDATE local_ai.installation_operations')) { recovered = JSON.parse(values[2]); return { rows: [], rowCount: 1 }; }
        if (sql.startsWith('SELECT document FROM')) return { rows: [{ document: model }] };
        if (sql.startsWith('SELECT model_id,revision')) return { rows: [{ model_id: 'm', revision: 'r', profile_id: 'p', directory: '/verified', files: [], installed_at: new Date('2026-01-01T00:00:00Z') }] };
        if (sql.startsWith('SELECT idle_unload_seconds')) return { rows: [{ idle_unload_seconds: null }] };
        return { rows: [] };
      } };
    } };
}
test('independent installation recovery marks unknown once without any outbox access', async () => {
  const pool = poolFixture(); const store = createPostgresStore(pool, { queryTimeoutMs: 1000 });
  assert.equal(await store.recoverInterrupted(), 1); assert.equal(pool.recovered.status, 'unknown'); assert.equal(pool.recovered.errorCode, 'INTERNAL');
  assert.equal(await store.recoverInterrupted(), 0);
  assert.equal('claimBatch' in store, false); assert.equal('status' in store, false);
});
test('warm lifecycle invoke uses the actual storage adapter only during verified preparation', async () => {
  const pool = poolFixture(); const store = createPostgresStore(pool, { queryTimeoutMs: 1000 });
  const lifecycle = createLifecycleManager({ store, artifacts: { async withReadyAudio() { assert.fail('embed does not acquire audio'); } },
    runtimeFactory: { async open() { let finish; const exited = new Promise(resolve => { finish = resolve; }); return {
      exited, async embed() { return { vectors: [[1]] }; }, async transcribe() { assert.fail('unused'); }, async close() { finish(); },
    }; } }, limits: { maxLoadedModels: 1, maxQueuedOperations: 1, maxInputBytes: 1000, maxEmbeddingItems: 1, maxResultBytes: 1000, loadDeadlineMs: 1000 } });
  await lifecycle.refreshModel('m'); pool.forbid();
  for (let i = 0; i < 2; i++) {
    const input = { operation: 'embed', operationId: `op-${i}`, requestId: `request-${i}`, ownerId: 'u', model: selector, texts: ['private input'], purpose: 'document', deadlineAt: new Date(Date.now() + 2000).toISOString() };
    assert.deepEqual((await lifecycle.invoke(input, { ...input, signal: new AbortController().signal })).vectors, [[1]]);
  }
  await lifecycle.close();
});
