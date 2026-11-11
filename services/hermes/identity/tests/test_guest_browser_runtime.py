# ABOUTME: Проверяет гостевой browser sandbox и отдельный сетевой выход.
# ABOUTME: Не запускает systemd или реальный Chrome.
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.browser import browser_identity, browser_unit
from identity.profiles import native_profile, profile_for_user, worker_unit


class GuestBrowserTest(unittest.TestCase):
    def profile(self, role='guest'):
        return profile_for_user({'id': 'user-a', 'role': role,
            'profileId': '11111111-1111-4111-8111-111111111111',
            'telegramId': '123', 'status': 'provisioning'},
            profile_root='/var/lib/brai-dev/identity/profiles')

    def test_guest_chrome_has_only_its_own_home_and_restricted_proxy(self):
        profile = self.profile()
        ident = browser_identity(profile)
        self.assertRegex(ident['username'], r'^braib-[0-9a-f]{20}$')
        self.assertEqual(ident['home'], '/var/lib/brai-dev/identity/browser-guests/' + profile['profileId'])
        unit = browser_unit(profile, chrome_root='/software/chrome')
        self.assertIn('User=' + ident['username'] + '\n', unit)
        self.assertIn('Group=' + ident['username'] + '\n', unit)
        self.assertIn('BindPaths=' + ident['home'] + '\n', unit)
        self.assertNotIn(profile['home'], unit)
        self.assertIn('ProtectProc=invisible', unit)
        self.assertIn('ProcSubset=pid', unit)
        self.assertIn('--disable-extensions', unit)
        self.assertIn('--proxy-server=http://127.0.0.1:18081', unit)
        self.assertIn('--proxy-bypass-list=<-loopback>', unit)
        self.assertNotIn('127.0.0.1:18080', unit)

    def test_guest_worker_uses_readonly_config_and_dedicated_socket(self):
        profile = self.profile()
        unit = worker_unit(profile, engine_root='/software/engine', runtime_root='/software/runtime',
            python='/software/python/bin/python3', ingress_uid=995, broker_socket='/run/broker.sock',
            memory_socket='/run/memory.sock', egress_socket='/run/egress.sock')
        self.assertIn('Wants=brai-hermes-dev-browser-' + profile['profileId'], unit)
        self.assertIn('BindReadOnlyPaths=/run/egress.sock.browser:/run/brai-profile/browser-egress.sock', unit)
        self.assertIn('Environment=AGENT_BROWSER_CONFIG=/opt/brai-profile/browser-defaults.json', unit)
        config = native_profile(profile, instructions_root='/software/instructions', model='fixture')
        self.assertEqual(config['browser'], {'backend': 'off', 'cdp_url': 'http://127.0.0.1:19364'})
        self.assertEqual(config['web']['search_backend'], 'codex-cli')

    def test_ordinary_browser_identity_unchanged(self):
        profile = self.profile('user')
        self.assertEqual(browser_identity(profile), {'username': profile['username'],
            'home': profile['home'], 'browser': profile['home'] + '/browser'})
        self.assertIn('--proxy-server=http://127.0.0.1:18080', browser_unit(profile, chrome_root='/chrome'))


if __name__ == '__main__':
    unittest.main()
