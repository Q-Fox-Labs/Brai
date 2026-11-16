# ABOUTME: Проверяет настоящую справку подкоманд доски и ошибки разбора параметров.
# ABOUTME: Зависимости базы заменены заглушками; действия с задачами не выполняются.
import argparse
import ast
import contextlib
import importlib.util
import os
import re
from pathlib import Path
import shlex
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class KanbanParserRussianTests(unittest.TestCase):
    def setUp(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('Нужна проверочная копия движка HERMES_TEST_CANDIDATE')
        self.root = Path(candidate)

    def _runner(self, language):
        package = ModuleType('hermes_cli')
        package.__path__ = [str(self.root / 'hermes_cli')]
        kb = SimpleNamespace(DEFAULT_CLAIM_TTL_SECONDS=900, DEFAULT_FAILURE_LIMIT=3,
                             VALID_BLOCK_KINDS={'dependency', 'transient'},
                             VALID_INITIAL_STATUSES={'running', 'blocked'},
                             VALID_SORT_ORDERS={'priority': 1}, VALID_STATUSES={'ready', 'done'})
        i18n = SimpleNamespace(get_language=lambda: language,
                               _russian_gateway_error=lambda text: 'причину ошибки нужно проверить')
        modules = {'hermes_cli': package, 'hermes_cli.kanban_db': kb,
                   'hermes_cli.kanban_db_dispatch': SimpleNamespace(DEFAULT_FAILURE_LIMIT=3),
                   'hermes_cli.kanban_db_notify': SimpleNamespace(_NOTIFY_DELIVERY_MODES=('notify', 'wake')),
                   'agent.i18n': i18n}
        context = patch.dict(sys.modules, modules)
        context.start()
        self.addCleanup(context.stop)
        spec = importlib.util.spec_from_file_location('hermes_cli.kanban_parser', self.root / 'hermes_cli/kanban_parser.py')
        parser = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(parser)
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        names = {'_ru_kanban_help', '_ru_kanban_parse_error', 'run_slash'}
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        scope = {'argparse': argparse, 'contextlib': contextlib, 'shlex': shlex, 'os': os,
                 'sys': sys, 'build_parser': parser.build_parser, '_SLASH_KANBAN_HELP': 'Справка',
                 'kanban_command': lambda args: None}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), 'kanban.py', 'exec'), scope)
        return scope['run_slash'], parser

    def test_subcommand_help_and_input_errors(self):
        run, parser = self._runner('ru')
        create = run('create -h')
        self.assertIn('Название задачи', create)
        self.assertIn('Параметры:', create)
        self.assertIn('Причина', run('block -h'))
        self.assertIn('архив', run('boards export -h'))
        for text in ('Task title', 'show this help message', 'options:', 'usage:'):
            self.assertNotIn(text, create)
        self.assertIn('Неизвестные параметры: --bad-arg', run('list --bad-arg'))
        self.assertIn('Не указаны обязательные параметры: title', run('create'))
        self.assertIn('недопустимое значение', run('list --status nonsense'))
        self.assertIn('кавычки', run('create "bad'))

    def test_all_built_in_subcommand_descriptions_are_russian(self):
        _, parser = self._runner('ru')
        def check(specs):
            for name, options, arguments, children in specs:
                texts = [options.get('help', ''), options.get('description', '')]
                texts.extend(argument[1].get('help', '') for argument in arguments)
                for text in texts:
                    if isinstance(text, str):
                        self.assertNotRegex(text, r"\b[a-zA-Z]{3,}(?:\s+[a-zA-Z]{3,})+\b", name)
                if children:
                    check(children[1])
        check(parser._SPECS)

    def test_notification_listing_explains_its_fields(self):
        from io import StringIO
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_cmd_notify_list')
        subscription = {'task_id': 't_12', 'platform': 'telegram', 'chat_id': '123',
                        'thread_id': '55', 'last_event_id': 8, 'notifier_profile': 'main',
                        'delivery_mode': 'notify+wake', 'chat_type': 'group', 'user_id_alt': '17'}
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): return False
        scope = {'argparse': argparse, 'kbc': SimpleNamespace(connect_closing=lambda: Connection()),
                 'kbn': SimpleNamespace(list_notify_subs=lambda connection, task: [subscription]),
                 '_json_out': lambda args, value: False, '_ui': lambda text: text}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'kanban.py', 'exec'), scope)
        output = StringIO()
        with patch.dict(sys.modules, {'agent.i18n': SimpleNamespace(get_language=lambda: 'ru')}), contextlib.redirect_stdout(output):
            scope['_cmd_notify_list'](SimpleNamespace(task_id='t_12'))
        self.assertIn('с события №8', output.getvalue())
        self.assertIn('тип чата: группа', output.getvalue())
        self.assertIn('уведомления и вызов помощника', output.getvalue())
        self.assertNotIn('since event', output.getvalue())

    def test_diagnostics_explain_failure_without_leaking_provider_text(self):
        from io import StringIO
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        names = {'_print_diagnostics_ru', '_print_diagnostics'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        scope = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), 'kanban.py', 'exec'), scope)
        diag = SimpleNamespace(kind='repeated_failures', severity='error', count=3,
                               data={'last_error': 'HTTP 403 forbidden SECRET'},
                               actions=[SimpleNamespace(kind='cli_hint', label='Check logs', suggested=True)])
        output = StringIO()
        i18n = SimpleNamespace(get_language=lambda: 'ru', _russian_gateway_error=lambda text: 'доступ отклонён')
        with patch.dict(sys.modules, {'agent.i18n': i18n}), contextlib.redirect_stdout(output):
            scope['_print_diagnostics']([diag], '  ', with_kind=True)
        self.assertIn('не удалось выполнить несколько раз подряд: 3', output.getvalue())
        self.assertIn('Причина: доступ отклонён', output.getvalue())
        self.assertIn('проверить журнал работы', output.getvalue())
        self.assertNotIn('SECRET', output.getvalue())
        self.assertNotIn('Check logs', output.getvalue())

    def test_runtime_errors_and_empty_result_are_russian(self):
        run, _ = self._runner('ru')
        self.assertEqual(run('list'), 'Нет результата.')
        def fail(_args):
            raise RuntimeError('English provider error with a secret')
        run.__globals__['kanban_command'] = fail
        result = run('list')
        self.assertIn('Не удалось выполнить действие с доской', result)
        self.assertIn('причину ошибки нужно проверить', result)
        self.assertNotIn('English', result)
        self.assertNotIn('secret', result)

    def test_task_event_preserves_values_and_explains_failure(self):
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_kanban_event_ru')
        scope = {'_fmt_ts': lambda ts: 'дата', '_status_name': lambda value: {'running': 'в работе'}.get(value, value)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'kanban.py', 'exec'), scope)
        event = SimpleNamespace(kind='blocked', created_at=1, run_id=2,
                                payload={'status': 'running', 'assignee': 'Мария', 'error': 'HTTP 403 forbidden'})
        i18n = SimpleNamespace(_russian_gateway_error=lambda text: 'доступ отклонён')
        with patch.dict(sys.modules, {'agent.i18n': i18n}):
            result = scope['_kanban_event_ru'](event)
        self.assertIn('попытка 2', result)
        self.assertIn('Задача заблокирована', result)
        self.assertIn('состояние: в работе', result)
        self.assertIn('исполнитель: Мария', result)
        self.assertIn('причина ошибки: доступ отклонён', result)
        self.assertNotIn('forbidden', result)

    def test_run_history_explains_provider_errors(self):
        from io import StringIO
        tree = ast.parse((self.root / 'hermes_cli/kanban.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_cmd_runs')
        run = SimpleNamespace(ended_at=120, started_at=100, outcome='crashed', status='done',
                              profile='main', summary=None, error='English provider error SECRET')
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): return False
        scope = {'argparse': argparse, '_run_state_kwargs': lambda args, command: ({}, 0),
                 'kbc': SimpleNamespace(connect_closing=lambda: Connection()),
                 'kb': SimpleNamespace(list_runs=lambda connection, task, **kw: [run]),
                 '_json_out': lambda args, value: False, '_obj_dict': lambda run, fields: {},
                 '_RUNS_RUN_FIELDS': (), '_ui': lambda text: text,
                 '_fmt_ts': lambda ts: 'дата', '_status_name': lambda status: 'прервана',
                 'time': SimpleNamespace(time=lambda: 120)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'kanban.py', 'exec'), scope)
        i18n = SimpleNamespace(get_language=lambda: 'ru', _russian_gateway_error=lambda text: 'доступ отклонён')
        output = StringIO()
        with patch.dict(sys.modules, {'agent.i18n': i18n}), contextlib.redirect_stdout(output):
            scope['_cmd_runs'](SimpleNamespace(task_id='t_12'))
        self.assertIn('прервана', output.getvalue())
        self.assertIn('Причина: доступ отклонён', output.getvalue())
        self.assertNotIn('SECRET', output.getvalue())

    def test_user_context_is_russian_and_worker_context_remains_english(self):
        import __future__
        import json
        tree = ast.parse((self.root / 'hermes_cli/kanban_db.py').read_text())
        names = {'build_worker_context', '_ctx_cap', '_ctx_age_ru', '_ctx_stamp', '_ctx_metadata_line',
                 '_ctx_tail', '_ctx_header', '_ctx_attachments', '_ctx_prior_attempts',
                 '_ctx_parent_results', '_ctx_role_history', '_ctx_comments'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        task = SimpleNamespace(id='t_12', title='Отчёт', assignee='Мария', status='running', tenant=None,
                               workspace_kind='scratch', workspace_path='/tmp/work', max_runtime_seconds=None,
                               branch_name=None, body='User content in English')
        run = SimpleNamespace(ended_at=110, started_at=100, profile='main', outcome='crashed', status='done',
                              summary='Результат', error='English provider error SECRET', metadata=None)
        attachment = SimpleNamespace(size=100, content_type='text/plain', filename='a.txt', stored_path='/tmp/a.txt')
        comment = SimpleNamespace(author='Мария', created_at=100, body='Комментарий пользователя')
        class Rows:
            def fetchall(self): return []
        class Connection:
            def execute(self, *args): return Rows()
        scope = {'_CTX_MAX_FIELD_BYTES': 1000, '_CTX_MAX_BODY_BYTES': 1000, '_CTX_MAX_COMMENT_BYTES': 1000,
                 '_CTX_MAX_PRIOR_ATTEMPTS': 3, '_CTX_MAX_COMMENTS': 3, 'json': json, 'os': os,
                 'time': SimpleNamespace(time=lambda: 120, strftime=lambda *args: 'дата', localtime=lambda ts: ts),
                 '_relative_age': lambda ts, now: '3h ago', '_first_line': lambda text, limit: text,
                 'get_task': lambda conn, tid: task, 'list_runs': lambda conn, tid: [run],
                 'list_attachments': lambda conn, tid: [attachment], 'list_comments': lambda conn, tid: [comment]}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), 'kanban_db.py', 'exec',
                     flags=__future__.annotations.compiler_flag), scope)
        i18n = SimpleNamespace(_russian_gateway_error=lambda text: 'доступ отклонён')
        kanban_output = SimpleNamespace(_status_name=lambda status: {'running': 'в работе', 'crashed': 'прервана'}.get(status, status))
        with patch.dict(sys.modules, {'agent.i18n': i18n, 'hermes_cli.kanban_output': kanban_output}):
            user = scope['build_worker_context'](Connection(), 't_12', human_ru=True)
            worker = scope['build_worker_context'](Connection(), 't_12')
        for text in ('# Задача t_12', 'Исполнитель: Мария', 'Состояние: в работе', '## Описание',
                     '## Вложения', 'Рабочая папка: временная папка', '## Предыдущие попытки', 'причина ошибки_: доступ отклонён', '## Комментарии'):
            self.assertIn(text, user)
        self.assertIn('User content in English', user)
        self.assertNotIn('English provider error SECRET', user)
        self.assertIn('# Kanban task t_12', worker)
        self.assertIn('_error_: English provider error SECRET', worker)
        self.assertIn('comment from worker', worker)
        expected = ("# Kanban task t_12: Отчёт\n\nAssignee: Мария\nStatus:   running\n"
                    "Workspace: scratch @ /tmp/work\n\n## Body\nUser content in English\n\n"
                    "## Attachments\nFiles attached to this task. Read them with the file/terminal "
                    "tools at the absolute paths below:\n- `a.txt`, text/plain, 1 KB → `/tmp/a.txt`\n\n"
                    "## Prior attempts on this task\n### Attempt 1 — crashed (main, дата, 3h ago)\n"
                    "Результат\n_error_: English provider error SECRET\n\n## Comment thread\n"
                    "comment from worker `Мария` at дата, 3h ago:\nКомментарий пользователя\n")
        self.assertEqual(worker, expected)

    def test_explicit_english_keeps_original_help(self):
        run, _ = self._runner('en')
        self.assertIn('Task title', run('create -h'))
        self.assertIn('usage:', run('create -h'))


if __name__ == '__main__':
    unittest.main()
