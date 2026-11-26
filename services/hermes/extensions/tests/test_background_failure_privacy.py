# ABOUTME: Проверяет короткую правку прямых уведомлений о фоновых задачах.
# ABOUTME: Для запуска нужен подготовленный изолированный движок HERMES_TEST_CANDIDATE.
import ast
import asyncio
from contextlib import asynccontextmanager
import io
import logging
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch


def methods(names):
    candidate = os.environ.get('HERMES_TEST_CANDIDATE')
    if not candidate:
        raise unittest.SkipTest('Нужна подготовленная копия движка')
    path = Path(candidate) / 'gateway/run_notifications.py'
    tree = ast.parse(path.read_text())
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'GatewayNotificationsMixin')
    found = [node for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    if {node.name for node in found} != set(names):
        raise AssertionError('Не найдены проверяемые методы')
    for node in found:
        node.decorator_list = []
    scope = {'asyncio': asyncio, 'logging': logging, 'Optional': Optional,
             'logger': logging.getLogger('gateway.run'),
             't': lambda key: {'gateway.background.task_failed': 'Фоновая задача завершилась с ошибкой',
                               'gateway.background.task_finished': 'Фоновая задача завершена',
                               'gateway.background.still_running': 'Фоновая задача выполняется'}[key]}
    exec(compile(ast.fix_missing_locations(ast.Module(body=found, type_ignores=[])), str(path), 'exec'), scope)
    return scope


class BackgroundWatcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_failure_is_logged_with_reference_but_never_shows_raw_output(self):
        source = methods({'_run_process_watcher', '_format_process_final_message', '_format_process_running_message'})
        modules = {name: ModuleType(name) for name in ('tools', 'tools.process_registry',
                   'tools.process_registry_notifications', 'gateway', 'gateway.warning_notifications')}
        modules['tools.process_registry_notifications'].format_process_notification = lambda event: event['output']
        async def present(send, **kwargs):
            await send()
        modules['gateway.warning_notifications'].present_notification = present
        session = SimpleNamespace(exited=True, exit_code=1, output_buffer='Traceback /private/path SECRET')
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: session, is_completion_consumed=lambda sid: False)
        log, stream = logging.getLogger('gateway.run'), io.StringIO()
        handler = logging.StreamHandler(stream)
        previous = log.level, log.propagate, log.disabled
        log.setLevel(logging.WARNING)
        log.propagate = log.disabled = False
        log.addHandler(handler)
        class Runner:
            _run_process_watcher = source['_run_process_watcher']
            _format_process_final_message = source['_format_process_final_message']
            _format_process_running_message = source['_format_process_running_message']
            def __init__(self, mode, busy):
                self.mode, self.busy, self.direct, self.agent = mode, busy, [], []
            @asynccontextmanager
            async def _completion_event_scope(self, event):
                yield
            def _load_background_notifications_mode(self):
                return self.mode
            def _redacted_output_tail(self, item, limit):
                return item.output_buffer.replace('SECRET', '[redacted]')
            def _build_process_completion_event(self, watcher, item, session_id):
                return {'session_id': session_id, 'output': item.output_buffer,
                        'parent_session_id': watcher.get('parent_session_id', '')}
            async def _enqueue_process_completion_notification(self, text, event):
                self.agent.append((text, event))
                return True
            async def _launching_turn_active(self, platform, watcher):
                return self.busy
            async def _send_watcher_message(self, platform, chat, thread, text, watcher):
                self.direct.append(text)
        watcher = {'session_id': 'proc_abcdef123456', 'check_interval': 0, 'platform': 'telegram', 'chat_id': 'chat'}
        try:
            with patch.dict(sys.modules, modules):
                for notify in (True, False):
                    runner = Runner('concise', busy=True)
                    await runner._run_process_watcher({**watcher, 'notify_on_complete': notify})
                    self.assertEqual(len(runner.direct), 1)
                    self.assertIn('abcdef123456', runner.direct[0])
                    for private in ('Traceback', '/private/path', 'SECRET'):
                        self.assertNotIn(private, runner.direct[0])
                    if notify:
                        self.assertIn('Traceback /private/path SECRET', runner.agent[0][0])
                        self.assertIn('abcdef123456', runner.agent[0][0])
                self.assertIn('reference=abcdef123456', stream.getvalue())
                self.assertNotIn('SECRET', stream.getvalue())
                log.disabled = True
                self.assertNotIn('abcdef123456', runner._format_process_final_message('proc_abcdef123456', session, 'error'))
                log.disabled = False
                self.assertEqual(runner._format_process_running_message(session), 'Фоновая задача выполняется')
                session.exit_code, session.output_buffer = 0, 'готовый результат'
                runner = Runner('result', busy=False)
                await runner._run_process_watcher({**watcher, 'notify_on_complete': False, 'parent_session_id': 'new-session'})
                self.assertIn('готовый результат', runner.agent[0][0])
                self.assertEqual(runner.agent[0][1]['parent_session_id'], 'new-session')
                self.assertEqual(runner.direct, [])
                for mode in ('off', 'error'):
                    runner = Runner(mode, busy=False)
                    await runner._run_process_watcher({**watcher, 'notify_on_complete': False, 'parent_session_id': 'new-session'})
                    self.assertEqual(runner.agent, [])
                    self.assertEqual(runner.direct, [])
                running = SimpleNamespace(exited=False, exit_code=None, output_buffer='Traceback /private/path')
                failed = SimpleNamespace(exited=True, exit_code=1, output_buffer='Traceback /private/path SECRET')
                states = iter((running, failed))
                modules['tools.process_registry'].process_registry = SimpleNamespace(
                    get=lambda sid: next(states), is_completion_consumed=lambda sid: False)
                runner = Runner('all', busy=False)
                await runner._run_process_watcher({**watcher, 'notify_on_complete': False})
                self.assertEqual(len(runner.direct), 2)
                self.assertNotIn('Traceback', runner.direct[0])
                self.assertNotIn('/private/path', runner.direct[1])
        finally:
            log.removeHandler(handler)
            log.level, log.propagate, log.disabled = previous


    async def test_batch_separates_conversations(self):
        source = methods({'_enqueue_process_completion_notification'})
        class Runner:
            _enqueue_process_completion_notification = source['_enqueue_process_completion_notification']
            _COMPLETION_BATCH_KEY_FIELDS = ('session_key', 'platform')
            def __init__(self):
                self.keys = []
            def _event_route_key(self, event, fields):
                return tuple(event.get(field, '') for field in fields)
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


    async def test_batch_keeps_each_error_reference_for_agent(self):
        formatter = methods({'_format_coalesced_process_completions'})['_format_coalesced_process_completions']
        run = ModuleType('gateway.run')
        run._redact_gateway_user_facing_secrets = lambda text: text
        entries = [('', {'session_id': f'proc_{number}', 'exit_code': 1,
                         'output': 'x' * 1000 + f'\n[Без сырых ошибок. Номер в журнале: {number}]'}, None)
                   for number in ('abcdef123456', 'fedcba654321')]
        with patch.dict(sys.modules, {'gateway.run': run}):
            text = formatter(entries)
        self.assertIn('Номер в журнале: abcdef123456', text)
        self.assertIn('Номер в журнале: fedcba654321', text)


if __name__ == '__main__':
    unittest.main()
