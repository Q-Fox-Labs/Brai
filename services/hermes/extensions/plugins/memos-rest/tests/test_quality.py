# ABOUTME: Проверяет отбор фактов, классификацию с контекстом и исправление старых копий.
# ABOUTME: Использует только fake MemOS и модель; пользовательские данные не читаются.
"""Regression coverage for reviewed memory and exhaustive scoped recall."""
import copy
import importlib
import json
from unittest.mock import patch

from test_routing import RoutingTests


class QualityTests(RoutingTests):
    """Проверить внешнее поведение pipeline и возобновляемого обслуживания."""

    def test_unresolved_authors_and_mixed_checkpoints_never_create_personal_facts(self):
        self.provider.routing.router.transport = lambda _: self.fail('Unattributed history must not be classified')
        self.provider._archive([{'role':'user','content':'An old personal statement.'}],
            'session-a','turn','unresolved',{'id':'unknown'})
        self.provider._archive([{'role':'user','content':'Several speakers in a recovery archive.'}],
            'session-a','checkpoint','mixed',{'id':'multiple_or_unknown'})
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'],0)
        self.assertTrue(self.backend.rows)
        self.assertFalse(any(r['metadata']['info']['hermes_kind']=='fact' for r in self.backend.rows.values()))

    def test_review_drops_noise_and_repairs_category_before_any_fact_write(self):
        quote = 'Проверил публикации об аппарате для моего массажного кабинета.'
        candidate = self.fact(text=quote, source={'message_index': 0, 'role': 'user',
            'start': 0, 'end': len(quote), 'quote': quote}, spheres=['life_intellect'])
        def model(payload):
            data = json.loads(payload[-1]['content'])
            return ({'reviews': [{'index': 0, 'keep': True, 'spheres': ['life_work']}]}
                    if 'candidates' in data else {'facts': [candidate]})
        self.provider.routing.router.transport = model
        self.provider.sync_turn(quote, '')
        self.send()
        facts = [r for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind'] == 'fact']
        self.assertEqual([r['cube'] for r in facts], ['life_work'])
        self.assertTrue(all(r['metadata']['info']['hermes_quality_version'] for r in facts))

    def test_incomplete_review_never_delivers_unreviewed_facts(self):
        router = self.provider.routing.router
        self.router_reply([self.fact()])
        original = router.transport
        router.transport = lambda p: {'reviews': []} if 'candidates' in json.loads(p[-1]['content']) else original(p)
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        self.assertTrue(self.provider.outbox.status()['pending'])
        self.assertFalse(any(r['metadata']['info']['hermes_kind'] == 'fact' for r in self.backend.rows.values()))

    def test_rejected_greeting_is_archived_but_not_an_ordinary_memory(self):
        self.provider.routing.router.transport = lambda p: ({'cubes': []} if 'query' in json.loads(p[-1]['content'])
            else {'reviews': [{'index': 0, 'keep': False, 'spheres': []}]} if 'candidates' in json.loads(p[-1]['content'])
            else {'facts': [self.fact(text='Спасибо.', source={'message_index': 0,'role':'user','start':0,'end':8,'quote':'Спасибо.'})]})
        self.provider.sync_turn('Спасибо.', '')
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertEqual(json.loads(self.provider.handle_tool_call('memos_search', {'query':'Спасибо'}))['memories'], [])
        self.assertTrue(json.loads(self.provider.handle_tool_call('memos_search', {'query':'Спасибо','include_archive':True}))['memories'])

    def test_thousand_results_are_not_clamped_and_foreign_author_is_excluded(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        base = next(r for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact')
        self.backend.rows.clear()
        for i in range(1050):
            row = copy.deepcopy(base); row['id'] = str(i)
            row['metadata']['info']['hermes_logical_id'] = str(i)
            if i < 25: row['metadata']['info']['hermes_author_id'] = 'other-author'
            self.backend.rows[str(i)] = row
        self.provider.routing.router.transport = lambda p: {'cubes':['life_intellect']}
        self.assertEqual(len(json.loads(self.provider.handle_tool_call('memos_search',{'query':'sales','top_k':1000}))['memories']),1000)
        self.assertEqual(len(json.loads(self.provider.handle_tool_call('memos_search',{'query':'sales'}))['memories']),1025)
        self.assertEqual(json.loads(self.provider.handle_tool_call('memos_search',{'query':'sales','top_k':0}))['status'],'error')

    def test_context_never_includes_another_author_or_session(self):
        self.router_reply([])
        self.provider.sync_turn('My purpose is a massage business.', '')
        self.send()
        self.provider.author['id'] = 'bob'
        self.provider.sync_turn('Private unrelated purpose.', '')
        self.send()
        job = {'body':{'session_id':'session-a','messages':[], 'info':{'hermes_author_id':'alice'}}}
        context = self.provider.routing.conversation_context(job)
        self.assertIn('My purpose is a massage business.', context)
        self.assertNotIn('Private unrelated purpose.', context)
        job['body']['session_id']='another-session'
        self.assertEqual(self.provider.routing.conversation_context(job),[])

    def test_old_pinned_plan_is_reviewed_again_and_partial_wrong_copies_are_removed(self):
        self.router_reply([self.fact(spheres=['life_work'])])
        self.provider.sync_turn('I am studying sales.', '')
        path=next(self.provider.outbox.pending.glob('*.json'));job=json.loads(path.read_text())
        job.update(facts=[{**self.fact(),'memberships':['infra']}],units={},quality_version='old-unreviewed')
        path.write_text(json.dumps(job))
        info={**job['body']['info'],'hermes_kind':'fact','hermes_event_id':'old-copy',
              'hermes_source_event':job['event_id'],'hermes_cube':'infra','hermes_memberships':['infra'],
              'hermes_logical_id':'old-logical'}
        self.backend.rows['old-copy']={'id':'old-copy','cube':'infra','memory':'Old wrong classification',
            'metadata':{'user_id':'root','session_id':'session-a','info':info}}
        self.send()
        self.assertEqual(self.provider.outbox.status()['pending'],0)
        self.assertNotIn('old-copy',self.backend.rows)
        self.assertEqual([r['cube'] for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact'],['life_work'])

    def prepared_plan(self, keep=True):
        """Создать реальный локальный план на fake-записях с проверенным источником."""
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        admin = self.provider.routing.admin()
        scope = {'profile':'default','user_id':'root','managed_cubes':self.provider.routing.catalog.cubes}
        module = importlib.import_module(admin.__class__.__module__)
        with patch.object(module.SemanticRouter, 'review', side_effect=lambda facts, context, **kwargs:
                [{**f,'spheres':['life_work'],'memberships':['life_work']} for f in facts] if keep else []):
            summary = admin.quality_plan(scope)
        return admin, scope, summary

    def test_quality_apply_preserves_originals_logical_id_and_is_repeatable(self):
        admin, scope, plan = self.prepared_plan()
        originals = {k:copy.deepcopy(r) for k,r in self.backend.rows.items() if r['metadata']['info']['hermes_kind']!='fact'}
        logical = next(r['metadata']['info']['hermes_logical_id'] for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact')
        admin.freeze(scope)
        result = admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        self.assertTrue(result['complete'])
        facts = [r for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact']
        self.assertEqual([r['cube'] for r in facts],['life_work'])
        self.assertEqual(facts[0]['metadata']['info']['hermes_logical_id'], logical)
        self.assertTrue(all(self.backend.rows[k]==r for k,r in originals.items()))
        for path in self.provider.outbox.receipts.glob('*.json'):
            self.assertTrue(set(json.loads(path.read_text())['memory_ids']).issubset(self.backend.rows))
        before=copy.deepcopy(self.backend.rows)
        admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        self.assertEqual(self.backend.rows,before)

    def test_quality_rejection_keeps_the_source_and_rejects_a_changed_snapshot(self):
        admin,scope,plan = self.prepared_plan(keep=False)
        self.assertEqual(plan['rejected'],1)
        admin.freeze(scope)
        fact=next(r for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact')
        fact['memory']='Changed since audit'
        with self.assertRaisesRegex(ValueError,'changed'):
            admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        fact['memory']='I am studying sales.'
        admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        self.assertTrue(self.backend.rows)
        self.assertFalse(any(r['metadata']['info']['hermes_kind']=='fact' for r in self.backend.rows.values()))

    def test_quality_apply_obeys_bulk_protection_and_replays_an_interrupted_copy(self):
        admin,scope,plan = self.prepared_plan()
        self.cfg.update(frozen=True,bulk_clear_locked=True);self.save_config()
        before=copy.deepcopy(self.backend.rows)
        with self.assertRaisesRegex(ValueError,'protection'):
            admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        self.assertEqual(self.backend.rows,before)
        self.cfg['bulk_clear_locked']=False;self.save_config()
        self.backend.lose_response=True
        with self.assertRaises(RuntimeError):
            admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        count=self.backend.add_count
        admin.quality_apply(scope,plan['plan_id'],plan['plan_sha'])
        self.assertEqual(self.backend.add_count,count)
        self.assertEqual([r['cube'] for r in self.backend.rows.values() if r['metadata']['info']['hermes_kind']=='fact'],['life_work'])


def load_tests(loader, tests, pattern):
    """Не запускать унаследованные тесты повторно при discover."""
    return loader.loadTestsFromNames([name for name in dir(QualityTests)
        if name.startswith('test_') and name in QualityTests.__dict__], module=QualityTests)
