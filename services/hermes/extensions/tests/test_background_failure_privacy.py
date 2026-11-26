# ABOUTME: Проверяет безопасные уведомления фонового процесса на границе чата.
# ABOUTME: Исполняет watcher подготовленного движка с изолированными транспортом и реестром.
import ast
import asyncio
from contextlib import asynccontextmanager, contextmanager
import logging
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class BackgroundFailurePrivacyTest(unittest.IsolatedAsyncioTestCase):
    async def test_watcher_keeps_failure_details_out_of_chat(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
        source = Path(candidate) / 'gateway/run_notifications.py'
        tree = ast.parse(source.read_text())
        owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'GatewayNotificationsMixin')
        names = {'_format_process_final_message', '_format_process_running_message', '_run_process_watcher'}
        nodes = [n for n in owner.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
        self.assertEqual({n.name for n in nodes}, names)
        scope = {'asyncio': asyncio, 'logging': logging, 'logger': logging.getLogger('background-privacy-test'),
                 't': lambda key, **kw: {'gateway.background.task_failed': 'Фоновая задача завершилась с ошибкой',
                                         'gateway.background.still_running': 'Фоновая задача выполняется',
                                         'gateway.background.task_result_ready': 'Фоновая задача завершена. Можно попросить проверить результат.',
                                         'gateway.background.task_unknown': 'Результат неизвестен',
                                         'gateway.background.task_unknown_ref': 'Результат неизвестен. Номер: ' + str(kw.get('reference')),
                                         'gateway.background.task_failed_ref': 'Фоновая задача завершилась с ошибкой. Номер: ' + str(kw.get('reference')),
                                         'gateway.background.final_output': f"{kw.get('header')} {kw.get('output')}"}[key]}
        @contextmanager
        def suppressed(*args):
            try:
                yield
            except Exception:
                pass
        scope['_log_suppressed'] = suppressed
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(source), 'exec'), scope)
        sensitive = 'Traceback: /private/path SECRET_VALUE'
        command = 'export TMPDIR=/private/path'
        modules = {}
        for name in ('tools', 'tools.process_registry', 'tools.process_registry_notifications',
                     'gateway', 'gateway.run', 'gateway.warning_notifications'):
            modules[name] = ModuleType(name)
        modules['tools.process_registry_notifications'].format_process_notification = lambda event: event['output']
        modules['gateway.run']._redact_gateway_user_facing_secrets = lambda value: value
        modules['gateway.run']._format_concise_process_notification = lambda sid, cmd, code, out, duration_seconds=None: 'Успех'
        async def present(send, **kwargs):
            await send()
        modules['gateway.warning_notifications'].present_notification = present

        class Runner:
            _format_process_final_message = scope['_format_process_final_message']
            _format_process_running_message = scope['_format_process_running_message']
            _run_process_watcher = scope['_run_process_watcher']
            def __init__(self, mode):
                self.mode, self.sent, self.injected = mode, [], []
            @asynccontextmanager
            async def _completion_event_scope(self, watcher):
                yield
            def _load_background_notifications_mode(self):
                return self.mode
            def _redacted_output_tail(self, session, limit):
                return session.output_buffer.replace('SECRET_VALUE', '[REDACTED]')
            def _build_process_completion_event(self, watcher, session, sid):
                return {'output': session.output_buffer}
            async def _launching_turn_active(self, platform, watcher):
                return True
            async def _enqueue_process_completion_notification(self, text, event):
                self.injected.append(text)
                return True
            async def _send_watcher_message(self, platform, chat, thread, text, watcher):
                self.sent.append(text)

        for mode in ('concise', 'all', 'result', 'error', 'off'):
            for agent_notify in (False, True):
                with self.subTest(mode=mode, agent_notify=agent_notify):
                    running = SimpleNamespace(exited=False, exit_code=None, output_buffer=sensitive, command=command)
                    failed = SimpleNamespace(exited=True, exit_code=1, output_buffer=sensitive, command=command)
                    sessions = iter([running, failed])
                    modules['tools.process_registry'].process_registry = SimpleNamespace(
                        get=lambda sid: next(sessions, None), is_completion_consumed=lambda sid: False)
                    runner = Runner(mode)
                    watcher = {'session_id': 'proc', 'check_interval': 0, 'platform': 'telegram', 'chat_id': 'chat',
                               'notify_on_complete': agent_notify}
                    with patch.dict(sys.modules, modules), self.assertLogs('background-privacy-test', level='WARNING') as logs:
                        await runner._run_process_watcher(watcher)
                    for text in runner.sent:
                        self.assertNotIn('/private/path', text)
                        self.assertNotIn('Traceback', text)
                        self.assertNotIn('SECRET_VALUE', text)
                        self.assertNotIn('export', text)
                    self.assertNotIn('SECRET_VALUE', ' '.join(logs.output))
                    self.assertNotIn('/private/path', ' '.join(logs.output))
                    self.assertIn('BACKGROUND_PROCESS_FAILURE', ' '.join(logs.output))
                    reference = logs.output[0].split('reference=')[1].split()[0]
                    if runner.sent and mode != 'off':
                        self.assertIn(reference, runner.sent[-1])
                    if agent_notify:
                        self.assertEqual(runner.injected, [sensitive])
                    if mode == 'off':
                        self.assertEqual(runner.sent, [])
                    elif not agent_notify or mode != 'off':
                        self.assertIn('Фоновая задача завершилась с ошибкой', runner.sent[-1])
                    if mode == 'all' and not agent_notify:
                        self.assertEqual(runner.sent[0], 'Фоновая задача выполняется')

        class RetryRunner(Runner):
            async def _enqueue_process_completion_notification(self, text, event):
                self.injected.append(text)
                return len(self.injected) > 1

        failed = SimpleNamespace(exited=True, exit_code=1, output_buffer=sensitive, command=command)
        sessions = iter([failed, failed])
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: next(sessions, None), is_completion_consumed=lambda sid: False)
        runner = RetryRunner('concise')
        watcher = {'session_id': 'proc', 'check_interval': 0, 'platform': 'telegram', 'chat_id': 'chat',
                   'notify_on_complete': True}
        with patch.dict(sys.modules, modules), self.assertLogs('background-privacy-test', level='WARNING') as logs:
            await runner._run_process_watcher(watcher)
        self.assertEqual(len(logs.output), 1)
        self.assertEqual(runner.injected, [sensitive, sensitive])
        self.assertEqual(len(runner.sent), 1)
        self.assertIn(logs.output[0].split('reference=')[1].split()[0], runner.sent[0])

        unknown = SimpleNamespace(exited=True, exit_code=None, output_buffer=sensitive, command=command)
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: unknown, is_completion_consumed=lambda sid: False)
        runner = Runner('error')
        watcher = {'session_id': 'proc', 'check_interval': 0, 'platform': 'telegram', 'chat_id': 'chat'}
        with patch.dict(sys.modules, modules), self.assertLogs('background-privacy-test', level='WARNING') as logs:
            await runner._run_process_watcher(watcher)
        self.assertEqual(len(runner.sent), 1)
        self.assertIn('Результат неизвестен', runner.sent[0])
        self.assertIn(logs.output[0].split('reference=')[1].split()[0], runner.sent[0])
        self.assertNotIn('SECRET_VALUE', ' '.join(logs.output))

        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: None, is_completion_consumed=lambda sid: False)
        runner = Runner('concise')
        with patch.dict(sys.modules, modules), self.assertLogs('background-privacy-test', level='WARNING') as logs:
            await runner._run_process_watcher(watcher)
        self.assertEqual(len(runner.sent), 1)
        self.assertIn('Результат неизвестен', runner.sent[0])
        self.assertIn(logs.output[0].split('reference=')[1].split()[0], runner.sent[0])

        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: None, is_completion_consumed=lambda sid: True)
        runner = Runner('concise')
        with patch.dict(sys.modules, modules):
            await runner._run_process_watcher(watcher)
        self.assertEqual(runner.sent, [])

        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False)
        runner = Runner('concise')
        with patch.dict(sys.modules, modules), patch.object(scope['logger'], 'warning', side_effect=OSError('log unavailable')):
            await runner._run_process_watcher(watcher)
        self.assertEqual(runner.sent, ['Фоновая задача завершилась с ошибкой'])

        for exit_code, expected in [(0, 'Фоновая задача завершена. Можно попросить проверить результат.'), (None, 'Результат неизвестен')]:
            session = SimpleNamespace(exit_code=exit_code, output_buffer=sensitive, command=command)
            for mode in ('concise', 'all', 'result', 'error'):
                self.assertEqual(Runner(mode)._format_process_final_message('proc', session, mode), expected)


if __name__ == '__main__':
    unittest.main()
