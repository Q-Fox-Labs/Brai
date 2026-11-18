# ABOUTME: Проверяет понятные ответы о сокращении истории, целях и повторяющихся задачах.
# ABOUTME: Исполняет функции из подготовленного движка без обращения к сервисам и личным данным.
import ast
import logging
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from typing import Any, Sequence
import unittest
from unittest.mock import patch


def functions(path, names, scope):
    tree = ast.parse(path.read_text())
    found = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in found} == set(names)
    exec(compile(ast.fix_missing_locations(ast.Module(body=found, type_ignores=[])), str(path), 'exec'), scope)
    return scope


class AuxiliaryRussianOutputTests(unittest.TestCase):
    def setUp(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('Нужна проверочная копия движка HERMES_TEST_CANDIDATE')
        self.root = Path(candidate)

    def test_manual_compression_reports_preservation_and_fallback(self):
        scope = functions(self.root / 'agent/manual_compression_feedback.py',
                          {'summarize_manual_compression', 'describe_compression_lock_skip'},
                          {'Any': Any, 'Sequence': Sequence, 'logging': logging,
                           'redact_sensitive_text': lambda text, **kwargs: text})
        run = scope['summarize_manual_compression']
        before = [{'role': 'user', 'content': 'текст'}, {'role': 'assistant', 'content': 'ответ'}]
        aborted = run(before, before, 200, 200,
                      compression_state=SimpleNamespace(_last_compress_aborted=True, _last_summary_error='English provider error'))
        self.assertIn('Не удалось', aborted['headline'])
        self.assertIn('Все сообщения сохранены', aborted['note'])
        self.assertNotIn('English provider error', str(aborted))
        fallback = run(before, before[:1], 200, 100,
                       compression_state=SimpleNamespace(_last_summary_fallback_used=True, _last_summary_dropped_count=1))
        self.assertIn('удалено сообщений: 1', fallback['note'])
        self.assertIn('уже сокращается', scope['describe_compression_lock_skip']('holder'))

    def test_overflow_warning_explains_problem_without_commands(self):
        tree = ast.parse((self.root / 'agent/conversation_compression.py').read_text())
        node = next(node for node in tree.body if isinstance(node, ast.Assign) and
                    any(isinstance(target, ast.Name) and target.id == 'CONTEXT_OVERFLOW_BLOCKED_WARNING_TEMPLATE'
                        for target in node.targets))
        text = ast.literal_eval(node.value).format(tokens=216214, threshold=204000, reason='attempts_exhausted:3')
        self.assertIn('История разговора стала слишком большой', text)
        self.assertIn('сократить её пока не удалось', text)
        for raw in ('Context', 'attempts_exhausted', '/new', '/compress'):
            self.assertNotIn(raw, text)

    def test_russian_is_default_and_explicit_language_is_preserved(self):
        tree = ast.parse((self.root / 'hermes_cli/config_defaults.py').read_text())
        config = next(node.value for node in tree.body if isinstance(node, ast.Assign) and
                      any(isinstance(target, ast.Name) and target.id == 'DEFAULT_CONFIG' for target in node.targets))
        display = next(value for key, value in zip(config.keys, config.values)
                       if isinstance(key, ast.Constant) and key.value == 'display')
        language = next(value.value for key, value in zip(display.keys, display.values)
                        if isinstance(key, ast.Constant) and key.value == 'language')
        self.assertEqual(language, 'ru')
        class UnscopedSecretError(Exception):
            pass
        def unscoped(_key):
            raise UnscopedSecretError()
        secrets = SimpleNamespace(UnscopedSecretError=UnscopedSecretError, get_secret=unscoped)
        scope = functions(self.root / 'agent/i18n.py', {'_resolve_language'},
                          {'os': os, '_normalize_lang': lambda language, home: language,
                           '_config_language_cached': lambda home: None})
        with patch.dict(sys.modules, {'agent.secret_scope': secrets}), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(scope['_resolve_language']('profile'), 'ru')
            os.environ['HERMES_LANGUAGE'] = 'en'
            self.assertEqual(scope['_resolve_language']('profile'), 'en')
            del os.environ['HERMES_LANGUAGE']
            scope['_config_language_cached'] = lambda home: 'en'
            self.assertEqual(scope['_resolve_language']('profile'), 'en')
        import yaml
        tree = ast.parse((self.root / 'hermes_cli/ui_localization.py').read_text())
        method = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_configured_language')
        method.decorator_list = []
        ui_scope = {'Path': Path}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), ui_scope)
        with tempfile.TemporaryDirectory() as home, patch.dict(sys.modules, {'hermes_yaml': yaml}):
            self.assertEqual(ui_scope['_configured_language'](home, ()), 'ru')
            (Path(home) / 'config.yaml').write_text('display:\n  language: en\n')
            self.assertEqual(ui_scope['_configured_language'](home, ()), 'en')

    def test_goal_and_heartbeat_status_keep_user_text(self):
        import time
        scope = functions(self.root / 'hermes_cli/goals.py', {'status_line'},
                          {'time': time, '_session_waiting': lambda _: True, '_pid_alive': lambda _: True})
        status = scope['status_line']
        self.assertEqual(status(SimpleNamespace(_state=None)), 'Активной цели нет.')
        state = SimpleNamespace(status='active', goal='Доделать отчёт', turns_used=2, max_turns=10,
                                subgoals=[], gates=[], waiting_reason=None, waiting_on_session=None,
                                waiting_on_pid=None, waiting_until=0)
        owner = SimpleNamespace(_state=state, has_contract=lambda: False)
        self.assertIn('Цель выполняется', status(owner))
        self.assertIn('Доделать отчёт', status(owner))
        state.status, state.paused_reason = 'paused', 'нужны данные'
        self.assertIn('нужны данные', status(owner))
        heartbeat = functions(self.root / 'hermes_cli/heartbeat.py', {'status_line'}, {'time': time})['status_line']
        self.assertEqual(heartbeat(SimpleNamespace(_state=None)), 'Повторяющееся напоминание не настроено.')
        reminder = SimpleNamespace(interval_seconds=300, fire_count=1, status='active', last_fired_at=0,
                                   created_at=time.time(), prompt='Проверь отчёт')
        text = heartbeat(SimpleNamespace(_state=reminder))
        self.assertIn('каждые 300 сек.', text)
        self.assertIn('Проверь отчёт', text)
        self.assertNotIn('Heartbeat', text)

    def test_suggestions_and_approval_lists_are_understandable(self):
        suggestions = functions(self.root / 'hermes_cli/suggestions_cmd.py',
                                {'_fmt_pending', '_dismiss', '_clear'}, {})
        self.assertEqual(suggestions['_fmt_pending']([]), 'Пока нет предложений по автоматическим действиям.')
        pending = suggestions['_fmt_pending']([{'title': 'Проверять отчёт', 'description': 'Каждое утро'}])
        self.assertIn('Предложенные автоматические действия', pending)
        self.assertIn('Проверять отчёт', pending)
        store = SimpleNamespace(dismiss_suggestion=lambda _: True, clear_resolved=lambda: 2)
        self.assertIn('отклонено', suggestions['_dismiss'](store, '1', None, 'gateway'))
        self.assertIn('2', suggestions['_clear'](store, '', None, 'gateway'))
        wa = SimpleNamespace(MEMORY='memory', SKILLS='skills',
                             write_approval_enabled=lambda _: True,
                             list_pending=lambda _: [], _frontmatter_description=lambda _: 'Работа с файлами')
        approvals = functions(self.root / 'hermes_cli/write_approval_commands.py',
                              {'_fmt_state', '_fmt_pending_list', '_matched_entries', '_pending_summary'}, {'wa': wa})
        self.assertEqual(approvals['_fmt_state']('memory'), 'Подтверждение изменений памяти: включено.')
        self.assertEqual(approvals['_fmt_pending_list']('memory'), 'Нет изменений, ожидающих подтверждения.')
        memory = SimpleNamespace(destructive_ops=lambda _: [
            {'action': 'replace', 'matched_entry': 'первая запись'},
            {'action': 'remove', 'matched_entry': 'вторая запись'}])
        with patch.dict(sys.modules, {'tools.memory_tool': memory}):
            lines = approvals['_matched_entries']({})
        self.assertEqual(lines, ['Будет заменена запись: первая запись', 'Будет удалена запись: вторая запись'])
        record = {'summary': 'replace in memory: whole entry becomes: новый текст',
                  'payload': {'action': 'replace', 'target': 'memory', 'content': 'новый текст'}}
        self.assertEqual(approvals['_pending_summary']('memory', record), 'Заменить запись в памяти: новый текст')
        skill = {'payload': {'action': 'create', 'name': 'пример', 'content': 'description: Работа с файлами'}}
        self.assertEqual(approvals['_pending_summary']('skills', skill), 'Создать навык «пример» — Работа с файлами')

    def test_goal_commands_preserve_goal_and_explain_automatic_work(self):
        state = SimpleNamespace(goal='Подготовить отчёт', max_turns=10, has_contract=lambda: False)
        manager = SimpleNamespace(state=None, has_goal=lambda: False,
                                  set=lambda *args, **kwargs: state, stop_waiting=lambda: True)
        goals = SimpleNamespace(parse_contract=lambda text: (text, SimpleNamespace(is_empty=lambda: True)),
                                goal_kick_prompt=lambda goal, previous: goal)
        scope = functions(self.root / 'hermes_cli/goal_command.py', {'_set', '_unwait'},
                          {'GoalCommandResult': lambda output, *args, **kwargs: SimpleNamespace(output=output),
                           'goals': goals})
        result = scope['_set'](manager, state.goal, drafting=False, last_user_message=None,
                               render=lambda key, default, **values: default.format(**values), progress=None)
        self.assertIn('Подготовить отчёт', result.output)
        self.assertIn('После каждого шага модель проверит результат', result.output)
        self.assertNotIn('/goal', result.output)
        self.assertIn('Ожидание завершено', scope['_unwait'](manager, '', None).output)

    def test_gateway_error_details_are_explained_without_guessing_the_cause(self):
        import re
        scope = functions(self.root / 'agent/i18n.py', {'_russian_gateway_error', 't'},
                          {'Any': Any, 're': re, 'logger': logging.getLogger('gateway-error-test'),
                           '_current_home': lambda: 'test', '_normalize_lang': lambda lang, home: lang,
                           '_resolve_language': lambda home: 'ru', 'DEFAULT_LANGUAGE': 'en',
                           '_load_catalog': lambda lang, home: {'gateway.problem': 'Ошибка: {error}',
                                                               'cli.problem': 'Error: {error}'},
                           'brand_text': lambda text: text})
        redact = SimpleNamespace(redact_sensitive_text=lambda text, **kwargs: text.replace('SECRET', '[скрыто]'))
        with patch.dict(sys.modules, {'agent.redact': redact}), self.assertLogs('gateway-error-test', 'WARNING') as logs:
            self.assertIn('отказал в доступе', scope['t']('gateway.problem', error='HTTP 403: Error code: 403'))
            limited = scope['t']('gateway.problem', error='HTTP 429: too many requests')
            self.assertIn('причина и время возобновления пока неизвестны', limited)
            self.assertNotIn('подписки', limited)
            self.assertIn('причину ошибки нужно проверить', scope['t']('gateway.problem', error='Unknown provider failure SECRET'))
        self.assertNotIn('SECRET', ' '.join(logs.output))
        with patch.dict(sys.modules, {'agent.redact': redact}):
            self.assertIn('нужный файл', scope['t']('gateway.problem', error=FileNotFoundError('missing')))
            self.assertIn('Ошибка доступа OpenAI API', scope['t']('gateway.problem', error='Ошибка доступа OpenAI API'))
            self.assertIn('отказал в доступе', scope['t']('gateway.problem', error='Ошибка: forbidden'))
            self.assertIn('English failure', scope['t']('cli.problem', lang='en', error='English failure'))

    def test_export_help_and_invalid_format_are_russian(self):
        path = self.root / 'hermes_cli/session_export.py'
        tree = ast.parse(path.read_text())
        wanted = {'SAVE_USAGE', '_SAVE_FORMAT_ALIASES'}
        nodes = [node for node in tree.body if isinstance(node, ast.Assign) and
                 any(isinstance(target, ast.Name) and target.id in wanted for target in node.targets)]
        from typing import Optional
        scope = {'Optional': Optional}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), 'exec'), scope)
        functions(path, {'normalize_save_format'}, scope)
        self.assertIn('Сохранить текущий разговор', scope['SAVE_USAGE'])
        self.assertEqual(scope['normalize_save_format']('markdown'), 'md')
        with self.assertRaisesRegex(ValueError, 'Неизвестный формат'):
            scope['normalize_save_format']('invalid')

    def test_approval_prompt_and_skill_deletion_preview_are_russian(self):
        from typing import Optional
        path = self.root / 'tools/write_approval.py'
        tree = ast.parse(path.read_text())
        templates = next(node for node in tree.body if isinstance(node, ast.Assign) and
                         any(isinstance(target, ast.Name) and target.id == '_GIST_TEMPLATES'
                             for target in node.targets))
        scope = {'Any': Any, 'Optional': Optional,
                 'GateDecision': lambda **kwargs: SimpleNamespace(**kwargs),
                 '_frontmatter_description': lambda content: 'Работа с файлами'}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[templates], type_ignores=[])), str(path), 'exec'), scope)
        functions(path, {'_staged', 'skill_gist', 'skill_pending_diff'}, scope)
        self.assertIn('ожидает вашего подтверждения', scope['_staged']('memory').message)
        self.assertIn('Создать навык «пример»', scope['skill_gist']('create', 'пример', content='описание'))
        self.assertEqual(scope['skill_pending_diff']({'payload': {'action': 'delete', 'name': 'пример'}}),
                         'Удалить навык «пример»')
        memory_scope = functions(self.root / 'tools/memory_tool.py', {'_batch_op_line'}, {'Any': Any})
        self.assertIn('Удалить: старая запись', memory_scope['_batch_op_line']({'action': 'remove', 'old_text': 'старая запись'}))

    def test_session_listing_shows_current_chat_and_its_preview(self):
        scope = functions(self.root / 'hermes_cli/session_listing.py',
                          {'format_gateway_session_listing'}, {'Any': Any})
        render = scope['format_gateway_session_listing']
        self.assertIn('Разговоров с названиями пока нет', render([]))
        text = render([{'id': 's1', 'title': 'Отчёт', 'preview': 'Наш текст',
                        'source': 'telegram', 'is_current_session': True}], include_source=True)
        self.assertIn('текущий', text)
        self.assertIn('Наш текст', text)
        self.assertIn('Telegram', text)
        self.assertNotIn('Resume:', text)

    def test_kanban_help_explains_actions_in_russian(self):
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        node = next(node for node in tree.body if isinstance(node, ast.Assign) and
                    any(isinstance(target, ast.Name) and target.id == '_SLASH_KANBAN_HELP'
                        for target in node.targets))
        help_text = ast.literal_eval(node.value)
        self.assertIn('управление общей доской задач', help_text)
        self.assertIn('показать задачи', help_text)
        self.assertIn('`request-review <номер>`', help_text)
        self.assertNotIn('manage the shared task board', help_text)

    def test_kanban_errors_and_statuses_preserve_task_data(self):
        import contextlib
        import io
        import re
        from typing import Callable, Iterable
        scope = functions(self.root / 'hermes_cli/kanban_output.py',
                          {'_kanban_error_ru', '_kanban_success_ru', '_err', '_status_name', '_fmt_task_line', '_bulk_apply'},
                          {'re': re, 'sys': sys, 'Callable': Callable, 'Iterable': Iterable,
                           'Any': Any, 'kb': SimpleNamespace(Task=object), '_STATUS_ICONS': {'running': '●'}})
        i18n = SimpleNamespace(get_language=lambda: 'ru', _russian_gateway_error=lambda _: 'причину нужно проверить')
        with patch.dict(sys.modules, {'agent.i18n': i18n}):
            self.assertEqual(scope['_kanban_error_ru']('no such task: t_123'), 'Задача не найдена: t_123')
            self.assertEqual(scope['_kanban_success_ru']('Assigned t_123 to Мария'), 'Назначен исполнитель задачи t_123: Мария')
            row = scope['_fmt_task_line'](SimpleNamespace(status='running', id='t_123', assignee=None,
                                                           tenant=None, title='Мой отчёт'))
            self.assertIn('в работе', row)
            self.assertIn('не назначен', row)
            self.assertIn('Мой отчёт', row)
            output, errors = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                result = scope['_bulk_apply'](['t_1', 't_2'], lambda task: task == 't_1',
                                              lambda task: f'Completed {task}',
                                              lambda task: f'cannot archive {task}')
            self.assertEqual(result, 1)
            self.assertIn('Выполнена задача t_1', output.getvalue())
            self.assertIn('Не удалось архивировать задачу t_2', errors.getvalue())

    def test_localized_task_creation_keeps_automatic_subscription(self):
        import asyncio
        import re
        import shlex
        from unittest.mock import AsyncMock
        tree = ast.parse((self.root / 'gateway/slash_commands.py').read_text())
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef) and
                      node.name == '_handle_kanban_command')
        scope = {'MessageEvent': object, 'asyncio': asyncio, 'shlex': shlex, 're': re,
                 'logger': logging.getLogger('kanban-test'),
                 't': lambda key, **values: 'Подписка оформлена'}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<candidate>', 'exec'), scope)
        for output in ('Создано: t_ab12; готова', 'Created t_ab12  (ready, assignee=-)'):
            runner = SimpleNamespace(_kanban_auto_subscribe=AsyncMock(return_value=True))
            event = SimpleNamespace(text='/kanban create отчёт')
            with patch.dict(sys.modules, {'hermes_cli.kanban': SimpleNamespace(run_slash=lambda _: output)}):
                result = asyncio.run(scope['_handle_kanban_command'](runner, event))
            runner._kanban_auto_subscribe.assert_awaited_once_with(event, 't_ab12', None)
            self.assertIn('Подписка оформлена', result)


if __name__ == '__main__':
    unittest.main()
