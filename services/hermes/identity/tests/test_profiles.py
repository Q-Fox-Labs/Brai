# ABOUTME: Проверяет стабильность личных UID-профилей и файловые границы systemd.
# ABOUTME: Не создаёт системных пользователей и не меняет runtime.
"""Контракт чистого ядра provisioning."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.profiles import native_profile, profile_for_user, plan_users, registry, worker_unit
from identity.browser import browser_unit


class ProfileTests(unittest.TestCase):
    """Проверить входы Auth и исключить наследование общей среды."""

    def profile(self):
        return profile_for_user({'id': 'user-a', 'profileId': '11111111-1111-4111-8111-111111111111',
                                 'telegramId': '123', 'status': 'provisioning'},
                                profile_root='/var/lib/brai-dev/identity/profiles')

    def test_invite_retry_preserves_home_epoch_and_account(self):
        self.assertEqual(self.profile(), self.profile())
        self.assertEqual(self.profile()['home'], '/var/lib/brai-dev/identity/profiles/11111111-1111-4111-8111-111111111111')
        self.assertEqual(len(self.profile()['homeScope']), 64)
        self.assertEqual(len(self.profile()['memoryEpoch']), 64)

    def test_model_routes_responses_to_named_local_provider(self):
        value = native_profile(self.profile(), instructions_root='/software/instructions',
                               model='fixture-model')
        self.assertEqual(value['browser'], {'backend': 'browser-use'})
        self.assertEqual(value['model'], {'provider': 'brai-model', 'default': 'fixture-model'})
        self.assertEqual(value['providers']['brai-model'], {
            'base_url': 'http://127.0.0.1:18080/model/v1',
            'transport': 'codex_responses',
        })

    def test_invite_requires_provisioning_and_canonical_telegram(self):
        for field, value in [('status', 'active'), ('telegramId', '00123'), ('telegramId', '-1'),
                             ('profileId', '../profile'), ('id', 'x\nUser=root')]:
            user = {'id': 'user-a', 'profileId': self.profile()['profileId'],
                    'telegramId': '123', 'status': 'provisioning', field: value}
            with self.subTest(field=field), self.assertRaises((ValueError, AttributeError)):
                profile_for_user(user, profile_root='/profiles')

    def test_initial_owner_is_explicit_and_keeps_canonical_id(self):
        value = plan_users('123', 'original-owner', [{'telegramId': '456'}, {'telegramId': '123'}],
                           profile_root='/profiles')
        self.assertEqual(value['profiles'][0]['userId'], 'original-owner')
        self.assertEqual([p['role'] for p in value['profiles']], ['admin', 'user'])
        with self.assertRaises(ValueError):
            plan_users('123', 'original-owner', [{'telegramId': '456'}], profile_root='/profiles')

    def test_worker_unit_hides_shared_state_and_uses_installed_python(self):
        value = worker_unit(self.profile(), engine_root='/software/engine', runtime_root='/software/runtime',
                            python='/software/python/bin/python3.14', ingress_uid=995,
                            broker_socket='/run/broker.sock', memory_socket='/run/memory.sock',
                            egress_socket='/run/egress.sock', instance='dev',
                            site_packages='/software/site-packages', instructions_root='/software/instructions')
        self.assertIn('ExecStart=/opt/brai-profile/python/bin/python3.14 -P -B -m identity.worker', value)
        self.assertIn('PrivateNetwork=yes', value)
        self.assertIn('Environment=BU_CDP_URL=http://127.0.0.1:19364', value)
        self.assertIn('TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro', value)
        self.assertIn('BindPaths=' + self.profile()['home'], value)
        self.assertIn('/software/runtime:/opt/brai-profile/runtime', value)
        self.assertIn('/software/site-packages:/opt/brai-profile/site-packages', value)
        self.assertIn('brai-hermes-dev-identity-broker.service', value)
        self.assertNotIn('EnvironmentFile=', value)
        self.assertNotIn('docker.sock', value)
        self.assertNotIn('\\n', value)

    def test_telegram_sdk_wins_over_runtime_adapter_package(self):
        import os
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            roots = {name: Path(temp) / name for name in ('site', 'engine', 'runtime')}
            for root in roots.values():
                root.mkdir()
            for name, value in (('site', 'sdk'), ('runtime', 'adapter')):
                package = roots[name] / 'telegram'
                package.mkdir()
                (package / '__init__.py').write_text('ORIGIN = ' + repr(value), encoding='utf-8')
            unit = worker_unit(self.profile(), engine_root='/engine', runtime_root='/runtime',
                               python='/python/bin/python', ingress_uid=995,
                               broker_socket='/run/broker', memory_socket='/run/memory',
                               egress_socket='/run/egress', site_packages='/site')
            line = next(line for line in unit.splitlines() if line.startswith('Environment=PYTHONPATH='))
            paths = line.removeprefix('Environment=PYTHONPATH=').split(':')
            mapping = {'/opt/brai-profile/site-packages': str(roots['site']),
                       '/opt/brai-profile/engine': str(roots['engine']),
                       '/opt/brai-profile/runtime/services/hermes': str(roots['runtime'])}
            env = {**os.environ, 'PYTHONPATH': ':'.join(mapping[path] for path in paths)}
            result = subprocess.run([sys.executable, '-P', '-B', '-c',
                                     "import telegram; assert telegram.ORIGIN == 'sdk'"],
                                    cwd=temp, env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_browser_joins_only_own_worker_and_keeps_sandbox(self):
        profile = self.profile()
        value = browser_unit(profile, chrome_root='/software/chrome')
        worker = 'brai-hermes-dev-user-' + profile['profileId'] + '.service'
        self.assertIn('JoinsNamespaceOf=' + worker, value)
        self.assertIn('BindsTo=' + worker, value)
        self.assertIn('User=' + profile['username'], value)
        self.assertIn('TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro', value)
        self.assertIn('BindPaths=' + profile['home'] + '/browser:/var/lib/brai-browser', value)
        self.assertIn('Environment=TMPDIR=/var/lib/brai-browser/tmp', value)
        self.assertIn('RestrictNamespaces=user pid net', value)
        self.assertIn('--proxy-server=http://127.0.0.1:18080', value)
        self.assertIn('--proxy-bypass-list=<-loopback>', value)
        self.assertNotIn('--no-sandbox', value)
        self.assertNotIn('docker.sock', value)
        with self.assertRaises(ValueError):
            browser_unit(profile, chrome_root='/software/chrome\\nUser=root')

    def test_worker_unit_rejects_operator_path_injection(self):
        with self.assertRaises(ValueError):
            worker_unit(self.profile(), engine_root='/engine\nEnvironment=KEY=bad',
                        runtime_root='/runtime', python='/python/bin/python', ingress_uid=995,
                        broker_socket='/run/broker', memory_socket='/run/memory', egress_socket='/run/egress')

    def test_real_telegram_registration_uses_only_identity_factory(self):
        import importlib.util
        import os
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        path = Path(__file__).resolve().parents[2] / 'telegram/__init__.py'
        spec = importlib.util.spec_from_file_location('brai_identity_telegram_registration', path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        register = Mock()
        context = object()
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}, clear=True), \
                patch.dict(sys.modules, {'identity.native_ingress': SimpleNamespace(register=register)}), \
                patch.object(module.Config, 'from_env', side_effect=AssertionError('legacy owner config read')), \
                patch.object(module, 'TelegramPlugin', side_effect=AssertionError('legacy plugin constructed')):
            module.register(context)
        register.assert_called_once_with(context)

    def test_parent_runner_rejects_legacy_mode_before_native_import(self):
        import os
        from unittest.mock import patch
        from identity.parent_runner import main
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'legacy'}, clear=True):
            with self.assertRaises(PermissionError):
                main()

    def test_registry_requires_real_separate_accounts(self):
        p = self.profile()
        value = registry({'profiles': [p]}, {p['username']: {'uid': 1234, 'gid': 1234}}, active=True)
        self.assertEqual(value['profiles']['1234']['workerSocket'], p['home'] + '/control/worker.sock')
        self.assertEqual(value['profiles']['1234']['status'], 'active')
        with self.assertRaises(ValueError):
            registry({'profiles': [p]}, {p['username']: {'uid': 0, 'gid': 1234}})


if __name__ == '__main__':
    unittest.main()
