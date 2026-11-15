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

    def test_native_service_messages_are_russian_and_keep_old_history(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for native integration')
        root = Path(candidate)
        def extract(path, names, scope=None):
            from typing import Any, Optional
            tree = ast.parse((root / path).read_text())
            nodes = [node for node in tree.body if
                     (isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names) or
                     (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets))]
            namespace = {'Optional': Optional, 'Any': Any, **(scope or {})}
            exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<candidate>', 'exec'), namespace)
            return types.SimpleNamespace(**namespace)
        delivery_ledger = extract('gateway/delivery_ledger.py', {'RECOVERED_MARKER', 'RECONNECTED_MARKER', 'FLOOD_MARKER', '_claimed_row'})
        session_stall = extract('gateway/session_stall.py', {'format_session_stall_notification'})
        chat_completion_wait_notice = extract('agent/chat_completion_wait_notice.py', {'_PHASE_TEXT', 'wait_notice_text'})
        turn_failure_copy = extract('agent/turn_failure_copy.py', {'FAILED_TURN_NOTICE', 'PARTIAL_FAILED_TURN_NOTICE',
            'FAILED_TURN_DISPLAY_KIND', 'untyped_failed_turn_display_kind'})
        for marker in (delivery_ledger.RECOVERED_MARKER, delivery_ledger.RECONNECTED_MARKER,
                       delivery_ledger.FLOOD_MARKER):
            self.assertRegex(marker, '[А-Яа-я]')
            self.assertNotIn('Recovered reply', marker)
        self.assertIn('возможно', delivery_ledger.RECOVERED_MARKER)
        self.assertIn('часть ответа', delivery_ledger.FLOOD_MARKER)
        row = delivery_ledger._claimed_row('id', 'session', 'telegram', 'chat', None, 'ответ', 0, None,
                                           needs_marker=True, runtime=True)
        self.assertEqual(row['marker'], delivery_ledger.RECONNECTED_MARKER)
        self.assertIn('нет активности 3 мин', session_stall.format_session_stall_notification(180))
        self.assertNotIn('/stop', session_stall.format_session_stall_notification(180))
        for phase in chat_completion_wait_notice._PHASE_TEXT:
            text = chat_completion_wait_notice.wait_notice_text('model', 90, phase, ('TTFB', 12))
            self.assertIn('ожидаю', text)
            self.assertNotIn('TTFB', text)
            self.assertIn('12 сек.', text)
        for old in ('Your request was not processed. Send it again if you still want me to carry it out.',
                    'This turn did not complete. Some actions may already have run; verify their effects before resending.'):
            self.assertEqual(turn_failure_copy.untyped_failed_turn_display_kind('assistant', old), 'failed_turn')
        self.assertIn('не завершена', turn_failure_copy.PARTIAL_FAILED_TURN_NOTICE)
        tree = ast.parse((root / 'gateway/run_turn.py').read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_brai_activity_description')
        namespace = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<candidate>', 'exec'), namespace)
        describe = namespace['_brai_activity_description']
        self.assertEqual(describe('waiting for non-streaming API response'), 'ожидаю ответ модели')
        self.assertEqual(describe('unrecognised internal state'), 'продолжаю работу')
        self.assertEqual(describe('ignored', 'browser'), 'выполняю действие')

    def test_gateway_russian_catalog_covers_all_english_keys(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for catalog integration')
        import yaml
        directory = Path(candidate) / 'locales'
        english = yaml.safe_load((directory / 'en.yaml').read_text())['gateway']
        russian = yaml.safe_load((directory / 'ru.yaml').read_text())['gateway']
        self.assertIn('Не удалось получить ответ', russian['errors']['unexpected_silence'])
        for value in russian['errors'].values():
            if isinstance(value, str):
                for command in ('/retry', '/model', '/new', '/compress', '/login'):
                    self.assertNotIn(command, value)
        def check(en, ru, path='gateway'):
            for key, value in en.items():
                self.assertIn(key, ru, f'{path}.{key}')
                if isinstance(value, dict):
                    self.assertIsInstance(ru[key], dict)
                    check(value, ru[key], f'{path}.{key}')
        check(english, russian)

    def test_literal_agent_status_messages_have_no_english_prose(self):
        import os
        import re
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for native integration')
        offenders = []
        for path in (Path(candidate) / 'agent').glob('*.py'):
            for node in ast.walk(ast.parse(path.read_text())):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in {'_emit_warning', '_emit_status', '_emit_wait_notice', '_emit_startup_warning'}
                        and node.args and isinstance(node.args[0], (ast.Constant, ast.JoinedStr))):
                    continue
                value = node.args[0]
                parts = [value] if isinstance(value, ast.Constant) else value.values
                text = ''.join(part.value for part in parts if isinstance(part, ast.Constant) and isinstance(part.value, str))
                if re.search(r'[A-Za-z]{3,}\s+[A-Za-z]{3,}', text):
                    offenders.append(f'{path.name}:{node.lineno}')
        self.assertEqual(offenders, [])

    def test_diagnostic_status_is_localized_without_rewriting_normal_text(self):
        import os
        import re
        from typing import Any, Optional
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for native integration')
        tree = ast.parse((Path(candidate) / 'gateway/run.py').read_text())
        method = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name == '_prepare_gateway_status_message')
        class DiagnosticText(str):
            pass
        scope = {'Any': Any, 'Optional': Optional, 're': re, 'logger': logging.getLogger('notice-test'),
                 '_gateway_surface_passes_raw_text': lambda platform: platform == 'api_server',
                 '_redact_gateway_user_facing_secrets': lambda text: text.replace('SECRET', '[скрыто]'),
                 '_TELEGRAM_NOISY_STATUS_RE': re.compile(r'never-matches'),
                 '_COMPRESSION_PROGRESS_STATUS_RE': re.compile(r'Compacting context'),
                 '_gateway_compression_progress_notices_enabled': lambda: True,
                 '_looks_like_gateway_provider_error': lambda text: False}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), scope)
        prepare = scope['_prepare_gateway_status_message']
        module = types.SimpleNamespace(DiagnosticText=DiagnosticText)
        with patch.dict('sys.modules', {'gateway.warning_notifications': module}), self.assertLogs('notice-test', 'WARNING') as logs:
            self.assertIn('пустой ответ', prepare('telegram', 'warn', DiagnosticText('Empty response from model SECRET')))
            self.assertIn('причина отказа не подтверждена', prepare('telegram', 'warn', DiagnosticText('Billing unverified by provider')))
            self.assertIn('причина отказа не подтверждена', prepare('telegram', 'warn', DiagnosticText('Billing unverified; possible content filter rejection')))
            self.assertIn('$0.42', prepare('telegram', 'warn', DiagnosticText('Estimated cost of these attempts: ~$0.42')))
            self.assertIn('Подробности сохранены в журнале', prepare('telegram', 'warn', DiagnosticText('A new unexpected diagnostic')))
            self.assertIn('пустой ответ', prepare('telegram', 'warn', 'Empty response from model'))
            self.assertIn('Служебное уведомление', prepare('telegram', 'lifecycle', 'A new runtime status'))
        self.assertNotIn('SECRET', ' '.join(logs.output))
        self.assertEqual(prepare('telegram', 'interim', 'Hello, world'), 'Hello, world')
        self.assertEqual(prepare('api_server', 'warn', DiagnosticText('Original diagnostic')), 'Original diagnostic')
        with patch.dict('sys.modules', {'gateway.warning_notifications': module}):
            self.assertEqual(prepare('telegram', 'warn', DiagnosticText('Ошибка сервиса OpenAI API')), 'Ошибка сервиса OpenAI API')

    def test_error_messages_keep_visible_formatting(self):
        for code in self.notice._COPY:
            with self.subTest(code=code):
                text = self.render(code, result={'brai_connection_kind':'external'})
                self.assertTrue(text.startswith(self.notice._TITLES[code] + '\n\n'))
                self.assertIn('⚠️ **Работа не завершена.**', text)
                self.assertIn('\n\nКод: `' + code + '`', text)
                self.assertNotIn('Данные для проверки', text)
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

    def test_subscription_limit_is_distinct_from_generic_throttling(self):
        text = self.render('rate_limit', result={'brai_subscription_limit': True,
            'brai_connection_kind': 'external', 'failure_resets_at': 1121}, now=1000, partial=True)
        self.assertIn('Исчерпан лимит подписки на ИИ-размышления', text)
        self.assertIn('примерно 3 мин.', text)
        self.assertIn('напишите «продолжай»', text)
        self.assertIn('Некоторые действия могли уже выполниться', text)
        self.assertNotIn('ChatGPT', text)
        self.assertNotIn('/retry', text)
        later = self.render('rate_limit', result={'brai_subscription_limit': True,
            'failure_resets_at': 9160}, now=1000)
        self.assertIn('примерно 2 ч 16 мин.', later)
        self.assertIn('Исчерпан лимит подписки', self.render('billing', result={'brai_subscription_limit': True}))
        generic = self.render('rate_limit', result={'brai_connection_kind': 'external'})
        self.assertNotIn('лимит подписки', generic.lower())
        self.assertIn('напишите «продолжай»', generic)

    def test_no_failure_copy_suggests_commands(self):
        for code in [*self.notice._COPY, 'unknown']:
            for kind in ('external', 'local', 'unknown'):
                with self.subTest(code=code, kind=kind):
                    text = self.render(code, result={'brai_connection_kind': kind})
                    for command in ('/retry', '/model', '/new', '/compress'):
                        self.assertNotIn(command, text)

    def test_diagnostic_is_redacted_and_failure_to_log_does_not_leak_original(self):
        with self.assertLogs(self.log, 'WARNING') as records:
            text = self.notice.explain_failure('secret original', surface={'code':'auth'},
                diagnostic='secret', logger=self.log, redact=lambda value: '[скрыто]')
        self.assertIn('[скрыто]', records.output[0])
        self.assertNotIn('secret', records.output[0] + text)
        text = self.notice.explain_failure('secret original', surface={'code':'auth'},
            diagnostic='secret', logger=self.log, redact=lambda value: 1/0)
        self.assertNotIn('secret', text)

    def test_linked_diagnostic_preserves_redacted_facts_without_answer_text(self):
        result = {'brai_original_error':'Provider details and repair: TOKEN-SECRET',
                  'brai_error_provider':'openai-codex', 'brai_error_model':'private-model',
                  'brai_http_status':503, 'brai_attempts':3, 'api_calls':4,
                  'brai_connection_kind':'external', 'failure_resets_at':1121,
                  'failure_retryable':True, 'session_id':'session-test'}
        with self.assertLogs(self.log, 'WARNING') as records:
            text = self.notice.explain_failure('original', surface={'code':'overloaded'},
                diagnostic='failure TOKEN-SECRET', logger=self.log,
                redact=lambda value: value.replace('TOKEN-SECRET', '[скрыто]'),
                result=result, delivered_partial='Личная часть ответа')
        record = records.output[0]
        self.assertIn('Provider details and repair: [скрыто]', record)
        self.assertIn('brai_error_provider', record)
        self.assertIn('private-model', record)
        self.assertIn('brai_attempts', record)
        self.assertIn('failure_resets_at', record)
        self.assertIn('failure_retryable', record)
        self.assertIn('session-test', record)
        self.assertIn('http=503', record)
        self.assertNotIn('TOKEN-SECRET', record + text)
        self.assertNotIn('Личная часть ответа', record)
        self.assertNotIn('openai-codex', text)
        self.assertNotIn('Provider details', text)
        self.assertIn('Ответ сервера: `HTTP 503`', text)
        self.assertIn('Номер в журнале:', text)

    def test_context_rejection_does_not_recommend_compression(self):
        result = {'brai_failure_kind':'server_context_rejection', 'brai_connection_kind':'local',
                  'brai_request_tokens':24000, 'brai_context_window':80000}
        text = self.render('server_error', result=result)
        self.assertIn('Сокращение разговора в этом случае не поможет', text)
        self.assertIn('24,000 токенов', text)
        self.assertIn('80,000 токенов', text)
        self.assertNotIn('/compress', text)
        text = self.render('context_overflow', result={'compaction_disabled':True, 'failure_retryable':False})
        self.assertIn('автоматическое сокращение отключено', text)
        self.assertNotIn('/compress', text)

    def test_terminal_error_keeps_status_and_attempts_for_diagnostics(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for API error integration')
        tree = ast.parse((Path(candidate) / 'agent/turn_api_error.py').read_text())
        outer = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'handle_api_error')
        fn = next(node for node in outer.body if isinstance(node, ast.FunctionDef) and node.name == '_verdict')
        fn.returns = None
        for arg in fn.args.args + fn.args.kwonlyargs:
            arg.annotation = None
        scope = {'ApiErrorVerdict':lambda **kwargs:kwargs,
                 'api_error':types.SimpleNamespace(status_code=503),
                 'agent':types.SimpleNamespace(provider='openai-codex', model='example'),
                 'retry_count':3, 'max_retries':3, 'thinking_spinner':None, 'messages':[],
                 'active_system_prompt':'', 'conversation_history':[], 'approx_tokens':0,
                 'compression_attempts':0, '_provider_overflow_recovery_pending':False}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<candidate>', 'exec'), scope)
        result = scope['_verdict']('return', {'failure_reason':'overloaded'})['result']
        self.assertEqual(result['brai_http_status'], 503)
        self.assertEqual(result['brai_attempts'], 3)
        self.assertEqual(result['brai_error_provider'], 'openai-codex')
        self.assertEqual(result['brai_error_model'], 'example')
        kept = scope['_verdict']('return', {'brai_attempts':1})['result']
        self.assertEqual(kept['brai_attempts'], 1)

    def test_provider_error_marker_survives_only_confirmed_subscription_limit(self):
        import os
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for API error integration')
        tree = ast.parse((Path(candidate) / 'agent/turn_api_error.py').read_text())
        outer = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'handle_api_error')
        fn = next(node for node in outer.body if isinstance(node, ast.FunctionDef) and node.name == '_verdict')
        fn.returns = None
        for arg in fn.args.args + fn.args.kwonlyargs:
            arg.annotation = None
        from agent import error_classifier as classifier
        scope = {'ApiErrorVerdict': lambda **kwargs: kwargs,
            'api_error': types.SimpleNamespace(status_code=429, body={'error': {'type': 'usage_limit_reached'}}),
            'agent': types.SimpleNamespace(provider='openai-codex', model='example'),
            'retry_count': 3, 'max_retries': 3, 'thinking_spinner': None, 'messages': [],
            'active_system_prompt': '', 'conversation_history': [], 'approx_tokens': 0,
            'compression_attempts': 0, '_provider_overflow_recovery_pending': False}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<candidate>', 'exec'), scope)
        with patch.dict('sys.modules', {'agent.error_classifier': classifier}):
            def marked(reason='rate_limit'):
                return scope['_verdict']('return', {'failure_reason': reason})['result'].get('brai_subscription_limit')
            self.assertTrue(marked())
            self.assertTrue(marked('billing'))
            scope['api_error'].body = {'error': {'type': 'usage_limit_reached', 'code': 'rate_limit_exceeded'}}
            self.assertTrue(marked())
            scope['api_error'].body = {'error': {'code': 'usage_limit_reached'}}
            self.assertTrue(marked())
            scope['api_error'].body = {'error': {'type': 'rate_limit_exceeded'}}
            self.assertIsNone(marked())
            scope['api_error'].body = {'error': {'type': 'usage_limit_reached'}}
            scope['agent'].provider = 'openai'
            self.assertIsNone(marked())
            scope['agent'].provider = 'openai-codex'
            scope['api_error'].status_code = 503
            self.assertIsNone(marked())
            scope['api_error'].status_code = 429
            scope['api_error'].body = None
            scope['api_error'].response = types.SimpleNamespace(json=lambda: {'error': {'type': 'usage_limit_reached'}})
            self.assertTrue(marked())

    def test_engine_marks_distinct_rejections_before_gateway(self):
        import os
        import re
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for overflow integration')
        tree = ast.parse((Path(candidate) / 'agent/turn_overflow.py').read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_recover_context_length')
        fn.returns = None
        for arg in fn.args.args + fn.args.kwonlyargs:
            arg.annotation = None
        scope = {'parse_available_output_tokens_from_error':lambda value:None,
                 'is_output_cap_error':lambda value:True, 're':re}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<candidate>', 'exec'), scope)
        agent = types.SimpleNamespace(context_compressor=types.SimpleNamespace(context_length=80000), log_prefix='')
        state = types.SimpleNamespace(agent=agent, fail_turn=lambda message, **kwargs:kwargs)
        result = scope['_recover_context_length'](state, None, 'output cap')
        self.assertEqual(result['brai_failure_kind'], 'output_cap_exceeded')
        text = self.render('context_overflow', result=result)
        self.assertIn('запрошенная длина ответа превышает допустимый предел', text)
        self.assertIn('Сокращение разговора не решит', text)
        self.assertNotIn('/compress', text)
        scope['is_output_cap_error'] = lambda value:False
        scope['_adopt_provider_context_limit'] = lambda *args:None
        scope['is_local_endpoint'] = lambda value:True
        scope['_UNEXPLAINED_REJECTION_FRACTION'] = .75
        scope['site_copy'] = lambda *args, **kwargs:'size error'
        scope['FailoverReason'] = types.SimpleNamespace(server_error=types.SimpleNamespace(value='server_error'))
        agent.base_url = 'http://127.0.0.1:1234'
        agent.model = 'test-model'
        agent.max_tokens = 1000
        state.request_tokens = lambda:23000
        result = scope['_recover_context_length'](state, None, 'context too large')
        self.assertEqual(result['brai_failure_kind'], 'server_context_rejection')
        self.assertEqual(result['brai_request_tokens'], 24000)
        self.assertEqual(result['brai_context_window'], 80000)

    def test_original_error_is_separated_from_delivered_answer(self):
        import os
        import sys
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for recovery integration')
        tree = ast.parse((Path(candidate) / 'agent/turn_recovery.py').read_text())
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name in {'_failed_turn_result', '_with_delivered_partial', 'nonretryable_client_error_result'}]
        for node in selected:
            node.returns = None
            for arg in node.args.args + node.args.kwonlyargs:
                arg.annotation = None
        reasons = types.SimpleNamespace(content_policy_blocked='policy', billing='billing',
            model_not_found='missing', upstream_blocked='blocked', ssl_cert_verification='tls')
        scope = {'Optional':object, 'Any':object, 'FailoverReason':reasons, '_NONRETRYABLE_LABELS':{},
                 'provider_label_for':lambda provider:'service', 'display_hermes_home':lambda:'/test',
                 '_welcome_tier_guidance':lambda *a,**k:'',
                 '_missing_vendor_prefix_suggestion':lambda *a:None, '_vlines':lambda *a:None,
                 '_stamp_limit_reset':lambda *a:None, 'nonretryable_copy':lambda *a,**k:'original diagnostic',
                 'logger':self.log}
        exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), '<candidate>', 'exec'), scope)
        agent = types.SimpleNamespace(_flush_status_buffer=lambda:None, _summarize_api_error=lambda error:'summary',
            _emit_diagnostic_status=lambda *args:None, verbose_logging=False, log_prefix='',
            _persist_session=lambda *args:None)
        from enum import Enum
        class Reason(Enum):
            format = 'format'
        classified = types.SimpleNamespace(reason=Reason.format, is_auth=False, retryable=False)
        modules = {'agent.conversation_loop':types.SimpleNamespace(_billing_failure_result=None, _content_policy_blocked_result=None)}
        with patch.dict('sys.modules', modules):
            result = scope['nonretryable_client_error_result'](agent, Exception('error'), classified,
                status_code=400, api_kwargs=None, api_messages=[], messages=[], conversation_history=[],
                api_call_count=1, approx_tokens=0, provider='test', base_url='test', model='test',
                delivered='Личная часть ответа')
        self.assertEqual(result['brai_original_error'], 'original diagnostic')
        self.assertEqual(result['brai_delivered_partial'], 'Личная часть ответа')
        self.assertNotIn('Личная часть ответа', result['brai_original_error'])

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
            'tools.approval_conversation': types.SimpleNamespace(turn_scope=None, enabled=lambda: False, resume_note=None, gateway_generation=None),
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
        result = {'failed':True, 'failure_reason':'rate_limit', 'error':'error', 'brai_connection_kind':'external', 'brai_subscription_limit':True,
                  'brai_delivered_partial':'partial answer', 'brai_failure_kind':'truncated_tool_call',
                  'failure_resets_at':1121, 'billing_unverified':True, 'billing_block':{},
                  'free_tier':{'kind':'rate_limited'}, 'api_key':'secret', 'brai_original_error':'diagnostic',
                  'brai_http_status':503, 'brai_attempts':3, 'brai_error_provider':'test',
                  'brai_error_model':'test-model', 'brai_request_tokens':24000, 'brai_context_window':80000,
                  'compaction_disabled':True, 'failure_retryable':False}
        scope = {'result':result, 'ctx':types.SimpleNamespace(tools_holder=[[]]),
                 'history_offset':0, 'compacted_in_place':False, 'effective_session_id':'s', 'usage':{}}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[common], type_ignores=[])), '<candidate>', 'exec'), scope)
        output = scope['common']
        for key in ('brai_connection_kind', 'brai_subscription_limit', 'brai_delivered_partial', 'brai_failure_kind',
                    'failure_resets_at', 'billing_unverified', 'billing_block', 'free_tier', 'brai_original_error',
                    'brai_http_status', 'brai_attempts', 'brai_error_provider', 'brai_error_model',
                    'brai_request_tokens', 'brai_context_window', 'compaction_disabled', 'failure_retryable'):
            self.assertEqual(output[key], result[key])
        self.assertNotIn('api_key', output)
        text = self.notice.explain_failure('english', surface={'code':'rate_limit'}, diagnostic='',
            logger=self.log, redact=str, now=1000, result={key:value for key,value in output.items() if key not in {'brai_failure_kind', 'compaction_disabled'}},
            delivered_partial=output['brai_delivered_partial'])
        self.assertIn('Исчерпан лимит подписки на ИИ-размышления', text)
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
    async def test_recovered_reply_is_russian_at_delivery_boundary(self):
        import asyncio
        import contextlib
        import os
        from unittest.mock import AsyncMock
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for delivery integration')
        root = Path(candidate)
        ledger = ast.parse((root / 'gateway/delivery_ledger.py').read_text())
        marker = next(node.value.value for node in ledger.body if isinstance(node, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == 'RECOVERED_MARKER' for t in node.targets))
        tree = ast.parse((root / 'gateway/run_startup.py').read_text())
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == '_redeliver_claimed_obligations')
        scope = {'asyncio': asyncio, 'logging': logging, 'logger': logging.getLogger('notice-test'),
                 '_log_suppressed': lambda *args, **kwargs: contextlib.nullcontext()}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), scope)
        adapter = types.SimpleNamespace(send=AsyncMock(return_value=types.SimpleNamespace(success=True)))
        runner = types.SimpleNamespace(_obligation_adapter=AsyncMock(return_value=adapter),
                                       _arm_flood_timers_for_waiting_rows=AsyncMock())
        row = {'content': 'Ответ пользователя', 'needs_marker': True, 'chat_id': '1', 'thread_id': None,
               'obligation_id': 'id', 'platform': 'telegram', 'attempts': 1}
        ledger_module = types.SimpleNamespace(RECOVERED_MARKER=marker, mark_delivered=lambda value: None,
                                               mark_failed=lambda *args: None)
        with patch.dict('sys.modules', {'gateway.delivery_ledger': ledger_module}):
            self.assertEqual(await scope['_redeliver_claimed_obligations'](runner, [row]), 1)
        content = adapter.send.await_args.kwargs['content']
        self.assertIn('возможно, вы уже получили этот ответ', content)
        self.assertTrue(content.endswith('Ответ пользователя'))
        self.assertNotIn('Recovered reply', content)

    async def test_long_running_heartbeat_does_not_expose_internal_english(self):
        import asyncio
        import contextlib
        import os
        from unittest.mock import AsyncMock
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('HERMES_TEST_CANDIDATE is required for delivery integration')
        tree = ast.parse((Path(candidate) / 'gateway/run_turn.py').read_text())
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_brai_activity_description')
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == '_run_agent_notify_long_running')
        method.returns = None
        for arg in method.args.args:
            arg.annotation = None
        scope = {'asyncio': asyncio, 'time': types.SimpleNamespace(time=lambda: 180),
                 'suppress': contextlib.suppress, 'logger': logging.getLogger('notice-test'),
                 'format_iteration_progress': lambda *args: 'этап 1',
                 't': lambda key, **kw: f"⏳ Работаю — {kw['minutes']} мин{kw['detail']}"}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[helper, method], type_ignores=[])), '<candidate>', 'exec'), scope)
        adapter = types.SimpleNamespace(send=AsyncMock(return_value=types.SimpleNamespace(success=True, message_id='1')))
        calls = iter([True, True, False])
        runner = types.SimpleNamespace(_delivery_adapter_for=lambda source: adapter,
            _should_emit_long_running_notification=lambda *args: next(calls),
            _agent_activity_summary=lambda agent: {'api_call_count': 1, 'max_iterations': 2,
                'last_activity_desc': 'waiting for non-streaming API response'})
        disp = types.SimpleNamespace(_display_surface_mode=lambda *args, **kwargs: 'raw',
            resolve_display_setting=lambda *args: False, user_config={}, platform_key='telegram')
        ctx = types.SimpleNamespace(source=types.SimpleNamespace(chat_id='1', platform='telegram'),
            session_key='s', agent_holder=[object()], _status_thread_metadata={}, _cleanup_progress=False)
        fake_run = types.SimpleNamespace(_float_env=lambda *args: 0.001, _interim_metadata=lambda x: x,
                                         _non_conversational_metadata=lambda x, **kwargs: x)
        with patch.dict('sys.modules', {'gateway.run': fake_run}):
            await scope['_run_agent_notify_long_running'](runner, disp, ctx, [None])
        text = adapter.send.await_args.args[1]
        self.assertIn('ожидаю ответ модели', text)
        self.assertNotIn('waiting for', text)

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
