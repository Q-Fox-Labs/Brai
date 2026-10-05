// ABOUTME: Проверяет PostgreSQL-гарантии каталога и конечного metadata outbox.
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
function event({ id = randomUUID(), operation = 'invoke', operationId = randomUUID(), outcome = 'accepted', actorId = 'test-owner' } = {}) {
  const invoke = operation === 'invoke';
  return {
    id, type_id: invoke ? 1201 : 902, occurred_at: timestamp,
    actor_id: actorId, scope_type: invoke ? 'user' : 'system', scope_id: invoke ? actorId : 'local_ai',
    object_type: invoke ? 'operation' : 'installation', object_id: operationId,
    data: { operation, modelId: 'storage-integration-fixture', outcome, operationId, phase: outcome === 'accepted' ? 'accepted' : 'publish' },
  };
}

test('PostgreSQL catalog and metadata outbox preserve bounded atomic delivery semantics', { skip: !ready && 'isolated PostgreSQL fixture credentials are not configured' }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const identity = (await pool.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    assert.equal(identity.database, expectedDatabase, 'refusing to test against an unexpected database');
    assert.equal(identity.role, expectedAppRole, 'integration test must use the restricted runtime role');

    let ddlError;
    try { await pool.query('CREATE TABLE local_ai.runtime_ddl_probe(id integer)'); }
    catch (error) { ddlError = error; }
    assert.equal(ddlError?.code, '42501', 'runtime role must not be able to run DDL');

    const store = createPostgresStore(pool, { outboxCapacity: 2, queryTimeoutMs: 5000 });
    const initial = await store.status();
    assert.deepEqual(initial, { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null }, 'fixture must start with an empty outbox');

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

    const operationId = randomUUID();
    const terminalEventId = randomUUID();
    const admission = event({ operationId });
    await store.transaction(tx => tx.outbox.appendAdmission(admission, { operationId, terminalEventId }));
    await assert.rejects(store.transaction(tx => tx.outbox.append(event())), error => error?.code === 'BUSY');
    assert.equal((await store.status()).pending, 1, 'failed capacity admission must leave no partial event');
    assert.equal((await store.status()).reserved, 1, 'accepted work must reserve its terminal slot');

    const terminal = { ...admission, id: terminalEventId, occurred_at: timestamp, data: { ...admission.data, outcome: 'succeeded', phase: 'execute' } };
    await store.transaction(tx => tx.outbox.appendCompletion(operationId, terminal));
    await assert.rejects(store.transaction(tx => tx.outbox.appendCompletion(operationId, { ...terminal, id: randomUUID() })), error => error?.code === 'INVALID_ARGUMENT');

    const claimed = await store.claimBatch(2, 5000);
    assert.equal(claimed.length, 2);
    assert.ok(claimed.some(item => item.event.id === terminalEventId));
    const claim = claimed[0];
    await store.acknowledge(claim.event.id, randomUUID());
    assert.equal((await store.status()).sending, 2, 'stale claim token must not acknowledge a row');
    await Promise.all(claimed.map(item => store.acknowledge(item.event.id, item.claimToken)));
    assert.equal((await store.status()).pending, 0);
    assert.equal((await store.status()).sending, 0);

    const installOperationId = randomUUID();
    const installTerminalId = randomUUID();
    const installFact = event({ operation: 'install', operationId: installOperationId, actorId: 'test-owner' });
    await store.transaction(async tx => {
      await tx.installationOperations.put({
        operationId: installOperationId, ownerId: 'test-owner', modelId, revision: 'r1', profileId: 'fixture',
        status: 'accepted', phase: 'queued', progressPercent: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp,
      });
      await tx.outbox.appendAdmission(installFact, { operationId: installOperationId, terminalEventId: installTerminalId });
    });
    assert.equal(await store.recoverInterrupted(), 1);
    const recovered = await store.claimBatch(2, 5000);
    assert.equal(recovered.length, 2);
    const recoveredTerminal = recovered.find(item => item.event.id === installTerminalId);
    assert.ok(recoveredTerminal, 'startup recovery must preserve the reserved terminal ID');
    assert.equal(recoveredTerminal.event.data.outcome, 'unknown');
    assert.ok(recovered.some(item => item.event.id === installFact.id), 'the original admission fact must remain immutable');
    assert.equal((await store.transaction(tx => tx.installationOperations.get(installOperationId, 'test-owner'))).status, 'unknown');
    await Promise.all(recovered.map(item => store.acknowledge(item.event.id, item.claimToken)));

    await store.transaction(async tx => {
      await tx.settings.put(modelId, { idleUnloadSeconds: null });
      assert.deepEqual(await tx.settings.get(modelId), { idleUnloadSeconds: null });
      await tx.models.remove(modelId);
    });
    const cleaned = await store.status();
    assert.equal(cleaned.reserved, 0);
    assert.equal(cleaned.pending, 0);
    assert.equal(cleaned.sending, 0);
    assert.equal(cleaned.permanentlyFailed, 0);
  } finally {
    await pool.end();
  }
});
