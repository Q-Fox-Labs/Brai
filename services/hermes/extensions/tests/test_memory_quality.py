# ABOUTME: Проверяет строгую схему, смысловой review и публичный контракт поиска памяти.
# ABOUTME: Автономный CI без движка Hermes, моделей, сети и пользовательского профиля.
import importlib
import json
import sys
import types
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

    def test_search_accepts_large_requests_and_archive_is_opt_in(self):
        search=next(s for s in schemas.ROUTED_TOOLS if s['name']=='memos_search')
        fields=search['parameters']['properties']
        self.assertNotIn('maximum',fields['top_k'])
        self.assertNotIn('top_k',search['parameters']['required'])
        self.assertIn('include_archive',fields)

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
