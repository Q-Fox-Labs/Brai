# ABOUTME: Проверяет общую хронологию после смыслового отбора заданной темы.
# ABOUTME: Старые этапы, другие темы и новые копии фактов не заменяют последний диалог.
import json
import unittest
from test_routing import RoutingTests


class RecallTopicChronologyTests(unittest.TestCase):
    setUp = RoutingTests.setUp
    tearDown = RoutingTests.tearDown
    new_provider = RoutingTests.new_provider
    save_config = RoutingTests.save_config

    def test_latest_topic_is_selected_across_batches_after_semantic_matching(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        candidates = [
            {'text': 'old topic ' + 'x'*81000, 'kind': 'turn', 'date': '2026-01-01T08:00:00Z'},
            {'text': 'current topic', 'kind': 'turn', 'date': '2026-01-01T09:00:00Z'},
            {'text': 'same instant topic', 'kind': 'native', 'date': '2026-01-01T12:00:00+03:00'},
            {'text': 'unrelated', 'kind': 'turn', 'date': '2026-02-01T00:00:00Z'},
            {'text': 'new copy of old fact', 'kind': 'fact', 'date': '2026-03-01T00:00:00Z'},
        ]
        calls=[]
        def transport(payload):
            data=json.loads(payload[-1]['content']);calls.append(data)
            return {'matches':[{'index':row['index'],'relevance':'direct','reason':'Requested topic.'}
                for row in data['recall_candidates'] if 'topic' in row['text']],
                'needs_sources':False,'source_query':data['query']}
        router.transport=transport
        result=router.rank('Our latest conversation about this topic?',candidates,goal='latest_topic')
        self.assertEqual([row['index'] for row in result['matches']],[1,2])
        self.assertEqual(result['matches'][0]['evidence'],candidates[1]['text'])
        self.assertEqual(len(calls),1)

    def test_no_matching_topic_does_not_substitute_the_latest_unrelated_dialogue(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        router.transport=lambda payload: {'matches':[],'needs_sources':False,'source_query':'absent topic'}
        result=router.rank('Latest conversation about an absent topic?',[
            {'text':'Different subject.','kind':'turn','date':'2026-01-01T09:00:00Z'}],goal='latest_topic')
        self.assertEqual(result['matches'],[])

    def test_no_match_in_the_newest_batch_still_searches_older_batches(self):
        router = type(self.provider.routing.router)(self.cfg['router'], self.provider.routing.catalog)
        def transport(payload):
            data=json.loads(payload[-1]['content'])
            return {'matches':[{'index':row['index'],'relevance':'direct','reason':'Requested topic.'}
                for row in data['recall_candidates'] if row['text'].startswith('requested')],
                'needs_sources':False,'source_query':data['query']}
        router.transport=transport
        result=router.rank('Latest conversation about the requested topic?',[
            {'text':'unrelated '+ 'x'*81000,'kind':'turn','date':'2026-01-02T09:00:00Z'},
            {'text':'requested topic','kind':'turn','date':'2026-01-01T09:00:00Z'},
        ],goal='latest_topic')
        self.assertEqual([row['index'] for row in result['matches']],[1])
