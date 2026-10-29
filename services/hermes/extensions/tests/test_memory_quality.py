# ABOUTME: Проверяет строгую схему, смысловой review и публичный контракт поиска памяти.
# ABOUTME: Автономный CI без движка Hermes, моделей, сети и пользовательского профиля.
import importlib
import json
import sys
import types
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'plugins/memos-rest'
PACKAGE = types.ModuleType('isolated_memory_quality')
PACKAGE.__path__ = [str(ROOT)]
sys.modules[PACKAGE.__name__] = PACKAGE
router_module = importlib.import_module(PACKAGE.__name__ + '.router')
schemas = importlib.import_module(PACKAGE.__name__ + '.schemas')


class QualityContractTests(unittest.TestCase):
    """Проверить решения pipeline, а не совпадение реализации с собой."""

    def setUp(self):
        self.router = router_module.SemanticRouter({}, router_module.Catalog(Path('/nonexistent-neutral-home')))

    def test_long_plain_source_does_not_backtrack_for_a_document_path(self):
        self.assertEqual(router_module.document_references('x' * 100000 + ' report.pdf'), ['report.pdf'])

    def test_proposed_wrong_category_is_replaced_by_review_and_noise_is_removed(self):
        text = 'I researched an appliance for my paid massage service.'
        candidate = {'text': text, 'source': {'message_index':0,'role':'user','start':0,'end':len(text),'quote':text},
                     'spheres':['life_intellect'],'projects':[],'status':'observation'}
        calls=[]
        def model(payload):
            data=json.loads(payload[-1]['content']);calls.append(data)
            return {'reviews':[{'index':0,'keep':True,'spheres':['life_work'],
                'supported':True,'standalone':True,'reason':'Explicit paid service purpose.'}]} if 'candidates' in data else {'facts':[candidate]}
        self.router.transport=model
        facts=self.router.extract([{'role':'user','content':text}],context=['Growing my business.'])
        self.assertEqual(facts[0]['memberships'],['life_work'])
        self.assertEqual(calls[0]['conversation_context'],['Growing my business.'])
        self.assertEqual(calls[1]['conversation_context'],['Growing my business.',text])
        self.router.transport=lambda _: {'reviews':[{'index':0,'keep':False,'spheres':[],
            'supported':False,'standalone':True,'reason':'No useful supported fact.'}]}
        self.assertEqual(self.router.review(facts),[])

    def test_unreviewed_candidates_and_unquoted_context_cannot_become_facts(self):
        candidate={'text':'Context only','source':{'message_index':0,'role':'user','start':0,'end':12,'quote':'Context only'},
                   'spheres':['life_work'],'projects':[],'status':'observation'}
        self.router.transport=lambda _: {'facts':[candidate]}
        with self.assertRaises(router_module.MemOSError):
            self.router.extract([{'role':'user','content':'Thanks.'}],context=['Context only'])
        self.router.transport=lambda _: {'reviews':[]}
        with self.assertRaises(router_module.MemOSError):
            self.router.review([candidate])

    def test_bridge_schema_requires_an_explicit_decision_for_each_candidate(self):
        schema=self.router._response_schema([{'content':json.dumps({'candidates':[{},{}]})}])
        reviews=schema['properties']['reviews']
        self.assertEqual((reviews['minItems'],reviews['maxItems']),(2,2))
        self.assertEqual(set(reviews['items']['required']),{'index','keep','spheres','supported','standalone','reason'})

    def test_schema_binds_evidence_role_to_the_actual_message(self):
        schema=self.router._response_schema([{'content':json.dumps({'messages':[{'role':'assistant','content':'Research finding.'}]})}])
        source=schema['properties']['facts']['items']['properties']['source']['properties']
        self.assertNotIn('role',source)
        self.assertNotIn('quote',source)
        self.assertEqual(source['message_index']['enum'],[0])
        candidate={'text':'Research finding.','source':{'message_index':0},'spheres':['life_work'],'projects':[],'status':'observation'}
        self.router.transport=lambda p: {'reviews':[{'index':0,'keep':True,'spheres':['life_work'],
            'supported':True,'standalone':True,'reason':'Attributed research finding.'}]} if 'candidates' in json.loads(p[-1]['content']) else {'facts':[candidate]}
        fact=self.router.extract([{'role':'assistant','content':'Research finding.'}])[0]
        self.assertEqual(fact['source']['role'],'assistant')
        self.assertEqual(fact['source']['quote'],'Research finding.')

    def test_model_search_does_not_offer_a_result_quota_and_archive_is_opt_in(self):
        search=next(s for s in schemas.ROUTED_TOOLS if s['name']=='memos_search')
        fields=search['parameters']['properties']
        self.assertNotIn('top_k',fields)
        self.assertNotIn('top_k',search['parameters']['required'])
        self.assertIn('include_archive',fields)

    def test_recall_uses_validated_source_indices_without_generating_quotations(self):
        source='The preferred studio name is Quiet Harbour.'
        schema=self.router._response_schema([{'content':json.dumps({'recall_candidates':[{'text':source}]})}])
        self.assertNotIn('evidence',schema['properties']['matches']['items']['properties'])
        self.router.transport=lambda _: {'matches':[{'index':0,'relevance':'direct','reason':'The chosen name.'}],
                                         'needs_sources':False,'source_query':''}
        result=self.router.rank('Which studio name?', [{'text':source}])
        self.assertEqual(result['matches'][0]['evidence'],source)

    def test_independent_batches_run_concurrently_without_losing_candidates(self):
        barrier=threading.Barrier(3,timeout=3)
        def model(payload):
            data=json.loads(payload[-1]['content'])
            barrier.wait()
            return {'matches':[{'index':i,'relevance':'direct','reason':'A requested source.'}
                               for i in range(len(data['recall_candidates']))],
                    'needs_sources':False,'source_query':''}
        self.router.transport=model
        rows=[{'text':str(i)+' '+('x'*41000)} for i in range(3)]
        result=self.router.rank('Find these sources',rows)
        self.assertEqual([m['index'] for m in result['matches']],[0,1,2])

    def test_parallel_batch_failure_is_visible_instead_of_partial_success(self):
        def model(payload):
            source=json.loads(payload[-1]['content'])['recall_candidates'][0]['text']
            if source.startswith('bad'):raise router_module.MemOSError('backend unavailable')
            return {'matches':[{'index':0,'relevance':'direct','reason':'Requested.'}],
                    'needs_sources':False,'source_query':''}
        self.router.transport=model
        with self.assertRaisesRegex(router_module.MemOSError,'unavailable'):
            self.router.rank('Find sources',[{'text':'good'+'x'*80000},{'text':'bad'+'x'*80000}])

    def test_document_lookup_keeps_actual_pointers_and_their_original_indices(self):
        seen=[]
        def model(payload):
            data=json.loads(payload[-1]['content']);seen.append(data)
            if 'recall_goal_query' in data:return {'goal':'locate_document'}
            self.assertEqual(len(data['recall_candidates']),1)
            self.assertIn('report-brand.pdf',data['recall_candidates'][0]['document_refs'])
            return {'matches':[{'index':0,'relevance':'direct','reason':'The actual report file.'}],
                    'needs_sources':True,'source_query':'report file'}
        self.router.transport=model
        result=self.router.rank('Find the actual report file',[
            {'text':'Please research this topic.','kind':'turn'},
            {'text':'The report is ready.','kind':'turn'},
            {'text':'Final report: report-brand.pdf','kind':'turn'}])
        self.assertEqual([m['index'] for m in result['matches']],[2])
        self.assertEqual(len(seen),2)

    def test_missing_document_pointer_is_explicit_and_does_not_return_progress(self):
        self.router.transport=lambda _: {'goal':'locate_document'}
        result=self.router.rank('Find the actual PDF',[
            {'text':'The report was finished.','kind':'turn'}])
        self.assertEqual(result['matches'],[])
        self.assertTrue(result['needs_sources'])

    def test_query_plan_uses_recent_dialogue_instead_of_candidate_profile_topics(self):
        calls=[]
        def model(payload):
            calls.append(json.loads(payload[-1]['content']))
            return {'goal':'evidence','query':'Which cancellation terms did we agree?'}
        self.router.transport=model
        context=[{'role':'user','content':'Discussing cancellation of appointments.'}]
        result=self.router.plan('Continue',context)
        self.assertEqual(calls,[{'recent_conversation':context,'recall_goal_query':'Continue'}])
        self.assertIn('cancellation',result['query'])

    def test_outer_whitespace_is_trimmed_but_evidence_stays_exact(self):
        text='I chose this business name.'
        candidate={'text':text,'source':{'message_index':0,'role':'user','start':0,'end':999,'quote':text+' '},
                   'spheres':['life_work'],'projects':[],'status':'decision'}
        self.router.transport=lambda p: {'reviews':[{'index':0,'keep':True,'spheres':['life_work'],
            'supported':True,'standalone':True,'reason':'Exact source confirms a decision.'}]} if 'candidates' in json.loads(p[-1]['content']) else {'facts':[candidate]}
        fact=self.router.extract([{'role':'user','content':text}])[0]
        self.assertEqual(fact['source']['quote'],text)
        self.assertEqual(fact['source']['end'],len(text))

    def test_keep_flag_cannot_admit_unsupported_or_incomplete_facts(self):
        candidate={'text':'Remember those options.','source':{'quote':'Remember those options.'}}
        for supported, standalone in [(False,True),(True,False)]:
            self.router.transport=lambda _: {'reviews':[{'index':0,'keep':True,'spheres':['life_work'],
                'supported':supported,'standalone':standalone,'reason':'Incomplete or ungrounded candidate.'}]}
            self.assertEqual(self.router.review([candidate]),[])

    def test_recall_index_cannot_borrow_evidence_from_another_candidate(self):
        self.router.transport=lambda _: {'matches':[{'index':1,'relevance':'direct',
            'reason':'Chosen practice name.','evidence':'Quiet Studio'}], 'needs_sources':False,'source_query':''}
        with self.assertRaisesRegex(router_module.MemOSError,'invalid evidence'):
            self.router.rank('Which name was chosen?',[{'text':'Quiet Studio'},{'text':'Oil pressure warning'}])


if __name__=='__main__':
    unittest.main()
