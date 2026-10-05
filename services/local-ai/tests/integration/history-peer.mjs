// ABOUTME: Принимает настоящий путь local-ai outbox → NATS → public history query.
// ABOUTME: Фазы down, recovery и pressure используют только собственную синтетическую запись и собственные UUID.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { connect } from 'nats';
import { createHistoryDeliveryWorker } from '../../dist/adapters/history/index.js';
import { createPostgresStore } from '../../dist/storage/postgres.js';

const REQUIRED = [
  'HISTORY_PEER_READY', 'HISTORY_PEER_PHASE', 'HISTORY_PEER_HISTORY_STATE', 'HISTORY_PEER_STATE_FILE',
  'HISTORY_PEER_DATABASE_URL', 'HISTORY_PEER_EXPECTED_DATABASE', 'HISTORY_PEER_EXPECTED_APP_ROLE',
  'HISTORY_PEER_LOCAL_NATS_URL', 'HISTORY_PEER_LOCAL_NATS_USER', 'HISTORY_PEER_LOCAL_NATS_PASSWORD',
  'HISTORY_PEER_LOCAL_NATS_INBOX_PREFIX', 'HISTORY_PEER_QUERY_NATS_URL', 'HISTORY_PEER_QUERY_NATS_USER',
  'HISTORY_PEER_QUERY_NATS_PASSWORD', 'HISTORY_PEER_QUERY_NATS_INBOX_PREFIX',
  'HISTORY_PEER_OUTBOX_CAPACITY', 'HISTORY_PEER_QUERY_TIMEOUT_MS', 'HISTORY_PEER_BATCH_SIZE',
  'HISTORY_PEER_LEASE_MS', 'HISTORY_PEER_RETRY_DELAY_MS', 'HISTORY_PEER_POLL_INTERVAL_MS',
  'HISTORY_PEER_REQUEST_TIMEOUT_MS', 'HISTORY_PEER_PHASE_TIMEOUT_MS',
];
const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
if (missing.length) throw new Error(`Missing required history fixture inputs: ${missing.join(', ')}`);
if (process.env.HISTORY_PEER_READY !== 'verified') {
  throw new Error('HISTORY_PEER_READY must be verified by the release fixture checks.');
}

function configInteger(name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`);
  return value;
}
function localOrigin(name, expectedPort) {
  let url;
  try { url = new URL(process.env[name]); } catch { throw new Error(`Invalid ${name}.`); }
  if (url.protocol !== 'nats:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== String(expectedPort) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must identify this acceptance fixture on localhost:${expectedPort}.`);
  }
  return url.toString();
}
function parseDatabaseUrl() {
  let url;
  try { url = new URL(process.env.HISTORY_PEER_DATABASE_URL); } catch { throw new Error('Invalid HISTORY_PEER_DATABASE_URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '19472' || url.pathname !== '/brai_local_ai_acceptance_local_ai' || url.search || url.hash
    || decodeURIComponent(url.username) !== 'laa_local_ai_app') {
    throw new Error('HISTORY_PEER_DATABASE_URL must identify this fixture database using its app role.');
  }
  if (process.env.HISTORY_PEER_EXPECTED_DATABASE !== 'brai_local_ai_acceptance_local_ai'
    || process.env.HISTORY_PEER_EXPECTED_APP_ROLE !== 'laa_local_ai_app') {
    throw new Error('Expected database and role must match the isolated local-ai acceptance fixture.');
  }
  return url.toString();
}
function requiredIdentity(name, value, expected) {
  if (value !== expected) throw new Error(`${name} must be ${expected}.`);
}
const phase = process.env.HISTORY_PEER_PHASE;
if (!['seed-down', 'recover-up', 'pressure-permanent'].includes(phase)) {
  throw new Error('HISTORY_PEER_PHASE must be seed-down, recover-up, or pressure-permanent.');
}
requiredIdentity('HISTORY_PEER_HISTORY_STATE', process.env.HISTORY_PEER_HISTORY_STATE, phase === 'seed-down' ? 'down' : 'up');
requiredIdentity('HISTORY_PEER_LOCAL_NATS_USER', process.env.HISTORY_PEER_LOCAL_NATS_USER, 'local_ai');
requiredIdentity('HISTORY_PEER_QUERY_NATS_USER', process.env.HISTORY_PEER_QUERY_NATS_USER, 'fixture');
const localNatsUrl = localOrigin('HISTORY_PEER_LOCAL_NATS_URL', 19473);
const queryNatsUrl = localOrigin('HISTORY_PEER_QUERY_NATS_URL', 19473);
const databaseUrl = parseDatabaseUrl();
const outboxCapacity = configInteger('HISTORY_PEER_OUTBOX_CAPACITY', 2);
if (outboxCapacity !== 2) throw new Error('HISTORY_PEER_OUTBOX_CAPACITY must be 2 for the isolated synthetic pressure phase.');
const queryTimeoutMs = configInteger('HISTORY_PEER_QUERY_TIMEOUT_MS', 1, 2_147_483_647);
const batchSize = configInteger('HISTORY_PEER_BATCH_SIZE', 1, 1000);
const leaseMs = configInteger('HISTORY_PEER_LEASE_MS', 1, 2_147_483_647);
const retryDelayMs = configInteger('HISTORY_PEER_RETRY_DELAY_MS');
const pollIntervalMs = configInteger('HISTORY_PEER_POLL_INTERVAL_MS');
const requestTimeoutMs = configInteger('HISTORY_PEER_REQUEST_TIMEOUT_MS', 1, 10_000);
const phaseTimeoutMs = configInteger('HISTORY_PEER_PHASE_TIMEOUT_MS');
if (!Number.isSafeInteger(batchSize * requestTimeoutMs) || leaseMs <= batchSize * requestTimeoutMs) {
  throw new Error('HISTORY_PEER_LEASE_MS must exceed batch size times request timeout.');
}
if (!isAbsolute(process.env.HISTORY_PEER_STATE_FILE)) throw new Error('HISTORY_PEER_STATE_FILE must be an absolute path below /tmp.');
const stateFile = resolve(process.env.HISTORY_PEER_STATE_FILE);
if (!stateFile.startsWith('/tmp/')) throw new Error('HISTORY_PEER_STATE_FILE must be an owned file below /tmp.');

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: queryTimeoutMs, statement_timeout: queryTimeoutMs });
let localNats;
let queryNats;

function event({ id, operationId, ownerId, outcome, phase: eventPhase }) {
  return {
    id,
    type_id: 1201,
    occurred_at: '2026-10-05T00:00:00.000Z',
    actor_id: ownerId,
    scope_type: 'user',
    scope_id: ownerId,
    object_type: 'operation',
    object_id: operationId,
    data: {
      operation: 'invoke', modelId: 'history-peer-synthetic', outcome, operationId,
      phase: eventPhase,
    },
  };
}
function manifestIds(state) {
  for (const key of ['acceptedEventId', 'terminalEventId', 'operationId']) {
    assert.match(state[key], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `invalid ${key}`);
  }
  assert.notEqual(state.acceptedEventId, state.terminalEventId);
  assert.equal(state.ownerId, `history-peer-${state.operationId}`);
}
async function readState(expectedPhase) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.version, 1);
  assert.equal(state.phase, expectedPhase);
  manifestIds(state);
  return state;
}
async function writeNewState(state) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const file = await open(stateFile, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8'); }
  finally { await file.close(); }
}
async function replaceState(state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8'); }
  finally { await file.close(); }
  await rename(temporary, stateFile);
}
async function connectNats(url, user, pass, inboxPrefix, name) {
  return connect({
    servers: url, user, pass, inboxPrefix, maxReconnectAttempts: 0,
    timeout: requestTimeoutMs, name,
  });
}
async function request(nc, subject, body, timeout = requestTimeoutMs) {
  const message = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout });
  const headers = message.headers;
  const hasCode = headers?.has('Nats-Service-Error') ?? false;
  const hasStatus = headers?.has('Nats-Service-Error-Code') ?? false;
  if (hasCode !== hasStatus) throw new Error(`Malformed public history error headers for ${subject}.`);
  const code = hasCode ? headers.get('Nats-Service-Error') : null;
  const status = hasStatus ? headers.get('Nats-Service-Error-Code') : null;
  if (hasCode && (!code || !status)) throw new Error(`Empty public history error headers for ${subject}.`);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data)); }
  catch { throw new Error(`Malformed public history response for ${subject}.`); }
  return { value, code, status };
}
function assertNoServiceError(reply, subject) {
  assert.equal(reply.code, null, `${subject} returned a service error (${reply.code ?? 'unknown'}).`);
  assert.equal(reply.status, null, `${subject} returned an error status.`);
}
async function checkPostgresIdentity() {
  const identity = (await pool.query('SELECT current_database() AS database,current_user AS role')).rows[0];
  assert.equal(identity.database, process.env.HISTORY_PEER_EXPECTED_DATABASE);
  assert.equal(identity.role, process.env.HISTORY_PEER_EXPECTED_APP_ROLE);
}
function deliveryWorker(store) {
  return createHistoryDeliveryWorker({
    nats: localNats, outbox: store, batchSize, leaseMs, retryDelayMs, pollIntervalMs, requestTimeoutMs,
  });
}
async function waitForEmpty(store) {
  const deadline = Date.now() + phaseTimeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await store.status();
    if (status.reserved === 0 && status.pending === 0 && status.sending === 0) return status;
    if (status.permanentlyFailed > 0) assert.fail(`outbox has ${status.permanentlyFailed} permanently failed synthetic event(s); error=${status.lastErrorCode}`);
    await delay(pollIntervalMs);
  }
  assert.fail(`outbox did not drain before phase timeout; status=${JSON.stringify(status)}`);
}
async function fetchOwnEvent(ownerId, id) {
  const reply = await request(queryNats, 'brai.history.v1.query.get', { user_id: ownerId, source: 'local_ai', id });
  assertNoServiceError(reply, 'brai.history.v1.query.get');
  assert.ok(reply.value && reply.value.event && typeof reply.value.event === 'object');
  return reply.value.event;
}
function assertEventContent(actual, expected, { changedOccurredAt = false } = {}) {
  assert.equal(actual.id, expected.id);
  assert.equal(actual.source, 'local_ai');
  assert.equal(actual.type_id, expected.type_id);
  if (changedOccurredAt) assert.match(actual.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  else assert.equal(actual.occurred_at, '2026-10-05T00:00:00.000000Z');
  assert.equal(actual.actor_id, expected.actor_id);
  assert.equal(actual.scope_type, 'user');
  assert.equal(actual.scope_id, expected.scope_id);
  assert.equal(actual.object_type, 'operation');
  assert.equal(actual.object_id, expected.object_id);
  assert.deepEqual(actual.data, expected.data);
  assert.match(actual.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}
async function phaseSeedDown(store) {
  const initial = await store.status();
  assert.deepEqual(initial, { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null },
    'the dedicated acceptance outbox must be empty before this peer run');
  const operationId = randomUUID();
  const state = {
    version: 1, phase: 'seeded-down', operationId, ownerId: `history-peer-${operationId}`,
    acceptedEventId: randomUUID(), terminalEventId: randomUUID(),
  };
  manifestIds(state);
  await writeNewState(state);
  const accepted = event({ id: state.acceptedEventId, operationId, ownerId: state.ownerId, outcome: 'accepted', phase: 'accepted' });
  await store.transaction((tx) => tx.outbox.appendAdmission(accepted, { operationId, terminalEventId: state.terminalEventId }));

  const worker = deliveryWorker(store);
  try { assert.equal(await worker.runOnce(), 1); }
  finally { await worker.stop(); }
  const afterAttempt = await store.status();
  assert.equal(afterAttempt.reserved, 1, 'the upfront terminal ID must remain reserved while the operation is unfinished');
  assert.equal(afterAttempt.pending, 1, 'history outage must retain the accepted fact for retry');
  assert.equal(afterAttempt.sending, 0);
  assert.equal(afterAttempt.permanentlyFailed, 0);
  assert.equal(afterAttempt.lastErrorCode, 'HISTORY_UNAVAILABLE');
  state.phase = 'seeded-down';
  await replaceState(state);
  return { phase, acceptedEventId: state.acceptedEventId, terminalEventId: state.terminalEventId, retryablePending: afterAttempt.pending, reserved: afterAttempt.reserved };
}
async function phaseRecoverUp(store) {
  const state = await readState('seeded-down');
  const before = await store.status();
  assert.equal(before.reserved, 1);
  assert.equal(before.pending, 1);
  assert.equal(before.sending, 0);
  assert.equal(before.permanentlyFailed, 0);
  const recoveredCount = await store.recoverInterrupted();
  assert.equal(recoveredCount, 1, 'fresh-process recovery must convert exactly this run’s own reservation');
  const afterRecovery = await store.status();
  assert.equal(afterRecovery.reserved, 0);
  assert.equal(afterRecovery.pending, 2, 'accepted and recovered terminal facts must both be pending');

  const worker = deliveryWorker(store);
  worker.start();
  try { await waitForEmpty(store); }
  finally { await worker.stop(); }

  const acceptedExpected = event({ id: state.acceptedEventId, operationId: state.operationId, ownerId: state.ownerId, outcome: 'accepted', phase: 'accepted' });
  const accepted = await fetchOwnEvent(state.ownerId, state.acceptedEventId);
  assertEventContent(accepted, acceptedExpected);
  const acceptedAgain = await fetchOwnEvent(state.ownerId, state.acceptedEventId);
  assert.equal(acceptedAgain.recorded_at, accepted.recorded_at, 'history get must return the original recorded_at');

  const terminal = await fetchOwnEvent(state.ownerId, state.terminalEventId);
  assert.equal(terminal.id, state.terminalEventId, 'recovery must use the upfront terminal event ID');
  assert.equal(terminal.data.outcome, 'unknown', 'storage recovery represents an interrupted operation as unknown');
  const terminalExpected = event({ id: state.terminalEventId, operationId: state.operationId, ownerId: state.ownerId,
    outcome: terminal.data.outcome, phase: 'accepted' });
  terminalExpected.data.errorCode = 'INTERNAL';
  assertEventContent(terminal, terminalExpected, { changedOccurredAt: true });
  const terminalAgain = await fetchOwnEvent(state.ownerId, state.terminalEventId);
  assert.equal(terminalAgain.recorded_at, terminal.recorded_at, 'repeated public get must preserve terminal recorded_at');

  const listed = await request(queryNats, 'brai.history.v1.query.list', {
    user_id: state.ownerId, filters: { source: 'local_ai' }, limit: 100,
  });
  assertNoServiceError(listed, 'brai.history.v1.query.list');
  assert.deepEqual(listed.value.items.map((item) => item.id).sort(), [state.acceptedEventId, state.terminalEventId].sort(),
    'the synthetic owner scope must contain exactly one accepted and one recovered event');

  const duplicate = await request(localNats, 'brai.history.v1.append.local_ai', {
    id: state.acceptedEventId, ...Object.fromEntries(Object.entries(acceptedExpected).filter(([key]) => key !== 'id')),
  });
  assertNoServiceError(duplicate, 'brai.history.v1.append.local_ai idempotent retry');
  assert.equal(duplicate.value.event.id, accepted.id);
  assert.equal(duplicate.value.event.source, 'local_ai');
  assert.equal(duplicate.value.event.recorded_at, accepted.recorded_at, 'idempotent append must preserve the first recorded_at');
  const changed = { ...acceptedExpected, data: { ...acceptedExpected.data, modelId: 'history-peer-conflict-probe' } };
  const conflict = await request(localNats, 'brai.history.v1.append.local_ai', {
    id: changed.id, ...Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'id')),
  });
  assert.equal(conflict.code, 'EVENT_ID_CONFLICT');
  assert.equal(conflict.status, '409');
  assert.equal(conflict.value?.error?.code ?? conflict.value?.code, 'EVENT_ID_CONFLICT');

  state.phase = 'verified-up';
  await replaceState(state);
  const final = await store.status();
  assert.deepEqual(final, { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null });
  return { phase, acceptedEventId: state.acceptedEventId, terminalEventId: state.terminalEventId, recoveredReservations: recoveredCount, delivered: 2, idempotentRecordedAtStable: true, conflictCode: conflict.code };
}

async function phasePressurePermanent(store) {
  const state = await readState('verified-up');
  const initial = await store.status();
  assert.deepEqual(initial, { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null });

  const operationId = randomUUID();
  const ownerId = `history-peer-${operationId}`;
  const acceptedEventId = randomUUID();
  const terminalEventId = randomUUID();
  const accepted = event({ id: acceptedEventId, operationId, ownerId, outcome: 'accepted', phase: 'accepted' });
  await store.transaction((tx) => tx.outbox.appendAdmission(accepted, { operationId, terminalEventId }));
  const overflow = event({ id: randomUUID(), operationId: randomUUID(), ownerId, outcome: 'accepted', phase: 'accepted' });
  await assert.rejects(store.transaction((tx) => tx.outbox.append(overflow)), (error) => error?.code === 'BUSY');
  const full = await store.status();
  assert.equal(full.reserved, 1);
  assert.equal(full.pending, 1);
  assert.equal(full.sending, 0);
  assert.equal(full.permanentlyFailed, 0, 'rejected capacity admission must not create a partial outbox row');

  assert.equal(await store.recoverInterrupted(), 1, 'the fresh pressure phase recovers only its own reservation');
  assert.equal((await store.status()).pending, 2);
  const worker = deliveryWorker(store);
  worker.start();
  try { await waitForEmpty(store); }
  finally { await worker.stop(); }

  const conflicting = event({
    id: state.acceptedEventId, operationId: state.operationId, ownerId: state.ownerId,
    outcome: 'accepted', phase: 'accepted',
  });
  conflicting.data.modelId = 'history-peer-conflict-probe';
  await store.transaction((tx) => tx.outbox.append(conflicting));
  const permanentWorker = deliveryWorker(store);
  try { assert.equal(await permanentWorker.runOnce(), 1); }
  finally { await permanentWorker.stop(); }
  const failed = await store.status();
  assert.equal(failed.reserved, 0);
  assert.equal(failed.pending, 0);
  assert.equal(failed.sending, 0);
  assert.equal(failed.permanentlyFailed, 1, 'public EVENT_ID_CONFLICT must remain visible in the outbox status');
  assert.equal(failed.lastErrorCode, 'HISTORY_REJECTED');

  state.phase = 'verified-permanent';
  state.pressureOperationId = operationId;
  state.pressureAcceptedEventId = acceptedEventId;
  state.pressureTerminalEventId = terminalEventId;
  await replaceState(state);
  return {
    phase, pressureOperationId: operationId, pressureAcceptedEventId: acceptedEventId,
    pressureTerminalEventId: terminalEventId, capacity: outboxCapacity,
    backpressureCode: 'BUSY', permanentlyFailed: failed.permanentlyFailed, lastErrorCode: failed.lastErrorCode,
  };
}

async function main() {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const realStateDirectory = await realpath(dirname(stateFile));
  if (!realStateDirectory.startsWith('/tmp/')) throw new Error('HISTORY_PEER_STATE_FILE directory must resolve below /tmp.');
  const stateInfo = await lstat(stateFile).catch(() => null);
  if (phase === 'seed-down') assert.equal(stateInfo, null, 'remove only this run’s old synthetic state file before a new down phase');
  else assert.ok(stateInfo?.isFile() && !stateInfo.isSymbolicLink(), 'continuation phase requires its own regular state file');
  await checkPostgresIdentity();
  localNats = await connectNats(localNatsUrl, process.env.HISTORY_PEER_LOCAL_NATS_USER,
    process.env.HISTORY_PEER_LOCAL_NATS_PASSWORD, process.env.HISTORY_PEER_LOCAL_NATS_INBOX_PREFIX, 'local_ai_history_peer');
  queryNats = await connectNats(queryNatsUrl, process.env.HISTORY_PEER_QUERY_NATS_USER,
    process.env.HISTORY_PEER_QUERY_NATS_PASSWORD, process.env.HISTORY_PEER_QUERY_NATS_INBOX_PREFIX, 'history_peer_query');
  const store = createPostgresStore(pool, { outboxCapacity, queryTimeoutMs });
  const result = phase === 'seed-down' ? await phaseSeedDown(store)
    : phase === 'recover-up' ? await phaseRecoverUp(store)
      : await phasePressurePermanent(store);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

try { await main(); }
finally {
  await Promise.allSettled([localNats?.drain(), queryNats?.drain()]);
  await pool.end();
}
