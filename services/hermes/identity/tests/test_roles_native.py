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


if __name__ == '__main__':
    unittest.main(verbosity=2)
