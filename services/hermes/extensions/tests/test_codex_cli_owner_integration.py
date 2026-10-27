# ABOUTME: Проверяет реальный native main/aux/image routing с единственным credential owner.
# ABOUTME: Синтетический access и stale pool используются без сети и живого профиля.
"""Run against a patched pinned core via PYTHONPATH and its installed test interpreter."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

from hermes_cli import auth_codex, runtime_provider, codex_cli_owner, config
from agent import auxiliary_client, codex_headers


class NativeParityTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.home=Path(self.directory.name)
        (self.home/'config.yaml').write_text(json.dumps({'auth':{'adopt_external_logins':False,'codex_credential_owner':'codex-cli'},'model':{'provider':'openai-codex','default':'fixture-model'}}))
        patch=mock.patch.dict(os.environ,{'HERMES_HOME':str(self.home)});patch.start();self.addCleanup(patch.stop)
        import base64
        claims={'exp':int(time.time())+3600,'https://api.openai.com/auth':{'chatgpt_account_id':'fixture-owner'}}
        self.token='header.'+base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')+'.signature'
        patch=mock.patch.object(codex_cli_owner,'snapshot',return_value={'api_key':self.token,'account_id':'fixture-owner','expires_at':claims['exp']});patch.start();self.addCleanup(patch.stop)

    def test_main_aux_image_share_token_host_and_account_headers_despite_stale_pool(self):
        self.assertTrue(codex_cli_owner.enabled())
        with mock.patch.object(runtime_provider,'load_pool',side_effect=AssertionError('stale pool must not be read')), \
             mock.patch.object(auxiliary_client,'_select_pool_entry',side_effect=AssertionError('stale pool must not be read')), \
             mock.patch('hermes_cli.auth._read_codex_tokens',side_effect=AssertionError('no native auth store')):
            self.assertIsNone(runtime_provider._resolve_from_pool('openai-codex','openai-codex',{},None,None,None))
            main=auth_codex.resolve_codex_runtime_credentials()
            auxiliary=auxiliary_client._resolve_codex_credential_and_base()
            source=Path(auth_codex.__file__).parents[1]/'plugins/image_gen/openai-codex/__init__.py'
            spec=importlib.util.spec_from_file_location('fixture_codex_image',source)
            image=importlib.util.module_from_spec(spec);spec.loader.exec_module(image)
            self.assertEqual(image._read_codex_credential(),auxiliary)
        self.assertEqual(auxiliary,(main['api_key'],main['base_url']))
        self.assertEqual(codex_headers.codex_account_headers(main['api_key']),{'ChatGPT-Account-ID':'fixture-owner'})
        self.assertFalse((self.home/'auth.json').exists())

    def test_force_401_delegates_to_owner_and_never_native_oauth_or_login(self):
        with mock.patch.object(codex_cli_owner,'resolve',return_value={'api_key':self.token}) as resolve, \
             mock.patch.object(auth_codex,'_refresh_codex_auth_tokens',side_effect=AssertionError('no Hermes refresh')):
            self.assertTrue(auxiliary_client._refresh_codex_credentials())
            self.assertTrue(resolve.call_args.kwargs['force_refresh'])
        with mock.patch.object(codex_cli_owner,'resolve',side_effect=ValueError('safe')), \
             mock.patch.object(auth_codex,'_recover_codex_tokens_from_cli',side_effect=AssertionError('no import/login')):
            from hermes_cli.auth_constants import AuthError
            with self.assertRaises(AuthError) as raised:auth_codex.resolve_codex_runtime_credentials(force_refresh=True)
            self.assertFalse(raised.exception.relogin_required)
            self.assertNotIn(self.token,str(raised.exception))

    def test_opt_out_preserves_existing_pool_behavior(self):
        (self.home/'config.yaml').write_text('{"auth":{"adopt_external_logins":false}}')
        with mock.patch.object(runtime_provider,'load_pool',return_value=None) as pool:
            self.assertIsNone(runtime_provider._resolve_from_pool('openai-codex','openai-codex',{},None,None,None))
            pool.assert_called_once_with('openai-codex')


if __name__=='__main__':unittest.main()
