# ABOUTME: Проверяет динамическое разрешение cron-вызовов по текущей роли Auth.
# ABOUTME: Не запускает scheduler; ошибка Auth и неизвестная роль запрещают новый tick.
import importlib.util
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[4]


class CronPermissionTests(unittest.TestCase):
    def load_policy(self, state, fail=False):
        calls = []

        def broker(method, params):
            calls.append(method)
            if fail:
                raise ConnectionError("Auth unavailable")
            if method != "permissions.get":
                raise AssertionError(method)
            return dict(state)

        package = types.ModuleType("identity")
        package.__path__ = []
        client = types.ModuleType("identity.tool_client")
        client.broker_call = broker
        sys.modules.update({"identity": package, "identity.tool_client": client})
        spec = importlib.util.spec_from_file_location(
            "identity.native_policy", ROOT / "services/hermes/identity/native_policy.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, calls

    def test_active_roles_allow_new_cron_ticks_and_recheck_current_role(self):
        state = {"role": "user", "generation": 7}
        policy, calls = self.load_policy(state)
        self.assertTrue(policy.scheduler_permitted())
        self.assertEqual(calls, ["permissions.get"])

        state.update(role="guest", generation=8)
        self.assertFalse(policy.scheduler_permitted())
        self.assertEqual(calls, ["permissions.get", "permissions.get"])

        for role in ("creator", "admin", "user"):
            with self.subTest(role=role):
                state.update(role=role, generation=9)
                self.assertTrue(policy.scheduler_permitted())

    def test_unknown_role_and_auth_failure_deny_new_cron_ticks(self):
        policy, _ = self.load_policy({"role": "future-role", "generation": 3})
        self.assertFalse(policy.scheduler_permitted())
        denied, _ = self.load_policy({}, fail=True)
        self.assertFalse(denied.scheduler_permitted())


if __name__ == "__main__":
    unittest.main(verbosity=2)
