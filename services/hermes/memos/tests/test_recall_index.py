# ABOUTME: Проверяет полный индексный recall на настоящем изолированном PostgreSQL.
# ABOUTME: Синтетическая БД и явный DSN обязательны; рабочая память не используется.
import ast
import json
import os
from pathlib import Path
import unittest

DSN = os.environ.get('MEMOS_INDEX_TEST_DSN')
SOURCE = Path(os.environ.get('MEMOS_INDEX_SOURCE', '/nonexistent-recall-fixture.py'))


def load_store():
    """Загрузить только проверяемые методы PostgreSQL patch без запуска MemOS."""
    tree = ast.parse(SOURCE.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'PostgresGraphDB')
    names = {'_parse_row', '_init_recall_index', 'recall_index'}
    selected = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    if len(selected) != len(names):
        raise AssertionError('Index methods missing from composed patch')
    module = ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(
        name='Store', bases=[], keywords=[], body=selected, decorator_list=[])], type_ignores=[]))
    scope = {'json': json, 'Any': object}
    exec(compile(module, '<candidate-postgres-index>', 'exec'), scope)
    return scope['Store']


@unittest.skipUnless(DSN, 'Requires explicit isolated MEMOS_INDEX_TEST_DSN')
class RecallIndexPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        from psycopg2.pool import ThreadedConnectionPool
        cls.admin = psycopg2.connect(DSN)
        cls.admin.autocommit = True
        cls.pool = ThreadedConnectionPool(1, 4, DSN)
        cls.store = load_store()()
        cls.store.schema = 'fixture'
        def get():
            conn = cls.pool.getconn(); conn.autocommit = True; return conn
        def put(conn):
            if conn.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
                raise AssertionError('Recall index leaked a transaction')
            cls.pool.putconn(conn)
        cls.store._get_conn, cls.store._put_conn = get, put
        with cls.admin.cursor() as cur:
            cur.execute('CREATE SCHEMA fixture')
            cur.execute('CREATE TABLE fixture.memories (id text PRIMARY KEY, memory text NOT NULL, properties jsonb NOT NULL, embedding vector(768), user_name text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())')
            cur.execute('CREATE INDEX fixture_props ON fixture.memories USING gin(properties)')
            cur.execute('CREATE INDEX fixture_vectors ON fixture.memories USING ivfflat(embedding vector_cosine_ops) WITH (lists=1)')
            cls.store._init_recall_index(cur)

    @classmethod
    def tearDownClass(cls):
        cls.pool.closeall(); cls.admin.close()

    def setUp(self):
        with self.admin.cursor() as cur:
            cur.execute('TRUNCATE fixture.memories')
        self.scope = {'hermes_home_scope': 'profile', 'hermes_memory_epoch': 'epoch'}

    def add(self, identifier, text, *, event=None, logical=None, cube='main', author='alice',
            chunk=0, vector=(0, 1, 0), messages=None, date='2000-01-01T00:00:00Z', owner='owner', **extra):
        info = {**self.scope, 'hermes_kind': 'fact' if logical else 'native',
                'hermes_event_id': event or identifier, 'hermes_author_id': author,
                'hermes_cube': cube, 'hermes_memberships': [cube],
                'hermes_chunk_index': chunk, **extra}
        if logical:
            info['hermes_logical_id'] = logical
        if messages is not None:
            info['hermes_messages'] = messages
        with self.admin.cursor() as cur:
            cur.execute('INSERT INTO fixture.memories (id,memory,properties,embedding,user_name,created_at) VALUES (%s,%s,%s,%s::vector,%s,%s)',
                        (identifier, text, json.dumps({'user_id': owner, 'info': info}),
                         json.dumps([*vector, *([0]*765)]) if vector is not None else None, cube, date))

    def search(self, query='rare', **extra):
        return self.store.recall_index(cubes=['main', 'life_work', 'infra'], user_id='owner',
            scope=self.scope, author_id='alice', query=query, vector=[1, 0, 0, *([0]*765)], **extra)

    def test_profile_cubes_and_owners_are_isolated_in_real_index(self):
        self.add('a', 'rare shared marker', cube='profile-a__main', owner='owner-a')
        self.add('b', 'rare shared marker', cube='profile-b__main', owner='owner-b')
        for owner, cube, wanted in [('owner-a', 'profile-a__main', 'a'), ('owner-b', 'profile-b__main', 'b')]:
            result = self.store.recall_index(cubes=[cube], user_id=owner, scope=self.scope,
                author_id='alice', query='rare', vector=[1, 0, 0, *([0]*765)])
            self.assertEqual([item['id'] for item in result['memories']], [wanted])
            self.assertEqual(result['physical_count'], 1)
        result = self.store.recall_index(cubes=['profile-b__main'], user_id='owner-a', scope=self.scope,
            author_id='alice', query='rare', vector=[1, 0, 0, *([0]*765)])
        self.assertEqual(result['memories'], [])

    def test_full_text_crosses_parts_and_returns_one_original_without_rewriting_rows(self):
        messages = [{'role': 'user', 'content': 'x'*766+'rare_boundary_token'},
                    {'role': 'assistant', 'content': 'Exact complete answer'}]
        for i in range(70):
            self.add('part'+str(i), 'unrelated' if i == 0 else 'rare', event='long', chunk=i, messages=messages)
        self.add('copy', 'unrelated', event='long', cube='life_work', messages=messages)
        with self.admin.cursor() as cur:
            cur.execute('SELECT md5(string_agg(row_to_json(m)::text,\'\' ORDER BY id)) FROM fixture.memories m')
            before = cur.fetchone()[0]
        result = self.search('rare_boundary_token')
        self.assertEqual(result['physical_count'], 71)
        self.assertEqual(result['logical_count'], 1)
        self.assertEqual(result['matched_count'], 1)
        self.assertEqual(result['memories'][0]['metadata']['info']['hermes_messages'], messages)
        with self.admin.cursor() as cur:
            cur.execute('SELECT md5(string_agg(row_to_json(m)::text,\'\' ORDER BY id)) FROM fixture.memories m')
            self.assertEqual(cur.fetchone()[0], before)

    def test_semantic_match_in_later_part_is_not_limited_or_approximate(self):
        for i in range(45):
            self.add('a'+str(i), 'first', event=str(i), chunk=0)
            self.add('b'+str(i), 'last', event=str(i), chunk=1, vector=(1, 0, 0))
        result = self.search('no_literal_match')
        self.assertEqual(result['matched_count'], 45)
        self.assertEqual(result['physical_count'], 90)

    def test_old_rare_literal_and_short_terms_survive_unrelated_vectors(self):
        self.add('old', 'The identifier A_B is literal. Ёж.', date='1990-01-01')
        self.add('other', 'The identifier AXB is different')
        self.assertEqual([r['id'] for r in self.search('A_B')['memories']], ['old'])
        self.assertEqual([r['id'] for r in self.search('Ёж')['memories']], ['old'])
        self.assertEqual(self.search('absent')['memories'], [])


    def test_russian_inflections_and_stop_words_do_not_pull_unrelated_archive(self):
        self.add('topic', 'Выбрана одежда для поездки')
        self.add('unrelated', 'Мы говорили в комнате')
        self.assertEqual({r['id'] for r in self.search('Мы в поездке')['memories']}, {'topic'})

    def test_large_archive_returns_only_index_matches_and_reports_coverage(self):
        import time
        from psycopg2.extras import execute_values
        info = {**self.scope, 'hermes_kind': 'native', 'hermes_author_id': 'alice',
                'hermes_cube': 'main', 'hermes_memberships': ['main'], 'hermes_chunk_index': 0}
        with self.admin.cursor() as cur:
            execute_values(cur, 'INSERT INTO fixture.memories (id,memory,properties,embedding,user_name) VALUES %s',
                [(str(i), 'Unrelated ' + ('background text '*300),
                  json.dumps({'user_id': 'owner', 'info': {**info, 'hermes_event_id': str(i)}}),
                  json.dumps([0,1,0, *([0]*765)]), 'main') for i in range(5000)])
            cur.execute('ANALYZE fixture.memories')
            cur.execute("EXPLAIN (FORMAT JSON) SELECT id FROM fixture.memories "
                        "WHERE (properties->'info'->'hermes_chunk_index' IS NULL "
                        "OR properties->'info'->'hermes_chunk_index'='0'::jsonb) "
                        "AND fixture.brai_recall_text_v1(memory,properties) ILIKE ANY(%s)",
                        [['%singularneedle%']])
            self.assertIn('idx_brai_recall_text_v1', json.dumps(cur.fetchone()[0]))
        self.add('needle', 'singularneedle')
        started = time.monotonic()
        result = self.search('singularneedle')
        elapsed = time.monotonic() - started
        self.assertEqual(result['physical_count'], 5001)
        self.assertEqual(result['matched_count'], 1)
        self.assertEqual(result['memories'][0]['id'], 'needle')
        # Это диагностическое измерение; CI не зависит от скорости общего сервера.
        print('INDEX_5001_RECORDS_SECONDS', round(elapsed, 4), flush=True)


    def test_legacy_authorized_source_kind_is_not_silently_excluded(self):
        self.add('legacy', 'rare', hermes_kind='legacy-source')
        self.assertEqual([row['id'] for row in self.search()['memories']], ['legacy'])

    def test_index_tracks_update_and_delete_transactionally(self):
        self.add('one', 'rare')
        self.assertEqual(self.search()['matched_count'], 1)
        with self.admin.cursor() as cur:
            cur.execute("UPDATE fixture.memories SET memory='changed' WHERE id='one'")
        self.assertEqual(self.search()['matched_count'], 0)
        self.assertEqual(self.search('changed')['matched_count'], 1)
        with self.admin.cursor() as cur:
            cur.execute("DELETE FROM fixture.memories WHERE id='one'")
        self.assertEqual(self.search('changed')['logical_count'], 0)

    def test_scope_shared_infra_and_private_boundaries(self):
        self.add('own', 'rare')
        self.add('foreign', 'rare', author='bob')
        self.add('shared', 'rare', cube='infra', author='bob', hermes_shared_infra=True)
        self.add('private', 'rare', hermes_visibility='business_private')
        self.add('business', 'rare', hermes_business_scope='business')
        self.add('epoch', 'rare', hermes_memory_epoch='old')
        self.add('profile', 'rare', hermes_home_scope='other')
        self.assertEqual({r['id'] for r in self.search()['memories']}, {'own'})
        self.assertEqual({r['id'] for r in self.search(shared_infra=True)['memories']}, {'own', 'shared'})

    def test_incomplete_embedding_or_anchor_is_explicit_error(self):
        for vector, chunk in [(None, 0), ((0, 0, 0), 0), ((0, 1, 0), 1)]:
            with self.subTest(vector=vector, chunk=chunk):
                with self.admin.cursor() as cur: cur.execute('TRUNCATE fixture.memories')
                self.add('incomplete', 'rare', vector=vector, chunk=chunk)
                with self.assertRaisesRegex(ValueError, 'coverage incomplete'): self.search()

    def test_chronology_uses_source_dates_and_all_latest_ties(self):
        self.add('old', 'old', date='2000-01-01')
        self.add('new', 'new', date='2001-01-01')
        self.add('tie', 'tie', date='2001-01-01')
        self.add('fact', 'rare', logical='fact', hermes_source_event='old', date='2026-01-01')
        result = self.search(goal='latest_conversation')
        self.assertEqual({r['id'] for r in result['memories']}, {'new', 'tie'})
        fact = self.search()['memories'][0]
        self.assertTrue(fact['_source_date'].startswith('2000-01-01'))


    def test_latest_conversation_skips_only_actual_background_control_messages(self):
        self.add('real', 'real', date='2001-01-01',
                 messages=[{'role': 'user', 'content': 'Explain [ASYNC DELEGATION BATCH COMPLETE]'}])
        self.add('control', 'control', date='2002-01-01', messages=[{'role': 'user',
            'content': '[Alice] [ASYNC DELEGATION BATCH COMPLETE batch]\nA background fan-out unit you dispatched earlier finished.'}])
        self.assertEqual([r['id'] for r in self.search(goal='latest_conversation')['memories']], ['real'])

    def test_real_http_client_negotiates_index_and_does_not_fetch_archive(self):
        import importlib.util
        import logging
        from types import SimpleNamespace
        import threading
        import time
        from fastapi import FastAPI, APIRouter, HTTPException
        import uvicorn
        api_source = Path(os.environ['MEMOS_INDEX_API_SOURCE'])
        tree = ast.parse(api_source.read_text())
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in ('memory_capabilities', 'recall_index')]
        router = APIRouter(prefix='/product')
        self.store.memory_index_version = 1
        embedder = SimpleNamespace(embed=lambda texts: [[1,0,0,*([0]*765)] for _ in texts])
        scope = {'router': router, 'HTTPException': HTTPException, 'logger': logging.getLogger(__name__),
                 'naive_mem_cube': SimpleNamespace(text_mem=SimpleNamespace(graph_store=self.store, embedder=embedder))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])),
                     '<candidate-recall-api>', 'exec'), scope)
        app = FastAPI(); app.include_router(router)
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=0,
                                               log_level='critical', lifespan='off'))
        thread = threading.Thread(target=server.run, daemon=True); thread.start()
        try:
            for _ in range(100):
                if server.started: break
                time.sleep(.03)
            self.assertTrue(server.started)
            port = server.servers[0].sockets[0].getsockname()[1]
            client_scope = {'__name__': 'recall_client'}
            exec(compile(Path(os.environ['MEMOS_INDEX_CLIENT']).read_text(),
                         '<candidate-recall-client>', 'exec'), client_scope)
            client = client_scope['Client']({'base_url': 'http://127.0.0.1:'+str(port),
                                             'user_id': 'owner', 'cube_id': 'main'})
            self.add('http-source', 'rare')
            result = client.indexed_search('rare', cubes=['main'], scope=self.scope, author_id='alice')
            self.assertEqual(result['matched_count'], 1)
            self.assertEqual(result['memories'][0]['id'], 'http-source')
            self.assertEqual(client._index_version, 1)
        finally:
            server.should_exit = True; thread.join(5)


    def test_source_dates_preserve_earliest_scoped_date_across_parts_and_cubes(self):
        self.add('source-main', 'unrelated', event='trip', date='2001-01-01')
        self.add('source-part', 'unrelated', event='trip', chunk=1, date='2000-01-01')
        self.add('source-copy', 'unrelated', event='trip', cube='life_work', date='1999-01-01')
        self.add('foreign-author', 'unrelated', event='trip', author='bob', date='1990-01-01')
        self.add('foreign-epoch', 'unrelated', event='trip', date='1991-01-01',
                 hermes_memory_epoch='other')
        self.add('foreign-cube', 'unrelated', event='trip', cube='excluded', date='1992-01-01')
        for i in range(3):
            self.add('fact'+str(i), 'rare', logical='fact'+str(i), hermes_source_event='trip')
        result = self.search()
        self.assertEqual(len(result['memories']), 3)
        self.assertEqual({r['_source_date'] for r in result['memories']},
                         {'1999-01-01T00:00:00+00:00'})

    def test_missing_source_keeps_fact_and_shared_authors_have_separate_dates(self):
        self.add('alice-source', 'unrelated', event='same', date='2001-01-01')
        self.add('bob-source', 'unrelated', event='same', author='bob', cube='infra',
                 hermes_shared_infra=True, date='1998-01-01')
        self.add('alice-fact', 'rare', logical='alice', hermes_source_event='same')
        self.add('bob-fact', 'rare', logical='bob', author='bob', cube='infra',
                 hermes_shared_infra=True, hermes_source_event='same')
        self.add('orphan', 'rare', logical='orphan', hermes_source_event='missing')
        self.add('no-link', 'rare', logical='no-link')
        rows = {r['id']: r for r in self.search(shared_infra=True)['memories']}
        self.assertEqual(rows['alice-fact']['_source_date'], '2001-01-01T00:00:00+00:00')
        self.assertEqual(rows['bob-fact']['_source_date'], '1998-01-01T00:00:00+00:00')
        self.assertIsNone(rows['orphan']['_source_date'])
        self.assertIsNone(rows['no-link']['_source_date'])

    def test_source_date_plan_does_not_repeat_archive_scan_for_each_result(self):
        import hashlib
        import psycopg2.extensions
        # Large, poorly compressible metadata reproduces the real archive layout.
        payload = ''.join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(400))
        self.add('source', 'unrelated', event='source', date='1999-01-01',
                 messages=[{'role': 'user', 'content': payload}])
        for i in range(36):
            self.add('fact'+str(i), 'rare', logical=str(i), hermes_source_event='source',
                     messages=[{'role': 'user', 'content': payload}])
        with self.admin.cursor() as cur:
            cur.execute("""INSERT INTO fixture.memories
                (id,memory,properties,embedding,user_name)
                SELECT 'padding-'||n,'unrelated',
                    jsonb_build_object('user_id','owner','info',jsonb_build_object(
                        'hermes_home_scope','profile','hermes_memory_epoch','epoch',
                        'hermes_kind','native','hermes_event_id','padding-'||n,
                        'hermes_author_id','bob','hermes_cube','main','hermes_memberships',jsonb_build_array('main'))),
                    %s::vector,'main' FROM generate_series(1,1000) AS n""",
                        (json.dumps([0,1,*([0]*766)]),))
            cur.execute('ANALYZE fixture.memories')
        queries = []
        class RecordingCursor(psycopg2.extensions.cursor):
            def execute(self, query, variables=None):
                if query.lstrip().startswith('WITH'):
                    queries.append((query, variables))
                return super().execute(query, variables)
        conn = self.pool.getconn()
        factory, get, put = conn.cursor_factory, self.store._get_conn, self.store._put_conn
        conn.cursor_factory = RecordingCursor
        conn.autocommit = True
        self.store._get_conn = lambda: conn
        self.store._put_conn = lambda returned: None
        try:
            result = self.search()
            self.assertEqual(result['matched_count'], 36)
            self.assertEqual({r['_source_date'] for r in result['memories']},
                             {'1999-01-01T00:00:00+00:00'})
            with self.admin.cursor() as cur:
                cur.execute('EXPLAIN (ANALYZE, FORMAT JSON) '+queries[0][0], queries[0][1])
                plan = cur.fetchone()[0][0]['Plan']
            def walk(node):
                yield node
                for child in node.get('Plans', []):
                    yield from walk(child)
            repeated = [n for n in walk(plan) if n.get('Node Type') == 'Aggregate'
                        and n.get('Actual Loops', 0) > 1]
            self.assertEqual(repeated, [], 'Source dates repeatedly scan the archive per result')
            date_probes = [n for n in walk(plan)
                           if n.get('Index Name') == 'idx_brai_recall_source_date_v1']
            self.assertTrue(date_probes, 'Source dates must use the derived lookup index')
        finally:
            self.store._get_conn, self.store._put_conn = get, put
            conn.rollback()
            conn.cursor_factory = factory
            conn.autocommit = True
            self.pool.putconn(conn)


    def test_source_date_index_preserves_long_and_legacy_numeric_event_keys(self):
        for suffix,event in [('long','event-'+'x'*4000),('numeric',123)]:
            self.add('source-'+suffix, 'unrelated', event=event, date='1997-01-01')
            self.add('fact-'+suffix, 'rare', logical=suffix, hermes_source_event=str(event))
        result = self.search()
        self.assertEqual(result['matched_count'], 2)
        self.assertEqual({r['_source_date'] for r in result['memories']},
                         {'1997-01-01T00:00:00+00:00'})

    def test_document_lookup_keeps_opaque_pointer_for_verified_metadata(self):
        self.add('document', 'Delivered artifact:11111111-1111-4111-8111-111111111111')
        self.assertEqual(self.search('report topic', goal='locate_document')['matched_count'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
