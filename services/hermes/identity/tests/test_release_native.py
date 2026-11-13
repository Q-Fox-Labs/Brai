# ABOUTME: Проверяет безопасное завершение работы native Hermes перед обновлением.
# ABOUTME: Использует настоящий закреплённый retirement fence без пользовательских данных.
import asyncio
import hashlib
import uuid
import sys
from contextlib import nullcontext
from contextlib import asynccontextmanager
import importlib.util
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock

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

    async def test_cold_start_holds_real_fence_and_pinned_recovery_until_resume(self):
        import ast
        from identity.native_policy import activate_deferred_startup
        path = Path(os.environ.get('BRAI_STARTUP_FIXTURE', str(_FIXTURE))) / 'gateway/run_startup.py'
        if not path.is_file():
            self.skipTest('Pinned gateway startup fixture required')
        startup = ast.parse(path.read_text())
        method = next(node for node in ast.walk(startup)
                      if isinstance(node, ast.AsyncFunctionDef) and node.name == '_start_recover_previous_run')
        unit = ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[]))
        import logging
        logger = SimpleNamespace(info=lambda *args: None, warning=lambda *args: None)
        scope = {'os': os, 'logging': logging, 'logger': logger,
                 '_log_suppressed': lambda *args, **kwargs: nullcontext()}
        exec(compile(unit, str(path), 'exec'), scope)
        operation = str(uuid.uuid4())
        source = Path('/opt/brai-profile/runtime/services/hermes/identity/worker.py')
        payload = b'pinned worker source'
        env = {'BRAI_IDENTITY_RELEASE_HOLD_OPERATION': operation,
               'BRAI_IDENTITY_RELEASE_HOLD_SOURCE_SHA256': hashlib.sha256(payload).hexdigest(),
               'BRAI_IDENTITY_MODE': 'worker'}
        with patch.dict(os.environ, env), patch.object(Path, 'read_bytes', return_value=payload):
            self.release.bootstrap(source)
        self.assertFalse(self.retirement.acquire())
        self.assertFalse(self.release.open.is_set())
        self.assertFalse(self.release.completions_open.is_set())
        self.worker.policy_stopping = False
        self.worker.cold_recovery_task = None
        self.runner._brai_deferred_startup = [(scope['_start_recover_previous_run'], ())]
        self.runner._start_register_plugins_relay_hooks = lambda: None
        self.runner._subscribe_plugin_rewire = lambda manager: None
        self.runner._rewire_plugin_handlers = lambda: None
        self.runner.hooks = SimpleNamespace(discover_and_load=lambda: None)
        self.runner._recover_secondary_process_checkpoints = lambda registry: 0
        recovery_started, recovery_finish = asyncio.Event(), asyncio.Event()
        durable_queue = ['preserved']
        async def recover():
            recovery_started.set()
            await recovery_finish.wait()
            self.assertEqual(durable_queue, ['preserved'])
            return (0, 0)
        self.runner._recover_unclean_sessions = AsyncMock(side_effect=recover)
        self.runner._suspend_stuck_loop_sessions = lambda: 0
        self.registry.recover_from_checkpoint = lambda: 0
        manager = SimpleNamespace(discover_and_load=lambda **kwargs: None)
        plugins = ModuleType('hermes_cli.plugins')
        plugins.get_plugin_manager = lambda: manager
        gateway = ModuleType('gateway.run')
        gateway._hermes_home = Path('/nonexistent-synthetic-profile')
        human = SimpleNamespace(attach=AsyncMock())
        async def check(): pass
        with patch.dict(sys.modules, {'hermes_cli.plugins': plugins, 'gateway.run': gateway,
                                      '_brai_identity_human': human}):
            task = await activate_deferred_startup(self.runner, self.adapter, check,
                                                    release_open=self.release.recovery_open)
            self.worker.cold_recovery_task = task
            self.assertEqual((await self.release.status(operation))['state'], 'ready')
            await asyncio.sleep(0)
            self.runner._recover_unclean_sessions.assert_not_awaited()
            with self.assertRaises(ValueError):
                await self.release.resume(str(uuid.uuid4()))
            first_wait = asyncio.create_task(self.release.resume(operation))
            await recovery_started.wait()
            self.assertEqual((await self.release.status(operation))['reason'], 'native_recovery')
            self.assertFalse(self.retirement.acquire())
            self.assertFalse(self.release.open.is_set())
            self.assertEqual(durable_queue, ['preserved'])
            first_wait.cancel()
            await asyncio.gather(first_wait, return_exceptions=True)
            self.assertFalse(task.cancelled())
            retry = asyncio.create_task(self.release.resume(operation))
            recovery_finish.set()
            await task
            self.runner._recover_unclean_sessions.assert_awaited_once()
            self.release.finish_cold_recovery()
            self.release.recovery_done.set()
            self.assertEqual((await retry)['state'], 'resumed')
            self.assertEqual((await self.release.status(operation))['state'], 'resumed')
            self.assertEqual((await self.release.resume(operation))['state'], 'resumed')
        self.assertTrue(self.release.open.is_set())
        self.assertTrue(self.retirement.acquire())
        self.retirement.release()

    async def test_failed_cold_recovery_wakes_waiter_without_opening_sources(self):
        operation = 'failure'
        self.release.operation = operation
        self.release.cold_start = True
        self.release.open.clear()
        self.release.completions_open.clear()
        self.worker.policy_stopping = False
        self.worker.cold_recovery_task = asyncio.create_task(asyncio.Event().wait())
        waiting = asyncio.create_task(self.release.resume(operation))
        await self.release.recovery_open.wait()
        self.worker.policy_error = RuntimeError('synthetic failure')
        self.release.recovery_done.set()
        with self.assertRaisesRegex(RuntimeError, 'Cold recovery failed'):
            await waiting
        self.assertFalse(self.release.open.is_set())
        self.assertEqual((await self.release.status(operation))['state'], 'blocked')
        self.worker.cold_recovery_task.cancel()
        await asyncio.gather(self.worker.cold_recovery_task, return_exceptions=True)

    async def test_lost_resume_response_reholds_without_replaying_recovery(self):
        operation = 'lost-response'
        self.assertEqual((await self.release.begin(operation))['state'], 'ready')
        self.assertEqual((await self.release.resume(operation))['state'], 'resumed')
        self.assertEqual((await self.release.status(operation))['state'], 'resumed')
        self.worker.active['new-work'] = object()
        self.assertEqual((await self.release.begin(operation))['state'], 'draining')
        self.assertFalse(self.release.open.is_set())
        self.worker.active.clear()
        self.assertEqual((await self.release.status(operation))['state'], 'ready')
        self.assertEqual((await self.release.resume(operation))['state'], 'resumed')
        self.assertTrue(self.release.open.is_set())

    async def test_active_policy_defers_the_real_native_startup_callbacks_when_cold(self):
        import ast
        policy = Path(__file__).parents[1] / 'native_policy.py'
        tree = ast.parse(policy.read_text())
        install = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'install')
        names = {'prepared_recovery', 'prepared_finish', 'prepared_watchers'}
        methods = [node for node in ast.walk(install)
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        self.assertEqual({node.name for node in methods}, names)
        unit = ast.fix_missing_locations(ast.Module(body=methods, type_ignores=[]))
        entered, pending = [], []
        async def recovery(runner): entered.append('recovery')
        async def finish(runner, count): entered.append('finish')
        def watchers(runner): entered.append('watchers')
        manager = SimpleNamespace(discover_and_load=lambda: None)
        plugins = ModuleType('hermes_cli.plugins')
        plugins.get_plugin_manager = lambda: manager
        scope = {'_suspended': False, 'active_configuration': lambda: True,
                 'recovery': recovery, 'finish': finish, 'watchers': watchers,
                 'defer': lambda runner, callback, *args: pending.append((callback, args))}
        exec(compile(unit, str(policy), 'exec'), scope)
        runner = SimpleNamespace(_brai_release_cold=True, _startup_restore_in_progress=True)
        with patch.dict(sys.modules, {'hermes_cli.plugins': plugins}):
            await scope['prepared_recovery'](runner)
            await scope['prepared_finish'](runner, 1)
            scope['prepared_watchers'](runner)
        self.assertEqual(entered, [])
        self.assertEqual([callback for callback, _ in pending], [recovery, finish, watchers])
        self.assertFalse(runner._startup_restore_in_progress)

    async def test_cold_start_rejects_partial_or_forged_binding(self):
        source = Path('/opt/brai-profile/runtime/services/hermes/identity/worker.py')
        with patch.dict(os.environ, {'BRAI_IDENTITY_RELEASE_HOLD_OPERATION': str(uuid.uuid4())}, clear=True):
            with self.assertRaises(RuntimeError):
                self.release.bootstrap(source)
        self.assertTrue(self.retirement.acquire())
        self.retirement.release()

    async def test_profile_attempt_caches_busy_then_rechecks_with_new_id(self):
        profile = str(uuid.uuid4())
        operation = str(uuid.uuid4())
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        start = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
        args = {'operationId': operation, 'attemptId': first, 'profileId': profile,
                'targetPayloadHash': 'a' * 64, 'workerPid': os.getpid(), 'workerStartTime': start}
        with patch.dict(os.environ, {'BRAI_IDENTITY_PROFILE_ID': profile}):
            self.worker.active['live'] = object()
            self.assertEqual((await self.release.try_hold(**args))['state'], 'busy')
            self.assertTrue(self.release.open.is_set())
            self.worker.active.clear()
            self.assertEqual((await self.release.try_hold(**args))['state'], 'busy')
            new = {**args, 'attemptId': second}
            self.assertEqual((await self.release.try_hold(**new))['state'], 'ready')
            self.assertEqual((await self.release.try_status(**args))['state'], 'unknown')
            self.assertEqual((await self.release.try_status(**new))['state'], 'ready')
            self.assertFalse(self.release.open.is_set())
            await self.release.resume(operation)
            self.assertEqual((await self.release.try_status(**new))['state'], 'unknown')
            following = {**new, 'operationId': str(uuid.uuid4()), 'attemptId': str(uuid.uuid4())}
            self.assertEqual((await self.release.try_hold(**following))['state'], 'ready')
            await self.release.resume(following['operationId'])

    async def test_profile_attempt_rejects_foreign_process_or_target(self):
        profile = str(uuid.uuid4())
        args = {'operationId': str(uuid.uuid4()), 'attemptId': str(uuid.uuid4()), 'profileId': profile,
                'targetPayloadHash': 'a' * 64, 'workerPid': os.getpid(),
                'workerStartTime': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]}
        with patch.dict(os.environ, {'BRAI_IDENTITY_PROFILE_ID': profile}):
            with self.assertRaises(ValueError): await self.release.try_hold(**{**args, 'workerPid': os.getpid()+1})
            with self.assertRaises(ValueError): await self.release.try_hold(**{**args, 'workerStartTime': '0'})
            self.assertEqual((await self.release.try_hold(**args))['state'], 'ready')
            with self.assertRaises(ValueError): await self.release.try_hold(**{**args, 'targetPayloadHash': 'b'*64})
            await self.release.resume(args['operationId'])

    async def test_ingress_busy_receipt_never_closes_sources_or_takes_fence(self):
        profile = str(uuid.uuid4())
        args = {'operationId': str(uuid.uuid4()), 'attemptId': str(uuid.uuid4()), 'profileId': profile,
                'targetPayloadHash': 'a' * 64, 'workerPid': os.getpid(),
                'workerStartTime': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]}
        with patch.dict(os.environ, {'BRAI_IDENTITY_PROFILE_ID': profile}):
            self.assertEqual((await self.release.reject_attempt(**args))['state'], 'busy')
            self.assertTrue(self.release.open.is_set())
            self.assertTrue(self.retirement.acquire())
            self.retirement.release()
            self.assertEqual((await self.release.try_status(**args))['state'], 'busy')
            self.assertTrue(self.retirement.brai_hold('foreign'))
            self.assertEqual((await self.release.try_status(**args))['state'], 'unknown')
            self.retirement.brai_resume('foreign')
            await self.release.begin(str(uuid.uuid4()))
            self.assertEqual((await self.release.try_status(**args))['state'], 'unknown')

    async def test_active_turn_keeps_native_child_admission_until_it_finishes(self):
        self.worker.active['turn'] = object()
        self.assertEqual((await self.release.begin('op'))['state'], 'draining')
        self.assertTrue(self.retirement.acquire())
        self.retirement.release()
        self.worker.active.clear()
        self.assertEqual((await self.release.status('op'))['state'], 'ready')
        self.assertFalse(self.retirement.acquire())
        await self.release.resume('op')
        self.assertTrue(self.retirement.acquire())
        self.retirement.release()

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
