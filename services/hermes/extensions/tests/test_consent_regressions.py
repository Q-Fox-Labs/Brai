# ABOUTME: Воспроизводит смену вопроса и повторную доставку согласования.
# ABOUTME: Использует только временную SessionDB и вымышленные сообщения.
import time
import unittest
import test_conversation_approval as fixture


class ConsentRegressions(unittest.TestCase):
    setUp = fixture.ConsentTests.setUp
    tearDown = fixture.ConsentTests.tearDown
    prepare = fixture.ConsentTests.prepare

    def test_reminder_preserves_first_delivery(self):
        row = self.prepare()
        self.store.delivered(row['id'], '10')
        first = self.store.query(self.scope.key)
        self.store.delivered(row['id'], '20')
        self.assertEqual(self.store.query(self.scope.key)['question_message_id'], '10')
        self.assertEqual(self.store.query(self.scope.key)['delivered_at'], first['delivered_at'])

    def test_answer_cannot_cross_question_replacement(self):
        row = self.prepare()
        self.store.delivered(row['id'], '10')
        result = self.store.answer(self.scope.key, 'alice', '11', 'да', time.time()+1, expected_id='older-question')
        self.assertEqual(result, 'stale')

    def test_clarification_returns_to_dialogue_before_and_after_delivery(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        for delivered in (False, True):
            with self.subTest(delivered=delivered):
                row = self.prepare()
                if delivered:
                    self.store.delivered(row['id'], '10')
                event = SimpleNamespace(source=fixture.source(), internal=False,
                    message_id='11', text='Да, но сначала покажи изменения',
                    timestamp=time.time()+1)
                runner = SimpleNamespace(_session_key_for_source=lambda _: 'session',
                    session_store=SimpleNamespace(_db_for_key=lambda _: self.db))
                self.assertIsNone(fixture.consent.gateway_input(runner, event, event))
                self.assertIsNone(self.store.query(self.scope.key))
                self.assertEqual(self.store.requests(self.scope.key, 'alice')[-1]['text'], event.text)

    def test_other_safe_operation_is_reviewed_while_question_pending(self):
        from unittest.mock import patch
        consent = fixture.consent
        self.prepare()
        with consent.turn_scope(self.db, fixture.source(), 'session', 'Покажи изменения', '11'):
            with consent.tool_scope('read_file', {'path':'report'}, 'read'):
                with patch.object(consent, 'review_action', return_value={'decision':'allow','effects_known':True}) as review:
                    self.assertTrue(consent.gate('read report')['approved'])
                    review.assert_called_once()

    def test_reviewer_reads_requests_arriving_after_turn_started(self):
        import json
        import sys
        import types
        from unittest.mock import patch
        consent = fixture.consent
        auxiliary = types.ModuleType('agent.auxiliary_client')
        auxiliary._get_task_timeout = lambda _: 30
        auxiliary.call_llm = None
        config = types.ModuleType('tools.approval_context')
        config._get_approval_config = lambda: {}
        redact = types.ModuleType('agent.redact')
        redact.redact_sensitive_text = lambda text, **_: text
        with consent.turn_scope(self.db, fixture.source(), 'session', 'Составь отчёт', '1') as scope:
            self.store.record_request(scope.key, 'alice', '2', 'Добавь годовые вкладки')
            calls = []
            def call(**kwargs):
                calls.append(json.loads(kwargs['messages'][1]['content']))
                return types.SimpleNamespace(choices=[types.SimpleNamespace(
                    message=types.SimpleNamespace(content=json.dumps(fixture.REVIEW)))])
            with patch.dict(sys.modules, {'agent.auxiliary_client':auxiliary,
                    'tools.approval_context':config, 'agent.redact':redact}):
                consent.review_action(self.descriptor, scope, call=call)
            self.assertIn({'message_id':'2','text':'Добавь годовые вкладки'},
                calls[0]['authenticated_conversation_requests'])
