# ABOUTME: Проверяет безопасную обработку завершений фоновых процессов Hermes.
# ABOUTME: Использует изолированные файлы, реестр процессов и транспорт; RELEASE не затрагивается.
import ast
import asyncio
import importlib.util
import json
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


def notification_module():
    candidate = os.environ.get('HERMES_TEST_CANDIDATE')
    if not candidate:
        raise unittest.SkipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
    path = Path(candidate) / 'tools/process_registry_notifications.py'
    spec = importlib.util.spec_from_file_location('brai_notification_test', path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'brai_notification_test': module}):
        spec.loader.exec_module(module)
    return module


def fake_translation(key, **kwargs):
    return {
        'gateway.background.task_failed': 'Фоновая задача завершилась с ошибкой',
        'gateway.background.task_failed_unlogged': 'Фоновая задача завершилась с ошибкой. Номер журнала недоступен.',
        'gateway.background.task_unknown_unlogged': 'Результат неизвестен. Номер журнала недоступен.',
        'gateway.background.task_failed_ref': f"Фоновая задача завершилась с ошибкой. Номер: {kwargs.get('reference')}",
        'gateway.background.task_unknown': 'Результат неизвестен',
        'gateway.background.task_unknown_ref': f"Результат неизвестен. Номер: {kwargs.get('reference')}",
        'gateway.background.task_finished': 'Фоновая задача завершена',
        'gateway.background.task_progress': 'Обновление фоновой задачи.',
    }[key]


class BackgroundFailureJournalTest(unittest.TestCase):
    def test_reference_exists_in_real_journal_and_never_contains_process_output(self):
        method = notification_module().record_background_failure
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
                def truncate_during_write(fd):
                    journal.write_text('')
                    original_fsync(fd)
                with patch('os.fsync', side_effect=truncate_during_write):
                    self.assertIsNone(method('proc_truncated', 1))
                with patch('os.fsync', side_effect=OSError('disk error')):
                    self.assertIsNone(method('proc_other', 1))
                journal.unlink()
                self.assertIsNone(method('proc_missing', 1))
                outside = home / 'outside'
                outside.write_text('untouched')
                journal.symlink_to(outside)
                self.assertIsNone(method('proc_link', 1))
                self.assertEqual(outside.read_text(), 'untouched')


class BackgroundFailureSurfaceTest(unittest.TestCase):
    def test_cli_and_tui_use_same_safe_notice_and_existing_record(self):
        module = notification_module()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'logs').mkdir()
            journal = home / 'logs/errors.log'
            journal.write_text('')
            agent = ModuleType('agent')
            i18n = ModuleType('agent.i18n')
            i18n.t = fake_translation
            event = {'type': 'completion', 'session_id': 'proc_surface', 'exit_code': 1,
                     'command': 'export TMPDIR=/private/path',
                     'output': 'Traceback: /private/path SECRET_VALUE'}
            with patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: home),
                                         'agent': agent, 'agent.i18n': i18n}):
                text = module.format_process_notification(event)
                cli_title = module.ProcessNotificationBatch(((event, text),)).display_text(
                    SimpleNamespace(is_completion_consumed=lambda sid: False))
                tui_title = module.process_completion_display_text([event])
                self.assertEqual(cli_title, tui_title)
                reference = event['_brai_failure_reference']
                self.assertIn(reference, text)
                self.assertIn(reference, cli_title)
                self.assertEqual(journal.read_text().count(f'reference={reference} '), 1)
                for value in (text, cli_title, tui_title, journal.read_text()):
                    self.assertNotIn('/private/path', value)
                    self.assertNotIn('SECRET_VALUE', value)
                    self.assertNotIn('Traceback', value)
                self.assertIn('Traceback', event['output'])
                unknown = {'type': 'completion', 'session_id': 'proc_unknown', 'exit_code': None,
                           'command': event['command'], 'output': event['output']}
                self.assertIn('Результат неизвестен', module.process_completion_display_text([unknown]))
                self.assertIn(reference, module.process_completion_display_text([event, unknown]))
                self.assertEqual(module.process_progress_display_text(), 'Обновление фоновой задачи.')
                success = {'type': 'completion', 'exit_code': 0, 'command': event['command']}
                self.assertEqual(module.process_completion_display_text([success]), 'Фоновая задача завершена')
                i18n.t = lambda key, **kwargs: key
                self.assertIn('Journal reference:', module.process_completion_display_text([event]))


class BackgroundProgressSurfaceTest(unittest.TestCase):
    def test_cli_and_tui_do_not_render_watched_output(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            raise unittest.SkipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
        module = notification_module()
        event = {'type': 'watch_match', 'session_id': 'proc', 'command': '/private/command',
                 'pattern': 'FAIL', 'output': 'Traceback SECRET_VALUE'}
        raw = module.format_process_notification(event)
        self.assertIn('SECRET_VALUE', raw)  # Вывод доступен агенту для осмысленного ответа.
        pending, updates = [], []
        modules = {name: ModuleType(name) for name in ('tools', 'tools.process_registry', 'tools.async_delegation',
                                                        'agent', 'agent.i18n', 'agent.notification_presentation',
                                                        'gateway', 'gateway.warning_notifications')}
        modules['tools.process_registry_notifications'] = module
        modules['agent.i18n'].t = fake_translation
        modules['agent.notification_presentation'].diagnostic_process_event = lambda event: False
        modules['gateway.warning_notifications'].render_notification = lambda callback, **kw: callback()
        modules['tools.async_delegation'].claim_event_delivery = lambda event, consumer: True
        modules['tools.async_delegation'].complete_event_delivery = lambda event, claim: None
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            drain_notifications=lambda **kw: [(event, raw)])
        cli_path = Path(candidate) / 'hermes_cli/cli_process_notifications.py'
        cli_tree = ast.parse(cli_path.read_text())
        cli_owner = next(node for node in cli_tree.body if isinstance(node, ast.ClassDef))
        method = next(node for node in cli_owner.body if isinstance(node, ast.FunctionDef)
                      and node.name == '_drain_process_notifications')
        cli_scope = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(cli_path), 'exec'), cli_scope)
        cli = SimpleNamespace(session_id='parent', _owns_process_notification=lambda event: True,
                              _background_notifications_suppressed=lambda: False,
                              _pending_input=SimpleNamespace(put=pending.append))
        tui_path = Path(candidate) / 'tui_gateway/session_notifications.py'
        tui_tree = ast.parse(tui_path.read_text())
        tui_method = next(node for node in tui_tree.body if isinstance(node, ast.FunctionDef)
                          and node.name == '_notif_handle_event')
        tui_scope = {'_notification_event_dedup_key': lambda event: 'unique',
                     '_background_notifications_off': lambda session: True,
                     '_emit': lambda kind, sid, payload: updates.append(payload['text'])}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[tui_method], type_ignores=[])), str(tui_path), 'exec'), tui_scope)
        registry = SimpleNamespace(completion_queue=SimpleNamespace())
        with patch.dict(sys.modules, modules):
            cli_scope['_drain_process_notifications'](cli, 'cli')
            tui_scope['_notif_handle_event']('parent', {}, event, set(), registry,
                                              module.format_process_notification, None, owned=True)
        self.assertEqual(pending[0].display_text, 'Обновление фоновой задачи.')
        self.assertIn('SECRET_VALUE', str(pending[0]))
        self.assertEqual(updates, ['Обновление фоновой задачи.'])
        for displayed in (pending[0].display_text, *updates):
            self.assertNotIn('SECRET_VALUE', displayed)
            self.assertNotIn('/private/command', displayed)


class BackgroundCheckpointRecoveryTest(unittest.TestCase):
    def test_real_checkpoint_keeps_unknown_result_until_acknowledged(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            raise unittest.SkipTest('Нужна подготовленная копия движка HERMES_TEST_CANDIDATE')
        path = Path(candidate) / 'tools/process_registry_checkpoint.py'
        modules = {name: ModuleType(name) for name in ('tools', 'tools.process_registry', 'agent', 'agent.redact', 'utils')}
        modules['agent.redact'].redact_sensitive_text = lambda value, **kwargs: value
        reg = modules['tools.process_registry']
        reg._CHECKPOINT_FIELDS = ()
        reg._CHECKPOINT_DEFAULTS = {}
        reg._WATCHER_ROUTE_KEYS = ('platform', 'chat_id')
        reg._stop_systemd_unit = lambda unit: True
        reg.ProcessSession = SimpleNamespace
        modules['utils'].atomic_json_write = lambda path, value: path.write_text(json.dumps(value))
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / 'processes.json'
            reg._checkpoint_path = lambda: checkpoint
            spec = importlib.util.spec_from_file_location('checkpoint_test', path)
            module = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, modules):
                spec.loader.exec_module(module)
                class Registry(module.ProcessCheckpointMixin):
                    def __init__(self, fate):
                        self._running, self.pending_watchers = {}, []
                        self._lock = threading.Lock()
                        self.fate = fate
                    def _detached_host_fate(self, pid, started):
                        return self.fate
                for pid, scope, fate in ((10, 'host', 'gone'), (10, 'host', 'reused'),
                                         (10, 'sandbox', 'gone'), (None, 'host', 'gone')):
                    with self.subTest(pid=pid, scope=scope, fate=fate):
                        checkpoint.write_text(json.dumps([{'session_id': 'proc', 'pid': pid, 'pid_scope': scope,
                            'watcher_interval': 1, 'parent_session_id': 'parent', 'session_key': 'key',
                            'watcher_platform': 'telegram', 'watcher_chat_id': 'chat', 'notify_on_complete': True}]))
                        first = Registry(fate)
                        self.assertEqual(first.recover_from_checkpoint(), 0)
                        self.assertTrue(first.pending_watchers[0]['brai_lost'])
                        self.assertEqual(first.pending_watchers[0]['chat_id'], 'chat')
                        first._write_checkpoint()
                        self.assertTrue(json.loads(checkpoint.read_text())[0]['brai_lost'])
                        restarted = Registry(fate)
                        restarted.recover_from_checkpoint()
                        self.assertEqual(len(restarted.pending_watchers), 1)
                        restarted._brai_forget_lost_checkpoint('proc')
                        self.assertEqual(json.loads(checkpoint.read_text()), [])
                orphan = {'session_id': 'orphan', 'pid': 10, 'pid_scope': 'host', 'watcher_interval': 1}
                checkpoint.write_text(json.dumps([orphan]))
                unrouteable = Registry('gone')
                unrouteable.recover_from_checkpoint()
                self.assertEqual(unrouteable.pending_watchers, [])
                self.assertEqual(json.loads(checkpoint.read_text())[0]['session_id'], 'orphan')
                other_checkpoint = Path(directory) / 'other-processes.json'
                checkpoint.write_text(json.dumps([{'session_id': 'profile_b', 'pid': 10, 'pid_scope': 'host',
                    'watcher_interval': 1, 'parent_session_id': 'parent', 'watcher_platform': 'telegram'}]))
                other_checkpoint.write_text('[]')
                profiles = Registry('gone')
                profiles.recover_from_checkpoint()
                source_key = profiles.pending_watchers[0]['brai_checkpoint_key']
                reg._checkpoint_path = lambda: other_checkpoint
                profiles._brai_forget_lost_checkpoint('profile_b', source_key)
                self.assertEqual(json.loads(checkpoint.read_text()), [])
                self.assertEqual(json.loads(other_checkpoint.read_text()), [])
                reg._checkpoint_path = lambda: checkpoint
                source = Path(candidate) / 'tools/process_registry.py'
                source_tree = ast.parse(source.read_text())
                owner = next(node for node in source_tree.body if isinstance(node, ast.ClassDef) and node.name == 'ProcessRegistry')
                prune = next(node for node in owner.body if isinstance(node, ast.FunctionDef)
                             and node.name == '_prune_uncollected_detached')
                reg._CHECKPOINT_FIELDS = ('pid', 'pid_scope', 'watcher_interval', 'parent_session_id',
                                          'session_key', 'watcher_platform', 'watcher_chat_id')
                scope = {'Optional': Optional, 'ProcessSession': object, 'time': __import__('time')}
                exec(compile(ast.fix_missing_locations(ast.Module(body=[prune], type_ignores=[])), str(source), 'exec'), scope)
                Registry._prune_uncollected_detached = scope['_prune_uncollected_detached']
                detached = Registry('gone')
                session = SimpleNamespace(id='proc_detached', pid=10, pid_scope='host',
                    watcher_interval=1, parent_session_id='parent', session_key='key', watcher_platform='telegram',
                    watcher_chat_id='chat', command='safe', systemd_unit='', exited=False,
                    _lock=threading.Lock(), _completion_event=threading.Event())
                detached._running[session.id] = session
                detached._finished = {}
                detached._prune_uncollected_detached(session)
                self.assertEqual(json.loads(checkpoint.read_text())[0]['session_id'], 'proc_detached')
                replay = Registry('gone')
                replay.recover_from_checkpoint()
                self.assertEqual(replay.pending_watchers[0]['session_id'], 'proc_detached')
                close = next(node for node in owner.body if isinstance(node, ast.FunctionDef)
                             and node.name == '_close_reused_detached')
                exec(compile(ast.fix_missing_locations(ast.Module(body=[close], type_ignores=[])), str(source), 'exec'), scope)
                Registry._close_reused_detached = scope['_close_reused_detached']
                reused = Registry('reused')
                session.exited = False
                reused._running[session.id] = session
                reused._finished = {}
                reused._close_reused_detached(session)
                self.assertEqual(json.loads(checkpoint.read_text())[0]['session_id'], 'proc_detached')
                replay = Registry('reused')
                replay.recover_from_checkpoint()
                self.assertEqual(replay.pending_watchers[0]['session_id'], 'proc_detached')
                reg._CHECKPOINT_DEFAULTS = {name: '' for name in reg._CHECKPOINT_FIELDS}
                def make_session(**values):
                    return SimpleNamespace(**values, systemd_unit='', host_start_time=123, exited=False, notify_on_complete=True,
                                           _lock=threading.Lock(), _completion_event=threading.Event())
                reg.ProcessSession = make_session
                checkpoint.write_text(json.dumps([{'session_id': 'live_b', 'pid': 10, 'pid_scope': 'host',
                    'host_start_time': 123, 'watcher_interval': 1, 'parent_session_id': 'parent',
                    'session_key': 'key', 'watcher_platform': 'telegram', 'watcher_chat_id': 'chat'}]))
                cross_profile = Registry('running')
                cross_profile._finished = {}
                cross_profile.recover_from_checkpoint()
                watcher = cross_profile.pending_watchers[0]
                self.assertEqual(watcher['brai_checkpoint_key'], str(checkpoint))
                reg._checkpoint_path = lambda: other_checkpoint
                cross_profile._prune_uncollected_detached(cross_profile._running['live_b'])
                self.assertTrue(json.loads(checkpoint.read_text())[0]['brai_lost'])
                cross_profile._brai_forget_lost_checkpoint('live_b', watcher['brai_checkpoint_key'])
                self.assertEqual(json.loads(checkpoint.read_text()), [])
                reg._checkpoint_path = lambda: checkpoint
                reg._CHECKPOINT_FIELDS = ()
                reg._CHECKPOINT_DEFAULTS = {}
                reg.ProcessSession = SimpleNamespace
                reg._stop_systemd_unit = lambda unit: False
                checkpoint.write_text(json.dumps([{'session_id': 'proc', 'pid': 10, 'pid_scope': 'host',
                    'systemd_unit': 'scope', 'watcher_interval': 1, 'parent_session_id': 'parent',
                    'watcher_platform': 'telegram', 'watcher_chat_id': 'chat'}]))
                first = Registry('gone')
                first.recover_from_checkpoint()
                self.assertTrue(first.pending_watchers[0]['brai_lost'])
                first._brai_forget_lost_checkpoint('proc')
                self.assertTrue(json.loads(checkpoint.read_text())[0]['brai_lost_notified'])
                again = Registry('gone')
                again.recover_from_checkpoint()
                self.assertEqual(again.pending_watchers, [])
                self.assertEqual(len(json.loads(checkpoint.read_text())), 1)
                reg._stop_systemd_unit = lambda unit: True
                cleaned = Registry('gone')
                cleaned.recover_from_checkpoint()
                self.assertEqual(cleaned.pending_watchers, [])
                self.assertEqual(json.loads(checkpoint.read_text()), [])


class BackgroundFailureWatcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_completion_routes_only_to_original_session_and_retains_reference(self):
        scope = candidate_methods({'_run_process_watcher'})
        modules = {name: ModuleType(name) for name in ('tools', 'tools.process_registry', 'agent', 'agent.i18n')}
        notification = notification_module()
        modules['tools.process_registry_notifications'] = notification
        modules['agent.i18n'].t = fake_translation
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
            def _build_process_completion_event(self, watcher, session, session_id):
                return {'type': 'completion', 'session_id': session_id, 'exit_code': session.exit_code, 'output': session.output_buffer, 'parent_session_id': self.parent, 'started_at': 1}
            async def _deliver_completion_notification(self, text, event):
                delivered.append((text, event['parent_session_id']))
                return self.outcomes.pop(0)

        def record_failure(session_id, exit_code):
            refs.append((session_id, exit_code))
            return 'a1b2c3d4e5f67890'
        notification.record_background_failure = record_failure
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
                        self.assertIn('Не показывай технические подробности', delivered[0][0])
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

        missing_ack = []
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: None, is_completion_consumed=lambda sid: False,
            _brai_forget_lost_checkpoint=lambda sid, key: missing_ack.append((sid, key)))
        with patch.dict(sys.modules, modules):
            await Runner('concise', parent='')._run_process_watcher(watcher)
        self.assertEqual(missing_ack, [])

        class NoIdentity(Runner):
            def _build_process_completion_event(self, watcher, session, session_id):
                return {'type': 'completion', 'session_id': session_id, 'exit_code': session.exit_code, 'output': session.output_buffer, 'parent_session_id': 'parent'}
        delivered.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules):
            await NoIdentity('concise')._run_process_watcher(watcher)
        self.assertEqual(len(delivered), 1)
        self.assertIn('a1b2c3d4e5f67890', delivered[0][0])

        delivered.clear()
        refs.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: None, is_completion_consumed=lambda sid: False,
            _brai_forget_lost_checkpoint=lambda sid, key: None)
        with patch.dict(sys.modules, modules):
            await Runner('concise')._run_process_watcher({**watcher, 'parent_session_id': 'parent'})
        self.assertEqual(len(delivered), 1)
        self.assertIn('Результат неизвестен', delivered[0][0])
        self.assertEqual(refs, [('proc', None)])

        delivered.clear()
        refs.clear()
        acknowledged = []
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False,
            _brai_forget_lost_checkpoint=lambda sid, key: acknowledged.append(sid))
        with patch.dict(sys.modules, modules):
            await Runner('concise', outcomes=[False, True])._run_process_watcher(
                {**watcher, 'parent_session_id': 'parent', 'brai_lost': True})
        self.assertEqual(len(delivered), 2)
        self.assertTrue(all('Результат неизвестен' in text for text, _ in delivered))
        self.assertEqual(acknowledged, ['proc'])

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

        delivered.clear()
        modules['tools.process_registry'].process_registry = SimpleNamespace(
            get=lambda sid: failed, is_completion_consumed=lambda sid: False)
        with patch.dict(sys.modules, modules), patch.object(notification, 'record_background_failure', return_value=None):
            await Runner('concise')._run_process_watcher(watcher)
        self.assertEqual(len(delivered), 1)
        self.assertIn('Фоновая задача завершилась с ошибкой', delivered[0][0])
        self.assertIn('Номер журнала недоступен', delivered[0][0])
        self.assertNotIn('Номер:', delivered[0][0])
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
