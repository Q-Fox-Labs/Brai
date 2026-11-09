# ABOUTME: Проверяет provenance, карантин и транзакционный owner migration MemOS.
# ABOUTME: PostgreSQL tests требуют явный DSN одноразовой синтетической БД.
import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
import tracemalloc
import uuid

SPEC = importlib.util.spec_from_file_location('memos_owner_migration', Path(__file__).parents[1] / 'migration.py')
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)
DSN = os.environ.get('MEMOS_MIGRATION_TEST_DSN')
if DSN:
    import psycopg2


def config(schema='fixture', runtime='memos_fixture_runtime'):
    """Вернуть синтетическую конфигурацию без настоящих секретов."""
    return {'version': 1, 'dsn': DSN or 'unused', 'schema': schema, 'runtimeRoles': [runtime],
            'runId': 'run-test', 'freezeFile': '/protected/freeze.json',
            'mapping': {author: {'userId': 'user-' + author, 'profileId': 'profile-' + author,
                        'homeScope': 'scope-' + author, 'memoryEpoch': 'epoch-' + author,
                        'authorId': author, 'cubes': {'main': 'profile-' + author + '__main', 'archive': 'profile-' + author + '__archive'}}
                        for author in ('11', '22')},
            'quarantine': {'userId': 'quarantine', 'profileId': 'quarantine-profile',
                           'homeScope': 'quarantine-scope', 'memoryEpoch': 'quarantine-epoch'},
            'verifiedRows': {}}


def row(memory_id, author='11', **info):
    """Создать исходник с embeddings, датами и исходной metadata."""
    return {'id': memory_id, 'memory': 'Свидетельство ' + memory_id, 'user_name': 'main',
            'properties': {'user_id': 'legacy-root', 'custom': {'nested': [1, True, None]},
                           'info': {'hermes_author_id': author, 'hermes_event_id': memory_id,
                                    'hermes_messages': [{'role': 'user', 'content': 'Слова'}], **info}},
            'embedding': '[0.1,0.2,0.3]', 'created_at': '2025-01-01T00:00:00+00:00',
            'updated_at': '2025-02-01T00:00:00+00:00'}


def attest(cfg, rows):
    """Аттестовать синтетические строки как проверенный owner preflight."""
    cfg['verifiedRows'] = {r['id']: {'authorId': r['properties']['info']['hermes_author_id'],
                                    'rowHash': migration.canonical_hash(r), 'evidenceRefs': ['synthetic-journal']}
                           for r in rows if r['properties']['info']['hermes_author_id'] in cfg['mapping']}


class PureMigrationTests(unittest.TestCase):
    def test_precise_json_hash_and_duplicate_keys(self):
        a = migration._parse_json('{"n":0.123456789012345678901}')
        b = migration._parse_json('{"n":0.123456789012345678902}')
        self.assertNotEqual(migration.canonical_hash(a), migration.canonical_hash(b))
        self.assertEqual(migration._json(a), '{"n":0.123456789012345678901}')
        with self.assertRaises(migration.MigrationError):
            migration._parse_json('{"n":1,"n":2}')
        with self.assertRaises(migration.MigrationError):
            migration.load_protected_json('/tmp/untrusted-private.json')

    def test_hash_does_not_buffer_complete_large_archive(self):
        payload = 'x' * (1024 * 1024)
        archive = [{'payload': payload} for _ in range(32)]
        tracemalloc.start()
        try:
            migration.canonical_hash(archive)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 16 * 1024 * 1024)

    def test_hash_is_key_order_independent_and_includes_embeddings(self):
        original = row('a')
        reordered = dict(reversed(list(original.items())))
        self.assertEqual(migration.canonical_hash(original), migration.canonical_hash(reordered))
        reordered['embedding'] = '[0.9,0.2,0.3]'
        self.assertNotEqual(migration.canonical_hash(original), migration.canonical_hash(reordered))

    def test_author_metadata_without_verified_source_is_quarantined(self):
        cfg, original = config(), row('a')
        plan = migration.build_plan([original], [], cfg)
        self.assertEqual(plan['summary']['assigned'], 0)
        self.assertEqual(plan['rows'][0]['properties']['user_id'], 'quarantine')
        self.assertTrue(plan['rows'][0]['properties']['info']['hermes_quarantined'])
        self.assertEqual(plan['rows'][0]['user_name'], 'quarantine-profile__main')
        self.assertEqual(plan['rows'][0]['properties']['info']['hermes_cube'], 'quarantine-profile__main')
        self.assertEqual(original['properties']['user_id'], 'legacy-root')

    def test_content_mentions_do_not_assign_or_change_author(self):
        cfg, original = config(), row('a')
        original['memory'] = 'Упоминание пользователя 22 и administrator'
        attest(cfg, [original])
        self.assertEqual(migration.classify_rows([original], cfg), {'a': '11'})
        original['memory'] += ' changed after preflight'
        self.assertEqual(migration.classify_rows([original], cfg), {'a': None})

    def test_mixed_messages_and_derived_chain_are_quarantined(self):
        cfg = config()
        a = row('a', hermes_messages=[{'role': 'user', 'sender_id': '11'}, {'role': 'user', 'sender_id': '22'}])
        b = row('b', hermes_source_ids=['a'])
        c = row('c', hermes_source_ids=['b'])
        attest(cfg, [a, b, c])
        self.assertEqual(migration.classify_rows([c, b, a], cfg), {'c': None, 'b': None, 'a': None})

    def test_shared_copies_unknown_sources_and_mixed_events_quarantine(self):
        cfg = config()
        rows = [row('a', hermes_event_id='shared'), row('b', '22', hermes_event_id='shared'),
                row('c', hermes_source_ids=['missing']), row('d', hermes_source_event='missing-event')]
        attest(cfg, rows)
        self.assertTrue(all(a is None for a in migration.classify_rows(rows, cfg).values()))

    def test_only_same_author_edges_survive_and_original_payload_is_exact(self):
        cfg = config()
        rows = [row('a'), row('b'), row('c', '22'), row('unknown', 'multiple_or_unknown')]
        attest(cfg, rows)
        edges = [{'id': i, 'source_id': a, 'target_id': b, 'edge_type': 'rel'}
                 for i, (a, b) in enumerate([('a', 'b'), ('a', 'c'), ('unknown', 'unknown'), ('a', 'missing')])]
        plan = migration.build_plan(rows, edges, cfg)
        self.assertEqual([e['id'] for e in plan['kept']], [0])
        for before, after in zip(rows, plan['rows']):
            for field in ('id', 'memory', 'embedding', 'created_at', 'updated_at'):
                self.assertEqual(before[field], after[field])
            self.assertEqual(before['properties']['custom'], after['properties']['custom'])
            self.assertEqual(before['properties']['info']['hermes_messages'], after['properties']['info']['hermes_messages'])
            self.assertEqual(before['properties']['info']['hermes_author_id'], after['properties']['info']['hermes_author_id'])
        self.assertEqual(plan['rows'][0]['properties']['user_id'], 'user-11')
        self.assertEqual(migration.build_plan(rows[::-1], edges[::-1], cfg)['summary'], plan['summary'])

    def test_cube_rename_keeps_primary_and_memberships_consistent(self):
        cfg = config()
        original = row('a', hermes_cube='archive', hermes_primary_cube='archive',
                       hermes_memberships=['archive', 'main'])
        original['user_name'] = 'archive'
        attest(cfg, [original])
        migrated = migration.build_plan([original], [], cfg)['rows'][0]
        self.assertEqual(migrated['user_name'], 'profile-11__archive')
        self.assertEqual(migrated['properties']['info']['hermes_cube'], 'profile-11__archive')
        self.assertEqual(migrated['properties']['info']['hermes_primary_cube'], 'profile-11__archive')
        self.assertEqual(migrated['properties']['info']['hermes_memberships'], ['profile-11__archive', 'profile-11__main'])
        self.assertEqual(migration._ownership_patch(migrated)[1]['hermes_primary_cube'], 'profile-11__archive')

    def test_conflicting_profiles_rejected(self):
        for key in ('userId', 'profileId', 'homeScope'):
            cfg = config()
            cfg['mapping']['22'][key] = cfg['mapping']['11'][key]
            if key == 'homeScope':
                cfg['mapping']['22']['memoryEpoch'] = cfg['mapping']['11']['memoryEpoch']
            with self.assertRaises(migration.MigrationError):
                migration.validate_config(cfg)
        cfg = config()
        cfg['quarantine']['userId'] = cfg['mapping']['11']['userId']
        with self.assertRaises(migration.MigrationError):
            migration.validate_config(cfg)


@unittest.skipUnless(DSN, 'Requires explicit isolated MEMOS_MIGRATION_TEST_DSN')
class PostgresMigrationTests(unittest.TestCase):
    def setUp(self):
        suffix = uuid.uuid4().hex[:12]
        self.schema, self.runtime = 'migration_' + suffix, 'migration_runtime_' + suffix
        self.cfg = config(self.schema, self.runtime)
        self.db = psycopg2.connect(DSN)
        self.db.autocommit = False
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f'CREATE ROLE {self.runtime} NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS')
                cur.execute(f'CREATE SCHEMA {self.schema}')
                cur.execute(f'CREATE TABLE {self.schema}.memories (id text PRIMARY KEY,memory text NOT NULL,properties jsonb NOT NULL,embedding real[],user_name text,created_at timestamptz,updated_at timestamptz)')
                cur.execute(f'CREATE TABLE {self.schema}.edges (id serial PRIMARY KEY,source_id text NOT NULL,target_id text NOT NULL,edge_type text NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(source_id,target_id,edge_type))')
                for value in [row('a'), row('b'), row('c', '22'), row('unknown', 'multiple_or_unknown')]:
                    cur.execute(f'INSERT INTO {self.schema}.memories VALUES (%s,%s,%s::jsonb,%s,%s,%s,%s)',
                                (value['id'], value['memory'], json.dumps(value['properties']), [0.1, 0.2, 0.3], value['user_name'], value['created_at'], value['updated_at']))
                for source, target in [('a', 'b'), ('a', 'c'), ('a', 'missing'), ('unknown', 'a')]:
                    cur.execute(f'INSERT INTO {self.schema}.edges(source_id,target_id,edge_type) VALUES (%s,%s,%s)', (source, target, 'rel'))
        inventory = migration.run_phase(self.db, self.cfg, 'inventory')
        self.original = inventory
        attest(self.cfg, [r['row'] for r in inventory['rows']])
        self.plan = migration.run_phase(self.db, self.cfg, 'plan')

    def tearDown(self):
        self.db.rollback()
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f'DROP SCHEMA IF EXISTS {self.schema}_brai_owner CASCADE')
                cur.execute(f'DROP SCHEMA IF EXISTS {self.schema} CASCADE')
                cur.execute(f'DROP ROLE {self.runtime}')
        self.db.close()

    def apply(self):
        return migration.run_phase(self.db, self.cfg, 'apply', frozen=True, preflight_hash=self.plan['preflightHash'])

    def test_apply_inventory_verify_idempotency_and_closed_acl(self):
        self.assertEqual(self.apply()['state'], 'applied')
        self.assertEqual(self.apply()['state'], 'applied')
        self.assertEqual(migration.run_phase(self.db, self.cfg, 'verify')['assigned'], 3)
        inventory = migration.run_phase(self.db, self.cfg, 'inventory')
        self.assertEqual(len(inventory['edges']), 1)
        original = {r['id']: r['row'] for r in self.original['rows']}
        for item in inventory['rows']:
            for field in ('memory', 'embedding', 'created_at', 'updated_at'):
                self.assertEqual(item['row'][field], original[item['id']][field])
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f'SET LOCAL ROLE {self.runtime}')
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    cur.execute(f'SELECT * FROM {self.schema}_brai_owner.memories')

    def test_changed_source_and_missing_freeze_leave_no_archive(self):
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, self.cfg, 'apply', preflight_hash=self.plan['preflightHash'])
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"UPDATE {self.schema}.memories SET memory='new source' WHERE id='a'")
        with self.assertRaises(migration.MigrationError):
            self.apply()
        with self.db:
            with self.db.cursor() as cur:
                cur.execute('SELECT to_regnamespace(%s)', (self.schema + '_brai_owner',))
                self.assertIsNone(cur.fetchone()[0])

    def test_rollback_preserves_new_rows_and_edges_and_is_idempotent(self):
        self.apply()
        with self.db:
            with self.db.cursor() as cur:
                for memory_id in ('new-a', 'new-b'):
                    cur.execute(f'INSERT INTO {self.schema}.memories VALUES (%s,%s,%s::jsonb,%s,%s,now(),now())', (memory_id, 'new data', '{"user_id":"new-user"}', [1, 2], 'main'))
                cur.execute(f"INSERT INTO {self.schema}.edges(source_id,target_id,edge_type) VALUES ('new-a','new-b','new')")
        before = migration.run_phase(self.db, self.cfg, 'inventory')
        expected_new = [r for r in before['rows'] if r['id'].startswith('new-')]
        outcome = migration.run_phase(self.db, self.cfg, 'rollback', frozen=True, preflight_hash=self.plan['preflightHash'])
        self.assertEqual(outcome['newRows'], 2)
        self.assertEqual(migration.run_phase(self.db, self.cfg, 'rollback', frozen=True, preflight_hash=self.plan['preflightHash'])['state'], 'rolled_back')
        after = migration.run_phase(self.db, self.cfg, 'inventory')
        self.assertEqual([r for r in after['rows'] if r['id'].startswith('new-')], expected_new)
        self.assertEqual([r for r in after['rows'] if not r['id'].startswith('new-')], self.original['rows'])
        self.assertEqual(len(after['edges']), len(self.original['edges']) + 1)

    def test_changed_migrated_row_blocks_entire_rollback(self):
        self.apply()
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"UPDATE {self.schema}.memories SET memory='new write' WHERE id='a'")
        before = migration.run_phase(self.db, self.cfg, 'inventory')
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, self.cfg, 'rollback', frozen=True, preflight_hash=self.plan['preflightHash'])
        self.assertEqual(migration.run_phase(self.db, self.cfg, 'inventory'), before)

    def test_exact_jsonb_numeric_preserved_and_cas_detects_precise_new_write(self):
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"UPDATE {self.schema}.memories SET properties=jsonb_set(properties,'{{precise}}','0.123456789012345678901'::jsonb) WHERE id='a'")
        inventory = migration.run_phase(self.db, self.cfg, 'inventory')
        attest(self.cfg, [r['row'] for r in inventory['rows']])
        self.plan = migration.run_phase(self.db, self.cfg, 'plan')
        self.apply()
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"SELECT (properties->'precise')::text FROM {self.schema}.memories WHERE id='a'")
                self.assertEqual(cur.fetchone()[0], '0.123456789012345678901')
                cur.execute(f"UPDATE {self.schema}.memories SET properties=jsonb_set(properties,'{{precise}}','0.123456789012345678902'::jsonb) WHERE id='a'")
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, self.cfg, 'rollback', frozen=True, preflight_hash=self.plan['preflightHash'])
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"SELECT (properties->'precise')::text FROM {self.schema}.memories WHERE id='a'")
                self.assertEqual(cur.fetchone()[0], '0.123456789012345678902')

    def test_second_run_and_new_edges_touching_old_rows_fail_closed(self):
        self.apply()
        cfg = copy.deepcopy(self.cfg)
        cfg['runId'] = 'other-run'
        second_plan = migration.run_phase(self.db, cfg, 'plan')
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, cfg, 'apply', frozen=True, preflight_hash=second_plan['preflightHash'])
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f"INSERT INTO {self.schema}.edges(source_id,target_id,edge_type) VALUES ('b','c','new')")
        before = migration.run_phase(self.db, self.cfg, 'inventory')
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, self.cfg, 'rollback', frozen=True, preflight_hash=self.plan['preflightHash'])
        self.assertEqual(migration.run_phase(self.db, self.cfg, 'inventory'), before)

    def test_archive_acl_drift_and_runtime_owner_bypass_fail_closed(self):
        cfg = copy.deepcopy(self.cfg)
        with self.db:
            with self.db.cursor() as cur:
                cur.execute('SELECT current_user')
                cfg['runtimeRoles'] = [cur.fetchone()[0]]
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, cfg, 'apply', frozen=True, preflight_hash=self.plan['preflightHash'])
        self.apply()
        with self.db:
            with self.db.cursor() as cur:
                cur.execute(f'GRANT SELECT ON {self.schema}_brai_owner.memories TO {self.runtime}')
        with self.assertRaises(migration.MigrationError):
            migration.run_phase(self.db, self.cfg, 'verify')


if __name__ == '__main__':
    unittest.main()
