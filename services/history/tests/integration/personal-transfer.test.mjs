// ABOUTME: Проверяет перенос History на настоящем PostgreSQL без изменения событий.
// ABOUTME: Только явная синтетическая БД; проверяет RLS, точность, отказ посередине и возврат.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../dist/migrate.js';
import { createPostgresStore } from '../../dist/storage.js';
import { createHistoryHandlers } from '../../dist/domain.js';
import { planTransfer, runPersonalTransfer } from '../../dist/personal-transfer.js';
const urls = ['OWNER', 'APP', 'WEB'].map(role => process.env['HISTORY_TEST_' + role + '_URL']);
for (const value of urls) {
  if (!value) throw Error('Explicit synthetic History URLs required');
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/brai_history_test') throw Error('Only loopback brai_history_test permitted');
}
const pools = urls.map(connectionString => new Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000 }));
const [owner, app, web] = pools, ownerRole = 'history_owner';
const scopeA = 'brai-personal-v1:' + 'a'.repeat(64), scopeB = 'brai-personal-v1:' + 'b'.repeat(64);
const proof = createHash('sha256').update('synthetic verified sender receipt').digest('hex');
const run = (phase, value) => runPersonalTransfer(owner, ownerRole, phase, value);
const migrateNow = () => migrate(owner, ownerRole, 'history_app', 'history_web');
const store = createPostgresStore(app, web);
const core = createHistoryHandlers(store, { cursorKey: 'synthetic-personal-history-cursor-key' });
const rawEvents = async () => (await owner.query("SELECT to_jsonb(e)::text AS value FROM history.events e ORDER BY source COLLATE \"C\",id")).rows;
const denied = error => error.code === '42501';
test('immutable History attribution and owner transfer lifecycle', async t => {
  try {
    await owner.query('DROP SCHEMA IF EXISTS history CASCADE');
    await migrateNow();
    const a = randomUUID(), b = randomUUID(), ambiguous = randomUUID();
    const exact = '{"large":123456789012345678901234567890.123456789012,"small":0.000000000001,"text":"synthetic"}';
    for (const id of [a, b, ambiguous]) {
      await owner.query("INSERT INTO history.events(id,source,type_id,occurred_at,recorded_at,actor_id,scope_type,scope_id,data) " +
        "VALUES($1,'legacy_fixture',101,'2026-10-05T12:34:56.123456Z','2026-10-06T12:34:56.654321Z','claimed-user-a','user','shared-technical-owner',$2::jsonb)", [id, exact]);
    }
    const original = await rawEvents();
    const inventory = await run('inventory');
    const input = { id: randomUUID(), sourceHash: inventory.sourceHash, assignments: [
      { source: 'legacy_fixture', id: a, scopeId: scopeA, proofSha256: proof },
      { source: 'legacy_fixture', id: b, scopeId: scopeB, proofSha256: proof },
    ] };
    const plan = planTransfer(inventory, input);
    await t.test('plan rejects unknown, duplicated, unproven and arbitrary scope assignments', async () => {
      for (const assignments of [
        [...input.assignments, input.assignments[0]],
        [{ ...input.assignments[0], id: randomUUID() }],
        [{ ...input.assignments[0], proofSha256: null }],
        [{ ...input.assignments[0], scopeId: 'shared-technical-owner' }],
      ]) assert.throws(() => planTransfer(inventory, { ...input, assignments }), /HISTORY_TRANSFER_INVALID/);
      assert.throws(() => planTransfer(inventory, { ...input, sourceHash: '0'.repeat(64) }), /HISTORY_TRANSFER_INVALID/);
      for (const pool of [app, web]) await assert.rejects(runPersonalTransfer(pool, ownerRole, 'inventory'), /REQUIRES_DATABASE_OWNER/);
      assert.deepEqual(await rawEvents(), original);
    });
    await t.test('mid-apply failure rolls back every binding and receipt, preserving exact numbers and dates', async () => {
      await owner.query("CREATE FUNCTION history.reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic binding failure'; END $$; " +
        "CREATE TRIGGER reject_binding BEFORE INSERT ON history.personal_event_bindings FOR EACH ROW EXECUTE FUNCTION history.reject_binding()");
      try {
        await assert.rejects(run('apply', plan), /HISTORY_TRANSFER_DATABASE_REFUSED/);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM history.personal_event_bindings')).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM history.personal_transfers')).rows[0].n, 0);
        assert.deepEqual(await rawEvents(), original);
      } finally { await owner.query('DROP TRIGGER reject_binding ON history.personal_event_bindings; DROP FUNCTION history.reject_binding()'); }
    });
    await t.test('concurrent apply and repeat use one receipt, and assigned plus archived equals source', async () => {
      const [first, repeated] = await Promise.all([run('apply', plan), run('apply', plan)]);
      assert.deepEqual(first, repeated);
      assert.equal(first.assigned, 2);
      assert.equal(first.archived, inventory.rows.length - 2);
      assert.equal(first.assigned + first.archived, first.sourceRows);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM history.personal_transfers')).rows[0].n, 1);
      assert.deepEqual(await rawEvents(), original);
      const raw = (await owner.query("SELECT data::text AS data FROM history.events WHERE source='legacy_fixture' AND id=$1", [a])).rows[0].data;
      assert.ok(raw.includes('123456789012345678901234567890.123456789012'));
      assert.ok(raw.includes('0.000000000001'));
    });
    await t.test('user reads only attributed originals; declared actor and technical owner prove nothing', async () => {
      const read = await core.getForWeb({ user_id: scopeA, source: 'legacy_fixture', id: a });
      assert.equal(read.event.id, a);
      assert.equal(read.event.scope_id, 'shared-technical-owner');
      assert.equal(read.event.occurred_at, '2026-10-05T12:34:56.123456Z');
      assert.equal(read.event.recorded_at, '2026-10-06T12:34:56.654321Z');
      assert.deepEqual((await core.listForWeb({ user_id: scopeA, filters: { source: 'legacy_fixture' } })).items.map(e => e.id), [a]);
      assert.deepEqual((await core.listForWeb({ user_id: scopeB, filters: { source: 'legacy_fixture' } })).items.map(e => e.id), [b]);
      for (const id of [b, ambiguous]) await assert.rejects(core.getForWeb({ user_id: scopeA, source: 'legacy_fixture', id }), error => error.code === 'NOT_FOUND');
      const archive = (await owner.query('SELECT id::text FROM history.personal_event_bindings WHERE scope_id IS NULL')).rows;
      assert.ok(archive.some(row => row.id === ambiguous));
      assert.equal((await web.query('SELECT count(*)::int AS n FROM history.personal_event_bindings')).rows[0].n, 0);
      for (const pool of [app, web]) {
        for (const sql of ['INSERT INTO history.personal_transfers(id,source_hash,plan_hash,state) VALUES(null,null,null,null)',
          'UPDATE history.personal_event_bindings SET scope_id=scope_id', 'DELETE FROM history.personal_event_bindings', 'TRUNCATE history.personal_event_bindings'])
          await assert.rejects(pool.query(sql), denied);
        await assert.rejects(pool.query('SELECT * FROM history.personal_transfers'), denied);
      }
      await assert.rejects(app.query('SELECT * FROM history.personal_event_bindings'), denied);
      await store.ready();
    });
    await t.test('schema repeat and verification preserve bindings without republishing any event', async () => {
      await migrateNow();
      assert.equal((await run('verify', plan)).assigned, 2);
      assert.deepEqual(await rawEvents(), original);
      const reordered = value => JSON.parse(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item));
      assert.equal((await run('verify', reordered(plan))).planHash, plan.planHash);
      assert.deepEqual(planTransfer(reordered(inventory), reordered(input)), plan);
      const tampered = structuredClone(plan); tampered.rows.find(row => row.scopeId === null).proofSha256 = proof;
      await assert.rejects(run('verify', tampered), /HISTORY_TRANSFER_INVALID|HISTORY_TRANSFER_PLAN_DRIFT/);
    });
    await t.test('rollback before new writes removes only bindings and is idempotent', async () => {
      const first = await run('rollback', plan);
      assert.equal(first.state, 'rolled_back');
      assert.deepEqual(await run('rollback', plan), first);
      assert.deepEqual(await rawEvents(), original);
      await assert.rejects(core.getForWeb({ user_id: scopeA, source: 'legacy_fixture', id: a }), error => error.code === 'NOT_FOUND');
      await assert.rejects(run('apply', plan), /HISTORY_TRANSFER_RECEIPT_CHANGED/);
    });
    await t.test('new user event blocks rollback and source drift blocks a stale plan', async () => {
      const next = planTransfer(await run('inventory'), { ...input, id: randomUUID() });
      await run('apply', next);
      await core.appendEvent({ id: randomUUID(), source: 'new_fixture', type_id: 101, scope_type: 'user', scope_id: scopeA,
        occurred_at: '2026-11-06T12:00:00.000001Z', data: { synthetic: true } });
      await assert.rejects(run('rollback', next), /HISTORY_TRANSFER_SOURCE_CHANGED/);
      await assert.rejects(run('apply', plan), /HISTORY_TRANSFER_SOURCE_CHANGED/);
      assert.equal((await core.getForWeb({ user_id: scopeA, source: 'legacy_fixture', id: a })).event.id, a);
    });
  } finally { await Promise.all(pools.map(pool => pool.end())); }
});
