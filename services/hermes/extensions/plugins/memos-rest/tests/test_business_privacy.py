import copy
import json
import unittest
import test_provider as legacy
import test_routing as routed


class BusinessLegacyPrivacyTests(unittest.TestCase):
    setUp = legacy.ProviderTests.setUp
    tearDown = legacy.ProviderTests.tearDown
    new_provider = legacy.ProviderTests.new_provider
    send = legacy.ProviderTests.send

    def test_legacy_tools_exclude_private_business_records(self):
        self.provider.sync_turn('private sentence', '')
        self.send()
        row = next(iter(self.backend.rows.values()))
        row['metadata']['info']['hermes_visibility'] = 'business_private'
        self.assertNotIn('private sentence', self.provider.prefetch('private sentence'))
        self.assertEqual(self.provider.recall_status().count, 0)
        for tool in ('memos_read','memos_forget'):
            result = json.loads(self.provider.handle_tool_call(tool, {'memory_id':row['id']}))
            self.assertEqual(result['status'],'not_found')
        self.assertIn(row['id'], self.backend.rows)


class BusinessPrivacyTests(unittest.TestCase):
    setUp = routed.RoutingTests.setUp
    tearDown = routed.RoutingTests.tearDown
    new_provider = routed.RoutingTests.new_provider
    send = routed.RoutingTests.send
    save_config = routed.RoutingTests.save_config
    router_reply = routed.RoutingTests.router_reply
    fact = routed.RoutingTests.fact

    def test_business_scan_has_a_whole_request_time_budget(self):
        from unittest.mock import patch
        module = __import__(self.provider.__class__.__module__.rsplit('.',1)[0] + '.business', fromlist=['BusinessMemory'])
        memory = module.BusinessMemory(self.provider)
        a = {'profile':str(self.home.resolve()),'owner':'alice','account':'alice',
             'connection':'conn-a','chat':'200','recipient':'200'}
        ticks=iter(range(1000))
        with patch('time.monotonic',side_effect=lambda:next(ticks)):
            self.assertEqual(memory.recall(a,'query',lambda *args:True),[])
        reads=[c for c in self.backend.calls if c[0]=='/product/get_memory']
        self.assertLessEqual(len(reads),4,'Whole context retrieval cannot spend seconds per cube indefinitely')

    def test_business_archive_retrieves_only_validated_recipient_sources(self):
        module = __import__(self.provider.__class__.__module__.rsplit('.',1)[0] + '.business', fromlist=['BusinessMemory'])
        memory = module.BusinessMemory(self.provider)
        a = {'profile':str(self.home.resolve()), 'owner':'alice', 'account':'alice',
             'connection':'conn-a','chat':'200','recipient':'200'}
        b = {**a,'chat':'201','recipient':'201'}
        c = {**a,'owner':'bob','account':'bob','connection':'conn-b'}
        self.router_reply([self.fact()])
        source = {'message_id':'1','text':'I am studying sales.','revision':'revision-1',
                  'actor':'customer','author_id':'200','origin':'telegram_incoming','created_at':1}
        events = [memory.archive(scope, {**source,'author_id':scope['recipient']}) for scope in (a,b,c)]
        self.send()
        self.assertEqual(len(self.backend.rows),6)
        for row in self.backend.rows.values():
            info = row['metadata']['info']
            self.assertEqual(info['hermes_visibility'],'business_private')
            self.assertEqual(info['hermes_subject_id'],info['hermes_business_scope']['recipient'])
        rows = memory.recall(a,'sales study',lambda mid,rev,author,actor,evidence: mid=='1' and rev=='revision-1' and author=='200' and evidence == source['text'])
        self.assertTrue(rows)
        self.assertTrue(all(r['scope'] == a for r in rows))
        for row in self.backend.rows.values():
            row['memory'] = 'FORGED OTHER CUSTOMER CONTENT'
        rows = memory.recall(a,'sales',lambda *args: True)
        self.assertTrue(all('FORGED' not in r['text'] for r in rows))
        self.assertEqual(memory.recall(a,'sales',lambda *args: False), [])
        for row in self.backend.rows.values():
            row['metadata']['info']['hermes_business_scope'] = {**a,'owner':'other'}
        self.assertEqual(memory.recall(a,'sales',lambda *args: True), [])
        self.assertEqual(memory.recall({**a,'profile':'other'},'sales',lambda *args: True), [])

    def test_generic_recall_and_id_tools_exclude_business_records_even_same_owner(self):
        self.router_reply([self.fact()])
        self.provider.sync_turn('I am studying sales.', '')
        self.send()
        ids = list(self.backend.rows)
        for row in self.backend.rows.values():
            row['metadata']['info']['hermes_visibility'] = 'business_private'
            row['metadata']['info']['hermes_business_scope'] = {'owner': 'alice', 'chat': '200'}
        self.provider.routing.router.transport = lambda payload: {'cubes': ['main']}
        self.assertNotIn('studying sales', self.provider.prefetch('studying sales'))
        self.assertEqual(self.provider.recall_status().count, 0)
        for identifier in ids:
            for tool in ('memos_read','memos_forget','memos_replace'):
                result = json.loads(self.provider.handle_tool_call(tool, {'memory_id':identifier,'content':'new'}))
                self.assertEqual(result['status'], 'not_found')
        result = json.loads(self.provider.handle_tool_call('memos_search', {'query':'sales','cubes':['main']}))
        self.assertEqual(result['memories'], [])
        self.assertEqual(set(self.backend.rows), set(ids))
