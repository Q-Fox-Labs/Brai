# ABOUTME: Проверяет сохранность смысла факта при записи и переклассификации.
# ABOUTME: Использует отдельные тексты факта и источника в изолированном fake API.
"""Регрессии подмены факта цитатой при переносе между кубами."""
import importlib
import json
from unittest.mock import patch

from test_routing import RoutingTests


class MemoryIntegrityTests(RoutingTests):
    """Проверить содержимое перенесённого факта, а не только его метаданные."""

    def test_reclassification_preserves_fact_text_and_reviews_the_fact(self):
        quote = 'The options are River Studio and Quiet Studio; I prefer Quiet Studio.'
        content = 'The preferred practice name is Quiet Studio.'
        fact = self.fact(text=content, source={'message_index': 0, 'role': 'user',
            'start': 0, 'end': len(quote), 'quote': quote})
        self.router_reply([fact])
        self.provider.sync_turn(quote, '')
        self.send()
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root',
                 'managed_cubes': self.provider.routing.catalog.cubes}
        reviewed = []
        module = importlib.import_module(admin.__class__.__module__)
        def review(facts, context, **kwargs):
            reviewed.extend(facts)
            return [{**f, 'spheres': ['life_work'], 'memberships': ['life_work']} for f in facts]
        with patch.object(module.SemanticRouter, 'review', side_effect=review):
            plan = admin.quality_plan(scope)
        self.assertEqual([f['text'] for f in reviewed], [content])
        admin.freeze(scope)
        admin.quality_apply(scope, plan['plan_id'], plan['plan_sha'])
        facts = [r for r in self.backend.rows.values()
                 if r['metadata']['info'].get('hermes_kind') == 'fact']
        self.assertEqual([(r['cube'], r['memory']) for r in facts], [('life_work', content)])
        self.assertEqual(facts[0]['metadata']['info']['hermes_source']['quote'], quote)

    def test_readback_rejects_changed_fact_content_with_matching_metadata(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        row = next(r for r in self.backend.rows.values()
                   if r['metadata']['info'].get('hermes_kind') == 'fact')
        client = self.provider.routing.client(row['cube'])
        job = {'body': {'session_id': row['metadata']['session_id'],
                        'info': row['metadata']['info'],
                        'messages': [{'role': 'user', 'content': 'I am studying sales.'}]}}
        row['memory'] = 'Please remember that.'
        with self.assertRaisesRegex(Exception, 'content|text|payload'):
            client.verify(job, [row['id']])

    def test_restore_uses_completed_matching_snapshot_and_keeps_source_separate(self):
        content, quote = 'The preferred name is Quiet Studio.', 'Remember those options.'
        self.router_reply([self.fact(text=content, source={'message_index': 0, 'role': 'user',
            'start': 0, 'end': len(quote), 'quote': quote})])
        self.provider.sync_turn(quote, '')
        self.send()
        admin = self.provider.routing.admin()
        scope = {'profile': 'default', 'user_id': 'root', 'managed_cubes': self.provider.routing.catalog.cubes}
        module = importlib.import_module(admin.__class__.__module__)
        client = importlib.import_module(self.provider.client.__class__.__module__)
        with patch.object(module.SemanticRouter, 'review', side_effect=lambda facts, *a, **kw: facts):
            original = admin.quality_plan(scope)
        path = admin.root / 'quality' / (original['plan_id'] + '.json')
        snapshot = json.loads(path.read_text()); snapshot['version'] = 'historical-quality-v3'
        path.write_text(json.dumps(snapshot))
        path.with_suffix('.progress.json').write_text(json.dumps({'complete': True, 'plan_sha': module.stable_id(snapshot)}))
        row = next(r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_kind') == 'fact')
        info = row['metadata']['info']
        info.update(client.fact_fields(quote), hermes_event_id=module.stable_id([
            snapshot['version'], info['hermes_logical_id'], row['cube']]))
        row['memory'] = quote
        with patch.object(module.SemanticRouter, 'review', side_effect=lambda facts, *a, **kw: facts):
            result = admin.quality_plan(scope, original['plan_id'])
        self.assertEqual(result['restored'], 1)
        admin.freeze(scope)
        admin.quality_apply(scope, result['plan_id'], result['plan_sha'])
        facts = [r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_kind') == 'fact']
        self.assertEqual([client.memory_text(r) for r in facts], [content])
        self.assertEqual(facts[0]['metadata']['info']['hermes_source']['quote'], quote)

    def test_rank_requires_evidence_from_the_selected_candidate(self):
        module = importlib.import_module(self.provider.routing.router.__class__.__module__)
        router = module.SemanticRouter({}, self.provider.routing.catalog)
        payloads = []
        def invalid(payload):
            payloads.append(json.loads(payload[-1]['content']))
            return {'matches': [{'index': 1, 'relevance': 'direct', 'reason': 'preferred name',
                                 'evidence': 'Quiet Studio'}], 'needs_sources': False, 'source_query': ''}
        router.transport = invalid
        with self.assertRaisesRegex(module.MemOSError, 'invalid'):
            router.rank('Which name was chosen?', [{'text': 'Quiet Studio'}, {'text': 'Vehicle oil pressure'}])
        self.assertEqual([r['index'] for r in payloads[0]['recall_candidates']], [0, 1])

    def test_context_finds_referenced_options_in_the_middle_of_long_history(self):
        module = importlib.import_module(self.provider.routing.router.__class__.__module__)
        history = ['Unrelated household details. ' * 1000] * 10
        history.insert(5, '[assistant historical source] Practice names: River Studio or Quiet Studio.')
        context = module.evidence_context(history, [{'text': 'Quiet Studio is preferred.',
            'source': {'quote': 'Remember those options.'}}], budget=1000)
        self.assertTrue(any('Quiet Studio' in text for text in context))

    def test_adaptive_context_exceeds_old_character_ceiling_and_reports_actual_delivery(self):
        self.provider.config['context_chars'] = 0
        rows = [{'id': str(i), 'memory': 'A concrete distinct fact number ' + str(i) + '. ' + 'detail ' * 30,
                 'metadata': {'info': {'hermes_kind': 'fact', 'hermes_author_id': 'owner'}}} for i in range(60)]
        self.provider._search = lambda *args: rows
        self.provider.on_turn_start(1, 'synthetic question', context_length=128000,
                                    context_available_tokens=10000)
        text = self.provider.prefetch('What distinct facts were recorded?')
        self.assertGreater(len(text), 6000)
        self.assertEqual(self.provider.recall_status().found_count,60)
        from agent.model_metadata import estimate_messages_tokens_rough
        self.assertLessEqual(estimate_messages_tokens_rough([{'role': 'user', 'content': text}]), 6400)

    def test_reviewer_receives_current_source_even_without_prior_context(self):
        router = self.provider.routing.router
        text = 'I am studying sales.'
        self.router_reply([self.fact()])
        with patch.object(router, 'review', return_value=[]) as review:
            router.extract([{'role': 'user', 'content': text}], context=[])
        self.assertIn(text, review.call_args.args[1])

    def test_long_canonical_fact_keeps_full_text_and_detects_a_corrupt_part(self):
        text = 'My practice offers an appointment every weekday. ' * 40
        self.router_reply([self.fact(text=text)])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        rows = [r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_kind') == 'fact']
        self.assertEqual(self.provider.outbox.status()['pending'], 0)
        self.assertGreater(len(rows), 1)
        module = importlib.import_module(self.provider.client.__class__.__module__)
        self.assertTrue(all(module.memory_text(r) == text.strip() for r in rows))
        rows[-1]['memory'] = 'A different fragment.'
        with self.assertRaisesRegex(module.MemOSError, 'differs'):
            module.memory_text(rows[-1])

    def test_partial_existing_fact_cannot_be_acknowledged_as_a_complete_recovery(self):
        text = 'My practice offers appointments every weekday. ' * 40
        self.router_reply([self.fact(text=text)])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        rows = [r for r in self.backend.rows.values() if r['metadata']['info'].get('hermes_kind') == 'fact']
        first = rows[0]
        for row in rows[1:]:
            del self.backend.rows[row['id']]
        info = {key: value for key, value in first['metadata']['info'].items()
                if key not in ('hermes_chunk_index', 'hermes_chunk_count')}
        job = {'body': {'session_id': first['metadata']['session_id'], 'info': info,
                        'messages': [{'role': 'user', 'content': text.strip()}]}}
        client = self.provider.routing.client(first['cube'])
        with self.assertRaisesRegex(Exception, 'incomplete_fact_parts'):
            client.execute(job, lambda _: None)


def load_tests(loader, tests, pattern):
    """Не повторять унаследованные проверки при discover."""
    return loader.loadTestsFromNames([name for name in MemoryIntegrityTests.__dict__
        if name.startswith('test_')], module=MemoryIntegrityTests)
