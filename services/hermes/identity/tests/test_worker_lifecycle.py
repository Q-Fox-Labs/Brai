# ABOUTME: Проверяет bootstrap, native startup и остановку личного gateway.
# ABOUTME: Внешние сервисы заменены портами; native patch сверяется с pinned исходниками.
import ast
import asyncio
import inspect
import tempfile
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.worker import Worker, main
from identity.ipc import Peer, RpcError


class LifecycleTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls = []
        self.started = asyncio.Event()
        self.shutdown = asyncio.Event()
        self.finalized = asyncio.Event()
        self.allow_finalize = asyncio.Event()
        self.allow_finalize.set()
        self.exit_code = None
        outer = self

        class Runner:
            def __init__(self):
                self.config = NS(multiplex_profiles=False, platforms={})
                self.adapters = {}
                self._running = False
                self.exit_code = None
            async def stop(self):
                outer.calls.append('stop')
                self._running = False
                outer.shutdown.set()

        async def start_gateway(config=None, *, runner_factory, startup_gate, operational_ready):
            runner = runner_factory(config)
            outer.calls.append('gate')
            await startup_gate(runner)
            outer.calls.append('native_start')
            runner.adapters['telegram'] = runner._instantiate_adapter('telegram', None)
            runner._running = True
            outer.started.set()
            try:
                await operational_ready(runner)
                await outer.shutdown.wait()
                if outer.exit_code is not None:
                    raise SystemExit(outer.exit_code)
                return True
            finally:
                await runner.stop()
                await outer.allow_finalize.wait()
                outer.calls.append('native_finalized')
                outer.finalized.set()

        gateway = ModuleType('gateway.run')
        gateway.GatewayRunner = Runner
        gateway.start_gateway = start_gateway
        config = ModuleType('gateway.config')
        config.Platform = NS(TELEGRAM='telegram')
        config.PlatformConfig = lambda: NS(enabled=False)
        registry = ModuleType('tools.registry')
        registry.registry = NS(get_entry=lambda name: object())
        self.modules = patch.dict(sys.modules, {'gateway.run': gateway,
            'gateway.config': config, 'tools.registry': registry})
        self.modules.start()
        self.env = patch.dict(os.environ)
        self.env.start()
        os.environ.pop('BRAI_IDENTITY_MODE', None)
        self.adapter = NS(gateway_runner=None)
        self.adapter_patch = patch('identity.worker.make_adapter', return_value=self.adapter)
        self.adapter_patch.start()

    def tearDown(self):
        self.adapter_patch.stop()
        self.env.stop()
        self.modules.stop()

    async def worker(self):
        result = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        # The broker is the activation port; no real Auth or network is consulted.
        result._startup_gate = self.gate(result)
        await result.start(NS(closed=False))
        return result

    def gate(self, worker):
        async def active(runner):
            await worker.activation.wait()
            self.calls.append('active_auth')
        return active

    def test_native_exit_funnel_preserves_stop_failure_and_restart_codes(self):
        for outcome, expected in [(None, 0), (SystemExit(None), 0),
                                  (SystemExit(1), 1), (SystemExit(75), 75)]:
            with self.subTest(code=expected), patch.object(sys, 'argv',
                    ['worker', '--config', '/unused/worker.json']), patch(
                    'identity.worker.run', lambda _: None), patch(
                    'identity.worker.asyncio.run', side_effect=outcome), patch.object(
                    sys.modules['gateway.run'], '_exit_after_graceful_shutdown', create=True) as finish:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, expected)
                finish.assert_called_once_with(expected)

    def test_bootstrap_exit_without_native_import_preserves_failure(self):
        with patch.dict(sys.modules), patch.object(sys, 'argv',
                ['worker', '--config', '/unused/worker.json']), patch(
                'identity.worker.run', lambda _: None), patch(
                'identity.worker.asyncio.run', side_effect=SystemExit(1)):
            sys.modules.pop('gateway.run', None)
            with self.assertRaises(SystemExit) as stopped:
                main()
            self.assertEqual(stopped.exception.code, 1)

    async def test_bootstrap_probe_eof_keeps_worker_available_for_ingress(self):
        worker = await self.worker()
        await asyncio.sleep(0)
        await worker.stop_runtime()
        self.assertFalse(worker.exited.is_set())
        self.assertIsNone(worker.exit_code)
        self.assertNotIn('gate', self.calls)

    async def test_reconnect_keeps_cached_plugin_attachment_for_new_adapter(self):
        worker = await self.worker()
        try:
            with patch.dict(sys.modules), patch.dict(os.environ, {
                    'BRAI_IDENTITY_MODE': 'worker', 'BRAI_DIALOGUES_REQUIRED': '0'}):
                sys.modules.pop('_brai_identity_human', None)
                worker._install_telegram_profile()
                attach = AsyncMock()
                sys.modules['_brai_identity_human'].attach = attach
                worker.adapter = NS()
                worker._install_telegram_profile()
                await worker._operational_ready(worker.runner)
                attach.assert_awaited_once_with(worker.adapter)
                self.assertTrue(worker.operational.is_set())
        finally:
            await worker.stop_runtime()

    async def test_bootstrap_does_not_start_tools_or_recovery(self):
        worker = await self.worker()
        try:
            receipt = await worker.health()
            self.assertTrue(receipt['ready'])
            self.assertFalse(receipt['operational'])
            self.assertFalse(self.started.is_set())
            self.assertNotIn('active_auth', self.calls)
            await worker.health(require_tools=True)
            self.assertTrue(self.started.is_set())
            self.assertTrue(worker.operational.is_set())
            self.assertLess(self.calls.index('active_auth'), self.calls.index('native_start'))
            self.assertEqual(set(worker.runner.config.platforms), {'telegram'})
        finally:
            await worker.stop_runtime()
        self.assertTrue(self.finalized.is_set())

    async def test_operational_wait_is_shared_by_concurrent_health_calls(self):
        worker = await self.worker()
        try:
            receipts = await asyncio.gather(worker.health(require_tools=True),
                                            worker.health(require_tools=True))
            self.assertTrue(all(value['operational'] for value in receipts))
            self.assertEqual(self.calls.count('native_start'), 1)
        finally:
            await worker.stop_runtime()

    async def test_reconnect_waits_for_closed_bootstrap_peer_drain(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        worker._startup_gate = self.gate(worker)
        worker.peer = NS(closed=True)
        worker.peer_released.clear()
        with tempfile.TemporaryDirectory() as directory, patch(
                'identity.worker.peer_uid', return_value=worker.ingress_uid):
            server = await asyncio.start_unix_server(worker.serve_connection,
                                                     path=directory + '/worker.sock')
            reader, writer = await asyncio.open_unix_connection(directory + '/worker.sock')
            client = Peer(reader, writer, {})
            reading = asyncio.create_task(client.run())
            call = asyncio.create_task(client.call('health', {'require_tools': True}, timeout=2))
            try:
                await asyncio.sleep(.02)
                self.assertFalse(call.done())
                self.assertIsNone(worker.runner)
                worker.peer = None
                worker.peer_released.set()
                receipt = await call
                self.assertTrue(receipt['operational'])
                self.assertEqual(self.calls.count('native_start'), 1)
            finally:
                writer.close()
                await reading
                await asyncio.gather(call, return_exceptions=True)
                if worker.peer is not None:
                    await asyncio.wait_for(worker.peer_released.wait(), 2)
                server.close()
                await server.wait_closed()

    async def test_bootstrap_observer_never_claims_primary_and_supervisor_can_start(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        worker._startup_gate = self.gate(worker)
        with tempfile.TemporaryDirectory() as directory, patch(
                'identity.worker.peer_uid', return_value=worker.ingress_uid):
            server = await asyncio.start_unix_server(worker.serve_connection,
                                                     path=directory + '/worker.sock')
            reader, writer = await asyncio.open_unix_connection(directory + '/worker.sock')
            observer = Peer(reader, writer, {})
            reading = asyncio.create_task(observer.run())
            try:
                with self.assertRaises(RpcError):
                    await observer.call('health', {}, timeout=2)
                self.assertIsNone(worker.peer)
                self.assertIsNone(worker.runner)
                writer.close()
                await reading
                reader, writer = await asyncio.open_unix_connection(directory + '/worker.sock')
                supervisor = Peer(reader, writer, {})
                reading = asyncio.create_task(supervisor.run())
                receipt = await supervisor.call('health', {'require_tools': True}, timeout=2)
                self.assertTrue(receipt['policyReady'])
                self.assertIsNotNone(worker.peer)
            finally:
                writer.close()
                await reading
                if worker.peer is not None:
                    await worker.peer_released.wait()
                server.close()
                await server.wait_closed()

    async def test_failed_owned_recovery_notifies_waiter_and_keeps_gate_closed(self):
        import identity.native_policy as policy
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        runner = NS(_exit_code=None, _request_clean_exit=lambda reason: None)
        adapter = NS()
        worker.runner, worker.adapter = runner, adapter
        worker.operational.set()
        worker.policy_ready.clear()
        worker.release.operation = 'operation'
        worker.release.cold_start = True
        worker.release.open.clear()
        expected = {'role': 'user', 'generation': 1}
        async def activate(_runner, _adapter, _check, *, release_open):
            async def recover():
                await release_open.wait()
                raise RuntimeError('synthetic recovery failure')
            return asyncio.create_task(recover())
        with patch.object(policy, 'principal', return_value=expected), \
                patch.object(policy, 'activate_deferred_startup', side_effect=activate):
            await worker._activate_user_startup(runner, adapter, expected)
            with self.assertRaisesRegex(RuntimeError, 'Cold recovery failed'):
                await worker.release.resume('operation')
        self.assertTrue(worker.release.recovery_done.is_set())
        self.assertFalse(worker.release.open.is_set())
        self.assertIsNotNone(worker.policy_error)
        self.assertEqual((await worker.release.status('operation'))['state'], 'blocked')

    async def test_stopping_waits_for_already_admitted_recovery(self):
        worker = await self.worker()
        started, finish = asyncio.Event(), asyncio.Event()
        async def recovery():
            started.set()
            await finish.wait()
        worker.release.recovery_open.set()
        worker.cold_recovery_task = asyncio.create_task(recovery())
        await started.wait()
        stopping = asyncio.create_task(worker.stop_runtime())
        await asyncio.sleep(0)
        self.assertFalse(stopping.done())
        self.assertFalse(worker.policy_stopping)
        self.assertFalse(worker.cold_recovery_task.cancelled())
        finish.set()
        await stopping
        self.assertTrue(worker.policy_stopping)

    async def test_health_policy_ready_requires_settled_live_policy(self):
        worker = await self.worker()
        try:
            self.assertFalse((await worker.health())['policyReady'])
            worker.operational.set()
            self.assertTrue((await worker.health())['policyReady'])
            worker.policy_ready.clear()
            self.assertFalse((await worker.health())['policyReady'])
            worker.policy_ready.set()
            worker.policy_error = RuntimeError('failed')
            self.assertFalse((await worker.health())['policyReady'])
            worker.policy_error = None
            worker.policy_stopping = True
            self.assertFalse((await worker.health())['policyReady'])
        finally:
            await worker.stop_runtime()

    async def test_secondary_operator_health_preserves_the_active_ingress_and_runtime(self):
        worker = await self.worker()
        primary = NS(closed=False)
        worker.peer = primary
        try:
            with tempfile.TemporaryDirectory() as directory, patch(
                    'identity.worker.peer_uid', return_value=worker.ingress_uid):
                server = await asyncio.start_unix_server(worker.serve_connection,
                                                         path=directory + '/worker.sock')
                try:
                    reader, writer = await asyncio.open_unix_connection(directory + '/worker.sock')
                    client = Peer(reader, writer, {})
                    reading = asyncio.create_task(client.run())
                    receipt = await client.call('health', {}, timeout=2)
                    self.assertTrue(receipt['ready'])
                    self.assertFalse(receipt['operational'])
                    with self.assertRaises(RpcError) as denied:
                        await client.call('dispatch', {}, timeout=2)
                    self.assertEqual(denied.exception.code, -32601)
                    with self.assertRaises(RpcError):
                        await client.call('health', {'require_tools': True}, timeout=2)
                    writer.close()
                    await reading
                    self.assertIs(worker.peer, primary)
                    self.assertIsNotNone(worker.runner)
                    self.assertFalse(worker.exited.is_set())
                    self.assertNotIn('stop', self.calls)
                    self.assertFalse(worker.activation.is_set())
                finally:
                    server.close()
                    await server.wait_closed()
        finally:
            await worker.stop_runtime()

    async def test_native_detached_task_drops_only_the_expiring_turn_scope(self):
        from identity.scope import delivery_scope
        patch_text = (Path(__file__).resolve().parents[1] / 'native.patch').read_text()
        name, old, new = next(patch_hunks(patch_text, {'gateway/slash_commands.py'}))
        import textwrap
        method = ast.parse(textwrap.dedent(new)).body[0]
        scope = {'asyncio': asyncio, 'os': os}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])),
                     name, 'exec'), scope)
        owner = NS(_background_tasks=set())
        async def observed():
            return delivery_scope.get()
        token = delivery_scope.set('active-turn')
        try:
            with patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'):
                scope['_track_background_task'](owner, observed())
            task = next(iter(owner._background_tasks))
            self.assertIsNone(await task)
            self.assertEqual(delivery_scope.get(), 'active-turn')
            with patch.dict(os.environ, BRAI_IDENTITY_MODE='ordinary'):
                scope['_track_background_task'](owner, observed())
            task = next(iter(owner._background_tasks))
            self.assertEqual(await task, 'active-turn')
        finally:
            delivery_scope.reset(token)

    async def test_startup_failure_never_becomes_operational(self):
        worker = await self.worker()
        async def unavailable(runner):
            await worker.activation.wait()
            raise PermissionError('Auth unavailable')
        worker._startup_gate = unavailable
        try:
            with self.assertRaisesRegex(RpcError, 'startup unavailable'):
                await asyncio.wait_for(worker.health(require_tools=True), 1)
            self.assertFalse(worker.operational.is_set())
            self.assertEqual(worker.exit_code, 1)
        finally:
            await worker.stop_runtime()

    async def test_shutdown_waits_for_native_outer_teardown(self):
        worker = await self.worker()
        await worker.health(require_tools=True)
        self.allow_finalize.clear()
        stopping = asyncio.create_task(worker.stop_runtime())
        await self.shutdown.wait()
        await asyncio.sleep(0)
        self.assertFalse(stopping.done())
        self.assertFalse(self.finalized.is_set())
        self.allow_finalize.set()
        await stopping
        self.assertTrue(self.finalized.is_set())

    async def test_private_plugin_profile_exists_before_images_discovery_and_is_not_reset(self):
        attach = AsyncMock()
        def discover():
            profile = sys.modules.get('_brai_identity_human')
            self.assertIsNotNone(profile)
            self.assertEqual(profile.telegram_id, '123')
            self.assertIs(profile.game_core_enabled, False)
            self.assertFalse(hasattr(profile, 'call'))
            profile.attach = attach
            self.calls.append('plugin_discovery')
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), patch.dict(sys.modules):
            with patch('identity.native_policy.revalidate_startup'), patch('identity.native_policy.install', side_effect=lambda **_kwargs: self.calls.append('role_policy')), patch('identity.images.install_shared_provider', side_effect=discover):
                worker = await self.worker()
            try:
                self.assertIs(sys.modules['_brai_identity_human'].attach, attach)
                await worker.health(require_tools=True)
                attach.assert_awaited_once_with(worker.adapter)
                self.assertLess(self.calls.index('role_policy'), self.calls.index('plugin_discovery'))
                self.assertLess(self.calls.index('plugin_discovery'), self.calls.index('native_start'))
            finally:
                await worker.stop_runtime()

    async def test_private_plugin_attaches_before_operational_ready(self):
        worker = await self.worker()
        attach = AsyncMock()
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), patch.dict(
                sys.modules, {'_brai_identity_human': NS(attach=attach)}):
            try:
                await worker.health(require_tools=True)
                attach.assert_awaited_once_with(worker.adapter)
                self.assertTrue(worker.operational.is_set())
            finally:
                await worker.stop_runtime()

    async def test_partial_bootstrap_runner_is_stopped(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        worker.runner = NS(stop=AsyncMock())
        await worker.stop_runtime()
        worker.runner.stop.assert_awaited_once()

    async def test_service_restart_75_survives_native_system_exit(self):
        worker = await self.worker()
        await worker.health(require_tools=True)
        self.exit_code = 75
        await worker.stop_runtime()
        self.assertEqual(worker.exit_code, 75)
        self.assertTrue(worker.exited.is_set())

    async def test_peer_reader_runs_before_native_startup(self):
        from identity import worker as module
        reading = asyncio.Event()
        class Peer:
            closed = False
            def __init__(self, reader, writer, methods):
                self.methods = methods
            async def run(self):
                reading.set()
                await self.methods['health'](require_tools=True)
                await self_wait.wait()
        class Writer:
            def close(self):
                pass
        self_wait = asyncio.Event()
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        original_start = worker.start
        async def start(peer):
            await reading.wait()
            await original_start(peer)
            worker._startup_gate = self.gate(worker)
        worker.start = start
        with patch.object(module, 'Peer', Peer), patch.object(module, 'peer_uid',
                return_value=os.getuid() + 1):
            serving = asyncio.create_task(worker.serve_connection(None, Writer()))
            await asyncio.wait_for(reading.wait(), 1)
            while worker.lifecycle_task is None:
                await asyncio.sleep(0)
            await worker.health(require_tools=True)
            self_wait.set()
            await serving
        self.assertIsNone(worker.peer)
        self.assertTrue(self.finalized.is_set())


def patch_hunks(text, wanted):
    """Читать unified hunks, сохраняя порядок повторных секций одного файла."""
    path, old, new = None, None, None
    for line in text.splitlines():
        if line.startswith('--- a/'):
            if old is not None and path in wanted:
                yield path, '\n'.join(old) + '\n', '\n'.join(new) + '\n'
            path, old, new = line[6:], None, None
        elif line.startswith('@@'):
            if old is not None and path in wanted:
                yield path, '\n'.join(old) + '\n', '\n'.join(new) + '\n'
            old, new = [], []
        elif old is not None and line == '':
            old.append('')
            new.append('')
        elif old is not None and line[:1] in (' ', '-', '+') and not line.startswith('+++ '):
            if line[0] != '+':
                old.append(line[1:])
            if line[0] != '-':
                new.append(line[1:])
    if old is not None and path in wanted:
        yield path, '\n'.join(old) + '\n', '\n'.join(new) + '\n'


@unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Pinned public engine required')
class NativeHooksTest(unittest.TestCase):
    def test_independent_os_profile_uses_one_root_for_all_native_helpers(self):
        engine = Path(os.environ['HERMES_TEST_ENGINE'])
        text = (Path(__file__).resolve().parents[2] / 'files/native.patch').read_text()
        selected = {
            'hermes_constants.py': {'get_default_hermes_root', 'profile_name_for_home'},
            'hermes_cli/profiles.py': {'profile_root_for_env_home', '_get_default_hermes_home', '_get_profiles_root'},
            'hermes_cli/service_manager.py': {'_profile_dir_for_gateway_service'},
            'tools/bot_mode_probe.py': {'_hermes_root', '_profile_name'},
            'tui_gateway/change_watcher.py': {'_bot_relay_outbox_sig'},
        }
        scope = {'os': os, 'Path': Path, '_default_hermes_root_memo': None,
                 '_expand_hermes_home': Path,
                 '_get_platform_default_hermes_home': lambda: Path('/tmp/native-default/.hermes'),
                 '_profile_from_service': lambda name: name.removeprefix('gateway-'),
                 'validate_profile_name': lambda name: None}
        constants = ModuleType('hermes_constants')
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'profiles/personal'
            home.mkdir(parents=True)
            scope['get_process_hermes_home'] = lambda: home
            scope['_watcher_home'] = lambda: home
            scope['_bot_relay_outbox_seen'] = 0
            import contextlib
            scope['contextlib'] = contextlib
            for name, wanted in selected.items():
                source = (engine / name).read_text()
                for target, old, new in patch_hunks(text, {name}):
                    old, new = old.rstrip('\n') + '\n', new.rstrip('\n') + '\n'
                    self.assertEqual(source.count(old), 1, name)
                    source = source.replace(old, new, 1)
                functions = [node for node in ast.parse(source).body
                             if isinstance(node, ast.FunctionDef) and node.name in wanted]
                self.assertEqual({node.name for node in functions}, wanted)
                module = ast.Module(body=[ast.ImportFrom(module='__future__',
                    names=[ast.alias(name='annotations')], level=0), *functions], type_ignores=[])
                exec(compile(ast.fix_missing_locations(module), name, 'exec'), scope)
            constants.get_default_hermes_root = scope['get_default_hermes_root']
            constants.profile_name_for_home = scope['profile_name_for_home']
            with patch.dict(sys.modules, {'hermes_constants': constants}), patch.dict(
                    os.environ, {'BRAI_IDENTITY_MODE': 'worker', 'HERMES_HOME': str(home)}):
                self.assertEqual(scope['get_default_hermes_root'](), home)
                self.assertEqual(scope['get_default_hermes_root'](home='/foreign/profiles/other'), home)
                self.assertEqual(scope['_get_profiles_root'](), home / 'profiles')
                self.assertEqual(scope['profile_root_for_env_home'](str(home), Path('/foreign')), home)
                self.assertEqual(scope['_profile_dir_for_gateway_service']('gateway-default'), home)
                self.assertEqual(scope['_hermes_root'](home), home)
                self.assertEqual(scope['_profile_name'](home), 'default')
                def inside_only(path):
                    self.assertEqual(path, home / 'bot_relay/outbox')
                    return iter(())
                with patch.object(Path, 'iterdir', inside_only):
                    self.assertIsNone(scope['_bot_relay_outbox_sig']())
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'ordinary', 'HERMES_HOME': str(home)}):
                self.assertEqual(scope['get_default_hermes_root'](), home.parent.parent)
                self.assertEqual(scope['profile_root_for_env_home'](str(home), Path('/foreign')), home.parent.parent)

    def test_hosted_room_database_stays_inside_independent_os_home(self):
        engine = Path(os.environ['HERMES_TEST_ENGINE'])
        source = (engine / 'gateway/hosted_rooms.py').read_text()
        text = (Path(__file__).resolve().parents[2] / 'files/native.patch').read_text()
        for name, old, new in patch_hunks(text, {'gateway/hosted_rooms.py'}):
            self.assertEqual(source.count(old), 1)
            source = source.replace(old, new, 1)
        tree = ast.parse(source)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'default_db_path')
        module = ast.Module(body=[function], type_ignores=[])
        scope = {'Path': Path}
        exec(compile(ast.fix_missing_locations(module), 'hosted room path', 'exec'), scope)
        constants = ModuleType('hermes_constants')
        home = Path('/var/lib/brai-identity/dev/profiles/personal')
        constants.get_hermes_home = lambda: home
        with patch.dict(sys.modules, {'hermes_constants': constants}):
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
                self.assertEqual(scope['default_db_path'](), home / 'shared-state.db')
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
                self.assertEqual(scope['default_db_path'](), home.parent.parent / 'shared-state.db')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(scope['default_db_path'](), home.parent.parent / 'shared-state.db')
                home = Path('/tmp/standalone-hermes')
                self.assertEqual(scope['default_db_path'](), home / 'shared-state.db')

    def test_native_patch_reconstructs_base_and_preserves_owner_scope(self):
        engine = Path(os.environ['HERMES_TEST_ENGINE'])
        native_patch = (Path(__file__).resolve().parents[1] / 'native.patch').read_text()
        marker = '\n--- a/gateway/run.py\n+++ b/gateway/run.py\n@@ -1607,'
        previous = native_patch.split(marker, 1)[0] + '\n'
        wanted = {'gateway/run.py', 'gateway/run_adapters.py', 'gateway/slash_commands.py'}
        installed = {name: (engine / name).read_text() for name in wanted}
        base = dict(installed)
        for name, old, new in reversed(list(patch_hunks(previous, wanted))):
            self.assertEqual(base[name].count(new), 1, (name, new[:100]))
            base[name] = base[name].replace(new, old, 1)
        for name, old, new in patch_hunks(native_patch, wanted):
            self.assertEqual(base[name].count(old), 1, (name, old[:100]))
            base[name] = base[name].replace(old, new, 1)
        for name, source in base.items():
            compile(source, name, 'exec')
        tree = ast.parse(base['gateway/run.py'])
        cron = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == '_cron_tick_profile_homes')
        entry = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                     and node.name == 'start_gateway')
        module = ast.Module(body=[ast.ImportFrom(module='__future__',
            names=[ast.alias(name='annotations')], level=0), cron, entry], type_ignores=[])
        scope = {'os': os, 'Path': Path, '_multiplex_profile_homes':
                 lambda config: self.fail('Worker must never enumerate sibling homes')}
        exec(compile(ast.fix_missing_locations(module), 'native lifecycle hooks', 'exec'), scope)
        signature = inspect.signature(scope['start_gateway'])
        for name in ('runner_factory', 'startup_gate', 'operational_ready'):
            self.assertIn(name, signature.parameters)
        profiles = ModuleType('hermes_cli.profiles')
        profiles.get_active_profile_name = lambda: 'personal'
        profiles.get_profile_dir = lambda name: self.fail('Sibling profile resolution')
        constants = ModuleType('hermes_constants')
        constants.get_process_hermes_home = lambda: Path('/owner-only')
        with patch.dict(sys.modules, {'hermes_cli.profiles': profiles,
                                      'hermes_constants': constants}), patch.dict(
                                          os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            self.assertEqual(scope['_cron_tick_profile_homes'](NS()),
                             [('personal', Path('/owner-only'))])
