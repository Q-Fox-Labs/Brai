# ABOUTME: Проверяет русские сообщения о сбоях на границе Telegram и движка.
# ABOUTME: Проверяет классификацию, важные детали и сохранение частичного ответа.

import ast
import importlib.util
import logging
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PATCH = Path(__file__).resolve().parents[1] / 'patches/russian-failure-notice.patch'


def added_source(path):
    text = PATCH.read_text().split(f'diff --git a/{path} b/{path}\n', 1)[1]
    text = text.split('\ndiff --git ', 1)[0]
    return '\n'.join(line[1:] for line in text.splitlines()
                     if line.startswith('+') and not line.startswith('+++'))


def notice_module():
    module = types.ModuleType('gateway.russian_failure_notice')
    exec(added_source('gateway/russian_failure_notice.py'), module.__dict__)
    return module


def gateway_function():
    lines = PATCH.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('+def _telegram_failure_explanation'))
    body = []
    for line in lines[start:]:
        if not line.startswith('+'):
            break
        body.append(line[1:])
    code = ast.parse('\n'.join(body))
    scope = {'logger': logging.getLogger('notice-test'), 'PARTIAL_FAILED_TURN_NOTICE': 'partial'}
    exec(compile(code, '<patch>', 'exec'), scope)
    return scope['_telegram_failure_explanation']


class FailureNoticeTest(unittest.TestCase):
    def setUp(self):
        self.notice = notice_module()
        self.log = logging.getLogger('notice-test')

    def render(self, code, **kwargs):
        surface = {'code': code, 'layer': kwargs.pop('layer', 'provider')}
        return self.notice.explain_failure(
            'ChatGPT or Codex Subscription. hermes fallback add.', surface=surface,
            diagnostic='', logger=self.log, redact=lambda value: value, **kwargs)

    def test_all_known_reasons_have_distinct_localized_descriptions(self):
        reasons = '''auth auth_permanent billing rate_limit upstream_rate_limit upstream_blocked
        overloaded server_error timeout ssl_cert_verification context_overflow payload_too_large
        image_too_large image_corrupt model_not_found provider_policy_blocked content_policy_blocked
        model_entitlement incomplete_response format_error role_alternation invalid_encrypted_content
        multimodal_tool_content_unsupported reasoning_mandatory thinking_signature long_context_tier
        oauth_long_context_beta_forbidden llama_cpp_grammar_pattern truncated invalid_response
        empty_response loop_error interpreter_shutdown session_busy stream_drop disk_full
        compression_deferred free_tier_rate_limited free_tier_at_capacity free_tier_outage
        free_tier_model_not_free free_tier_disabled free_tier_route free_tier_refused'''.split()
        for code in reasons:
            with self.subTest(code=code):
                self.assertIn(code, self.notice._COPY)
                text = self.render(code)
                self.assertNotIn('ChatGPT', text)
                self.assertNotIn('Codex', text)
                self.assertNotIn('hermes', text.lower())
                self.assertNotIn('Исходное сообщение', text)
                self.assertNotIn(self.notice._UNKNOWN, text)

    def test_error_meaning_and_unverified_billing(self):
        self.assertIn('Сервер, который обрабатывает запросы к модели', self.render('overloaded'))
        self.assertIn('отклонил данные для подключения', self.render('auth'))
        self.assertIn('точная причина не подтверждена', self.render('billing', billing_unverified=True))
        self.assertIn('причину ошибки', self.render('unknown').lower())
        self.assertIn('защита перед сервером', self.render('upstream_blocked').lower())
        self.assertIn('неизвестное действие', self.render('truncated', result={'brai_failure_kind':'invalid_tool_call'}))
        self.assertIn('это действие не выполнено', self.render('truncated', result={'brai_failure_kind':'truncated_tool_call'}))

    def test_reset_and_partial_are_preserved(self):
        text = self.notice.explain_failure('english', surface={'code':'rate_limit', 'resets_at':1121},
            diagnostic='', logger=self.log, redact=str, partial=True, now=1000,
            delivered_partial='Начатый ответ.')
        self.assertTrue(text.startswith('Начатый ответ.'))
        self.assertIn('примерно 3 мин.', text)
        self.assertIn('Некоторые действия могли уже выполниться', text)
        text = self.render('context_overflow', result={'brai_session_reset': True})
        self.assertIn('начат новый разговор', text)
        self.assertNotIn('/compress', text)

    def test_diagnostic_is_redacted_and_failure_to_log_does_not_leak_original(self):
        with self.assertLogs(self.log, 'WARNING') as records:
            text = self.notice.explain_failure('secret original', surface={'code':'auth'},
                diagnostic='secret', logger=self.log, redact=lambda value: '[скрыто]')
        self.assertIn('[скрыто]', records.output[0])
        self.assertNotIn('secret', records.output[0] + text)
        text = self.notice.explain_failure('secret original', surface={'code':'auth'},
            diagnostic='secret', logger=self.log, redact=lambda value: 1/0)
        self.assertNotIn('secret', text)

    def test_tool_validation_distinguishes_incomplete_and_unknown_actions(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for tool validation')
        tree = ast.parse((Path(candidate) / 'agent/turn_tool_validation.py').read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_partial_exit')
        fn.returns = None
        for arg in fn.args.args + fn.args.kwonlyargs:
            arg.annotation = None
        scope = {'close_interrupted_tool_sequence': lambda *args: None,
                 'stamp_failure': lambda value, reason, retryable: {**value, 'failure_reason':reason}}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<candidate>', 'exec'), scope)
        agent = types.SimpleNamespace(_persist_session=lambda *args: None)
        for kind in ('invalid_tool_call', 'truncated_tool_call'):
            result = scope['_partial_exit'](agent, [], [], 1, 'detail', brai_failure_kind=kind)
            self.assertEqual(result['brai_failure_kind'], kind)
            self.assertEqual(result['failure_reason'], 'truncated')

    def test_classifier_taxonomy_is_covered(self):
        import os
        engine = os.environ.get('HERMES_TEST_ENGINE')
        if not engine:
            self.skipTest('HERMES_TEST_ENGINE is required for the classifier taxonomy')
        tree = ast.parse((Path(engine) / 'agent/error_classifier.py').read_text())
        enum = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'FailoverReason')
        reasons = {node.value.value for node in enum.body if isinstance(node, ast.Assign)
                   and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}
        self.assertEqual(reasons - set(self.notice._COPY), {'unknown'})

    def test_real_classifier_and_gateway_wrapper(self):
        engine = __import__('os').environ.get('HERMES_TEST_ENGINE')
        if not engine:
            self.skipTest('HERMES_TEST_ENGINE is required for the real classifier')
        spec = importlib.util.spec_from_file_location('agent.error_surface', Path(engine) / 'agent/error_surface.py')
        classifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(classifier)
        fake_run = types.SimpleNamespace(_gateway_platform_value=lambda value: value,
            _redact_gateway_user_facing_secrets=lambda value: '[скрыто]',
            _sanitize_gateway_final_response=lambda platform, value: value)
        fake_modules = {'gateway.run': fake_run, 'gateway.russian_failure_notice': self.notice,
                        'agent.error_surface': classifier}
        func = gateway_function()
        with patch.dict('sys.modules', fake_modules):
            result = {'failed': True, 'failure_reason': 'overloaded', 'error': 'provider said overloaded',
                      'brai_delivered_partial': 'Уже полученная часть ответа.'}
            with self.assertLogs(self.log, 'WARNING'):
                text = func('ChatGPT hermes fallback add', types.SimpleNamespace(platform='telegram'),
                            result=result, failure_notice=lambda value: 'partial')
            self.assertTrue(text.startswith('Уже полученная часть ответа.'))
            self.assertIn('Сервер, который обрабатывает запросы к модели', text)
            self.assertIn('Некоторые действия могли уже выполниться', text)
            self.assertNotIn('ChatGPT', text)
            self.assertEqual(func('original', types.SimpleNamespace(platform='other'), result=result), 'original')

class DeliveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_failure_is_translated_before_voice_and_final_delivery(self):
        import contextlib
        from unittest.mock import AsyncMock
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for delivery integration')
        tree = ast.parse((Path(candidate) / 'gateway/run_turn.py').read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'GatewayTurnMixin')
        method = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == '_hmwa_deliver_turn_response')
        module = notice_module()
        fake_run = types.SimpleNamespace(_gateway_platform_value=lambda value: value,
            _redact_gateway_user_facing_secrets=lambda value: value,
            _sanitize_gateway_final_response=lambda platform, value: value)
        classifier = types.SimpleNamespace(build_error_surface_from_result=lambda result: {'code':result['failure_reason']},
            build_error_surface_from_exception=lambda error: None)
        wrapper = gateway_function()
        scope = {'diagnostic_wake_muted': lambda event: False, 'suppress':contextlib.suppress,
                 'logger':logging.getLogger('notice-test'), '_telegram_failure_explanation':wrapper}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), scope)
        runner = types.SimpleNamespace(_delivery_adapter_for=lambda source: None,
            _should_send_voice_reply=lambda *args, **kwargs: True, _send_voice_reply=AsyncMock(),
            _hmwa_failed_turn_notice=lambda result: 'partial')
        result = {'failed':True, 'failure_reason':'auth', 'error':'rejected', 'already_sent':False}
        with patch.dict('sys.modules', {'gateway.run':fake_run, 'gateway.russian_failure_notice':module,
                                        'agent.error_surface':classifier}), self.assertLogs('notice-test', 'WARNING'):
            reply = await scope['_hmwa_deliver_turn_response'](runner, object(), types.SimpleNamespace(platform='telegram'),
                types.SimpleNamespace(session_id='x'), 's', 1, result, [], 'ChatGPT hermes setup', '', False)
        self.assertIn('отклонил данные для подключения', reply)
        self.assertNotIn('ChatGPT', reply)
        runner._send_voice_reply.assert_awaited_once_with(unittest.mock.ANY, reply)


if __name__ == '__main__':
    unittest.main()
