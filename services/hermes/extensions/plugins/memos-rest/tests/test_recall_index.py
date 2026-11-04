# ABOUTME: Проверяет индексный recall и отсутствие повторной выгрузки архива.
# ABOUTME: Использует синтетическую память и существующий изолированный fake API.
import copy
import importlib
import unittest

from test_routing import RoutingTests


class IndexedRecallTests(unittest.TestCase):
    setUp = RoutingTests.setUp
    tearDown = RoutingTests.tearDown
    new_provider = RoutingTests.new_provider
    save_config = RoutingTests.save_config

    def row(self, identifier, kind='native', author='alice'):
        info = {'hermes_kind': kind, 'hermes_author_id': author,
                'hermes_event_id': identifier, 'hermes_logical_id': identifier,
                'hermes_cube': 'main', 'hermes_memberships': ['main'],
                'hermes_home_scope': self.provider.routing.home_scope,
                'hermes_memory_epoch': self.cfg['memory_epoch']}
        return {'id': identifier, 'memory': 'Exact synthetic evidence',
                '_cube_id': 'main', 'metadata': {'user_id': 'root', 'info': info}}

    def index(self, rows):
        original = self.backend.request
        calls = []
        state = {'version': 1, 'complete': True, 'physical_count': 5000,
                 'logical_count': 1000, 'matched_count': len(rows), 'memories': rows}
        def request(client, path, body=None, **kwargs):
            calls.append((path, copy.deepcopy(body)))
            if path == '/product/memory_capabilities':
                return {'code': 200, 'data': {'recall_index': 1}}
            if path == '/product/recall_index':
                return {'code': 200, 'data': copy.deepcopy(state)}
            if path == '/product/get_memory':
                raise AssertionError('Indexed search must not fetch the archive')
            return original(client, path, body, **kwargs)
        self.backend.request = request
        return state, calls

    def test_index_returns_all_matches_in_one_review_without_archive_get(self):
        rows = [self.row(str(i), 'fact' if i % 2 else 'native') for i in range(40)]
        state, calls = self.index(rows)
        ranked = []
        def rank(query, candidates, **kwargs):
            ranked.append(candidates)
            return {'matches': [{'index': i, 'relevance': 'direct', 'reason': 'Evidence'}
                                for i in range(len(candidates))],
                    'needs_sources': True, 'source_query': query}
        self.provider.routing.router.rank = rank
        result = self.provider.routing.search('Synthetic topic', 'session-a', expand_sources=True)
        self.assertEqual(len(result), 40)
        self.assertEqual([len(batch) for batch in ranked], [40])
        self.assertTrue(result.archive_searched)
        self.assertEqual([path for path, body in calls],
                         ['/product/memory_capabilities', '/product/recall_index'])
        body = calls[-1][1]
        self.assertEqual(body['author_id'], 'alice')
        self.assertEqual(set(body['cubes']), set(self.provider.routing.catalog.cubes))
        self.assertEqual(body['scope']['hermes_memory_epoch'], self.cfg['memory_epoch'])
        self.assertNotIn('top_k', body)

    def test_partial_incompatible_and_foreign_responses_never_fall_back(self):
        state, calls = self.index([self.row('source')])
        client = importlib.import_module(self.provider.__class__.__module__.rsplit('.', 1)[0]+'.client')
        original = copy.deepcopy(state)
        changes = [{'complete': False}, {'matched_count': 2}, {'version': True},
                   {'logical_count': 0},
                   {'memories': [self.row('foreign', author='bob'), self.row('duplicate')]}]
        for change in changes:
            state.clear(); state.update(copy.deepcopy(original)); state.update(change)
            with self.subTest(change=change), self.assertRaises(client.MemOSError):
                self.provider.routing.search('Synthetic', 'session-a', expand_sources=True)
        self.assertFalse(any(path == '/product/get_memory' for path, _ in calls))

    def test_allowed_boundary_still_rejects_wrong_author_and_private_memory(self):
        own = self.row('own')
        foreign = self.row('foreign', author='bob')
        private = self.row('private')
        private['metadata']['info']['hermes_visibility'] = 'business_private'
        state, _ = self.index([own, foreign, private])
        result = self.provider.routing.search('Synthetic', 'session-a', expand_sources=True)
        self.assertEqual([row['id'] for row in result], ['own'])

    def test_source_timestamp_from_index_survives_fact_selection(self):
        row = self.row('fact', 'fact')
        row['_source_date'] = '2020-01-01T00:00:00+00:00'
        row['metadata']['created_at'] = '2026-01-01T00:00:00+00:00'
        self.index([row])
        result = self.provider.routing.search('Synthetic', 'session-a', expand_sources=True)
        self.assertEqual(result[0]['_source_date'], row['_source_date'])

    def test_repeated_question_observes_new_memory_without_thirty_second_cache(self):
        state, calls = self.index([self.row('first', 'fact')])
        self.provider.context_window = 500000
        self.provider.prefetch('Find synthetic evidence')
        state['memories'] = [self.row('second', 'fact')]
        text = self.provider.prefetch('Find synthetic evidence')
        self.assertIn('second', text)
        self.assertEqual(sum(path == '/product/recall_index' for path, _ in calls), 2)


if __name__ == '__main__':
    unittest.main()
