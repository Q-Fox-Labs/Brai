// ABOUTME: Проверяет реальный JetStream, Services API, повторы после отказа и границу commit/ack.
// ABOUTME: Работает только с disposable loopback ресурсами и синтетическими данными.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AckPolicy, DiscardPolicy, RetentionPolicy, StorageType } from 'nats';
import { brokerConfigured, setup, broker, eventually } from './fixture.mjs';
import { runNats, streamName, durableName, ingestMessage } from '../../dist/nats.js';
import { createLoadGate } from '../../dist/load.js';
import { createAlertsHandlers } from '../../dist/domain.js';
import { createPostgresStore } from '../../dist/storage.js';
import { subjects, validateResponse, validateChanged } from '../../contracts/index.mjs';
let f, admin, sender, web, service, runtime, gate;
const integration = (name, work) => test(name, { skip: !brokerConfigured, timeout: 50_000 }, work);
const event = (override = {}) => ({ id: randomUUID(), service_id: 'fixture opaque source', type_id: 5, scope_type: 'user', scope_id: 'user-alice', title: 'Синтетический результат', text: '', occurred_at: '2026-10-06T12:00:00Z', ...override });
const body = value => Buffer.from(JSON.stringify(value));
async function rows() { return Number((await f.owner.query('SELECT count(*) FROM alerts.notifications')).rows[0].count); }
async function queued() { return (await (await admin.jetstreamManager()).streams.info(streamName)).state.messages; }
async function start(handlers = f.handlers) { service = await broker('alerts'); gate = createLoadGate(); runtime = await runNats(service, handlers, gate); }
async function stop() { if (runtime) { gate.stopAccepting(); await runtime.stop(); await gate.drain(); runtime = undefined; } await service?.close(); service = undefined; }
before(async () => {
  if (!brokerConfigured) return;
  f = await setup(user_id => service?.publish(subjects.changed, body({ user_id })));
  [admin, sender, web] = await Promise.all([broker('fixture'), broker('publisher'), broker('web')]);
});
beforeEach(async () => { if (f) { await f.cleanup(); await (await admin.jetstreamManager()).streams.purge(streamName); } });
afterEach(async () => { await stop(); });
after(async () => { await Promise.all([admin?.close(), sender?.close(), web?.close(), f?.close()]); });

integration('offline ingress persists, then serves own/global DTOs and privacy-safe changed signals', async () => {
  const signals = web.subscribe(subjects.changed);
  const first = event(), common = event({ scope_type: 'system', scope_id: 'global', type_id: 1 });
  await sender.jetstream().publish(subjects.ingest, body(first));
  await sender.jetstream().publish(subjects.ingest, body(common));
  assert.equal(await queued(), 2); assert.equal(await rows(), 0);
  await start();
  await eventually(async () => await rows() === 2 && await queued() === 0);
  const listReply = await web.request(subjects.list, body({ user_id: 'user-alice' }), { timeout: 2000 });
  const list = JSON.parse(listReply.string()); assert.equal(validateResponse('list', list), true); assert.equal(list.items.length, 2);
  assert.equal(listReply.headers?.get('Nats-Service-Error') ?? '', '');
  const newReply = await web.request(subjects.summary, body({ user_id: 'brand-new-user' }), { timeout: 2000 });
  assert.equal(JSON.parse(newReply.string()).unread_count, 1);
  assert.equal((await f.owner.query('SELECT count(*) FROM alerts.read_marks')).rows[0].count, '0');
  const readReply = await web.request(subjects.read, body({ user_id: 'user-alice', service_id: common.service_id, id: common.id }), { timeout: 2000 });
  assert.equal(validateResponse('read', JSON.parse(readReply.string())), true);
  await eventually(async () => signals.getReceived() >= 3);
  signals.unsubscribe();
  const values = []; for await (const msg of signals) values.push(JSON.parse(msg.string()));
  assert.equal(values.every(validateChanged), true); assert.deepEqual(values.map(v => v.user_id), ['user-alice', null, 'user-alice']);
  const infoReply = await admin.request('$SRV.INFO.service_alerts', undefined, { timeout: 2000 });
  assert.equal(JSON.parse(infoReply.string()).endpoints.length, 5);
  for (const kind of ['PING', 'STATS']) assert.equal(JSON.parse((await admin.request(`$SRV.${kind}.service_alerts`, undefined, { timeout: 2000 })).string()).name, 'service_alerts');
});
integration('identical replay, conflict, malformed and unknown type receive correct ack/term handling', async () => {
  await start();
  const value = event();
  for (const input of [value, value, { ...value, title: 'conflict' }, event({ type_id: 999 })]) await sender.jetstream().publish(subjects.ingest, body(input));
  await sender.jetstream().publish(subjects.ingest, Buffer.from('{bad'));
  await eventually(async () => await queued() === 0);
  assert.equal(await rows(), 1);
  const invalid = await web.request(subjects.list, body({ user_id: 'user-alice', limit: 101 }), { timeout: 2000 });
  assert.equal(invalid.headers.get('Nats-Service-Error'), 'INVALID_ARGUMENT'); assert.equal(invalid.headers.get('Nats-Service-Error-Code'), '400');
  assert.deepEqual(JSON.parse(invalid.string()), { code: 'INVALID_ARGUMENT', message: 'INVALID_ARGUMENT', retryable: false });
  const oversized = await web.request(subjects.summary, Buffer.alloc(65537, 32), { timeout: 2000 });
  assert.equal(oversized.headers.get('Nats-Service-Error'), 'REQUEST_TOO_LARGE');
  const missing = await web.request(subjects.get, body({ user_id: 'user-bob', service_id: value.service_id, id: value.id }), { timeout: 2000 });
  assert.equal(missing.headers.get('Nats-Service-Error-Code'), '404');
});
integration('real PostgreSQL connection refusal leaves message pending, restart consumes after database recovery', async () => {
  const brokenURL = new URL(process.env.ALERTS_TEST_APP_DATABASE_URL); brokenURL.port = '1';
  const brokenPool = new Pool({ connectionString: brokenURL.href, connectionTimeoutMillis: 500 });
  const badStore = createPostgresStore(brokenPool, f.web);
  const badHandlers = createAlertsHandlers({ ...badStore, ready: () => f.handlers.ready() }, { cursorKey: Buffer.alloc(32, 7) });
  try {
    await start(badHandlers);
    const value = event(); await sender.jetstream().publish(subjects.ingest, body(value));
    await eventually(async () => (await (await admin.jetstreamManager()).consumers.info(streamName, durableName)).num_redelivered > 0, 6000);
    assert.equal(await rows(), 0); assert.equal(await queued(), 1);
    await stop(); await start();
    await eventually(async () => await rows() === 1 && await queued() === 0, 8000);
  } finally { await brokenPool.end(); }
});
integration('consumer crash after actual COMMIT and before ACK redelivers after ack_wait without duplicate record', async () => {
  service = await broker('alerts');
  const consumer = await service.jetstream().consumers.get(streamName, durableName);
  const value = event(); await sender.jetstream().publish(subjects.ingest, body(value));
  const delivery = await consumer.next({ expires: 1000 }); assert.ok(delivery);
  await f.handlers.ingest(JSON.parse(delivery.string()));
  assert.equal(await rows(), 1); assert.equal(await queued(), 1);
  await service.close(); service = undefined;
  await start();
  await eventually(async () => await queued() === 0, 35_000);
  assert.equal(await rows(), 1);
});
integration('response byte budget trims pages with cursor and semantic importance survives large payloads', async () => {
  for (let i = 0; i < 12; i++) await f.handlers.ingest(event({ data: { body: 'x'.repeat(50000) } }));
  await start();
  const reply = await web.request(subjects.list, body({ user_id: 'user-alice', limit: 100 }), { timeout: 2000 });
  assert.ok(reply.data.length <= 524288);
  const first = JSON.parse(reply.string()); assert.ok(first.items.length < 12); assert.ok(first.next_cursor);
  const next = JSON.parse((await web.request(subjects.list, body({ user_id: 'user-alice', limit: 100, cursor: first.next_cursor }), { timeout: 2000 })).string());
  assert.equal(first.items.length + next.items.length, 12);
});
integration('DiscardNew full-stream rejects new publish while retaining all accepted messages', async () => {
  const manager = await admin.jetstreamManager();
  const name = 'ALERTS_FULL_FIXTURE';
  const subject = 'brai.alerts.fixture.full';
  await manager.streams.add({ name, subjects: [subject], retention: RetentionPolicy.Workqueue, storage: StorageType.File, discard: DiscardPolicy.New, max_age: 0, max_bytes: 100000, max_msg_size: 65536 });
  try {
    const bytes = Buffer.alloc(40000, 97);
    await admin.jetstream().publish(subject, bytes); await admin.jetstream().publish(subject, bytes);
    await assert.rejects(admin.jetstream().publish(subject, bytes));
    assert.equal((await manager.streams.info(name)).state.messages, 2);
    assert.equal((await manager.streams.getMessage(name, { seq: 1 })).data.length, 40000);
  } finally { await manager.streams.delete(name); }
});
integration('real broker ACL rejects publisher user queries and web ingestion', async () => {
  await start();
  const denied = e => ['PERMISSIONS_VIOLATION', 'TIMEOUT'].includes(e.code);
  await assert.rejects(sender.request(subjects.summary, body({ user_id: 'arbitrary-user' }), { timeout: 300 }), denied);
  await assert.rejects(web.request(subjects.ingest, body(event()), { timeout: 300 }), denied);
  await assert.rejects(service.request('$JS.API.STREAM.PURGE.BRAI_ALERTS_INGEST_V1', body({}), { timeout: 300 }), denied);
  assert.equal(await queued(), 0);
});
