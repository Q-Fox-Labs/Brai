# ABOUTME: Проверяет безопасную обработку завершений фоновых процессов Hermes.
# ABOUTME: Использует изолированные файлы, реестр процессов и транспорт; RELEASE не затрагивается.
import ast
import asyncio
from contextlib import asynccontextmanager
from collections import OrderedDict
import threading
from concurrent.futures import ThreadPoolExecutor
import logging
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch


def candidate_methods(names):
    """Загрузить реальные методы подготовленного движка для проверки без внешних служб."""
    candidate = os.environ.get('HERMES_TEST_CANDIDATE')
    if not candidate:
        raise unittest.SkipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
    path = Path(candidate) / 'gateway/run_notifications.py'
    tree = ast.parse(path.read_text())
    owner = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'GatewayNotificationsMixin')
    nodes = [n for n in owner.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    if {n.name for n in nodes} != set(names):
        raise AssertionError('Отсутствует необходимый метод')
    for node in nodes:
        node.decorator_list = []
    scope = {'asyncio': asyncio, 'logging': logging, 'Optional': Optional,
             'logger': logging.getLogger('background-privacy-test'),
             't': lambda key, **kw: f"{key}: {kw.get('reference', '')}"}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(path), 'exec'), scope)
    return scope


class BackgroundFailureJournalTest(unittest.TestCase):
    def test_reference_exists_in_real_journal_and_never_contains_process_output(self):
        method = candidate_methods({'_record_background_failure'})['_record_background_failure']
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'logs').mkdir()
            journal = home / 'logs/errors.log'
            journal.write_text('existing\n')
            constants = SimpleNamespace(get_hermes_home=lambda: home)
            with patch.dict(sys.modules, {'hermes_constants': constants}):
                reference = method('proc_test', 1)
                self.assertRegex(reference, r'^[a-f0-9]{16}$')
                self.assertIn(f'reference={reference} session=proc_test exit=1', journal.read_text())
                with ThreadPoolExecutor(max_workers=4) as pool:
                    references = list(pool.map(lambda n: method(f'proc_{n}', 1), range(12)))
                self.assertEqual(len(set(references)), 12)
                for item in references:
                    self.assertEqual(journal.read_text().count(f'reference={item} '), 1)
                self.assertIsNone(method('invalid\nsecret', 1))
                original_fsync = os.fsync
                def rotate_during_write(fd):
                    journal.rename(home / 'logs/errors.log.1')
                    journal.write_text('new log\n')
                    original_fsync(fd)
                with patch('os.fsync', side_effect=rotate_during_write):
                    rotated_reference = method('proc_rotated', 1)
                self.assertIn(f'reference={rotated_reference} ', (home / 'logs/errors.log.1').read_text())
                with patch('os.fsync', side_effect=OSError('disk error')):
                    self.assertIsNone(method('proc_other', 1))
                journal.unlink()
                self.assertIsNone(method('proc_missing', 1))
                outside = home / 'outside'
                outside.write_text('untouched')
                journal.symlink_to(outside)
                self.assertIsNone(method('proc_link', 1))
                self.assertEqual(outside.read_text(), 'untouched')


class BackgroundFailureWatcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_completion_routes_only_to_original_session_and_retains_reference(self):
        scope = candidate_methods({'_run_process_watcher'})
        modules = {name: ModuleType(name) for name in ('tools', 'tools.process_registry',
                                                        'tools.process_registry_notifications')}
        modules['tools.process_registry_notifications'].format_process_notification = lambda event: event['output']
        sensitive = 'Traceback: /private/path SECRET_VALUE'
        failed = SimpleNamespace(exited=True, exit_code=1, output_buffer=sensitive)
        delivered = []
        refs = []

        class Runner:
            _run_process_watcher = scope['_run_process_watcher']
            def __init__(self, mode, parent='parent', outcomes=None):
                self.mode, self.parent, self.outcomes = mode, parent, list(outcomes or [True])
            @asynccontextmanager
            async def _completion_event_scope(self, watcher):
                yield
            def _load_background_notifications_mode(self):
                return self.mode
            def _record_background_failure(self, session_id, exit_code):
                refs.append((session_id, exit_code))
                return 'a1b2c3d4e5f67890'
            def _build_process_completion_event(self, watcher, session, session_id):
                return {'type': 'completion', 'output': session.output_buffer, 'parent_session_id': self.parent, 'started_at': 1}
            async def _deliver_completion_notification(self, text, event):
                delivered.append((text, event['parent_session_id']))
                return self.outcomes.pop(0)

        for mode in ('concise', 'all', 'result', 'error', 'off'):
            for agent_notify in (False, True):
                with self.subTest(mode=mode, agent_notify=agent_notify):
                    delivered.clear()
                    refs.clear()
                    sessions = iter([failed])
                    modules['tools.process_registry'].process_registry = SimpleNamespace(
                        get=lambda sid: next(sessions, None), is_completion_consumed=lambda sid: False)
                    runner = Runner(mode)
                    watcher = {'session_id': 'proc', 'check_interval': 0, 'platform': 'telegram',
                               'chat_id': 'chat', 'notify_on_complete': agent_notify}
                    with patch.dict(sys.modules, modules):
                        await runner._run_process_watcher(watcher)
                    self.assertEqual(refs, [('proc', 1)])
                    if mode == 'off' and not agent_notify:
                        self.assertEqual(delivered, [])
                    else:
                        self.assertEqual(len(delivered), 1)
                        self.assertEqual(delivered[0][1], 'parent')
                        self.assertIn('a1b2c3d4e5f67890', delivered[0][0])
                        self.assertIn('без команды, пути и технического вывода', delivered[0][0])
                        self.assertNotIn(sensitive, delivered[0][0])
                        self.assertNotIn('/private/path', delivered[0][0])

        delivered.clear()
        refs.clear()
        sessions = iter([failed])  # Реестр уже очистил результат после первой попытки.
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: next(sessions, None), is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await Runner('concise', outcomes=[False, True])._run_process_watcher(watcher)
        self.assertEqual(len(delivered), 2)
        self.assertEqual(refs, [('proc', 1)])
        self.assertEqual(delivered[0][0], delivered[1][0])

        delivered.clear()
        sessions = iter([failed])
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: next(sessions, None), is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await Runner('concise', parent='')._run_process_watcher(watcher)
        self.assertEqual(delivered, [])

        class NoIdentity(Runner):
            def _build_process_completion_event(self, watcher, session, session_id):
                return {'type': 'completion', 'output': session.output_buffer, 'parent_session_id': 'parent'}
        delivered.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await NoIdentity('concise')._run_process_watcher(watcher)
        self.assertEqual(delivered, [])

        delivered.clear()
        success = SimpleNamespace(exited=True, exit_code=0, output_buffer='prepared result')
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: success, is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await Runner('result')._run_process_watcher({**watcher, 'notify_on_complete': False})
        self.assertEqual(len(delivered), 1)
        self.assertIn('prepared result', delivered[0][0])
        delivered.clear()
        with patch.dict(sys.modules, modules):
            await Runner('error')._run_process_watcher({**watcher, 'notify_on_complete': False})
        self.assertEqual(delivered, [])

        class JournalUnavailable(Runner):
            def _record_background_failure(self, session_id, exit_code):
                return None
        delivered.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await JournalUnavailable('concise')._run_process_watcher(watcher)
        self.assertEqual(len(delivered), 1)
        self.assertIn('Номер журнала недоступен', delivered[0][0])
        self.assertNotIn(sensitive, delivered[0][0])

        delivered.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: True)
        with patch.dict(sys.modules, modules):
            await Runner('concise')._run_process_watcher(watcher)
        self.assertEqual(delivered, [])


class BackgroundCompletionAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_old_generation_never_enters_new_and_duplicates_do_not_wake_agent(self):
        names = {'_deliver_completion_notification_scoped', '_preflight_completion_delivery',
                 '_classify_completion_target', '_completion_delivery_identity',
                 '_completion_identity_seen', '_mark_completions_delivered_locked'}
        scope = candidate_methods(names)
        gateway = ModuleType('gateway')
        run = ModuleType('gateway.run')
        run._USER_BOUNDARY_END_REASONS = {'new'}
        wake = ModuleType('gateway.wake')
        wake.WakeNotAccepted = type('WakeNotAccepted', (Exception,), {})
        accepted = []

        class DB:
            async def get_session(self, session_id):
                if session_id == 'offline':
                    raise OSError('unavailable')
                if session_id == 'old':
                    return {'ended_at': 10, 'end_reason': 'new'}
                return {'ended_at': None}

        class Runner:
            _deliver_completion_notification_scoped = scope['_deliver_completion_notification_scoped']
            _preflight_completion_delivery = scope['_preflight_completion_delivery']
            _classify_completion_target = scope['_classify_completion_target']
            _completion_delivery_identity = staticmethod(scope['_completion_delivery_identity'])
            _completion_identity_seen = scope['_completion_identity_seen']
            _mark_completions_delivered_locked = scope['_mark_completions_delivered_locked']
            _CompletionClaim = lambda self: SimpleNamespace(delegation_id='', claim_id='', proceed=True, early_result=None)
            def __init__(self):
                self._session_db = DB()
                self._completion_delivery_lock = threading.Lock()
                self._completion_deliveries_inflight = set()
                self._completion_deliveries_delivered = OrderedDict()
                self._completion_delivery_retention = 2048
            async def _inject_watch_notification(self, text, event, **kwargs):
                accepted.append((text, event['parent_session_id']))
                return True

        runner = Runner()
        modules = {'gateway': gateway, 'gateway.run': run, 'gateway.wake': wake}
        def event(parent, proc):
            return {'type': 'completion', 'parent_session_id': parent, 'session_id': proc, 'started_at': 1}
        with patch.dict(sys.modules, modules):
            self.assertIsNone(await runner._deliver_completion_notification_scoped('OLD_PRIVATE_RESULT', event('old', 'old')))
            self.assertTrue(await runner._deliver_completion_notification_scoped('SAFE_NEW_RESULT', event('new', 'new')))
            self.assertIsNone(await runner._deliver_completion_notification_scoped('SAFE_NEW_RESULT', event('new', 'new')))
            self.assertFalse(await runner._deliver_completion_notification_scoped('DEFERRED', event('offline', 'third')))
        self.assertEqual(accepted, [('SAFE_NEW_RESULT', 'new')])


if __name__ == '__main__':
    unittest.main()
