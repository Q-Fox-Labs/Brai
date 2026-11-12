# ABOUTME: Независимо проверяет отзыв прав между разрешением и native dispatch.
# ABOUTME: Использует настоящий модуль политики с подменой внешних registry/Auth портов.
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[4]


class NativeGuardTests(unittest.TestCase):
    """Проверить эффекты handler, не только скрытие имени инструмента."""

    def load_policy(self, grants, snapshots, handler=None):
        """Загрузить неизменённый candidate с отдельными ответами портов."""
        calls = []
        class Registry:
            def get_definitions(self, names, quiet=False):
                return list(names)
            def dispatch(self, name, args, **kwargs):
                calls.append(name)
                if handler:
                    handler()
                return 'EXECUTED'
        def broker(method, params):
            if method == 'permissions.bootstrap':
                return {'role':'user','generation':1,'backgroundsSuspended':False,'staged':False}
            if method == 'native.authorize':
                return dict(grants.pop(0))
            if method == 'permissions.get':
                return dict(snapshots.pop(0))
            raise AssertionError(method)
        package = types.ModuleType('identity'); package.__path__ = []
        client = types.ModuleType('identity.tool_client'); client.broker_call = broker
        registry = types.ModuleType('tools.registry'); registry.ToolRegistry = Registry
        toolspkg = types.ModuleType('tools'); toolspkg.__path__ = []
        sys.modules.update({'identity':package,'identity.tool_client':client,'tools':toolspkg,'tools.registry':registry})
        spec = importlib.util.spec_from_file_location('identity.native_policy', ROOT / 'services/hermes/identity/native_policy.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.install_executor_guard = lambda: None
        module.install()
        return Registry(), calls

    def test_downgrade_between_authorize_and_principal_never_executes(self):
        registry, calls = self.load_policy(
            [{'allowed':True,'role':'user','generation':1}],
            [{'role':'guest','generation':2},{'role':'guest','generation':2}])
        result = registry.dispatch('terminal', {})
        self.assertEqual(calls, [], 'terminal executed after guest snapshot')
        self.assertIn('error', json.loads(result))

    def test_denied_direct_name_never_executes(self):
        registry, calls = self.load_policy([{'allowed':False,'role':'guest','generation':2}], [{'role':'guest','generation':2}])
        self.assertIn('error', json.loads(registry.dispatch('code_execution', {})))
        self.assertEqual(calls, [])

    def test_generation_change_after_execution_hides_result(self):
        registry, calls = self.load_policy(
            [{'allowed':True,'role':'user','generation':1}],
            [{'role':'user','generation':1},{'role':'user','generation':2}])
        self.assertIn('error', json.loads(registry.dispatch('terminal', {})))
        self.assertEqual(calls, ['terminal'])

    def test_stable_allowed_request_executes(self):
        registry, calls = self.load_policy(
            [{'allowed':True,'role':'user','generation':1}],
            [{'role':'user','generation':1},{'role':'user','generation':1}])
        self.assertEqual(registry.dispatch('terminal', {}), 'EXECUTED')
        self.assertEqual(calls, ['terminal'])


class InlineExecutorTests(unittest.TestCase):
    """Inline и direct обходы registry получают собственную проверку перед эффектами."""

    def policy(self, grants, snapshots):
        from unittest.mock import patch
        effects = []
        package = types.ModuleType('identity'); package.__path__ = []
        client = types.ModuleType('identity.tool_client')
        client.broker_call = lambda name, args: grants.pop(0) if name == 'native.authorize' else snapshots.pop(0)
        agent = types.ModuleType('agent'); agent.__path__ = []
        common = types.ModuleType('agent.tool_executor')
        direct = types.ModuleType('agent.agent_runtime_helpers')
        def execute(agent, state, ref, **kwargs):
            kwargs['begin_execution'](); return kwargs['execute']()
        common._dispatch_authorized_once = execute
        direct.invoke_tool = lambda *a, **k: effects.append('direct') or 'RESULT'
        direct.repair_tool_call = lambda agent, name: 'mcp__brai__files_list'
        inline = types.ModuleType('agent.inline_tool_executors')
        inline.resolve_invoke_tool_executor = lambda agent, name: None
        agent.tool_executor, agent.agent_runtime_helpers, agent.inline_tool_executors = common, direct, inline
        with patch.dict(sys.modules, {'identity': package, 'identity.tool_client': client, 'agent': agent,
                                     'agent.tool_executor': common, 'agent.agent_runtime_helpers': direct, 'agent.inline_tool_executors': inline}):
            spec = importlib.util.spec_from_file_location('identity.native_policy', ROOT / 'services/hermes/identity/native_policy.py')
            policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
            policy.install_executor_guard()
        self.loaded_policy = policy
        return common, direct, effects

    def test_denied_inline_and_direct_do_not_enter_executor(self):
        common, direct, effects = self.policy([{'allowed': False}] * 2, [{'role': 'guest', 'generation': 2}] * 2)
        state, ref, begun = types.SimpleNamespace(blocked=False), types.SimpleNamespace(name='delegate_task'), []
        result = common._dispatch_authorized_once(None, state, ref, execute=None, scope_block=None,
            display_index=0, begin_execution=lambda: begun.append(True), authorization_gate=None)
        self.assertIn('error', json.loads(result)); self.assertTrue(state.blocked)
        self.assertEqual(begun, [True]); self.assertEqual(effects, [])
        self.assertIn('error', json.loads(direct.invoke_tool(None, 'manage_connections', '{}')))
        self.assertEqual(effects, [])

    def test_guest_unknown_name_does_not_repair_into_allowed_operation(self):
        _, direct, effects = self.policy([], [])
        self.loaded_policy._guest = True
        self.assertIsNone(direct.repair_tool_call(None, 'mcp__brai__brai_login'))
        self.assertEqual(effects, [])
        self.loaded_policy._guest = False
        self.assertEqual(direct.repair_tool_call(None, 'mcp__brai__brai_login'), 'mcp__brai__files_list')

    def test_nested_call_cannot_replace_inherited_generation(self):
        common, direct, effects = self.policy(
            [{'allowed': True, 'role': 'user', 'generation': 2}] * 2,
            [{'role': 'user', 'generation': 2}] * 2)
        token = self.loaded_policy._execution_state.set({'role': 'user', 'generation': 1})
        state, begun = types.SimpleNamespace(blocked=False), []
        try:
            result = common._dispatch_authorized_once(None, state, types.SimpleNamespace(name='delegate_task'),
                execute=lambda: effects.append('forbidden'), scope_block=None, display_index=0,
                begin_execution=lambda: begun.append(True), authorization_gate=None)
            self.assertIn('error', json.loads(result)); self.assertTrue(state.blocked)
            self.assertIn('error', json.loads(direct.invoke_tool(None, 'delegate_task', '{}')))
            self.assertEqual(effects, []); self.assertEqual(begun, [True])
        finally:
            self.loaded_policy._execution_state.reset(token)

    def test_revocation_during_native_preparation_blocks_late_execute(self):
        common, _, effects = self.policy(
            [{'allowed': True, 'role': 'user', 'generation': 1}, {'allowed': False}],
            [{'role': 'user', 'generation': 1}, {'role': 'guest', 'generation': 2}])
        state, begun = types.SimpleNamespace(blocked=False), []
        result = common._dispatch_authorized_once(None, state, types.SimpleNamespace(name='delegate_task'),
            execute=lambda: effects.append('forbidden'), scope_block=None, display_index=0,
            begin_execution=lambda: begun.append(True), authorization_gate=None)
        self.assertIn('error', json.loads(result)); self.assertTrue(state.blocked)
        self.assertEqual(begun, [True]); self.assertEqual(effects, [])

    def test_authorized_inline_executes_once_and_checks_generation_afterwards(self):
        common, _, effects = self.policy([{'allowed': True, 'role': 'user', 'generation': 1}] * 2,
            [{'role': 'user', 'generation': 1}] * 2 + [{'role': 'guest', 'generation': 2}])
        state, begun = types.SimpleNamespace(blocked=False), []
        result = common._dispatch_authorized_once(None, state, types.SimpleNamespace(name='delegate_task'),
            execute=lambda: effects.append('common') or 'RESULT', scope_block=None, display_index=0, begin_execution=lambda: begun.append(True), authorization_gate=None)
        self.assertIn('error', json.loads(result)); self.assertTrue(state.blocked)
        self.assertEqual(begun, [True]); self.assertEqual(effects, ['common'])


class ExclusiveLoaderTests(unittest.TestCase):
    """HOME/проект/entrypoints не становятся кодом гостевого trusted startup."""

    def test_all_exclusive_groups_use_canonical_bundle_until_active(self):
        from unittest.mock import patch
        active, effects = {'value': False}, []
        product, home = Path('/trusted/product'), Path('/untrusted/home')
        package = types.ModuleType('identity'); package.__path__ = []
        client = types.ModuleType('identity.tool_client'); client.broker_call = lambda *a: None
        plugins = types.ModuleType('plugins'); plugins.__path__ = []
        loader = types.ModuleType('plugins.plugin_loader'); loader.user_plugins_dir = lambda: home / 'plugins'
        plugins.plugin_loader = loader
        providers = types.ModuleType('providers')
        providers._user_plugins_dir = lambda: home / 'model-providers'
        providers._installed_plugins_dir = lambda: home / 'plugins'
        providers._discover_entry_point_providers = lambda: effects.append('model entrypoint')
        modules = {'identity': package, 'identity.tool_client': client, 'plugins': plugins,
                   'plugins.plugin_loader': loader, 'providers': providers}
        groups = {}
        for group, iterator in (('memory', '_iter_provider_dirs'), ('context_engine', '_iter_engine_dirs'),
                                ('cron_providers', '_iter_provider_dirs'), ('computer_use', '_iter_provider_dirs')):
            module = types.ModuleType('plugins.' + group)
            bundle = Path('/trusted/native/plugins') / group
            module.__file__ = str(bundle / '__init__.py')
            setattr(module, iterator, lambda bundle=bundle: [('builtin', bundle / 'builtin'), ('evil', home / 'evil')])
            groups[group] = (module, iterator, bundle)
            modules[module.__name__] = module
        memory = groups['memory'][0]
        memory._get_user_plugins_dir = loader.user_plugins_dir
        memory._iter_entry_points = lambda: ['untrusted entrypoint']
        memory.find_provider_dir = lambda name: home / name
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('identity.native_policy', ROOT / 'services/hermes/identity/native_policy.py')
            policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
            policy.active_configuration = lambda: active['value']
            policy.restrict_exclusive_plugins(product)
            self.assertIsNone(loader.user_plugins_dir())
            self.assertIsNone(memory._get_user_plugins_dir())
            self.assertEqual(memory._iter_entry_points(), [])
            self.assertIsNone(providers._user_plugins_dir())
            self.assertIsNone(providers._installed_plugins_dir())
            providers._discover_entry_point_providers()
            self.assertEqual(effects, [])
            for group, (module, iterator, bundle) in groups.items():
                expected = [('builtin', bundle / 'builtin')]
                if group == 'memory':
                    expected.append(('memos-rest', product / 'extensions/plugins/memos-rest'))
                self.assertEqual(getattr(module, iterator)(), expected)
            self.assertEqual(memory.find_provider_dir('memos-rest'), product / 'extensions/plugins/memos-rest')
            self.assertIsNone(memory.find_provider_dir('evil'))
            # Обычный active user получает прежнюю конфигурацию без перезапуска guard.
            active['value'] = True
            self.assertEqual(loader.user_plugins_dir(), home / 'plugins')
            self.assertEqual(memory.find_provider_dir('memos-rest'), home / 'memos-rest')
            self.assertEqual(memory._iter_entry_points(), ['untrusted entrypoint'])
            providers._discover_entry_point_providers()
            self.assertEqual(effects, ['model entrypoint'])
            for module, iterator, _bundle in groups.values():
                self.assertEqual(len(getattr(module, iterator)()), 2)


class DeferredStartupTests(unittest.IsolatedAsyncioTestCase):
    """Ordinary startup возвращается после Auth; sticky old jobs остаются закрытыми."""

    async def exercise(self, sticky):
        from unittest.mock import patch
        active, effects = {'value': False}, []
        class Runner:
            async def _start_recover_previous_run(self): effects.append('recover')
            async def _start_finish_wiring(self, count): effects.append(('finish', count))
            def _start_spawn_background_watchers(self): effects.append('watchers')
            def _spawn_reconnect_watcher(self): effects.append('reconnect')
            def _subscribe_plugin_rewire(self, manager): effects.append('subscribe')
            def _rewire_plugin_handlers(self): effects.append('rewire')
        class Registry:
            def get_definitions(self, names, quiet=False): return names
            def dispatch(self, name, args, **kwargs): return '{}'
        class Manager:
            def _collect_directory_manifests(self): return ['HOME']
            def _scan_entry_points(self): return []
            def discover_and_load(self, force=False): effects.append('reload' if force else 'trusted')
        manager = Manager()
        package = types.ModuleType('identity'); package.__path__ = []
        client = types.ModuleType('identity.tool_client')
        def broker(method, args):
            if method == 'permissions.bootstrap':
                return {'role': 'user', 'generation': 4, 'staged': True, 'backgroundsSuspended': sticky}
            if method == 'permissions.get' and active['value']:
                return {'role': 'user', 'generation': 4}
            raise PermissionError('not active')
        client.broker_call = broker
        hermes = types.ModuleType('hermes_cli'); hermes.__path__ = []
        config = types.ModuleType('hermes_cli.config')
        config.load_config = config.load_config_readonly = lambda *a, **k: {'source': 'HOME'}
        plugins = types.ModuleType('hermes_cli.plugins'); plugins.PluginManager = Manager
        plugins.get_plugin_manager = lambda: manager
        plugins.get_bundled_plugins_dir = lambda: Path('/trusted/native/plugins')
        discovery = types.ModuleType('hermes_cli.plugins_discovery'); discovery.scan_directory = lambda *a, **k: []
        tools_config = types.ModuleType('hermes_cli.tools_config')
        tools_config.load_config = config.load_config
        effective = types.ModuleType('hermes_cli.config_effective')
        effective.load_user_config_effective = lambda *a, **k: {'source': 'HOME'}
        gateway = types.ModuleType('gateway'); gateway.__path__ = []
        raw = types.ModuleType('gateway.config_loader')
        raw.read_yaml_layers = lambda *a, **k: {'source': 'HOME'}
        raw.load_legacy_gateway_json = lambda *a, **k: {'legacy': True}
        run = types.ModuleType('gateway.run'); run.GatewayRunner = Runner
        tools = types.ModuleType('tools'); tools.__path__ = []
        registry = types.ModuleType('tools.registry'); registry.ToolRegistry = Registry
        async def attach(adapter): effects.append('attach')
        modules = {'identity': package, 'identity.tool_client': client, 'hermes_cli': hermes,
                   'hermes_cli.config': config, 'hermes_cli.tools_config': tools_config, 'hermes_cli.config_effective': effective, 'hermes_cli.plugins': plugins,
                   'hermes_cli.plugins_discovery': discovery, 'gateway': gateway, 'gateway.config_loader': raw, 'gateway.run': run,
                   'tools': tools, 'tools.registry': registry,
                   '_brai_identity_human': types.SimpleNamespace(attach=attach)}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('identity.native_policy', ROOT / 'services/hermes/identity/native_policy.py')
            policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
            policy.protected_config = lambda path: {'source': 'trusted'}
            policy.restrict_exclusive_plugins = lambda product: None
            policy.install_executor_guard = lambda: None
            policy.install()
            runner = Runner()
            await runner._start_recover_previous_run()
            await runner._start_finish_wiring(1)
            runner._start_spawn_background_watchers()
            self.assertEqual(effects, ['trusted', 'reconnect'] if sticky else ['trusted'])
            self.assertEqual(policy.backgrounds_suspended(), sticky)
            self.assertEqual(tools_config.load_config()['source'], 'trusted')
            self.assertEqual(effective.load_user_config_effective()['source'], 'trusted')
            self.assertEqual(raw.read_yaml_layers(Path('/untrusted/home'))['source'], 'trusted')
            self.assertEqual(raw.load_legacy_gateway_json(Path('/untrusted/home')), {})
            active['value'] = True
            async def check(): self.assertEqual(policy.principal(), {'role': 'user', 'generation': 4})
            await policy.activate_deferred_startup(runner, object(), check)
            expected = ['trusted', 'reconnect'] if sticky else [
                'trusted', 'reload', 'subscribe', 'rewire', 'attach', 'recover', ('finish', 1), 'watchers']
            self.assertEqual(effects, expected)
            await policy.activate_deferred_startup(runner, object(), check)
            self.assertEqual(effects, expected, 'activation must be idempotent')
            expected_source = 'trusted' if sticky else 'HOME'
            self.assertEqual(config.load_config()['source'], expected_source)
            self.assertEqual(tools_config.load_config()['source'], expected_source)
            self.assertEqual(effective.load_user_config_effective()['source'], expected_source)
            self.assertEqual(raw.read_yaml_layers(Path('/untrusted/home'))['source'], expected_source)
            self.assertEqual(raw.load_legacy_gateway_json(Path('/untrusted/home')), {} if sticky else {'legacy': True})

    async def test_ordinary_user_startup_is_deferred_then_restored_once(self):
        await self.exercise(False)

    async def test_promoted_guest_does_not_restore_old_backgrounds(self):
        await self.exercise(True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
