# ABOUTME: Проверяет понятные пользовательские ошибки без подсказок с командами.
# ABOUTME: Исполняет подготовленный движок на изолированных заглушках, не меняя DEV.
import ast
import logging
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from typing import Any, Optional
import unittest
from unittest.mock import patch

import yaml

COMMAND = re.compile(
    r'(?<![\w/}\[])/[a-z][\w-]*\b'
    r'|`(?:hermes|sudo|systemctl|docker|pip|python3?|git|curl)\s+[^`]+`'
    r'|(?:командой|запустите|выполните)\s+(?:hermes|sudo|systemctl|docker|pip|python3?|git|curl)\s+'
    r'|`continue`', re.I)
ERROR_KEY = re.compile(r'error|fail|warn|unavailable|invalid|block|timeout|stuck|expir|not_found|wrong|missing|'
                       r'denied|out_of_range|insufficient|empty|abort|interrupt|overflow', re.I)


def functions(path, names, scope):
    tree = ast.parse(path.read_text())
    nodes = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == set(names)
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), 'exec'), scope)
    return scope


class CommandFreeErrorTests(unittest.TestCase):
    def setUp(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
        self.root = Path(candidate)
        self.catalog = yaml.safe_load((self.root / 'locales/ru.yaml').read_text())

    def assert_no_command(self, text):
        self.assertNotRegex(text, COMMAND)
        self.assertNotIn('начните новый разговор', text.lower())
        self.assertNotIn('начните новый сеанс', text.lower())

    def test_catalog_failure_and_warning_messages_have_no_commands(self):
        checked = []
        def walk(value, path):
            if isinstance(value, dict):
                for key, child in value.items():
                    walk(child, f'{path}.{key}')
            elif isinstance(value, str) and ERROR_KEY.search(path):
                with self.subTest(path=path):
                    self.assert_no_command(value)
                checked.append(path)
        for group in ('gateway', 'platform', 'cli', 'display', 'explainer', 'approval'):
            walk(self.catalog.get(group, {}), group)
        self.assertIn('gateway.progress.stuck_warning', checked)
        self.assertIn('gateway.progress.timeout_hint', checked)
        self.assertIn('gateway.notify.turn_error_detailed', checked)
        self.assertIn('platform.telegram.prompt.expired_body', checked)
        for path in ('gateway.unknown_command', 'gateway.resume.no_named_sessions',
                     'gateway.session.auto_reset_notice', 'explainer.empty_response'):
            value = self.catalog
            for name in path.split('.'):
                value = value[name]
            self.assert_no_command(value)

    def test_dynamic_diagnostic_does_not_repeat_commands_or_modify_user_text(self):
        values = {
            'gateway.notify.turn_error_detailed': 'Ошибка: {error_detail}',
            'gateway.btw.failed': 'Вопрос «{preview}»: {error}',
            'cli.error.with_details': '{lead}: {details}',
            'gateway.ordinary': 'Ответ: {text}',
        }
        scope = functions(self.root / 'agent/i18n.py', {'_russian_gateway_error', 't'},
                          {'Any': Any, 're': re, 'logger': logging.getLogger('command-free-test'),
                           '_current_home': lambda: 'test', '_normalize_lang': lambda lang, home: lang,
                           '_resolve_language': lambda home: 'ru', 'DEFAULT_LANGUAGE': 'en',
                           '_load_catalog': lambda language, home: values, 'brand_text': lambda text: text})
        redact = SimpleNamespace(redact_sensitive_text=lambda text, **kwargs: text)
        with patch.dict(sys.modules, {'agent.redact': redact}):
            for field, message in [('error_detail', 'Ошибка HTTP 403. Выполните /retry'),
                                   ('error_detail', 'Ошибка соединения. Выполните hermes doctor'),
                                   ('error_detail', 'Проблема. Используйте /неизвестно')]:
                result = scope['t']('gateway.notify.turn_error_detailed', **{field: message})
                self.assert_no_command(result)
            text = scope['t']('gateway.btw.failed', preview='Покажи /retry в документации',
                              error='Ошибка. Используйте /retry')
            self.assertIn('Покажи /retry в документации', text)
            self.assertNotIn('Используйте /retry', text)
            self.assertEqual(scope['t']('gateway.ordinary', text='Напиши /retry'), 'Ответ: Напиши /retry')
            result = scope['t']('cli.error.with_details', lead='Не удалось подключиться',
                                details='Ошибка. Запустите hermes doctor')
            self.assert_no_command(result)

    def test_compression_timeout_warnings_keep_messages_and_hide_commands(self):
        scope = functions(self.root / 'agent/compression_facade.py',
                          {'_report_compression_timeout', '_warn_commit_overrun'},
                          {'logger': logging.getLogger('command-free-compression'),
                           'ActivityProvenance': SimpleNamespace(AGENT_COMPRESSION_TIMEOUT='timeout')})
        warnings = []
        agent = SimpleNamespace(_emit_warning=warnings.append, context_compressor=None)
        compression = SimpleNamespace(mark_context_compression_timed_out=lambda agent: None)
        with patch.dict(sys.modules, {'agent.conversation_compression': compression}):
            for exhausted in (False, True):
                scope['_report_compression_timeout'](agent, idle=10, waited=20, since_progress=10,
                    total_ceiling=30, total_exhausted=exhausted, progress_observed=False)
            scope['_warn_commit_overrun'](agent, waited=30, ceiling=20)
        self.assertEqual(len(warnings), 3)
        for message in warnings:
            self.assert_no_command(message)
        self.assertIn('Сообщения сохранены', warnings[0])
        self.assertIn('Сообщения сохранены', warnings[1])

    def test_deferred_and_timed_out_compression_preserves_contract(self):
        path = self.root / 'agent/conversation_loop.py'
        tree = ast.parse(path.read_text())
        constant = next(n for n in tree.body if isinstance(n, ast.Assign) and
                        any(isinstance(t, ast.Name) and t.id == '_COMPRESSION_TIMEOUT_FINAL_RESPONSE' for t in n.targets))
        text = ast.literal_eval(constant.value)
        self.assertIn('Сообщения сохранены', text)
        self.assert_no_command(text)
        scope = functions(path, {'_partial_turn_result', '_compression_deferred_result'},
                          {'Any': Any, 'logger': logging.getLogger('command-free-compression')})
        agent = SimpleNamespace(session_id='test', _flush_status_buffer=lambda: None)
        for reason in ('lock', 'transient_block'):
            result = scope['_compression_deferred_result'](agent, [{'role': 'user', 'content': 'привет'}], 0, reason=reason)
            self.assertFalse(result['failed'])
            self.assertTrue(result['compression_deferred'])
            self.assert_no_command(result['final_response'])

    def test_preflight_failures_keep_unsent_message_fact_without_commands(self):
        path = self.root / 'agent/turn_context.py'
        tree = ast.parse(path.read_text())
        names = {'PreflightCompressionTimedOut', '_fail_closed_after_preflight_timeout',
                 '_fail_closed_on_insufficient_progress'}
        nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        scope = {'logger': logging.getLogger('command-free-preflight')}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), 'exec'), scope)
        compression = SimpleNamespace(context_compression_timed_out=lambda agent: True,
                                      request_exceeds_model_window=lambda agent, tokens: True,
                                      compression_blocked_transiently=lambda agent: False)
        agent = SimpleNamespace(context_compressor=SimpleNamespace(context_length=100))
        with patch.dict(sys.modules, {'agent.conversation_compression': compression}):
            for name in ('_fail_closed_after_preflight_timeout', '_fail_closed_on_insufficient_progress'):
                with self.subTest(name=name), self.assertRaises(scope['PreflightCompressionTimedOut']) as caught:
                    scope[name](agent, 150)
                self.assertIn('не отправлено модели', str(caught.exception))
                self.assert_no_command(str(caught.exception))

    def test_status_delivery_filters_diagnostics_not_user_prose(self):
        path = self.root / 'gateway/run.py'
        scope = functions(path, {'_prepare_gateway_status_message'},
                          {'Any': Any, 'Optional': Optional, 're': re,
                           'logger': logging.getLogger('command-free-gateway'),
                           '_gateway_surface_passes_raw_text': lambda platform: platform == 'api_server',
                           '_redact_gateway_user_facing_secrets': lambda text: text,
                           '_TELEGRAM_NOISY_STATUS_RE': re.compile('never-match'),
                           '_COMPRESSION_PROGRESS_STATUS_RE': re.compile('never-match'),
                           '_gateway_compression_progress_notices_enabled': lambda: False,
                           '_looks_like_gateway_provider_error': lambda text: False})
        class DiagnosticText(str):
            pass
        warning_module = SimpleNamespace(DiagnosticText=DiagnosticText)
        translation = SimpleNamespace(_russian_gateway_error=lambda text: 'причину ошибки нужно проверить')
        text = '⚠️ Ошибка. Выполните /retry'
        with patch.dict(sys.modules, {'gateway.warning_notifications': warning_module, 'agent.i18n': translation}):
            delivered = scope['_prepare_gateway_status_message']('telegram', 'warn', DiagnosticText(text))
            self.assert_no_command(delivered)
            compression = scope['_prepare_gateway_status_message']('telegram', 'warn', DiagnosticText(
                'Compression timed out. No messages were dropped. Run /compress.'))
            self.assert_no_command(compression)
            self.assertIn('Сообщения сохранены', compression)
            self.assertEqual(scope['_prepare_gateway_status_message']('telegram', 'interim', text), text)
            self.assertEqual(scope['_prepare_gateway_status_message']('api_server', 'warn', DiagnosticText(text)), text)

    def test_gateway_error_formatter_contains_no_command_hints(self):
        tree = ast.parse((self.root / 'gateway/russian_failure_notice.py').read_text())
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {'_COPY', '_EXTERNAL_COPY'} for t in node.targets):
                values = ast.literal_eval(node.value)
                for reason, text in values.items():
                    with self.subTest(reason=reason):
                        self.assert_no_command(text)


if __name__ == '__main__':
    unittest.main()
