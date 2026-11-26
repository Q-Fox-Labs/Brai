# ABOUTME: Проверяет безопасные уведомления о фоновых задачах без изменения результата для агента.
# ABOUTME: Нужен подготовленный изолированный движок HERMES_TEST_CANDIDATE.
import ast
import asyncio
import importlib.util
import io
import logging
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch


def engine_file(relative):
    candidate = os.environ.get('HERMES_TEST_CANDIDATE')
    if not candidate:
        raise unittest.SkipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
    return Path(candidate) / relative


def real_methods(relative, names, owner=None):
    path = engine_file(relative)
    tree = ast.parse(path.read_text())
    nodes = tree.body if owner is None else next(n.body for n in tree.body if isinstance(n, ast.ClassDef) and n.name == owner)
    nodes = [n for n in nodes if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    if {node.name for node in nodes} != set(names):
        raise AssertionError('Не найдены проверяемые методы')
    for node in nodes:
        node.decorator_list = []
    scope = {'asyncio': asyncio, 'logging': logging, 'Optional': Optional, 't': translate,
             'logger': logging.getLogger('gateway.run')}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), 'exec'), scope)
    return scope


def translate(key, **kwargs):
    return {
        'gateway.background.task_failed_ref': f"Фоновая задача завершилась с ошибкой. Номер в журнале: {kwargs.get('reference')}.",
        'gateway.background.task_failed_unlogged': 'Фоновая задача завершилась с ошибкой. Номер журнала недоступен.',
        'gateway.background.task_unknown': 'Результат фоновой задачи неизвестен.',
        'gateway.background.task_finished': 'Фоновая задача завершена.',
        'gateway.background.still_running': 'Фоновая задача ещё выполняется.',
        'gateway.background.task_progress': 'Обновление фоновой задачи.',
    }.get(key, key)


def notification_module():
    path = engine_file('tools/process_registry_notifications.py')
    spec = importlib.util.spec_from_file_location('background_notice_fixture', path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'background_notice_fixture': module}):
        spec.loader.exec_module(module)
    return module


def fake_modules(notification):
    modules = {name: ModuleType(name) for name in ('agent', 'agent.i18n', 'agent.redact', 'tools',
                                                     'tools.process_registry', 'tools.ansi_strip', 'gateway', 'gateway.warning_notifications')}
    modules['agent.i18n'].t = translate
    modules['tools.ansi_strip'].strip_ansi = lambda value: value
    modules['agent.redact'].redact_terminal_output = lambda text, command, **kwargs: text.replace('SECRET_VALUE', '[redacted]')
    modules['agent.redact'].redact_sensitive_text = lambda text, **kwargs: text.replace('SECRET_VALUE', '[redacted]')
    modules['tools.process_registry_notifications'] = notification
    async def present(send, **kwargs):
        await send()
    modules['gateway.warning_notifications'].present_notification = present
    return modules


class BackgroundSurfaceTest(unittest.TestCase):
    def test_failure_is_numbered_in_existing_log_and_safe_on_screen(self):
        module = notification_module()
        modules = fake_modules(module)
        event = {'type': 'completion', 'session_id': 'proc_test', 'exit_code': 1,
                 'command': 'export TMPDIR=/private/path', 'output': 'Traceback /private/path SECRET_VALUE'}
        log = logging.getLogger('gateway.run')
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        previous_level, previous_propagate, previous_disabled = log.level, log.propagate, log.disabled
        log.addHandler(handler)
        log.setLevel(logging.WARNING)
        log.propagate = log.disabled = False
        try:
            with patch.dict(sys.modules, modules):
                agent_text = module.format_process_notification(event)
                title = module.process_completion_display_text([event])
                reference = event['_brai_failure_reference']
                self.assertRegex(reference, r'^[a-f0-9]{16}$')
                self.assertIn(reference, title)
                self.assertIn(f'reference={reference}', stream.getvalue())
                self.assertIn('Traceback', stream.getvalue())
                self.assertNotIn('SECRET_VALUE', stream.getvalue())
                self.assertIn('Traceback /private/path SECRET_VALUE', agent_text)
                for private in ('Traceback', '/private/path', 'SECRET_VALUE', 'TMPDIR'):
                    self.assertNotIn(private, title)
                module.process_completion_display_text([event])
                self.assertEqual(stream.getvalue().count(f'reference={reference}'), 1)
                unknown = {'type': 'completion', 'exit_code': None, 'completion_reason': 'lost'}
                self.assertEqual(module.process_completion_display_text([unknown]), 'Результат фоновой задачи неизвестен.')
        finally:
            log.removeHandler(handler)
            log.setLevel(previous_level)
            log.propagate, log.disabled = previous_propagate, previous_disabled

    def test_reference_is_present_in_real_hermes_error_log(self):
        candidate = str(engine_file('.'))
        code = """
from pathlib import Path
from hermes_logging import setup_logging, flush_log_queue
from tools.process_registry_notifications import background_failure_reference
secret = 'sk-' + 'a' * 48
folder = setup_logging(mode='gateway')
reference = background_failure_reference({'session_id':'proc_fixture', 'exit_code':1,
                                          'command':'cmd', 'output':'error ' + secret})
flush_log_queue()
record = (Path(folder) / 'errors.log').read_text()
assert reference and ('reference=' + reference) in record
assert secret not in record
"""
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'HOME': directory, 'HERMES_HOME': str(Path(directory) / 'hermes'),
                   'PYTHONPATH': os.pathsep.join(filter(None, (candidate, os.environ.get('PYTHONPATH', ''))))}
            result = subprocess.run([sys.executable, '-B', '-c', code], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_cli_and_tui_progress_render_safe_text_but_keep_agent_output(self):
        module = notification_module()
        event = {'type': 'watch_match', 'session_id': 'proc', 'command': '/private/command',
                 'pattern': 'FAIL', 'output': 'Traceback SECRET_VALUE'}
        raw = module.format_process_notification(event)
        pending, updates = [], []
        modules = fake_modules(module)
        for name in ('tools.async_delegation', 'agent.notification_presentation'):
            modules[name] = ModuleType(name)
        modules['agent.notification_presentation'].diagnostic_process_event = lambda event: False
        modules['gateway.warning_notifications'].render_notification = lambda callback, **kw: callback()
        modules['tools.async_delegation'].claim_event_delivery = lambda event, consumer: True
        modules['tools.async_delegation'].complete_event_delivery = lambda event, claim: None
        modules['tools.process_registry'].process_registry = SimpleNamespace(drain_notifications=lambda **kw: [(event, raw)])
        cli_scope = real_methods('hermes_cli/cli_process_notifications.py', {'_drain_process_notifications'}, 'CLIProcessNotificationsMixin')
        cli = SimpleNamespace(session_id='parent', _owns_process_notification=lambda event: True,
                              _background_notifications_suppressed=lambda: False,
                              _pending_input=SimpleNamespace(put=pending.append))
        tui_scope = real_methods('tui_gateway/session_notifications.py', {'_notif_handle_event'})
        tui_scope.update(_notification_event_dedup_key=lambda event: 'unique',
                         _background_notifications_off=lambda session: True,
                         _emit=lambda kind, sid, payload: updates.append(payload['text']))
        registry = SimpleNamespace(completion_queue=SimpleNamespace())
        with patch.dict(sys.modules, modules):
            cli_scope['_drain_process_notifications'](cli, 'cli')
            tui_scope['_notif_handle_event']('parent', {}, event, set(), registry,
                                              module.format_process_notification, None, owned=True)
        self.assertIn('SECRET_VALUE', str(pending[0]))
        self.assertEqual(pending[0].display_text, 'Обновление фоновой задачи.')
        self.assertEqual(updates, ['Обновление фоновой задачи.'])


class BackgroundWatcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_modes_preserve_agent_data_and_direct_notifications_are_safe(self):
        methods = real_methods('gateway/run_notifications.py',
                               {'_run_process_watcher', '_format_process_final_message', '_format_process_running_message'},
                               'GatewayNotificationsMixin')
        module = notification_module()
        modules = fake_modules(module)
        log = logging.getLogger('gateway.run')
        stream, handler = io.StringIO(), logging.StreamHandler()
        handler.setStream(stream)
        previous_level, previous_propagate, previous_disabled = log.level, log.propagate, log.disabled
        log.addHandler(handler)
        log.setLevel(logging.WARNING)
        log.propagate = log.disabled = False
        class Runner:
            _run_process_watcher = methods['_run_process_watcher']
            _format_process_final_message = methods['_format_process_final_message']
            _format_process_running_message = methods['_format_process_running_message']
            def __init__(self, mode, busy=False, outcomes=None):
                self.mode, self.busy, self.direct, self.agent = mode, busy, [], []
                self.outcomes = list(outcomes or [True])
            @asynccontextmanager
            async def _completion_event_scope(self, watcher):
                yield
            def _load_background_notifications_mode(self):
                return self.mode
            def _build_process_completion_event(self, watcher, session, session_id):
                return {'type': 'completion', 'session_id': session_id, 'exit_code': session.exit_code,
                        'command': session.command, 'output': session.output_buffer,
                        'parent_session_id': watcher.get('parent_session_id', '')}
            async def _launching_turn_active(self, platform, watcher):
                return self.busy
            async def _enqueue_process_completion_notification(self, text, event):
                self.agent.append((text, event))
                return self.outcomes.pop(0)
            async def _send_watcher_message(self, platform, chat, thread, text, watcher):
                self.direct.append(text)
        try:
            with patch.dict(sys.modules, modules):
                for mode in ('concise', 'all', 'result', 'error', 'off'):
                    for agent_notify in (False, True):
                        with self.subTest(mode=mode, agent_notify=agent_notify):
                            stream.seek(0); stream.truncate(0)
                            session = SimpleNamespace(exited=True, exit_code=1, command='export TMPDIR=/private/path',
                                                      output_buffer='Traceback /private/path SECRET_VALUE')
                            modules['tools.process_registry'].process_registry = SimpleNamespace(
                                get=lambda sid: session, is_completion_consumed=lambda sid: False)
                            runner = Runner(mode, busy=True)
                            await runner._run_process_watcher({'session_id': 'proc', 'check_interval': 0,
                                'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': agent_notify})
                            self.assertEqual(stream.getvalue().count('BACKGROUND_PROCESS_FAILURE'), 1)
                            if agent_notify:
                                self.assertEqual(len(runner.agent), 1)
                                self.assertIn('Traceback /private/path SECRET_VALUE', runner.agent[0][0])
                            else:
                                self.assertEqual(runner.agent, [])
                            if mode == 'off':
                                self.assertEqual(runner.direct, [])
                            else:
                                self.assertEqual(len(runner.direct), 1)
                                self.assertIn('Номер в журнале:', runner.direct[0])
                                for private in ('Traceback', '/private/path', 'SECRET_VALUE', 'TMPDIR'):
                                    self.assertNotIn(private, runner.direct[0])
                session = SimpleNamespace(exited=True, exit_code=0, command='/private/path', output_buffer='готовый результат')
                modules['tools.process_registry'].process_registry = SimpleNamespace(
                    get=lambda sid: session, is_completion_consumed=lambda sid: False)
                runner = Runner('result')
                await runner._run_process_watcher({'session_id': 'legacy', 'check_interval': 0,
                    'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': False})
                self.assertIn('готовый результат', runner.agent[0][0])
                self.assertEqual(runner.agent[0][1]['parent_session_id'], '')
                self.assertEqual(runner.direct, [])
                self.assertNotIn('/private/path', runner._format_process_running_message(session))
                # Even successful output may contain an error: it goes only to the agent.
                session.output_buffer = '[Errno 17] /private/path'
                runner = Runner('result')
                await runner._run_process_watcher({'session_id': 'legacy', 'check_interval': 0,
                    'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': False})
                self.assertIn('[Errno 17]', runner.agent[0][0])
                self.assertEqual(runner.direct, [])

                failed = SimpleNamespace(exited=True, exit_code=1, command='cmd', output_buffer='bad')
                modules['tools.process_registry'].process_registry = SimpleNamespace(
                    get=lambda sid: failed, is_completion_consumed=lambda sid: False)
                stream.seek(0); stream.truncate(0)
                runner = Runner('concise', busy=True, outcomes=[False, True])
                await runner._run_process_watcher({'session_id': 'retry', 'check_interval': 0,
                    'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': True})
                self.assertEqual(len(runner.agent), 2)
                self.assertEqual(stream.getvalue().count('BACKGROUND_PROCESS_FAILURE'), 1)
                self.assertIn(runner.agent[0][1]['_brai_failure_reference'], runner.direct[0])

                log.disabled = True
                runner = Runner('error')
                await runner._run_process_watcher({'session_id': 'unlogged', 'check_interval': 0,
                    'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': False})
                self.assertIn('Номер журнала недоступен', runner.direct[0])
                log.disabled = False

                running = SimpleNamespace(exited=False, exit_code=None, command='cmd', output_buffer='Traceback /private/path')
                sessions = iter([running, failed])
                modules['tools.process_registry'].process_registry = SimpleNamespace(
                    get=lambda sid: next(sessions), is_completion_consumed=lambda sid: False)
                runner = Runner('all')
                await runner._run_process_watcher({'session_id': 'progress', 'check_interval': 0,
                    'platform': 'telegram', 'chat_id': 'chat', 'notify_on_complete': False})
                self.assertEqual(len(runner.direct), 2)
                self.assertNotIn('Traceback', runner.direct[0])
                self.assertNotIn('/private/path', runner.direct[0])
        finally:
            log.removeHandler(handler)
            log.setLevel(previous_level)
            log.propagate, log.disabled = previous_propagate, previous_disabled

    async def test_batch_retains_failure_references_for_the_agent(self):
        scope = real_methods('gateway/run_notifications.py', {'_format_coalesced_process_completions'}, 'GatewayNotificationsMixin')
        gateway, run = ModuleType('gateway'), ModuleType('gateway.run')
        run._redact_gateway_user_facing_secrets = lambda value: value
        entries = [('ignored', {'session_id': 'one', 'exit_code': 1, 'output': 'reason',
                                '_brai_failure_reference': 'a1b2'}, None),
                   ('ignored', {'session_id': 'two', 'exit_code': 1, 'output': 'reason',
                                '_brai_failure_reference': None}, None)]
        with patch.dict(sys.modules, {'gateway': gateway, 'gateway.run': run}):
            result = scope['_format_coalesced_process_completions'](entries)
        self.assertIn('Journal reference: a1b2', result)
        self.assertIn('Journal reference unavailable', result)
        self.assertIn('report every failure', result)

    async def test_batch_keeps_known_conversation_generations_separate(self):
        scope = real_methods('gateway/run_notifications.py', {'_enqueue_process_completion_notification'}, 'GatewayNotificationsMixin')
        class Runner:
            _enqueue_process_completion_notification = scope['_enqueue_process_completion_notification']
            _COMPLETION_BATCH_KEY_FIELDS = ('session_key', 'platform')
            def __init__(self):
                self.keys = []
            def _event_route_key(self, evt, fields):
                return tuple(evt.get(field, '') for field in fields)
            def _retain_background_task(self, task):
                pass
            def _track_task_in(self, collection, task):
                collection.add(task)
            async def _flush_process_completion_batch(self, key):
                self.keys.append(key)
                for _, _, future in self._completion_notification_batches.pop(key):
                    future.set_result(True)
        runner = Runner()
        await asyncio.gather(*(runner._enqueue_process_completion_notification('result',
            {'session_key': 'same', 'platform': 'telegram', 'parent_session_id': parent}) for parent in ('old', 'new')))
        self.assertEqual({key[-1] for key in runner.keys}, {'old', 'new'})


if __name__ == '__main__':
    unittest.main()
