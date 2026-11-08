# ABOUTME: Проверяет обязательную область feedback прямо из поставляемого canonical patch.
# ABOUTME: Только синтетические SQL/threads; без внешнего MemOS engine, моделей и пользовательских данных.
import ast
import copy
from datetime import datetime
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from contextvars import Context

HERMES=Path(__file__).resolve().parents[2]
WORKTREE=HERMES.parents[1]
PATCH=HERMES/'memos/patches/postgres-stream.patch'
raw=PATCH.read_text()
marker='+++ b/src/memos/graph_dbs/brai_feedback_scope.py\n'
chunk=raw.split(marker,1)[1].split('diff --git ',1)[0]
module_source=''.join(line[1:]+'\n' for line in chunk.splitlines()[1:] if line.startswith('+'))
if not module_source.startswith('# ABOUTME:'):
    raise AssertionError('Missing scoped feedback module in canonical overlay')
m=types.ModuleType('feedback_scope_candidate');sys.modules[m.__name__]=m
exec(compile(module_source,'<canonical-feedback-overlay>','exec'),m.__dict__)
S=m.FeedbackScope('owner','profile__main','home','epoch','author',('target',))
def metadata(**override):
    return S.metadata({'memory_type':'WorkingMemory','status':'activated',**override})
def node(identifier='target',memory='old',md=None):
    return (identifier,memory,copy.deepcopy(md if md is not None else metadata()),datetime.now(),datetime.now(),[1.0,0.0])
class Database:
    def __init__(self,rows=None):
        self.rows={r[0]:copy.deepcopy(r) for r in (rows or [node()])}
        self.edges=[]; self.sql=[]; self.commits=0; self.rollbacks=0; self.unknown=False
class Cursor:
    def __init__(self,conn): self.c=conn; self.result=[]; self.rowcount=0
    def __enter__(self): return self
    def __exit__(self,*a): pass
    def execute(self,sql,params):
        self.c.db.sql.append((sql,copy.deepcopy(params)))
        self.rowcount=0; self.result=[]
        if sql.startswith('SELECT set_config'): return
        if '.edges' in sql:
            ids=set(params[0]) if isinstance(params[0],list) else set(params[:2])
            if sql.startswith('SELECT source_id,target_id FROM'):
                self.result=[(a,b) for a,b,k in self.c.edges if a in ids or b in ids]; return
            if sql.startswith('SELECT source_id,target_id,edge_type'):
                self.result=[e for e in self.c.edges if e[0] in ids or e[1] in ids]; return
            if sql.startswith('DELETE'):
                self.c.edges=[e for e in self.c.edges if not (e[0] in ids or e[1] in ids)]; return
            raise AssertionError('unexpected edge SQL')
        if sql.startswith('INSERT'):
            identifier,memory,raw,embedding,cube=params
            if identifier in self.c.rows: raise RuntimeError('collision')
            md=m.json.loads(raw)
            self.c.rows[identifier]=node(identifier,memory,md)
            self.rowcount=1; return
        if sql.startswith('UPDATE'):
            prefix=3; selected=self.select(sql,params[prefix:-1]); identifier=params[-1]
            if identifier in {r[0] for r in selected}:
                self.c.rows[identifier]=node(identifier,params[0],m.json.loads(params[1])); self.rowcount=1
            return
        if sql.startswith('DELETE'):
            selected=self.select(sql,params[:-1]); identifier=params[-1]
            if identifier in {r[0] for r in selected}: del self.c.rows[identifier]; self.rowcount=1
            return
        if sql.startswith('SELECT id,memory,properties'):
            selected=self.select(sql,params)
            if 'AND (id=%s)' in sql: selected=[r for r in selected if r[0]==params[-1]]
            elif 'AND (id = ANY(%s))' in sql or 'AND (id=ANY(%s))' in sql:
                selected=[r for r in selected if r[0] in params[-1]]
            self.result=copy.deepcopy(selected); return
        raise AssertionError('unexpected SQL')
    def select(self,sql,p):
        for predicate in ("user_name=%s","properties->>'user_id'=%s",
                          "'hermes_home_scope'=%s","'hermes_memory_epoch'=%s",
                          "'hermes_author_id'=%s","'hermes_cube'=%s",
                          "'hermes_visibility' IS DISTINCT FROM 'business_private'",
                          "'hermes_business_scope' IS NULL","id=ANY(%s)"):
            if predicate not in sql: raise AssertionError('missing scope SQL')
        cube,user,home,epoch,author,info_cube,ids=p[:7]
        out=[]
        for r in self.c.rows.values():
            md=r[2]; info=md.get('info') or {}
            if (r[0] in ids and md.get('user_id')==user and
                info.get('hermes_cube')==cube==info_cube and info.get('hermes_home_scope')==home and
                info.get('hermes_memory_epoch')==epoch and info.get('hermes_author_id')==author and
                info.get('hermes_visibility')!='business_private' and info.get('hermes_business_scope') is None):
                out.append(r)
        return out
    def fetchall(self): return self.result
class Connection:
    def __init__(self,db):
        self.db=db; self.rows=copy.deepcopy(db.rows); self.edges=copy.deepcopy(db.edges)
        self.autocommit=True; self.closed=False
    def cursor(self): return Cursor(self)
    def commit(self):
        self.db.commits+=1; self.db.rows=copy.deepcopy(self.rows); self.db.edges=copy.deepcopy(self.edges)
        if self.db.unknown: raise OSError('unknown commit response')
    def rollback(self): self.db.rollbacks+=1; self.rows=copy.deepcopy(self.db.rows)
    def close(self): self.closed=True
class PostgresGraphDB:
    __module__='memos.graph_dbs.postgres'
    schema='memos'
    config={'schema':'memos'}
    def __init__(self,db): self.db=db; self.returned=[]
    def _get_conn(self): return Connection(self.db)
    def _put_conn(self,conn): self.returned.append(conn)
    def _parse_row(self,r,include_embedding=False):
        value={'id':r[0],'memory':r[1],'metadata':copy.deepcopy(r[2])}
        value['metadata']['updated_at']=r[4].isoformat()
        if include_embedding: value['metadata']['embedding']=r[5]
        return value

# Import actual accepted-source consumers; no HTTP call occurs on import.
sys.path.insert(0,str(WORKTREE/'services/hermes'))
from identity.memory_gateway import Boundary, physical_cube
client_spec=importlib.util.spec_from_file_location('actual_memos_client',WORKTREE/'services/hermes/extensions/plugins/memos-rest/client.py')
client=importlib.util.module_from_spec(client_spec); client_spec.loader.exec_module(client)

class ScopeTest(unittest.TestCase):
    def test_unicode_multiline_fact_actual_client_and_boundary(self):
        profile={'profileId':'fixture-profile','userId':'owner','homeScope':'home','memoryEpoch':'epoch','authorId':'author','cubes':['main','work']}
        cube=physical_cube(profile,'main'); other=physical_cube(profile,'work')
        scope=m.FeedbackScope('owner',cube,'home','epoch','author',('target',))
        original=scope.metadata({'info':{'hermes_kind':'fact','hermes_source':'fixture',
            'hermes_source_ids':['source'],'hermes_subject_id':'subject'}},'old')
        original['info'].update(hermes_memberships=[cube,other],hermes_primary_cube=other)
        db=Database([node(md=original)]); view=m.BoundFeedbackStore(PostgresGraphDB(db),scope)
        value='user: [2026-11-08]: Проверка\nстрока n\n'
        view.update_node('target',{'memory':value,'info':{'ordinary':'native'}})
        row=view.get_node('target')
        self.assertEqual(client.memory_text(row),'Проверка\nстрока n')
        checked=Boundary.checked_row(profile,'main',row)
        self.assertEqual(checked['metadata']['info']['hermes_memberships'],['main','work'])
        self.assertEqual(checked['metadata']['info']['hermes_primary_cube'],'work')
        for key in ('hermes_source','hermes_source_ids','hermes_subject_id'):
            self.assertEqual(row['metadata']['info'][key],original['info'][key])
        view.finish()
        # A genuine final letter n must survive; newline stripping cannot strip n.
        for value in ('n','Русский n','строка\nвторая n'):
            md=scope.metadata({},value)
            self.assertEqual(client.memory_text({'memory':value,'metadata':md}),value)
            Boundary.checked_row(profile,'main',{'id':'new','memory':value,'metadata':md})
        self.assertEqual(m.content('строка\nещё\tстрока'),'строка\nещё\tстрока')
        with self.assertRaises(m.FeedbackScopeError): m.text('bad\nidentifier')
    def test_forged_metadata_rollback_and_cleanup_cannot_mask_unknown(self):
        db=Database(); view=m.BoundFeedbackStore(PostgresGraphDB(db),S)
        with self.assertRaises(m.FeedbackScopeError):
            view.update_node('target',{'info':{'hermes_author_id':'foreign'}})
        view.abort(); self.assertEqual(db.commits,0)
        for failure in ('commit','return'):
            db=Database(); native=PostgresGraphDB(db); view=m.BoundFeedbackStore(native,S)
            view.update_node('target',{'memory':'committed'})
            if failure=='commit':
                def fail_commit():
                    db.commits+=1
                    raise OSError('lost response')
                view._conn.commit=fail_commit
            else:
                def fail_return(connection): raise OSError('pool failed after commit')
                native._put_conn=fail_return
            def fail_rollback(): raise OSError('closed connection')
            view._conn.rollback=fail_rollback
            with self.assertRaisesRegex(m.FeedbackScopeError,'OUTCOME_UNKNOWN'): view.finish()
            view.abort(); view.abort()
            self.assertEqual(db.commits,1)

    def test_cross_profile_epoch_author_private_target_denied_before_llm(self):
        for md in [
            {**metadata(),'user_id':'other'},
            {**metadata(),'info':{**metadata()['info'],'hermes_cube':'other__main'}},
            {**metadata(),'info':{**metadata()['info'],'hermes_home_scope':'old-home'}},
            {**metadata(),'info':{**metadata()['info'],'hermes_memory_epoch':'old-epoch'}},
            {**metadata(),'info':{**metadata()['info'],'hermes_author_id':'other-author'}},
            {**metadata(),'info':{**metadata()['info'],'hermes_visibility':'business_private'}},
            {**metadata(),'info':{**metadata()['info'],'hermes_business_scope':'private'}},
        ]:
            db=Database([node(md=md)])
            with self.subTest(md=md):
                with self.assertRaises(m.FeedbackScopeError):
                    m.BoundFeedbackStore(PostgresGraphDB(db),S)
                self.assertEqual(db.commits,0); self.assertEqual(db.rows['target'][1],'old')
    def test_empty_thread_context_preserves_bound_scope_and_sql_predicates(self):
        db=Database([node(),node('foreign',md={**metadata(),'user_id':'other'})])
        view=m.BoundFeedbackStore(PostgresGraphDB(db),S)
        errors=[]
        def work():
            try:
                self.assertEqual(view.get_node('target')['memory'],'old')
                view.update_node('target',{'memory':'corrected'})
                with self.assertRaises(m.FeedbackScopeError): view.get_node('foreign')
            except BaseException as error: errors.append(error)
        thread=threading.Thread(target=lambda:Context().run(work)); thread.start(); thread.join()
        self.assertEqual(errors,[])
        with self.assertRaises(m.FeedbackScopeError): view.finish()
        view.abort()
        self.assertEqual(db.rows['target'][1],'old'); self.assertEqual(db.rows['foreign'][1],'old')
        self.assertEqual(db.commits,0)
    def test_hidden_scope_fault_rolls_back_prior_valid_write(self):
        db=Database(); view=m.BoundFeedbackStore(PostgresGraphDB(db),S)
        view.update_node('target',{'memory':'staged-only'})
        try: view.add_node('new','nope',{**metadata(),'user_id':'other'})
        except m.FeedbackScopeError: pass
        with self.assertRaises(m.FeedbackScopeError): view.finish()
        view.abort()
        self.assertEqual(db.commits,0); self.assertEqual(db.rows['target'][1],'old')
    def test_readback_rejects_scope_loss_without_commit(self):
        db=Database(); view=m.BoundFeedbackStore(PostgresGraphDB(db),S)
        view.update_node('target',{'memory':'staged-only'})
        r=view._conn.rows['target']; r[2]['info']['hermes_memory_epoch']='other'
        with self.assertRaises(m.FeedbackScopeError): view.finish()
        view.abort(); self.assertEqual(db.commits,0)
    def test_unknown_commit_is_one_attempt_no_retry(self):
        db=Database(); db.unknown=True; view=m.BoundFeedbackStore(PostgresGraphDB(db),S)
        view.update_node('target',{'memory':'own-only'})
        with self.assertRaisesRegex(m.FeedbackScopeError,'OUTCOME_UNKNOWN'): view.finish()
        view.abort()
        self.assertEqual(db.commits,1); self.assertEqual(db.rows['target'][1],'own-only')
    def test_cross_target_edge_aborts_before_effects(self):
        db=Database(); db.edges=[('target','outside','RELATE')]
        with self.assertRaisesRegex(m.FeedbackScopeError,'EXTERNAL_EDGE'):
            m.BoundFeedbackStore(PostgresGraphDB(db),S)
        self.assertEqual(db.commits,0)

    def test_typed_config_graph_db_is_inert_but_unserializable_handle_is_denied(self):
        Config=type('Config',(),{'__module__':'memos.configs.memory'})
        Feedback=type('Feedback',(),{'__module__':'memos.mem_feedback.feedback'})
        Reader=type('Reader',(),{'__module__':'memos.mem_reader.simple_struct'})
        db=Database(); store=PostgresGraphDB(db); view=m.BoundFeedbackStore(store,S)
        native=Feedback();native.graph_store=store;native.is_reorganize=False
        native.mem_reader=Reader();native.mem_reader.graph_db=store
        config=Config();config.graph_db={'backend':'postgres','config':{'schema':'memos'}}
        config.model_dump=lambda **kwargs:{'graph_db':config.graph_db}
        native.config=config
        Reranker=type('Reranker',(),{'__module__':'memos.reranker.fixture'})
        native.reranker=Reranker()
        self.assertIs(m.bind_feedback(native,view).graph_store,view)
        config.graph_db=store
        with self.assertRaises(m.FeedbackScopeError):m.bind_feedback(native,view)
        view.abort();self.assertEqual(db.commits,0)

    def test_failed_commit_rollback_and_autocommit_release_exact_lease_once(self):
        for failure in ('commit','rollback','autocommit'):
            db=Database();native=PostgresGraphDB(db);view=m.BoundFeedbackStore(native,S)
            lease=view._conn
            if failure=='commit': db.unknown=True
            if failure=='rollback':
                def fail():raise OSError('rollback failed')
                lease.rollback=fail
            if failure=='autocommit':
                class BrokenAutocommit(Connection):
                    @property
                    def autocommit(self):return False
                    @autocommit.setter
                    def autocommit(self,value):
                        if value:raise OSError('restore failed')
                lease.__class__=BrokenAutocommit
            with self.subTest(failure=failure):
                if failure in ('commit','autocommit'):
                    with self.assertRaisesRegex(m.FeedbackScopeError,'OUTCOME_UNKNOWN'):view.finish()
                view.abort();view.abort()
                self.assertTrue(lease.closed)
                self.assertEqual(native.returned,[lease])
                self.assertIsNone(view._conn);self.assertIsNone(view._lease)

    def test_projection_rejects_hidden_unknown_and_distinct_raw_store(self):
        Feedback=type('Feedback',(),{'__module__':'memos.mem_feedback.feedback'})
        Reader=type('Reader',(),{'__module__':'memos.mem_reader.simple_struct'})
        Provider=type('Provider',(),{'__module__':'memos.llms.fixture'})
        for mode in ('unknown','nested-provider','distinct-store'):
            db=Database(); store=PostgresGraphDB(db); view=m.BoundFeedbackStore(store,S)
            native=Feedback(); native.graph_store=store; native.is_reorganize=False
            native.mem_reader=Reader(); native.mem_reader.graph_db=store
            if mode=='unknown': native.hidden=types.SimpleNamespace(storage=store)
            if mode=='nested-provider':
                native.llm=Provider(); native.llm.nested=types.SimpleNamespace(pool=object())
            if mode=='distinct-store':
                native.mem_reader.graph_db=PostgresGraphDB(db)
                native.mem_reader.graph_db.config={'schema':'foreign'}
            with self.subTest(mode=mode), self.assertRaises(m.FeedbackScopeError): m.bind_feedback(native,view)
            view.abort(); self.assertEqual(db.commits,0)
            self.assertIs(native.graph_store,store)


if __name__=='__main__': unittest.main()
