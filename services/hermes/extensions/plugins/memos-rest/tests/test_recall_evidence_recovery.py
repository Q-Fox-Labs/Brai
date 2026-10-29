# ABOUTME: Проверяет восстановление поиска после непроверяемой цитаты маршрутизатора.
# ABOUTME: Не допускает тихого пропуска пакета или принятия выдуманного свидетельства.
import json
import unittest
import test_routing as routing


class RecallEvidenceRecoveryTests(unittest.TestCase):
    setUp = routing.RoutingTests.setUp
    tearDown = routing.RoutingTests.tearDown
    new_provider = routing.RoutingTests.new_provider
    save_config = routing.RoutingTests.save_config

    def test_invalid_quote_is_corrected_without_losing_other_batches(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        candidates = [{'text': 'x' * 41000 + ' The preferred studio name is Quiet Harbour.', 'kind': 'fact'},
                      {'text': 'y' * 41000 + ' The report is artifact REPORT-123.', 'kind': 'turn'}]
        calls = []
        def transport(payload):
            data = json.loads(payload[-1]['content'])
            calls.append(data)
            if len(calls) == 2:
                evidence = 'The report contains invented numbered sections.'
            else:
                evidence = ('The preferred studio name is Quiet Harbour.' if len(calls) == 1
                            else 'The report is artifact REPORT-123.')
            return {'matches': [{'index': 0, 'relevance': 'direct', 'reason': 'Relevant source.',
                                 'evidence': evidence}], 'needs_sources': True, 'source_query': 'studio report'}
        router.transport = transport
        result = router.rank('Which studio name and report did we discuss?', candidates)
        self.assertEqual([m['index'] for m in result['matches']], [0, 1])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1]['recall_candidates'], calls[2]['recall_candidates'])
        self.assertTrue(calls[2].get('validation_errors'))

    def test_repeated_invalid_evidence_remains_a_visible_failure(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        calls = []
        def transport(payload):
            calls.append(payload)
            return {'matches': [{'index': 0, 'relevance': 'direct', 'reason': 'Relevant.',
                                 'evidence': 'A quote absent from every source.'}],
                    'needs_sources': False, 'source_query': 'equipment'}
        router.transport = transport
        with self.assertRaisesRegex(Exception, 'invalid evidence selection'):
            router.rank('Which equipment?', [{'text': 'The device is Vector 4.', 'kind': 'fact'}])
        self.assertEqual(len(calls), 2)
