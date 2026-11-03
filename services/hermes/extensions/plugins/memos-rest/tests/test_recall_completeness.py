# ABOUTME: Проверяет полноту выдачи инструментов памяти без произвольной обрезки.
# ABOUTME: Использует только нейтральные данные и локальный fake транспорта.
import importlib
import unittest
import json
import copy

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
        def rank(query,rows,**kwargs):
            batches.append(rows)
            return {'matches':[{'index':i,'relevance':'direct','reason':'Requested evidence.'} for i in range(len(rows))],
                    'needs_sources':True,'source_query':query}
        runtime.router.rank=rank
        rows=runtime.search('Find the prior report','neutral',expand_sources=True)
        self.assertEqual([len(b) for b in batches],[30,1])
        self.assertEqual(len(rows),31)
        self.assertTrue(rows.archive_searched)
        self.assertEqual(sum(path=='/product/get_memory' for path,_ in self.backend.calls),len(runtime.catalog.cubes))

    def test_ambiguous_continuation_does_not_scan_the_entire_archive(self):
        runtime=self.provider.routing
        runtime.router.plan=lambda query,context: {'goal':'needs_topic','query':query}
        text=self.provider.prefetch('Hi, let us continue.')
        self.assertIn('Memory was not searched',text)
        self.assertIn('Нужна тема',self.provider.recall_status().summary)
        self.assertEqual(self.backend.calls,[])

    def test_recent_turn_resolves_continuation_without_reusing_an_old_context_cache(self):
        self.seed_facts()
        provider=self.provider
        plans=[]
        def plan(query,context):
            plans.append(context)
            return {'goal':'evidence','query':context[0]['content']}
        provider.routing.router.plan=plan
        for topic in ['The studio name','The appointment price']:
            question='Hi, I have an hour; let us continue our discussion.'
            history=[{'role':'user','content':topic},{'role':'assistant','content':'Let us discuss it.'},
                     {'role':'user','content':'Gateway message origin: trusted transport metadata\n'+question}]
            provider.on_turn_start(1,question,memory_dialogue=history,context_length=500000)
            provider.prefetch(question)
        self.assertEqual([p[0]['content'] for p in plans],['The studio name','The appointment price'])

    def test_user_notification_has_the_requested_text_and_counts_stay_separate(self):
        self.seed_facts()
        self.provider.context_available_tokens=400
        self.provider.prefetch('Find the neutral facts')
        status=self.provider.recall_status()
        self.assertEqual(status.summary,'🧠 Найдено воспоминаний 30')
        self.assertEqual(status.found_count,30)
        self.assertLess(status.count,status.found_count)

    def test_native_manager_keeps_more_than_six_thousand_characters_within_model_budget(self):
        self.seed_facts()
        self.provider.context_window=500000
        from agent.memory_manager import MemoryManager
        manager=MemoryManager();manager.add_provider(self.provider)
        context=manager.prefetch_all('Find all neutral facts')
        self.assertGreater(len(context),6000)
        self.assertIn('[29;',context)
        self.assertEqual(self.provider.recall_status().count,30)

    def test_complete_empty_archive_is_identified_without_a_false_service_error(self):
        text=self.provider.prefetch('Find the absent synthetic topic')
        self.assertIn('original archive included',text)
        self.assertIn('Complete empty search',text)
        self.assertEqual(self.provider.recall_status().summary,'🧠 Найдено воспоминаний 0')

    def test_document_pointer_is_explicit_in_the_delivered_context(self):
        self.seed_facts()
        row=copy.deepcopy(self.backend.rows['0'])
        row.update(id='report',memory='The final report is report-brand.pdf')
        row['metadata']['info']['hermes_logical_id']='report'
        self.backend.rows['report']=row
        text=self.provider.prefetch('Find the final report')
        self.assertIn('DOCUMENT_REFS: ["report-brand.pdf"]',text)
        self.assertIn('files ALREADY LOCATED',text)

    def test_verified_document_name_reaches_ranker_and_agent(self):
        self.seed_facts()
        runtime=self.provider.routing
        row=copy.deepcopy(self.backend.rows['0'])
        row.update(id='report',memory='Delivered /old/opaque-id.pdf')
        row['metadata']['info']['hermes_logical_id']='report'
        self.backend.rows={'report':row}
        details={'artifactId':'11111111-1111-4111-8111-111111111111',
                 'filename':'Vector technology and market.pdf','mimeType':'application/pdf'}
        runtime.router.document_metadata=lambda reference: details
        del runtime.router.rank
        def transport(payload):
            data=json.loads(payload[-1]['content'])
            if 'recall_goal_query' in data:return {'goal':'locate_document'}
            self.assertEqual(data['recall_candidates'][0]['document_metadata'],[details])
            return {'matches':[{'index':0,'relevance':'direct','reason':'Verified report filename.'}],
                    'needs_sources':False,'source_query':data['query']}
        runtime.router.transport=transport
        text=self.provider.prefetch('Read the earlier Vector report')
        self.assertIn('DOCUMENT_METADATA:',text)
        self.assertIn(details['filename'],text)
        self.assertIn(details['artifactId'],text)

    def test_control_completion_is_neither_archived_nor_recalled_as_a_user_turn(self):
        messages=[{'role':'user','content':'[Alice] [ASYNC DELEGATION BATCH COMPLETE — batch-1]\n'
                   'A background fan-out unit you dispatched earlier has finished.'},
                  {'role':'assistant','content':'Read rules/planning.md. The desired future report is ready.'}]
        self.assertIsNone(self.provider._archive(messages,'neutral','turn',1))
        runtime=self.provider.routing
        info={'hermes_kind':'turn','hermes_author_id':'alice','hermes_event_id':'control',
              'hermes_messages':messages,'hermes_cube':'main','hermes_memberships':['main'],
              'hermes_home_scope':runtime.home_scope,'hermes_memory_epoch':self.cfg['memory_epoch']}
        self.backend.rows={'control':{'id':'control','cube':'main','memory':'Internal planning result.',
            'metadata':{'user_id':'root','session_id':'neutral','info':info}}}
        self.assertEqual(runtime.search('Find the report','neutral',include_archive=True),[])
        client=importlib.import_module(self.provider.__class__.__module__.rsplit('.',1)[0]+'.client')
        self.assertFalse(client.internal_dialogue([{'role':'user','content':'Explain this marker: [ASYNC DELEGATION BATCH COMPLETE]'}]))

    def test_native_artifact_references_do_not_require_a_filename_suffix(self):
        client=importlib.import_module(self.provider.__class__.__module__.rsplit('.',1)[0]+'.client')
        aid='11111111-1111-4111-8111-111111111111'
        self.assertEqual(client.document_references('BRAI_FILES:{"items":[{"artifactId":"'+aid+'"}]}'),
                         ['artifact:'+aid])


if __name__ == '__main__':
    unittest.main()
