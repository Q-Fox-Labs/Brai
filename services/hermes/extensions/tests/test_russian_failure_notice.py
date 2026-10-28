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

    def test_error_messages_keep_visible_formatting(self):
        for code in self.notice._COPY:
            with self.subTest(code=code):
                text = self.render(code, result={'brai_connection_kind':'external'})
                self.assertTrue(text.startswith(self.notice._TITLES[code] + '\n\n'))
                self.assertIn('⚠️ **Работа не завершена.**', text)
                self.assertIn('**Данные для проверки:**\nКод: `' + code + '`', text)
        self.assertTrue(self.render('unknown').startswith('⚠️ **Не удалось завершить запрос**'))
        text = self.render('overloaded', result={'brai_connection_kind':'external'}, partial=True)
        self.assertIn('Некоторые действия могли уже выполниться. Перед повтором проверьте их результат.', text)

    def test_connection_origin_requires_evidence(self):
        kind = self.notice.connection_kind
        self.assertEqual(kind('openai-codex', 'https://chatgpt.com/backend-api/codex'), 'external')
        self.assertEqual(kind('openrouter', 'https://openrouter.ai/api/v1'), 'external')
        self.assertEqual(kind('openai-codex', 'https://chatgpt.com.other.invalid/v1'), 'unknown')
        self.assertEqual(kind('openai-codex', 'https://localhost/v1'), 'local')
        self.assertEqual(kind('ollama', 'https://example.invalid/v1'), 'unknown')
        self.assertEqual(kind('custom:cloud', 'https://example.invalid/v1'), 'unknown')
        self.assertEqual(kind('openai-codex', 'https://user:pass@chatgpt.com/v1'), 'unknown')
        self.assertEqual(kind(None, None), 'unknown')
        registry = types.SimpleNamespace(PROVIDER_REGISTRY={'anthropic':types.SimpleNamespace(inference_base_url='https://api.anthropic.com/v1')})
        with patch.dict('sys.modules', {'hermes_cli.auth':registry}):
            self.assertEqual(kind('anthropic', 'https://api.anthropic.com/v1'), 'external')
            self.assertEqual(kind('anthropic', 'https://private.example/v1'), 'unknown')

    def test_external_local_and_unknown_errors_are_distinct(self):
        for code in self.notice._MODEL_CODES:
            with self.subTest(code=code):
                external = self.render(code, result={'brai_connection_kind':'external'})
                local = self.render(code, result={'brai_connection_kind':'local'})
                unknown = self.render(code, result={'brai_connection_kind':'unknown'})
                self.assertIn('сторонн', external.lower())
                self.assertIn('локальное подключение', local)
                self.assertIn('неизвестно, на чьей стороне', unknown)
                self.assertNotIn('chatgpt', external.lower())
                self.assertNotIn('codex', external.lower())
                self.assertNotIn('hermes', external.lower())
        for code in ('overloaded', 'server_error', 'rate_limit', 'auth', 'billing', 'invalid_response'):
            self.assertNotIn('администратор', self.render(code, result={'brai_connection_kind':'external'}))
        self.assertIn('стороннего сервиса ИИ', self.render('timeout', result={'brai_connection_kind':'external'}))
        self.assertIn('или в соединении', self.render('timeout', result={'brai_connection_kind':'external'}))

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

    def test_origin_tracks_actual_connection_after_fallback(self):
        import contextlib
        import os
        import sys
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for runner integration')
        tree = ast.parse((Path(candidate) / 'gateway/run_turn_runner.py').read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and any(isinstance(m, ast.FunctionDef) and m.name == '_run_conversation_with_approval' for m in node.body))
        method = next(m for m in cls.body if isinstance(m, ast.FunctionDef) and m.name == '_run_conversation_with_approval')
        scope = {'_accepts_keyword': lambda *args: False, 'suppress':contextlib.suppress}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), scope)
        source = types.SimpleNamespace(user_id='1', user_name='test', is_bot=False)
        ctx = types.SimpleNamespace(session_key='s', message='hello', source=source, session_id='s',
            title_user_message=None, persist_user_display_kind=None, persist_user_display_metadata=None,
            moa_config=None, inbound_message_id=None, mute_notification_reply=False)
        runner = types.SimpleNamespace(_ctx=ctx, _approval_notify_sync=lambda *args: None,
                                       _native_image_run_message=lambda: 'hello')
        agent = types.SimpleNamespace(provider='ollama', base_url='http://localhost:1234')
        def run(*args, **kwargs):
            agent.provider, agent.base_url = 'openai-codex', 'https://chatgpt.com/backend-api/codex'
            return {'failed':True, 'failure_reason':'server_error'}
        agent.run_conversation = run
        modules = {
            'gateway.run': types.SimpleNamespace(_wrap_current_message_with_observed_context=lambda text, context: text),
            'tools.approval': types.SimpleNamespace(register_gateway_notify=lambda *args: None, unregister_gateway_notify=lambda *args: None),
            'tools.approval_context': types.SimpleNamespace(set_current_session_key=lambda value: None, reset_current_session_key=lambda value: None),
            'agent.notification_presentation': types.SimpleNamespace(notification_turn=lambda *args, **kwargs: contextlib.nullcontext()),
            'brai_files': types.SimpleNamespace(inbound_handoff=lambda *args, **kwargs: contextlib.nullcontext()),
            'gateway.russian_failure_notice': self.notice,
        }
        with patch.dict(sys.modules, modules):
            result = scope['_run_conversation_with_approval'](runner, agent, [], None, None, None)
        self.assertEqual(result['brai_connection_kind'], 'external')
        self.assertIn('Сторонний сервис ИИ', self.render('server_error', result=result))

    def test_runner_preserves_error_facts_for_gateway(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for runner integration')
        tree = ast.parse((Path(candidate) / 'gateway/run_turn_runner.py').read_text())
        common = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'common' for target in node.targets)
                      and isinstance(node.value, ast.Dict)
                      and any(isinstance(key, ast.Constant) and key.value == 'failure_reason' for key in node.value.keys if key))
        result = {'failed':True, 'failure_reason':'rate_limit', 'error':'error', 'brai_connection_kind':'external',
                  'brai_delivered_partial':'partial answer', 'brai_failure_kind':'truncated_tool_call',
                  'failure_resets_at':1121, 'billing_unverified':True, 'billing_block':{},
                  'free_tier':{'kind':'rate_limited'}, 'api_key':'secret'}
        scope = {'result':result, 'ctx':types.SimpleNamespace(tools_holder=[[]]),
                 'history_offset':0, 'compacted_in_place':False, 'effective_session_id':'s', 'usage':{}}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[common], type_ignores=[])), '<candidate>', 'exec'), scope)
        output = scope['common']
        for key in ('brai_connection_kind', 'brai_delivered_partial', 'brai_failure_kind',
                    'failure_resets_at', 'billing_unverified', 'billing_block', 'free_tier'):
            self.assertEqual(output[key], result[key])
        self.assertNotIn('api_key', output)
        text = self.notice.explain_failure('english', surface={'code':'rate_limit'}, diagnostic='',
            logger=self.log, redact=str, now=1000, result={key:value for key,value in output.items() if key != 'brai_failure_kind'},
            delivered_partial=output['brai_delivered_partial'])
        self.assertIn('Сторонний сервис ИИ', text)
        self.assertIn('примерно 3 мин.', text)
        self.assertTrue(text.startswith('partial answer'))

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
                      'brai_delivered_partial': 'Уже полученная часть ответа.', 'brai_connection_kind': 'external'}
            with self.assertLogs(self.log, 'WARNING'):
                text = func('ChatGPT hermes fallback add', types.SimpleNamespace(platform='telegram'),
                            result=result, failure_notice=lambda value: 'partial')
            self.assertTrue(text.startswith('Уже полученная часть ответа.'))
            self.assertIn('Сторонний сервис ИИ', text)
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
