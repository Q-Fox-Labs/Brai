// ABOUTME: Проверяет настоящие транзакции, fencing, reserves и права PostgreSQL helper.
// ABOUTME: Запускается отдельно только с protected fixtures собственной loopback БД; секреты не выводятся.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPostgresStore, createPolicySnapshot, canonicalHash, StorageFault } from '../../dist/helper/storage/index.js';
import { migrate } from '../../dist/helper/migrate.js';

const env = process.env;
if (env.PGHOST !== '127.0.0.1' || env.PGDATABASE !== 'brai_transcription_acceptance' || !env.PGUSER || !env.PGPASSWORD || !env.TRANSCRIPTION_TEST_APP_PGUSER || !env.TRANSCRIPTION_TEST_APP_PGPASSWORD || !Number.isInteger(Number(env.PGPORT)) || Number(env.PGPORT) <= 0) throw new Error('Explicit isolated transcription PostgreSQL fixture inputs required');
const owner = new Pool({ connectionTimeoutMillis: 5000, query_timeout: 5000, max: 4 });
const app = new Pool({ host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE,
  user: env.TRANSCRIPTION_TEST_APP_PGUSER, password: env.TRANSCRIPTION_TEST_APP_PGPASSWORD, connectionTimeoutMillis: 5000, query_timeout: 5000, max: 8 });
const config = { alertsCapacity: 100, historyCapacity: 50, requestLeaseMs: 60000, historyLeaseMs: 60000, transactionTimeoutMs: 5000, recoveryBatchSize: 2 };
const store = createPostgresStore(app, config);
const selector = { modelId: 'synthetic/whisper', revision: 'fixture:1', profileId: 'transcribe/fixture' };
const settings = { policyVersion: 1, defaultLocalModel: selector, allowReplacement: false };
const principal = { scopeType: 'user', scopeId: 'synthetic-user', ownerId: 'synthetic-user', permissions: ['transcription:use', 'transcription:settings:write'] };
const snapshot = createPolicySnapshot(settings);
const fault = code => error => error instanceof StorageFault && error.code === code;
const future = () => new Date(Date.now() + 60000).toISOString();
const input = overrides => ({ clientIdempotencyKey: randomUUID(), audioArtifactId: randomUUID(), requestedModel: null, deadlineAt: null, ...overrides });
const accepted = params => ({ principal, input: params, artifact: { artifactId: params.audioArtifactId, ownerId: principal.ownerId, state: 'ready', mimeType: 'audio/wav', sizeBytes: 128 }, selectedModel: selector, policySnapshot: snapshot });
const get = requestId => store.execute('request.get', { principal, requestId });
const fence = (claim, attemptId = randomUUID()) => ({ requestId: claim.request.requestId, attemptId, claimToken: claim.claimToken, fenceGeneration: claim.fenceGeneration, expectedRevision: claim.revision });
const count = async table => Number((await owner.query(`SELECT count(*) AS n FROM transcription.${table}`)).rows[0].n);
async function reset() {
  await owner.query('TRUNCATE transcription.alerts_outbox,transcription.alerts_incidents,transcription.history_outbox,transcription.attempts,transcription.requests');
  await owner.query('UPDATE transcription.settings SET settings=$1,revision=1 WHERE singleton', [settings]);
}
async function start(params = input(), selectedModel = selector) {
  const result = await store.execute('request.accept', { ...accepted(params), selectedModel });
  const claim = await store.execute('request.claim', { workerId: 'worker' });
  assert.equal(claim.request.requestId, result.request.requestId);
  const dispatch = await store.execute('attempt.start', fence(claim));
  return { result, claim, dispatch };
}
function finish(claim, dispatch, overrides = {}) {
  return { ...fence(claim, dispatch.attempt.attemptId), expectedRevision: dispatch.request.revision, outcome: 'succeeded', actualModel: selector,
    durationMs: 123, usage: null, cost: null, errorCode: null, resultState: 'available', resultExpiresAt: future(), bufferOwnerInstanceId: 'coordinator-1', ...overrides };
}

test('isolated real PostgreSQL metadata storage', async t => {
  try {
    await t.test('repeatable owner migration preserves safe working grants and excludes DDL', async () => {
      await owner.query('DROP SCHEMA IF EXISTS transcription CASCADE');
      await migrate(owner, env.PGUSER, env.TRANSCRIPTION_TEST_APP_PGUSER, { transactionTimeoutMs: 5000 });
      await migrate(owner, env.PGUSER, env.TRANSCRIPTION_TEST_APP_PGUSER, { transactionTimeoutMs: 5000 });
      await store.ready();
      assert.equal(await count('migrations'), 2);
      for (const sql of ['CREATE TABLE transcription.forbidden(id integer)', 'CREATE TABLE public.forbidden(id integer)', 'DROP TABLE transcription.requests', 'TRUNCATE transcription.requests', 'INSERT INTO transcription.migrations(version) VALUES(3)']) {
        await assert.rejects(app.query(sql), error => error.code === '42501');
      }
      const ownership = (await owner.query("SELECT pg_get_userbyid(relowner) AS role FROM pg_class WHERE relnamespace='transcription'::regnamespace AND relkind='r'")).rows;
      assert.ok(ownership.every(row => row.role === env.PGUSER));
    });
    await t.test('concurrent admission records one request and reserves two stable facts', async () => {
      await reset(); const params = input(); const values = await Promise.all(Array.from({ length: 10 }, () => store.execute('request.accept', accepted(params))));
      assert.equal(values.filter(value => value.created).length, 1);
      assert.equal(new Set(values.map(value => value.request.requestId)).size, 1);
      assert.equal(await count('requests'), 1); assert.equal(await count('history_outbox'), 2);
      const repeat = await store.execute('request.accept', { ...accepted({ ...params, clientIdempotencyKey: params.clientIdempotencyKey.toUpperCase(), audioArtifactId: params.audioArtifactId.toUpperCase() }), artifact: { ...accepted(params).artifact, ownerId: 'other-owner' }, selectedModel: null, policySnapshot: { ...snapshot, version: 99 } });
      assert.equal(repeat.created, false); assert.deepEqual(repeat.request, values[0].request);
      await assert.rejects(store.execute('request.accept', accepted({ ...params, audioArtifactId: randomUUID() })), fault('IDEMPOTENCY_CONFLICT'));
      const hash = canonicalHash({ audioArtifactId: params.audioArtifactId, requestedModel: null, deadlineAt: null });
      assert.deepEqual((await store.execute('request.lookup', { principal, clientIdempotencyKey: params.clientIdempotencyKey, normalizedInputSha256: hash })).request, values[0].request);
      await assert.rejects(store.execute('request.lookup', { principal, clientIdempotencyKey: params.clientIdempotencyKey, normalizedInputSha256: 'f'.repeat(64) }), fault('IDEMPOTENCY_CONFLICT'));
      assert.equal((await store.execute('request.lookup', { principal: { ...principal, ownerId: 'other' }, clientIdempotencyKey: params.clientIdempotencyKey, normalizedInputSha256: hash })).request, null);
      await assert.rejects(store.execute('request.get', { principal: { ...principal, ownerId: 'other' }, requestId: values[0].request.requestId }), fault('NOT_FOUND'));
    });
    await t.test('capacity counts reserves and rolls back admission/settings without partial writes', async () => {
      await reset(); const small = createPostgresStore(app, { ...config, alertsCapacity: 100, historyCapacity: 2 });
      await small.execute('request.accept', accepted(input()));
      await assert.rejects(small.execute('request.accept', accepted(input())), fault('OVERLOADED'));
      assert.equal(await count('requests'), 1); assert.equal(await count('history_outbox'), 2);
      await assert.rejects(small.execute('settings.set', { principal, expectedRevision: 1, settings: { ...settings, policyVersion: 2 } }), fault('OVERLOADED'));
      assert.equal((await small.execute('settings.get', { principal })).revision, 1);
      assert.deepEqual(await small.execute('health', {}), { available: false, storageAvailable: true, capacityAvailable: false, historyRejected: false });
    });
    await t.test('history insert failure rolls back whole admission and releases key', async () => {
      await reset(); const params = input();
      await owner.query("CREATE FUNCTION transcription.reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER reject_fixture BEFORE INSERT ON transcription.history_outbox FOR EACH ROW EXECUTE FUNCTION transcription.reject_fixture()");
      try { await assert.rejects(store.execute('request.accept', accepted(params)), fault('STORAGE_UNAVAILABLE')); assert.equal(await count('requests'), 0); }
      finally { await owner.query('DROP TRIGGER reject_fixture ON transcription.history_outbox; DROP FUNCTION transcription.reject_fixture()'); }
      assert.equal((await store.execute('request.accept', accepted(params))).created, true);
    });
    await t.test('settings permission, version/CAS and immutable policy checks occur in transaction', async () => {
      await reset();
      await assert.rejects(store.execute('settings.set', { principal: { ...principal, permissions: ['transcription:use'] }, expectedRevision: 1, settings: { ...settings, policyVersion: 2 } }), fault('FORBIDDEN'));
      const result = await store.execute('settings.set', { principal, expectedRevision: 1, settings: { ...settings, policyVersion: 2 } });
      assert.equal(result.revision, 2); assert.equal(await count('history_outbox'), 1);
      await assert.rejects(store.execute('request.accept', accepted(input())), fault('STALE_REVISION'));
      await assert.rejects(store.execute('settings.set', { principal, expectedRevision: 1, settings: { ...settings, policyVersion: 3 } }), fault('STALE_REVISION'));
    });
    await t.test('claim renewal changes revision; expired old claim cannot start new invocation', async () => {
      await reset(); await store.execute('request.accept', accepted(input()));
      const first = await store.execute('request.claim', { workerId: 'worker-1' });
      const renewed = await store.execute('request.renew', { requestId: first.request.requestId, claimToken: first.claimToken, fenceGeneration: first.fenceGeneration, expectedRevision: first.revision });
      assert.equal(renewed.revision, first.revision + 1);
      await assert.rejects(store.execute('attempt.start', fence(first)), fault('STALE_REVISION'));
      await owner.query("UPDATE transcription.requests SET lease_expires_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(store.execute('attempt.start', fence(renewed)), fault('STALE_CLAIM'));
      const fresh = await store.execute('request.claim', { workerId: 'worker-2' });
      assert.equal(fresh.fenceGeneration, first.fenceGeneration + 1);
      const dispatch = await store.execute('attempt.start', fence(fresh));
      assert.equal(dispatch.created, true);
      await assert.rejects(store.execute('attempt.start', fence(fresh, dispatch.attempt.attemptId)), fault('STALE_REVISION'));
      assert.equal(await count('attempts'), 1);
    });
    await t.test('before-dispatch cancellation fills terminal slot; in-flight refusal preserves reply eligibility', async () => {
      await reset(); const acceptedResult = await store.execute('request.accept', accepted(input()));
      const cancelled = await store.execute('request.cancel', { principal, requestId: acceptedResult.request.requestId, expectedRevision: acceptedResult.request.revision });
      assert.equal(cancelled.accepted, true); assert.equal(cancelled.stopConfirmed, true); assert.equal(cancelled.request.taskState, 'cancelled');
      assert.equal((await owner.query("SELECT count(*)::integer AS n FROM transcription.history_outbox WHERE state='reserved'")).rows[0].n, 0);
      await reset(); const { claim, dispatch } = await start();
      const cancelledRunning = await store.execute('request.cancel', { principal, requestId: dispatch.request.requestId, expectedRevision: dispatch.request.revision });
      assert.equal(cancelledRunning.accepted, false); assert.equal(cancelledRunning.stopConfirmed, false); assert.equal(cancelledRunning.request.revision, dispatch.request.revision);
      const complete = await store.execute('attempt.finish', finish(claim, dispatch));
      assert.equal(complete.request.taskState, 'succeeded');
    });
    await t.test('terminal transaction rollback retains live attempt and reserved slot; exact costs survive', async () => {
      await reset(); const { claim, dispatch } = await start();
      await owner.query("CREATE FUNCTION transcription.reject_terminal_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state='reserved' AND NEW.state='pending' THEN RAISE EXCEPTION 'synthetic terminal rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_terminal_fixture BEFORE UPDATE ON transcription.history_outbox FOR EACH ROW EXECUTE FUNCTION transcription.reject_terminal_fixture()");
      try { await assert.rejects(store.execute('attempt.finish', finish(claim, dispatch)), fault('STORAGE_UNAVAILABLE')); assert.equal((await get(dispatch.request.requestId)).request.taskState, 'dispatching'); }
      finally { await owner.query('DROP TRIGGER reject_terminal_fixture ON transcription.history_outbox; DROP FUNCTION transcription.reject_terminal_fixture()'); }
      const amount = '12345678901234567890.1234567890';
      const complete = await store.execute('attempt.finish', finish(claim, dispatch, { cost: { amount, currency: 'USD' }, usage: { inputUnits: 123, outputUnits: null, unit: 'second' } }));
      assert.equal(complete.attempt.cost.amount, amount); assert.equal(complete.request.cost.amount, amount);
      assert.equal((await owner.query('SELECT cost_amount::text AS amount FROM transcription.attempts')).rows[0].amount, amount);
      assert.equal((await owner.query("SELECT count(*)::integer AS n FROM transcription.history_outbox WHERE state='reserved'")).rows[0].n, 0);
      await assert.rejects(store.execute('attempt.finish', finish(claim, dispatch)), fault('STALE_REVISION'));
    });
    await t.test('expired deadline and unavailable selected model yield terminal failure without imaginary invoke', async () => {
      for (const unavailable of [false, true]) {
        await reset(); const { claim, dispatch } = await start(input({ deadlineAt: '2000-01-01T00:00:00Z' }), unavailable ? null : selector);
        const result = await store.execute('attempt.finish', finish(claim, dispatch, { outcome: 'failed', actualModel: null, resultState: 'not_ready', resultExpiresAt: null, bufferOwnerInstanceId: null, durationMs: null, errorCode: unavailable ? 'MODEL_UNAVAILABLE' : 'DEADLINE_EXCEEDED' }));
        assert.equal(result.request.taskState, 'failed'); assert.equal(result.attempt.durationMs, null);
        assert.equal((await owner.query("SELECT count(*)::integer AS n FROM transcription.history_outbox WHERE state='reserved'")).rows[0].n, 0);
      }
    });
    await t.test('bounded recovery classifies expired intent and foreign/expired volatile buffers', async () => {
      await reset(); const one = await start();
      await owner.query("UPDATE transcription.requests SET lease_expires_at=clock_timestamp()-interval '1 second'");
      const unknown = await store.execute('recovery.run', { coordinatorInstanceId: 'coordinator-1' });
      assert.equal(unknown.dispatchingExpired, 1); assert.equal((await get(one.dispatch.request.requestId)).request.taskState, 'outcome_unknown');
      await assert.rejects(store.execute('attempt.finish', finish(one.claim, one.dispatch)), fault('STALE_REVISION'));
      await reset();
      for (let i = 0; i < 3; i++) { const value = await start(); await store.execute('attempt.finish', finish(value.claim, value.dispatch)); }
      const first = await store.execute('recovery.run', { coordinatorInstanceId: 'coordinator-2' });
      assert.equal(first.succeededBufferLost, 2);
      const second = await store.execute('recovery.run', { coordinatorInstanceId: 'coordinator-2' });
      assert.equal(second.succeededBufferLost, 1);
      assert.equal(await count('attempts'), 3);
      await reset(); const value = await start(); const complete = await store.execute('attempt.finish', finish(value.claim, value.dispatch));
      await owner.query("UPDATE transcription.requests SET metadata=jsonb_set(metadata,'{resultExpiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text))");
      await assert.rejects(store.execute('result.setState', { requestId: complete.request.requestId, expectedRevision: complete.request.revision, state: 'delivery_unknown', resultExpiresAt: '2000-01-01T00:00:00Z', bufferOwnerInstanceId: 'coordinator-1' }), fault('RESULT_UNAVAILABLE'));
      assert.equal((await store.execute('recovery.run', { coordinatorInstanceId: 'coordinator-1' })).resultsExpired, 1);
    });
    await t.test('history lease preserves immutable event, rejects stale sender and accounts permanent failure', async () => {
      await reset(); await store.execute('request.accept', accepted(input()));
      const first = await store.execute('history.claim', { workerId: 'sender-1' });
      await owner.query("UPDATE transcription.history_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE delivery_id=$1", [first.deliveryId]);
      const next = await store.execute('history.claim', { workerId: 'sender-2' });
      assert.equal(next.deliveryId, first.deliveryId); assert.deepEqual(next.event, first.event); assert.notEqual(next.claimToken, first.claimToken);
      await assert.rejects(store.execute('history.ack', { deliveryId: first.deliveryId, claimToken: first.claimToken }), fault('STALE_CLAIM'));
      await store.execute('history.fail', { deliveryId: next.deliveryId, claimToken: next.claimToken, errorCode: 'HISTORY_REJECTED' });
      assert.deepEqual(await store.execute('health', {}), { available: false, storageAvailable: true, capacityAvailable: true, historyRejected: true });
      assert.equal((await owner.query("SELECT count(*)::integer AS n FROM transcription.history_outbox WHERE state='failed'")).rows[0].n, 1);
    });
    await t.test('privacy and scope validation reject unsafe payload before persistent change', async () => {
      await reset(); const params = input();
      await assert.rejects(store.execute('request.accept', { ...accepted(params), text: 'private' }), fault('INVALID_ARGUMENT'));
      await assert.rejects(store.execute('request.accept', { ...accepted(params), principal: { ...principal, ownerId: 'private prose' } }), fault('INVALID_ARGUMENT'));
      assert.equal(await count('requests'), 0); assert.equal(await count('history_outbox'), 0);
    });
  } finally { await Promise.all([store.close(), owner.end()]); }
});
