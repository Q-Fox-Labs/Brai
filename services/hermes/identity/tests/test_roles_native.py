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


if __name__ == '__main__':
    unittest.main(verbosity=2)
