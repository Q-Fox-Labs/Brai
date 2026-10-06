// ABOUTME: Проверяет настоящий PostgreSQL: права, RLS, идемпотентность и snapshot прочтения.
// ABOUTME: Запускается только на disposable стенде; тесты не подключаются к production.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configured, setup, roles, eventually } from './fixture.mjs';
import { migrate } from '../../dist/migrate.js';
let f;
before(async () => { if (configured) f = await setup(); });
after(async () => { await f?.close(); });
beforeEach(async () => { await f?.cleanup(); });
const integration = (name, work) => test(name, { skip: !configured }, work);
const event = (overrides = {}) => ({ id: randomUUID(), service_id: 'opaque producer.ID', type_id: 5, scope_type: 'user', scope_id: 'user-alice', title: 'Готово', text: 'Синтетическое уведомление', data: {}, occurred_at: '2026-10-06T12:00:00.123456+03:00', ...overrides });
const summary = user_id => f.handlers.execute('summary', { user_id });

integration('concurrent replay commits one immutable row; different payload conflicts and unknown types reject', async () => {
  const input = event({ data: { z: '2', a: 1 } });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.handlers.ingest(input)));
  assert.equal(results.filter(r => r.inserted).length, 1);
  assert.equal((await f.owner.query('SELECT count(*) FROM alerts.notifications')).rows[0].count, '1');
  const { notification: first } = await f.handlers.execute('get', { user_id: 'user-alice', service_id: input.service_id, id: input.id });
  await f.handlers.ingest({ ...input, occurred_at: '2026-10-06T09:00:00.123456Z', data: { a: 1, z: '2' } });
  const { notification: replay } = await f.handlers.execute('get', { user_id: 'user-alice', service_id: input.service_id, id: input.id });
  assert.equal(replay.recorded_at, first.recorded_at);
  assert.equal(replay.occurred_at, '2026-10-06T09:00:00.123456Z');
  await assert.rejects(f.handlers.ingest({ ...input, title: 'changed' }), { code: 'EVENT_ID_CONFLICT' });
  await assert.rejects(f.handlers.ingest(event({ type_id: 999 })), { code: 'UNKNOWN_TYPE' });
});
integration('personal/global isolation, new users and individual explicit read marks', async () => {
  const personal = event(), common = event({ scope_type: 'system', scope_id: 'global', type_id: 1 }), other = event({ scope_id: 'user-bob' });
  for (const value of [personal, common, other]) await f.handlers.ingest(value);
  assert.equal((await summary('user-alice')).unread_count, 2);
  assert.equal((await summary('new-account')).unread_count, 1);
  assert.equal((await summary('user-bob')).unread_count, 2);
  await assert.rejects(f.handlers.execute('get', { user_id: 'user-alice', service_id: other.service_id, id: other.id }), { code: 'NOT_FOUND' });
  await assert.rejects(f.handlers.execute('read', { user_id: 'user-alice', service_id: other.service_id, id: other.id }), { code: 'NOT_FOUND' });
  await f.handlers.execute('list', { user_id: 'user-alice' });
  await f.handlers.execute('get', { user_id: 'user-alice', service_id: common.service_id, id: common.id });
  assert.equal((await summary('user-alice')).unread_count, 2);
  const result = await f.handlers.execute('read', { user_id: 'user-alice', service_id: common.service_id, id: common.id });
  assert.equal(result.unread_count, 1);
  await f.handlers.execute('read', { user_id: 'user-alice', service_id: common.service_id, id: common.id });
  assert.equal((await f.owner.query('SELECT count(*) FROM alerts.read_marks')).rows[0].count, '1');
  assert.equal((await summary('new-account')).unread_count, 1);
  const all = await f.handlers.execute('read_all', { user_id: 'user-alice' });
  assert.deepEqual(all, { unread_count: 0, category: null });
  assert.equal((await summary('user-bob')).unread_count, 2);
  assert.equal((await f.owner.query('SELECT count(*) FROM alerts.notifications')).rows[0].count, '3');
});
integration('SQL roles deny DDL, overwrite, deletes, catalogs and foreign read marks; empty context has no rows', async () => {
  const value = event(); await f.handlers.ingest(value);
  for (const pool of [f.app, f.web]) {
    for (const sql of ['CREATE TABLE public.forbidden(id integer)', 'UPDATE alerts.notifications SET title=title', 'DELETE FROM alerts.notifications', 'TRUNCATE alerts.notifications', "UPDATE alerts.sys_categories SET color='#000000'"]) await assert.rejects(pool.query(sql), e => e.code === '42501');
  }
  assert.equal((await f.web.query('SELECT count(*) FROM alerts.notifications')).rows[0].count, '0');
  const client = await f.web.connect();
  try {
    await client.query('BEGIN'); await client.query("SELECT set_config('app.user_id','user-alice',true)");
    await assert.rejects(client.query('INSERT INTO alerts.read_marks(user_id,service_id,id) VALUES($1,$2,$3)', ['user-bob', value.service_id, value.id]), e => e.code === '42501');
  } finally { await client.query('ROLLBACK'); client.release(); }
  await assert.rejects(f.web.query('INSERT INTO alerts.notifications(id,service_id,type_id,scope_type,scope_id,title,text,occurred_at) VALUES($1,$2,5,$3,$4,$5,$6,now())', [randomUUID(), 's', 'user', 'u', 't', '']), e => e.code === '42501');
  await assert.rejects(f.app.query('INSERT INTO alerts.notifications(id,service_id,type_id,scope_type,scope_id,title,text,occurred_at,recorded_at) VALUES($1,$2,5,$3,$4,$5,$6,now(),now())', [randomUUID(), 's', 'user', 'u', 't', '']), e => e.code === '42501');
});
integration('descending keyset is stable at equal microsecond timestamps and bound to user', async () => {
  const ids = [1, 2, 3].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const [i, id] of ids.entries()) await f.handlers.ingest(event({ id, service_id: i === 0 ? 'Z' : 'a' }));
  await f.owner.query("UPDATE alerts.notifications SET recorded_at='2026-10-06T09:00:00.123456Z'");
  const first = await f.handlers.execute('list', { user_id: 'user-alice', limit: 1 });
  assert.equal(first.items[0].id, ids[2]);
  const second = await f.handlers.execute('list', { user_id: 'user-alice', limit: 1, cursor: first.next_cursor });
  const third = await f.handlers.execute('list', { user_id: 'user-alice', limit: 1, cursor: second.next_cursor });
  assert.equal(second.items[0].id, ids[1]); assert.equal(third.items[0].id, ids[0]); assert.equal(third.next_cursor, null);
  await assert.rejects(f.handlers.execute('list', { user_id: 'user-bob', cursor: first.next_cursor }), { code: 'INVALID_CURSOR' });
});
integration('summary uses greatest importance then newest category with its actual color; repeat migration preserves edits', async () => {
  await f.owner.query("UPDATE alerts.sys_categories SET name='Свой заголовок',color='#123456' WHERE id=1");
  await migrate(f.owner, ...roles);
  assert.equal((await f.owner.query('SELECT name,color FROM alerts.sys_categories WHERE id=1')).rows[0].color, '#123456');
  await f.owner.query("INSERT INTO alerts.sys_categories VALUES(4,'custom_critical','Особые','', '#AABBCC',3) ON CONFLICT(id) DO NOTHING");
  await f.owner.query("INSERT INTO alerts.sys_types VALUES(7,4,'custom_failure','Особый сбой','') ON CONFLICT(id) DO NOTHING");
  const critical = event({ type_id: 1 }), custom = event({ type_id: 7 }), low = event({ type_id: 5 });
  for (const value of [critical, custom, low]) await f.handlers.ingest(value);
  const result = await summary('user-alice');
  assert.equal(result.category.id, 4); assert.equal(result.category.color, '#AABBCC'); assert.equal(result.category.importance, 3);
  await f.handlers.execute('read', { user_id: 'user-alice', service_id: custom.service_id, id: custom.id });
  assert.equal((await summary('user-alice')).category.color, '#123456');
  await f.owner.query("UPDATE alerts.sys_types SET category_id=3 WHERE id=1");
  await assert.rejects(migrate(f.owner, ...roles), /ALERTS_SEED_TYPE_CONFLICT/);
  await f.owner.query('UPDATE alerts.sys_types SET category_id=1 WHERE id=1');
  await f.owner.query("UPDATE alerts.sys_categories SET name='Критические',color='#FF3B30' WHERE id=1");
});
integration('read_all statement snapshot excludes notification committed during blocked mark insertion', async () => {
  await f.handlers.ingest(event());
  const blocker = await f.owner.connect();
  const observer = await f.web.connect();
  try {
    await f.owner.query("CREATE OR REPLACE FUNCTION alerts.test_mark_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(70482329); RETURN NEW; END $$");
    await f.owner.query('CREATE TRIGGER test_mark_block BEFORE INSERT ON alerts.read_marks FOR EACH ROW EXECUTE FUNCTION alerts.test_mark_block()');
    await blocker.query('SELECT pg_advisory_lock(70482329)');
    const reading = f.handlers.execute('read_all', { user_id: 'user-alice' });
    await eventually(async () => {
      const result = await observer.query('SELECT 1 FROM pg_locks WHERE locktype=$1 AND objid=70482329 AND NOT granted', ['advisory']);
      return result.rowCount > 0;
    });
    const future = event({ scope_type: 'system', scope_id: 'global' });
    await f.handlers.ingest(future);
    await blocker.query('SELECT pg_advisory_unlock(70482329)');
    assert.equal((await reading).unread_count, 1);
    const { notification } = await f.handlers.execute('get', { user_id: 'user-alice', service_id: future.service_id, id: future.id });
    assert.equal(notification.read_at, null);
  } finally {
    await blocker.query('SELECT pg_advisory_unlock(70482329)').catch(() => {}); blocker.release(); observer.release();
    await f.owner.query('DROP TRIGGER IF EXISTS test_mark_block ON alerts.read_marks');
    await f.owner.query('DROP FUNCTION IF EXISTS alerts.test_mark_block()');
  }
});
