# ABOUTME: Проверяет последний разговор по общей хронологии разрешённых источников.
# ABOUTME: Новизна факта и порядок пакетов не подменяют дату исходного диалога.
import unittest
from test_routing import RoutingTests


class RecallChronologyTests(unittest.TestCase):
    setUp = RoutingTests.setUp
    tearDown = RoutingTests.tearDown
    new_provider = RoutingTests.new_provider
    save_config = RoutingTests.save_config

    def test_latest_dialogue_uses_global_dates_and_preserves_all_ties(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        router.transport = lambda payload: self.fail('Chronological selection needs no batch ranking')
        candidates = [
            {'text': 'Earlier conversation. ' * 5000, 'kind': 'turn', 'date': '2026-01-01T08:00:00Z'},
            {'text': 'New fact about an old conversation.', 'kind': 'fact', 'date': '2026-02-01T00:00:00Z'},
            {'text': 'Latest conversation.', 'kind': 'turn', 'date': '2026-01-01T12:00:00+03:00'},
            {'text': 'Other dialogue at the same instant.', 'kind': 'native', 'date': '2026-01-01T09:00:00Z'},
        ]
        result = router.rank('What was our latest conversation?', candidates, goal='latest_conversation')
        self.assertEqual([row['index'] for row in result['matches']], [2, 3])
        self.assertEqual(result['matches'][0]['evidence'], candidates[2]['text'])
        self.assertFalse(result['needs_sources'])

    def test_invalid_dialogue_date_is_visible_instead_of_selecting_an_older_one(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        with self.assertRaisesRegex(Exception, 'timestamp'):
            router.rank('Latest conversation?', [
                {'text': 'Undated dialogue.', 'kind': 'turn', 'date': None},
                {'text': 'Dated dialogue.', 'kind': 'turn', 'date': '2026-01-01T09:00:00Z'},
            ], goal='latest_conversation')

    def test_facts_are_not_presented_as_a_conversation(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        result = router.rank('Latest conversation?', [
            {'text': 'A stored fact.', 'kind': 'fact', 'date': '2026-01-01T09:00:00Z'},
        ], goal='latest_conversation')
        self.assertEqual(result['matches'], [])
        self.assertTrue(result['needs_sources'])
