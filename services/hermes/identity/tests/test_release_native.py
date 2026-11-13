# ABOUTME: Проверяет безопасное завершение работы native Hermes перед обновлением.
# ABOUTME: Использует настоящий закреплённый retirement fence без пользовательских данных.
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from identity.release_native import NativeRelease

_FIXTURE = Path(os.environ.get('BRAI_NATIVE_FIXTURE', str(Path(__file__).parent / 'fixtures/release_native')))


def actual_retirement():
    path = _FIXTURE / 'hermes_cli/backend_retirement.py'
    if not path.is_file():
        raise unittest.SkipTest('Укажите BRAI_NATIVE_FIXTURE с закреплённым native engine')
    spec = importlib.util.spec_from_file_location('_test_release_retirement', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.RetirementFence()


class NativeReleaseTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.retirement = actual_retirement()
        def module(name, **kwargs):
            result = ModuleType(name)
            result.__dict__.update(kwargs)
            return result
        self.registry = SimpleNamespace(has_any_active=lambda: False, pending_watchers=[],
                                        completion_queue=SimpleNamespace(empty=lambda: True))
        packages = {
            'hermes_cli': module('hermes_cli'),
            'hermes_cli.backend_retirement': module('hermes_cli.backend_retirement', retirement=self.retirement),
            'cron': module('cron'),
            'cron.scheduler': module('cron.scheduler', get_running_job_ids=lambda: []),
            'tools': module('tools'),
            'tools.async_delegation': module('tools.async_delegation', active_count=lambda: 0),
            'tools.process_registry': module('tools.process_registry', process_registry=self.registry),
        }
        self.modules = patch.dict('sys.modules', packages)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.adapter = SimpleNamespace(_pending_messages={}, _active_sessions={}, _pending_text_batches={},
            _text_debounce={}, _session_tasks={}, _pending_text_batch_tasks={}, _background_tasks=set())
        self.runner = SimpleNamespace(_brai_release_protocol=1, _brai_release_cron_supported=True,
            _running_agents={}, _queued_events={}, _background_tasks=set(), _deferred_agent_workers={},
            adapters={'telegram': self.adapter})
        self.worker = SimpleNamespace(runner=self.runner, adapter=self.adapter, active={}, chat_dispatches={},
            chat_interactive={}, lifecycle_error=None, exited=asyncio.Event(), activation=asyncio.Event(),
            operational=asyncio.Event(), policy_ready=asyncio.Event(), policy_error=None)
        self.worker.activation.set()
        self.worker.operational.set()
        self.worker.policy_ready.set()
        self.release = NativeRelease(self.worker)

    async def test_actual_disabled_guest_cron_is_a_supported_empty_source(self):
        import threading
        spec = importlib.util.spec_from_file_location('_test_release_disabled_cron', _FIXTURE / 'gateway/run.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.os, module.threading = os, threading
        policy = ModuleType('identity.native_policy')
        policy.guest_mode = lambda: True
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), patch.dict('sys.modules', {'identity.native_policy': policy}):
            stop, provider, cron_thread, housekeeping_thread = module._start_gateway_start_cron_and_housekeeping(self.runner)
        try:
            self.assertTrue(self.runner._brai_release_cron_supported)
            self.assertEqual(type(provider).__name__, '_DisabledCron')
            self.assertEqual((await self.release.begin('op'))['state'], 'ready')
            await self.release.resume('op')
        finally:
            stop.set()
            cron_thread.join()
            housekeeping_thread.join()

    async def test_real_native_session_views_expose_idle_and_live_work(self):
        import sys
        name = '_test_release_session_state'
        spec = importlib.util.spec_from_file_location(name, _FIXTURE / 'gateway/session_state.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {name: module}):
            spec.loader.exec_module(module)
        state = module.SessionState()
        holder = SimpleNamespace(_sessions={'session': state})
        for field in ('_running_agents', '_queued_events'):
            setattr(self.runner, field, module.SessionFieldView(holder, module.LEGACY_FIELD_SPECS[field]))
        self.assertNotIsInstance(self.runner._running_agents, dict)
        self.assertEqual((await self.release.begin('op'))['state'], 'ready')
        state.turn.agent = object()
        self.assertEqual((await self.release.status('op'))['state'], 'draining')
        state.turn.agent = None
        state.conversation.queued_events.append(object())
        self.assertEqual((await self.release.status('op'))['state'], 'draining')
        state.conversation.queued_events.clear()
        self.assertEqual((await self.release.status('op'))['state'], 'ready')
        await self.release.resume('op')

    async def test_ready_bootstrap_cannot_activate_native_after_proof(self):
        from identity.worker import Worker
        from identity.ipc import RpcError
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        self.assertEqual((await worker.release.begin('op'))['state'], 'ready')
        with self.assertRaisesRegex(RpcError, 'Release holds native activation'):
            await worker.ensure_tools()
        self.assertFalse(worker.activation.is_set())
        await worker.release.resume('op')

    async def test_source_finishes_before_fence_and_future_source_waits(self):
        async with self.release.source():
            self.assertEqual((await self.release.begin('op'))['state'], 'draining')
        started = asyncio.Event()
        async def source():
            async with self.release.source():
                started.set()
        task = asyncio.create_task(source())
        await asyncio.sleep(0)
        self.assertFalse(started.is_set())
        self.assertEqual((await self.release.status('op'))['state'], 'ready')
        await self.release.resume('op')
        await task
        self.assertTrue(started.is_set())

    async def test_real_thread_reservation_finishes_before_release(self):
        with self.retirement.work() as admitted:
            self.assertTrue(admitted)
            self.assertEqual((await self.release.begin('op'))['state'], 'draining')
            self.assertTrue(self.retirement.acquire())
            self.retirement.release()
        self.assertEqual((await self.release.status('op'))['state'], 'ready')
        self.assertFalse(self.retirement.acquire())
        with self.assertRaises(ValueError):
            self.retirement.brai_resume('foreign')
        with self.assertRaises(ValueError):
            await self.release.resume('foreign')
        await self.release.resume('op')
        self.assertTrue(self.retirement.acquire())
        self.retirement.release()

    async def test_queues_and_tracked_work_drain_without_mutation(self):
        pending = object()
        self.adapter._pending_messages['session'] = pending
        task = asyncio.create_task(asyncio.Event().wait())
        self.release.track(task)
        try:
            self.assertEqual((await self.release.begin('op'))['state'], 'draining')
            self.assertIs(self.adapter._pending_messages['session'], pending)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.assertEqual((await self.release.status('op'))['state'], 'draining')
            self.adapter._pending_messages.clear()
            self.assertEqual((await self.release.status('op'))['state'], 'ready')
        finally:
            await self.release.resume('op')

    async def test_unknown_or_throwing_reader_never_reports_ready(self):
        del self.adapter._pending_messages
        self.assertEqual((await self.release.begin('op'))['state'], 'blocked')
        self.adapter._pending_messages = {}
        def failed():
            raise OSError('reader unavailable')
        self.registry.has_any_active = failed
        self.assertEqual((await self.release.status('op'))['state'], 'blocked')
        await self.release.resume('op')

    async def test_completion_handoff_can_finish_without_cancellation(self):
        async with self.release.completion():
            self.assertEqual((await self.release.begin('op'))['state'], 'draining')
        self.assertEqual((await self.release.status('op'))['state'], 'ready')
        entered = asyncio.Event()
        async def later_completion():
            async with self.release.completion():
                entered.set()
        task = asyncio.create_task(later_completion())
        await asyncio.sleep(0)
        self.assertFalse(entered.is_set())
        await self.release.resume('op')
        await task
        self.assertTrue(entered.is_set())

    async def test_pinned_housekeeping_watcher_stops_before_scan(self):
        import ast
        path = _FIXTURE / 'gateway/run_watchers.py'
        tree = ast.parse(path.read_text())
        cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'GatewaySessionWatchersMixin')
        method = next(node for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == '_session_housekeeping_watcher')
        unit = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        ast.fix_missing_locations(unit)
        async def immediate(*args):
            return None
        async def stop_after_tick(runner, interval):
            runner._running = False
        env = {'asyncio': SimpleNamespace(sleep=immediate), '_interruptible_sleep': stop_after_tick}
        exec(compile(unit, str(path), 'exec'), env)
        scans = []
        async def scan():
            scans.append('scanned')
        runner = SimpleNamespace(_running=True, _brai_release_source=self.release.source,
                                 _session_housekeeping=scan)
        self.assertEqual((await self.release.begin('op'))['state'], 'ready')
        task = asyncio.create_task(env['_session_housekeeping_watcher'](runner))
        await asyncio.sleep(0)
        self.assertEqual(scans, [])
        await self.release.resume('op')
        await task
        self.assertEqual(scans, ['scanned'])

    async def test_pinned_cron_delivery_requires_actual_retirement_reservation(self):
        import ast
        path = _FIXTURE / 'gateway/run.py'
        tree = ast.parse(path.read_text())
        method = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_drain_restart_safe_cron_deliveries')
        unit = ast.Module(body=[method], type_ignores=[])
        ast.fix_missing_locations(unit)
        calls = []
        env = {'_brai_admitted_cron_deliveries': lambda *args: calls.append(args)}
        exec(compile(unit, str(path), 'exec'), env)
        env['_drain_restart_safe_cron_deliveries']('adapter', 'loop')
        self.assertEqual(len(calls), 1)
        self.assertEqual((await self.release.begin('op'))['state'], 'ready')
        env['_drain_restart_safe_cron_deliveries']('adapter', 'loop')
        self.assertEqual(len(calls), 1)
        await self.release.resume('op')
        env['_drain_restart_safe_cron_deliveries']('adapter', 'loop')
        self.assertEqual(len(calls), 2)
