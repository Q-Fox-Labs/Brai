# ABOUTME: Проверяет границы native PROD, обязательные client inputs и порядок приёмки.
# ABOUTME: Не запускает службы, сеть, OAuth или рабочую память.
import base64
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

FILES = Path(__file__).resolve().parents[1] / 'roles/brai_install/files'
sys.path.insert(0, str(FILES))
import native_hermes as native
import partition
import install_server


class NativeHermes(unittest.TestCase):
    def test_descriptor_cannot_silently_select_dev_state(self):
        for shared in [False, True]:
            spec = native.descriptor(shared)
            native.validate(spec)
            self.assertEqual(spec['profile'], '/var/lib/brai/hermes')
            self.assertEqual(spec['software']['custom'], '/var/lib/brai/hermes/usercustom/hermescustom')
            for key, value in [('profile', '/var/lib/brai-dev/hermes'), ('ports', {'memos': 19361})]:
                broken = copy.deepcopy(spec); broken[key] = value
                with self.assertRaisesRegex(ValueError, 'DESCRIPTOR_INVALID'): native.validate(broken)

    def test_client_missing_inputs_fail_before_installer_prepares_documents(self):
        manifest = {'native_runtimes': {'hermes': native.descriptor()}}
        for values in [{}, {'native_hermes_auth': {'content': 'e30='}},
                       {'native_hermes_token_environment': 'BOT_TOKEN=fixture\n'}]:
            with patch.object(install_server.Installer, 'prepare_documents') as prepare:
                with self.assertRaisesRegex(ValueError, 'CLIENT_AUTH_AND_BOT_INPUT_REQUIRED'):
                    install_server.Installer(manifest, values)
                prepare.assert_not_called()

    def test_client_auth_requires_own_canonical_oauth_shape(self):
        encode = lambda value: base64.b64encode(json.dumps(value).encode()).decode()
        values = {'native_hermes_auth': {'content': encode({'tokens': {
            'access_token': 'fixture', 'refresh_token': 'fixture', 'account_id': 'fixture'}})},
            'native_hermes_token_environment': 'TELEGRAM_BOT_TOKEN=fixture\n'}
        native.validate_client_access(values)
        values['native_hermes_auth']['content'] = encode({'api_key': 'fixture'})
        with self.assertRaisesRegex(ValueError, 'CANONICAL_AUTH_INVALID'):native.validate_client_access(values)

    def test_private_file_rejects_links_and_broadened_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'input.json'; path.write_text('{}'); path.chmod(0o600)
            self.assertEqual(native.private(path, os.getuid(), os.getgid()), b'{}')
            path.chmod(0o640)
            with self.assertRaisesRegex(ValueError, 'PRIVATE_METADATA'):native.private(path, os.getuid(), os.getgid())
            path.chmod(0o600); link = path.with_name('hardlink');os.link(path, link)
            with self.assertRaisesRegex(ValueError, 'PRIVATE_METADATA'):native.private(path, os.getuid(), os.getgid())
            link.unlink();link.symlink_to(path)
            with self.assertRaises(OSError):native.private(link, os.getuid(), os.getgid())

    def test_native_gateway_uses_one_owner_and_explicit_terminal_cwd(self):
        spec = native.descriptor(True); units = native.units(spec, '/native/python')
        gateway = units['brai-hermes-production.service']
        self.assertIn('Environment=CODEX_HOME=' + spec['home'] + '/.codex\n', gateway)
        self.assertIn('Environment=TERMINAL_CWD=/var/lib/brai/hermes/workspace\n', gateway)
        self.assertIn('EnvironmentFile=' + spec['tokenEnvironmentFile'], gateway)
        self.assertIn('ExecStart=/usr/bin/python3 /etc/brai/hermes/gateway.py', gateway)
        self.assertNotIn('ExecStart=/usr/local/bin/node', gateway)
        self.assertNotIn('--no-sandbox', ''.join(units.values()))
        self.assertIn('/var/lib/brai/hermes/memos/bridge-venv/bin/python',
                      units['brai-hermes-production-codex-bridge.service'])

    def test_prepare_activation_does_not_start_gateway(self):
        spec=native.descriptor();events=[]
        with patch.object(native,'validate_inputs'),patch.object(native,'prepare',return_value=True),\
             patch.object(native,'run',side_effect=lambda argv,**kw:events.append(argv)):
            result=native.operate('prepare',spec,{},start=True)
        self.assertFalse(result['functionalAcceptance'])
        self.assertEqual(len(events),5)
        self.assertTrue(all(argv[-1]!='brai-hermes-production.service' for argv in events))
        memos=SimpleNamespace(activate=lambda:events.append('memory-activated'))
        with patch.object(native,'validate_inputs'),patch.object(native,'verify'),\
             patch.object(native,'memory',return_value=memos),patch.object(native,'run') as run:
            result=native.operate('activate-memory',spec,{})
        self.assertFalse(result['gatewayStarted']);run.assert_not_called()

    def test_product_replaces_shared_dependency_without_relaxing_exclusions(self):
        shared=native.descriptor(True)
        mapping={'nativeRuntime':'hermes','unit':'brai-hermes-production.service',
                 'beforeStartCommand':['/srv/projects/admin/native.py'],
                 'requiredEnvironment':{'HOME':shared['home'],'CODEX_HOME':shared['home']+'/.codex',
                                        'HERMES_ROOT':shared['software']['core']}}
        manifest={'native_runtimes':{'hermes':shared},'networks':{'brai_database_private':{'ipam':[{'Gateway':'172.23.0.1'}]}},
                  'programs':{'brai-hermes-production.service':copy.deepcopy(mapping)},
                  'operator':{'environments':{'prod':{'components':{'hermes':[copy.deepcopy(mapping)]}}}}}
        exclusions=partition.EXCLUDED
        partition.standalone_native(manifest)
        self.assertEqual(manifest['native_runtimes']['hermes'],native.descriptor())
        self.assertEqual(partition.EXCLUDED,exclusions)
        self.assertNotIn('beforeStartCommand',manifest['programs']['brai-hermes-production.service'])
        self.assertFalse(any(value in json.dumps(manifest) for value in exclusions))
        manifest['networks']['brai_database_private']['ipam'][0]['Gateway']='172.23.42.1'
        partition.standalone_native(manifest)
        self.assertEqual(manifest['native_runtimes']['hermes']['gatewayHost'],'172.23.42.1')

    def test_accepted_telegram_overlays_are_mandatory(self):
        spec=native.descriptor()
        self.assertEqual(len(spec['coreOverlays']),2)
        spec['coreOverlays']=[]
        with self.assertRaisesRegex(ValueError,'DESCRIPTOR_INVALID'):native.validate(spec)


if __name__ == '__main__': unittest.main()
