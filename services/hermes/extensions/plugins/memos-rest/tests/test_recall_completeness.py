# ABOUTME: Проверяет полноту выдачи инструментов памяти без произвольной обрезки.
# ABOUTME: Использует только нейтральные данные и локальный fake транспорта.
import importlib
import unittest
import json

from test_routing import RoutingTests


class RecallCompletenessTests(unittest.TestCase):
    setUp = RoutingTests.setUp
    tearDown = RoutingTests.tearDown
    new_provider = RoutingTests.new_provider
    save_config = RoutingTests.save_config

    def test_model_search_schema_does_not_offer_arbitrary_result_limits(self):
        schemas = importlib.import_module(self.provider.__class__.__module__.rsplit('.', 1)[0] + '.schemas')
        for tools in (schemas.TOOLS, schemas.ROUTED_TOOLS):
            search = next(tool for tool in tools if tool['name'] == 'memos_search')
            self.assertNotIn('top_k', search['parameters']['properties'])

    def seed_facts(self):
        """Подготовить 30 разрешённых фактов, не вызывая модель и writer."""
        runtime=self.provider.routing
        for i in range(30):
            info={'hermes_kind':'fact','hermes_author_id':'alice','hermes_logical_id':str(i),
                  'hermes_cube':'life_work','hermes_memberships':['life_work'],
                  'hermes_home_scope':runtime.home_scope,'hermes_memory_epoch':self.cfg['memory_epoch']}
            self.backend.rows[str(i)]={'id':str(i),'cube':'life_work','memory':'A neutral useful fact. '*30,
                'metadata':{'user_id':'root','session_id':'neutral','info':info}}

    def test_obsolete_top_k_from_existing_sessions_cannot_truncate_model_tool_results(self):
        self.seed_facts()
        value=json.loads(self.provider.handle_tool_call('memos_search',{'query':'neutral facts','top_k':5}))
        self.assertEqual(value['status'],'ok')
        self.assertEqual(len(value['memories']),30)
        self.assertFalse(value['result_limit_applied'])

    def test_legacy_character_limit_cannot_cut_recall_below_the_model_budget(self):
        self.seed_facts()
        self.provider.config['context_chars']=6000
        self.provider.context_window=500000
        text=self.provider.prefetch('neutral facts')
        self.assertGreater(len(text),6000)
        self.assertEqual(self.provider.recall_status().count,30)

    def test_source_expansion_reads_cubes_and_ranks_facts_only_once(self):
        self.seed_facts()
        runtime=self.provider.routing
        info={'hermes_kind':'turn','hermes_author_id':'alice','hermes_event_id':'source-event',
              'hermes_cube':'main','hermes_memberships':['main'],
              'hermes_home_scope':runtime.home_scope,'hermes_memory_epoch':self.cfg['memory_epoch']}
        self.backend.rows['source']={'id':'source','cube':'main','memory':'The requested report: report.pdf',
            'metadata':{'user_id':'root','session_id':'neutral','info':info}}
        batches=[]
        def rank(query,rows):
            batches.append(rows)
            return {'matches':[{'index':i,'relevance':'direct','reason':'Requested evidence.'} for i in range(len(rows))],
                    'needs_sources':True,'source_query':query}
        runtime.router.rank=rank
        rows=runtime.search('Find the prior report','neutral',expand_sources=True)
        self.assertEqual([len(b) for b in batches],[30,1])
        self.assertEqual(len(rows),31)
        self.assertTrue(rows.archive_searched)
        self.assertEqual(sum(path=='/product/get_memory' for path,_ in self.backend.calls),len(runtime.catalog.cubes))


if __name__ == '__main__':
    unittest.main()
