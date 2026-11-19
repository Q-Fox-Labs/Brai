# ABOUTME: Проверяет конфигурацию личного Kitesurf и публичного relay.
# ABOUTME: Не создаёт аккаунтов и не изменяет действующие службы.
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.kitesurf import units
from identity.profiles import profile_for_user, worker_unit


class KitesurfUnitsTests(unittest.TestCase):
    def setUp(self):
        self.profile = profile_for_user({'id': 'synthetic', 'role': 'user',
            'profileId': '11111111-1111-4111-8111-111111111111',
            'telegramId': '123', 'status': 'provisioning'}, profile_root='/profiles')
        self.settings = dict(runtime_root='/software/runtime', software_root='/software/kitesurf',
            node_root='/software/node', python='/software/python/bin/python3',
            browser_egress='/run/brai/browser.sock', instance='dev')

    def test_private_engine_and_profile_uid_public_relay(self):
        result = units(self.profile, **self.settings)
        engine, relay = result['engineUnit'], result['relayUnit']
        self.assertIn('User=' + result['browserUser'], engine)
        self.assertIn('Group=' + self.profile['username'], engine)
        self.assertIn('PrivateNetwork=yes', engine)
        self.assertIn('RuntimeDirectoryPreserve=yes', engine)
        self.assertNotIn('/profiles', engine)
        self.assertIn('JoinsNamespaceOf=' + result['engineName'], relay)
        self.assertIn('User=' + self.profile['username'], relay)
        self.assertIn('/run/brai-profile/browser-egress.sock --port 18081', relay)
        self.assertIn('TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro', engine)
        self.assertIn('TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro', relay)

    def test_worker_joins_only_chrome_network_and_receives_kitesurf_socket(self):
        result = units(self.profile, **self.settings)
        unit = worker_unit(self.profile, engine_root='/software/engine', runtime_root='/software/runtime',
            python='/software/python/bin/python3', ingress_uid=1000,
            broker_socket='/run/control.sock', egress_socket='/run/egress.sock',
            memory_socket='/run/memory.sock', kitesurf_socket=result['cdpSocket'])
        self.assertIn('After=' + result['engineName'] + ' ' + result['relayName'], unit)
        self.assertIn('Wants=' + result['engineName'] + ' ' + result['relayName'], unit)
        self.assertNotIn('BindsTo=' + result['engineName'], unit)
        self.assertNotIn('Requires=' + result['engineName'], unit)
        self.assertIn('BindReadOnlyPaths=-' + str(Path(result['cdpSocket']).parent) + ':/run/brai-profile/kitesurf', unit)
        self.assertNotIn('JoinsNamespaceOf=' + result['engineName'], unit)

    def test_invalid_identity_or_paths_are_rejected(self):
        with self.assertRaises(ValueError):
            units({**self.profile, 'username': 'root'}, **self.settings)
        with self.assertRaises(ValueError):
            units(self.profile, **{**self.settings, 'software_root': '/software/../home'})


if __name__ == '__main__':
    unittest.main()
