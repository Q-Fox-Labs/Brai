// ABOUTME: Проверяет долговечную доставку history после нового подключения и отказа отправки.
// ABOUTME: Использует только изолированную PostgreSQL; не отправляет историю и не запускает вычисление.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPostgresStore, createPolicySnapshot, StorageFault } from '../../dist/helper/storage/index.js';
import { validateDto } from '#transcription-contracts';
import { migrate } from '../../dist/helper/migrate.js';

const env = process.env;
if (env.PGHOST !== '127.0.0.1' || env.PGPORT !== '19679' || env.PGDATABASE !== 'brai_transcription_acceptance' ||
    env.PGUSER !== 'transcription_owner' || !env.PGPASSWORD || env.TRANSCRIPTION_TEST_APP_PGUSER !== 'transcription_app' ||
    !env.TRANSCRIPTION_TEST_APP_PGPASSWORD) throw new Error('Explicit isolated delivery PostgreSQL fixture required');
const owner = new Pool({ connectionTimeoutMillis: 5000, query_timeout: 5000, max: 2 });
const config = { alertsCapacity: 100, historyCapacity: 2, requestLeaseMs: 60000, historyLeaseMs: 60000, transactionTimeoutMs: 5000, recoveryBatchSize: 2 };
const selector = { modelId: 'synthetic/whisper', revision: 'fixture:1', profileId: 'transcribe/fixture' };
const settings = { policyVersion: 1, defaultLocalModel: selector, allowReplacement: false };
const principal = { scopeType: 'user', scopeId: 'delivery-fixture', ownerId: 'delivery-fixture', permissions: ['transcription:use', 'transcription:settings:write'] };
const fault = code => error => error instanceof StorageFault && error.code === code;
let store;

async function reopen(limits = config) {
  if (store) { await store.close(); store = undefined; }
  const app = new Pool({ host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE,
    user: env.TRANSCRIPTION_TEST_APP_PGUSER, password: env.TRANSCRIPTION_TEST_APP_PGPASSWORD,
    connectionTimeoutMillis: 5000, query_timeout: 5000, max: 2 });
  store = createPostgresStore(app, limits);
  await store.ready();
}
async function reset() {
  await owner.query('TRUNCATE transcription.alerts_outbox,transcription.alerts_incidents,transcription.history_outbox,transcription.attempts,transcription.requests');
  await owner.query('UPDATE transcription.settings SET settings=$1,revision=1 WHERE singleton', [settings]);
  await reopen();
}
async function accept() {
  const input = { clientIdempotencyKey: randomUUID(), audioArtifactId: randomUUID(), requestedModel: null, deadlineAt: null };
  return store.execute('request.accept', { principal, input,
    artifact: { artifactId: input.audioArtifactId, ownerId: principal.ownerId, state: 'ready', mimeType: 'audio/wav', sizeBytes: 128 },
    selectedModel: selector, policySnapshot: createPolicySnapshot(settings) });
}
async function persistentCounts() {
  return (await owner.query(`SELECT (SELECT count(*)::integer FROM transcription.requests) AS requests,
    (SELECT count(*)::integer FROM transcription.attempts) AS attempts,
    (SELECT count(*)::integer FROM transcription.history_outbox WHERE state<>'acknowledged') AS occupied,
    (SELECT count(*)::integer FROM transcription.history_outbox WHERE state='reserved') AS reserved`)).rows[0];
}
const claim = () => store.execute('history.claim', { workerId: 'delivery-worker' });
const ack = value => store.execute('history.ack', { deliveryId: value.deliveryId, claimToken: value.claimToken });
const identity = value => ({ deliveryId: value.deliveryId, requestId: value.requestId, source: value.source, event: value.event });

// Новый store закрывает прежний pool; это restart границы хранения, а не заявление о проверке NATS owner.
test('real PostgreSQL history restart and delivery-fault boundaries', async t => {
  try {
    await migrate(owner, env.PGUSER, env.TRANSCRIPTION_TEST_APP_PGUSER, { transactionTimeoutMs: 5000 });
    await t.test('unacknowledged restart and transient failure replay identical fact without request or attempt changes', async () => {
      await reset(); const accepted = await accept(); const first = await claim();
      assert.equal(first.requestId, accepted.request.requestId);
      assert.equal(first.source, 'transcription');
      assert.equal(validateDto('HistoryAppendRequest', first.event), true);
      const before = await persistentCounts();
      const requestBefore = await store.execute('request.get', { principal, requestId: accepted.request.requestId });
      await reopen();
      assert.equal(await claim(), null, 'Restart must not bypass a live sender lease');
      // Отсутствующее подтверждение имитирует потерянный ответ доставки; срок задаёт БД, без sleep.
      await owner.query("UPDATE transcription.history_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1", [first.deliveryId]);
      const reclaimed = await claim();
      assert.deepEqual(identity(reclaimed), identity(first));
      assert.notEqual(reclaimed.claimToken, first.claimToken);
      await assert.rejects(ack(first), fault('STALE_CLAIM'));
      await store.execute('history.fail', { deliveryId: reclaimed.deliveryId, claimToken: reclaimed.claimToken, errorCode: 'DEPENDENCY_UNAVAILABLE' });
      await reopen();
      const repeated = await claim();
      assert.deepEqual(identity(repeated), identity(first));
      assert.notEqual(repeated.claimToken, reclaimed.claimToken);
      assert.deepEqual(await persistentCounts(), before);
      assert.deepEqual(await store.execute('request.get', { principal, requestId: accepted.request.requestId }), requestBefore);
      assert.deepEqual(await ack(repeated), { acknowledged: true });
      assert.equal(await claim(), null, 'Reserved terminal slot is not a ready delivery');
      assert.deepEqual(await persistentCounts(), { requests: 1, attempts: 0, occupied: 1, reserved: 1 });
    });
    await t.test('ack releases capacity; terminal fact survives reopening; permanent failure stays visible and unclaimable', async () => {
      await reset(); const accepted = await accept();
      const reserved = (await owner.query("SELECT delivery_id FROM transcription.history_outbox WHERE request_id=$1 AND state='reserved'", [accepted.request.requestId])).rows[0].delivery_id;
      await reopen();
      const acceptanceFact = await claim();
      await ack(acceptanceFact);
      const changed = await store.execute('settings.set', { principal, expectedRevision: 1, settings: { ...settings, policyVersion: 2 } });
      assert.equal(changed.revision, 2, 'Acknowledged admission releases one occupied slot');
      assert.deepEqual(await persistentCounts(), { requests: 1, attempts: 0, occupied: 2, reserved: 1 });
      await assert.rejects(store.execute('settings.set', { principal, expectedRevision: 2, settings: { ...settings, policyVersion: 3 } }), fault('OVERLOADED'));
      assert.equal((await store.execute('settings.get', { principal })).revision, 2);
      await ack(await claim());
      const cancelled = await store.execute('request.cancel', { principal, requestId: accepted.request.requestId, expectedRevision: accepted.request.revision });
      assert.equal(cancelled.request.taskState, 'cancelled');
      const terminalBefore = (await owner.query('SELECT event FROM transcription.history_outbox WHERE delivery_id=$1', [reserved])).rows[0].event;
      await reopen();
      const terminal = await claim();
      assert.equal(terminal.deliveryId, reserved);
      assert.deepEqual(terminal.event, terminalBefore);
      assert.equal(terminal.event.data.phase, 'cancel');
      assert.equal(terminal.event.data.outcome, 'cancelled');
      assert.equal(validateDto('HistoryAppendRequest', terminal.event), true);
      await store.execute('history.fail', { deliveryId: terminal.deliveryId, claimToken: terminal.claimToken, errorCode: 'HISTORY_REJECTED' });
      await reopen({ ...config, alertsCapacity: 100, historyCapacity: 10 }); // Недоступность должна отражать постоянный отказ, при свободной capacity.
      assert.equal(await claim(), null, 'Permanent rejection must not create endless automatic delivery claims');
      assert.deepEqual(await store.execute('health', {}), { available: false, storageAvailable: true, capacityAvailable: true, historyRejected: true });
      assert.deepEqual(await persistentCounts(), { requests: 1, attempts: 0, occupied: 1, reserved: 0 });
      const failed = (await owner.query('SELECT state,error_code,event FROM transcription.history_outbox WHERE delivery_id=$1', [reserved])).rows[0];
      assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, 'HISTORY_REJECTED');
      assert.deepEqual(failed.event, terminalBefore);
      assert.equal((await store.execute('request.get', { principal, requestId: accepted.request.requestId })).request.taskState, 'cancelled');
    });
  } finally { if (store) await store.close(); await owner.end(); }
});
