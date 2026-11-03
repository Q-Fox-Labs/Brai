# ABOUTME: Проверяет bounded MemOS snapshot на настоящем изолированном PostgreSQL.
# ABOUTME: Загружает только проверяемые методы патча; fixture не имеет пользовательских данных.
import ast
import importlib.util
import json
import os
import threading
import time
import tracemalloc
import unittest
from pathlib import Path
from types import SimpleNamespace

DSN = os.environ.get('MEMOS_STREAM_TEST_DSN')
try:
    import psycopg2
    from psycopg2.extras import execute_values
    from psycopg2.pool import ThreadedConnectionPool
    from fastapi import APIRouter, FastAPI, HTTPException
    import uvicorn
except ImportError:
    if DSN:
        raise


ROOT = Path(os.environ.get('MEMOS_STREAM_SOURCE', '/nonexistent-unconfigured-memos-fixture'))
CLIENT_PATH = Path(os.environ['MEMOS_STREAM_CLIENT']) if os.environ.get('MEMOS_STREAM_CLIENT') else Path(__file__).resolve().parents[2] / 'extensions/plugins/memos-rest/client.py'


def load_store():
    tree = ast.parse((ROOT / 'graph_dbs/postgres.py').read_text())
    cls = next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='PostgresGraphDB')
    selected = [n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name in
                ('stream_memory','_parse_row','export_graph')]
    selected += [ast.Assign(targets=[ast.Name(id='memory_stream_version',ctx=ast.Store())],value=ast.Constant(1))]
    module = ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Store',bases=[],keywords=[],body=selected,decorator_list=[])],type_ignores=[]))
    scope = {'json':json,'Any':object}
    exec(compile(module,'<patched-postgres>','exec'),scope)
    return scope['Store']


@unittest.skipUnless(DSN, 'Requires explicit isolated MEMOS_STREAM_TEST_DSN and composed MEMOS_STREAM_SOURCE')
class StreamPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin=psycopg2.connect(DSN); cls.admin.autocommit=True
        with cls.admin.cursor() as cur:
            cur.execute('CREATE SCHEMA fixture')
            cur.execute('CREATE TABLE fixture.memories (id text PRIMARY KEY, memory text NOT NULL, properties jsonb NOT NULL, user_name text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())')
            cur.execute('CREATE TABLE fixture.edges (source_id text, target_id text, edge_type text)')
            execute_values(cur,'INSERT INTO fixture.memories (id,memory,properties,user_name) VALUES %s',[
                (str(i),'Evidence '+('x'*4096),json.dumps({'user_id':'owner','session_id':'session',
                    'memory_type':['WorkingMemory','PreferenceMemory','ToolSchemaMemory','SkillMemory'][i%4],
                    'info':{'event':'same' if i<3 else 'different','number':i,'unicode':'Тема','flag':True,'items':['x','y']}}),'cube')
                for i in range(2048)] + [('foreign-owner','other',json.dumps({'user_id':'other'}),'cube'),
                                        ('foreign-cube','other',json.dumps({'user_id':'owner'}),'other')])
        cls.pool=ThreadedConnectionPool(1,8,DSN)
        cls.store=load_store()();cls.store.schema='fixture';cls.store.user_name='cube'
        cls.returned=0
        def get():
            conn=cls.pool.getconn();conn.autocommit=True;return conn
        def put(conn):
            assert conn.get_transaction_status()==psycopg2.extensions.TRANSACTION_STATUS_IDLE
            cls.returned+=1;cls.pool.putconn(conn)
        cls.store._get_conn=get;cls.store._put_conn=put
        cls.app=FastAPI();router=APIRouter(prefix='/product')
        scope={'router':router,'HTTPException':HTTPException,'naive_mem_cube':SimpleNamespace(text_mem=SimpleNamespace(graph_store=cls.store))}
        tree=ast.parse((ROOT/'api/routers/server_router.py').read_text())
        funcs=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('memory_capabilities','get_memory_stream')]
        exec(compile(ast.fix_missing_locations(ast.Module(body=funcs,type_ignores=[])),'<patched-routes>','exec'),scope)
        cls.app.include_router(router)
        cls.server=uvicorn.Server(uvicorn.Config(cls.app,host='127.0.0.1',port=18432,log_level='critical',lifespan='off'))
        cls.thread=threading.Thread(target=cls.server.run,daemon=True);cls.thread.start()
        for _ in range(100):
            if cls.server.started:break
            time.sleep(.03)
        if not cls.server.started:raise RuntimeError('Fixture HTTP server unavailable')
        spec=importlib.util.spec_from_file_location('stream_client',CLIENT_PATH)
        cls.client_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.client_module)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit=True;cls.thread.join(5)
        cls.pool.closeall();cls.admin.close()

    def scan(self,filter=None):return self.store.stream_memory(cube_id='cube',user_id='owner',filter=filter)

    def test_a_all_categories_owner_cube_and_filters(self):
        rows=list(self.scan())
        self.assertEqual(len(rows),2048)
        self.assertEqual(len({r['metadata']['memory_type'] for r in rows}),4)
        self.assertEqual(len(list(self.scan({'info.event':'same'}))),3)
        self.assertEqual([r['id'] for r in self.scan({'id':'5'})],['5'])
        self.assertEqual([r['id'] for r in self.scan({'info.number':5,'info.flag':True,'info.items':['x','y'],'info.unicode':'Тема'})],['5'])
        self.assertEqual(list(self.scan({'session_id':"session' OR true --"})),[])
        self.assertEqual(len(list(self.scan({'info.absent':None}))),2048)

    def test_a_dates_use_exact_parse_row_isoformat_including_null(self):
        with self.admin.cursor() as cur:
            cur.execute("SELECT created_at,updated_at FROM fixture.memories WHERE id='5'")
            original=cur.fetchone()
            cur.execute("UPDATE fixture.memories SET created_at='2026-01-02T03:04:05.123456+00', updated_at='2026-01-02T03:04:06+00' WHERE id='5'")
            cur.execute("INSERT INTO fixture.memories VALUES ('null-dates','dates','{\"user_id\":\"owner\"}', 'cube', NULL, NULL)")
        try:
            row=next(self.scan({'id':'5'}))
            created=row['metadata']['created_at'];updated=row['metadata']['updated_at']
            self.assertEqual(created,'2026-01-02T03:04:05.123456+00:00')
            self.assertEqual(updated,'2026-01-02T03:04:06+00:00')
            self.assertEqual([r['id'] for r in self.scan({'created_at':created,'updated_at':updated})],['5'])
            self.assertEqual(list(self.scan({'created_at':created.replace('T',' ')})),[])
            self.assertEqual(list(self.scan({'created_at':123})),[])
            self.assertEqual([r['id'] for r in self.scan({'created_at':None,'updated_at':None})],['null-dates'])
        finally:
            with self.admin.cursor() as cur:
                cur.execute("DELETE FROM fixture.memories WHERE id='null-dates'")
                cur.execute("UPDATE fixture.memories SET created_at=%s,updated_at=%s WHERE id='5'",original)

    def test_b_repeatable_snapshot_sees_no_delete_or_insert_gap(self):
        stream=self.scan();first=next(stream)
        with self.admin.cursor() as cur:
            cur.execute("INSERT INTO fixture.memories VALUES ('new','after snapshot','{\"user_id\":\"owner\"}', 'cube', now(), now())")
            cur.execute("DELETE FROM fixture.memories WHERE id='0'")
        rows=[first,*stream]
        self.assertEqual(len(rows),2048)
        self.assertIn('0',{r['id'] for r in rows})
        self.assertNotIn('new',{r['id'] for r in rows})
        self.assertIn('new',{r['id'] for r in self.scan()})
        with self.admin.cursor() as cur:
            cur.execute("DELETE FROM fixture.memories WHERE id='new'")
            cur.execute("INSERT INTO fixture.memories VALUES ('0','Evidence','{\"user_id\":\"owner\"}', 'cube', now(), now())")

    def test_c_server_allocation_is_bounded_and_close_returns_transaction(self):
        tracemalloc.start();count=0
        for row in self.scan():count+=1
        _,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
        self.assertEqual(count,2048)
        self.assertLess(peak,2*1024*1024)
        before=type(self).returned
        stream=self.scan();next(stream);stream.close()
        self.assertEqual(type(self).returned,before+1)
        print('BOUNDED_STREAM_PEAK_BYTES',peak,flush=True)

    def test_d_real_http_complete_recall_and_exact_read(self):
        client=self.client_module.Client({'base_url':'http://127.0.0.1:18432','user_id':'owner','cube_id':'cube'})
        self.assertEqual(len(client.get({})),2048)
        self.assertEqual([r['id'] for r in client.get({'id':'5'})],['5'])
        self.assertEqual(client.get({'id':'foreign-owner'}),[])
        self.assertEqual(client.get({'id':'foreign-cube'}),[])
        self.assertEqual(client._stream_version,1)

    def test_e_oversized_record_refuses_without_partial_success(self):
        with self.admin.cursor() as cur:
            cur.execute("INSERT INTO fixture.memories VALUES ('oversize',%s,'{\"user_id\":\"owner\"}', 'cube', now(), now())",('x'*8388608,))
        try:
            with self.assertRaisesRegex(ValueError,'exceeds'):list(self.scan({'id':'oversize'}))
            client=self.client_module.Client({'base_url':'http://127.0.0.1:18432','user_id':'owner','cube_id':'cube'})
            with self.assertRaises(self.client_module.MemOSError):client.get({'id':'oversize'})
        finally:
            with self.admin.cursor() as cur:cur.execute("DELETE FROM fixture.memories WHERE id='oversize'")

    def test_f_legacy_export_keeps_full_unfiltered_semantics(self):
        rows=self.store.export_graph(user_name='cube',user_id='owner',page=1,page_size=10,filter={'id':'5'})['nodes']
        self.assertEqual(len(rows),2049)
        self.assertIn('foreign-owner',{r['id'] for r in rows})

    def test_f_disconnect_closes_snapshot(self):
        import urllib.request
        data=json.dumps({'mem_cube_id':'cube','user_id':'owner','filter':{}}).encode()
        before=type(self).returned
        response=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18432/product/get_memory_stream',data=data,headers={'Content-Type':'application/json'}),timeout=3)
        self.assertIn(b'header',response.readline())
        response.close()
        for _ in range(100):
            if type(self).returned>before:break
            time.sleep(.02)
        self.assertGreater(type(self).returned,before)
        with self.admin.cursor() as cur:
            cur.execute("SELECT count(*) FROM pg_stat_activity WHERE datname='fixture' AND state='idle in transaction'")
            self.assertEqual(cur.fetchone()[0],0)


if __name__=='__main__':unittest.main(verbosity=2)
