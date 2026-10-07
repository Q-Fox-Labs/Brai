// ABOUTME: Проверяет PostgreSQL-гарантии каталога и восстановления незавершённых установок.
// ABOUTME: Запускается только на явно указанной изолированной тестовой БД под app-ролью.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresStore } from '../../dist/storage/postgres.js';

const { Pool } = pg;
const databaseUrl = process.env.LOCAL_AI_DATABASE_URL;
const expectedDatabase = process.env.LOCAL_AI_TEST_DATABASE;
const expectedAppRole = process.env.LOCAL_AI_APP_ROLE;
const ready = Boolean(databaseUrl && expectedDatabase && expectedAppRole);

const timestamp = '2026-10-05T20:00:00.000Z';

test('PostgreSQL catalog preserves durable state and recovers interrupted installations independently', { skip: !ready && 'isolated PostgreSQL fixture credentials are not configured' }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const identity = (await pool.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    assert.equal(identity.database, expectedDatabase, 'refusing to test against an unexpected database');
    assert.equal(identity.role, expectedAppRole, 'integration test must use the restricted runtime role');

    let ddlError;
    try { await pool.query('CREATE TABLE local_ai.runtime_ddl_probe(id integer)'); }
    catch (error) { ddlError = error; }
    assert.equal(ddlError?.code, '42501', 'runtime role must not be able to run DDL');

    const store = createPostgresStore(pool, { queryTimeoutMs: 5000 });
    const modelId = `storage-test-${randomUUID()}`;
    const model = {
      modelId, name: 'fixture', description: '', source: 'isolated-test', license: null, revision: 'r1', profileId: 'fixture',
      supported: true, operations: ['embed'], languages: [], inputKinds: ['text'], outputKinds: ['vector'], files: [],
      hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
      limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: 4 },
      parameters: { embed: { purpose: ['query'] }, transcribe: null },
    };
    await store.transaction(async tx => {
      await tx.models.put(model);
      await tx.settings.put(modelId, { idleUnloadSeconds: 90 });
      assert.deepEqual(await tx.models.get(modelId), model);
      assert.deepEqual(await tx.settings.get(modelId), { idleUnloadSeconds: 90 });
      assert.deepEqual(await tx.models.list({ modelId, operation: 'embed', inputKind: 'text', installed: false }), [model]);
    });

    const installOperationId = randomUUID();
    await store.transaction(async tx => {
      await tx.installationOperations.put({
        operationId: installOperationId, ownerId: 'test-owner', modelId, revision: 'r1', profileId: 'fixture',
        status: 'accepted', phase: 'queued', progressPercent: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp,
      });
    });
    assert.equal(await store.recoverInterrupted(), 1);
    assert.equal((await store.transaction(tx => tx.installationOperations.get(installOperationId, 'test-owner'))).status, 'unknown');
    assert.equal(await store.recoverInterrupted(), 0, 'recovery is idempotent without invoking runtime or history');

    await store.transaction(async tx => {
      await tx.settings.put(modelId, { idleUnloadSeconds: null });
      assert.deepEqual(await tx.settings.get(modelId), { idleUnloadSeconds: null });
      await tx.models.remove(modelId);
    });
  } finally {
    await pool.end();
  }
});
