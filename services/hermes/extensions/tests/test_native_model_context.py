# ABOUTME: Проверяет реальный native resolver на каталоге доверенного Brai relay.
# ABOUTME: Использует копию закреплённого кода и подмену HTTP без модели и credentials.
import ast
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
ENGINE = os.environ.get('BRAI_CONTEXT_ENGINE')


@unittest.skipUnless(ENGINE, 'BRAI_CONTEXT_ENGINE points to pinned native engine')
class NativeModelContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        """Применить только новый metadata hunk к копии настоящего исходника."""
        cls.tmp = tempfile.TemporaryDirectory()
        cls.stage = Path(cls.tmp.name)
        target = cls.stage / 'agent/model_metadata.py'
        target.parent.mkdir()
        target.write_bytes((Path(ENGINE) / 'agent/model_metadata.py').read_bytes())
        patch_text = (ROOT / 'extensions/patches/russian-failure-notice.patch').read_text()
        section = patch_text.split('diff --git a/gateway/russian_failure_notice.py b/gateway/russian_failure_notice.py\n')[1].split('\ndiff --git ', 1)[0]
        notice = cls.stage / 'gateway/russian_failure_notice.py'
        notice.parent.mkdir()
        notice.write_text('\n'.join(line[1:] for line in section.splitlines()
                                   if line.startswith('+') and not line.startswith('+++')) + '\n')
        subprocess.run(['git', 'apply', '--include=agent/model_metadata.py', '--include=gateway/russian_failure_notice.py',
                        str(ROOT / 'identity/native.patch')], cwd=cls.stage, check=True, capture_output=True)
        cls.node = next(n for n in ast.parse(target.read_text()).body
                        if isinstance(n, ast.FunctionDef) and n.name == '_resolve_custom_codex_route_context_length')
        cls.notice = types.ModuleType('notice')
        exec(compile(notice.read_text(), str(notice), 'exec'), cls.notice.__dict__)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_actual_subscription_window_replaces_legacy_static_window(self):
        endpoint = Mock(return_value=500000)
        legacy = Mock(return_value=(272000, 'static'))
        namespace = {'_resolve_endpoint_context_length': endpoint,
                     '_resolve_codex_oauth_context_length_with_source': legacy}
        exec(compile(ast.Module(body=[self.node], type_ignores=[]), '<native>', 'exec'), namespace)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            value = namespace[self.node.name]('gpt-6.1-sol', 'http://127.0.0.1:18080/model/v1', 'placeholder', 'custom')
        self.assertEqual(value, 500000)
        legacy.assert_not_called()
        endpoint.assert_called_once_with('gpt-6.1-sol', 'http://127.0.0.1:18080/model/v1', api_key='placeholder')

    def test_unavailable_catalog_does_not_silently_restore_272k(self):
        namespace = {'_resolve_endpoint_context_length': Mock(return_value=None),
                     '_resolve_codex_oauth_context_length_with_source': Mock()}
        exec(compile(ast.Module(body=[self.node], type_ignores=[]), '<native>', 'exec'), namespace)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), self.assertRaisesRegex(
                RuntimeError, 'BRAI_MODEL_CONTEXT_UNAVAILABLE'):
            namespace[self.node.name]('gpt-6.1-sol', 'http://127.0.0.1:18080/model/v1', 'placeholder', 'custom')
        namespace['_resolve_codex_oauth_context_length_with_source'].assert_not_called()

    def test_each_selected_model_gets_current_catalog_value(self):
        endpoint = Mock(side_effect=[500000, 272000, 600000])
        namespace = {'_resolve_endpoint_context_length': endpoint}
        exec(compile(ast.Module(body=[self.node], type_ignores=[]), '<native>', 'exec'), namespace)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            values = [namespace[self.node.name](model, 'http://127.0.0.1:18080/model/v1', '', 'custom')
                      for model in ('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1-sol')]
        self.assertEqual(values, [500000, 272000, 600000])
        self.assertEqual([call.args[0] for call in endpoint.call_args_list],
                         ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1-sol'])

    def test_other_custom_routes_keep_native_resolution(self):
        legacy = Mock(return_value=(272000, 'static'))
        namespace = {'_resolve_endpoint_context_length': Mock(),
                     '_resolve_codex_oauth_context_length_with_source': legacy,
                     'is_codex_context_variant': lambda model: False,
                     'logger': Mock()}
        exec(compile(ast.Module(body=[self.node], type_ignores=[]), '<native>', 'exec'), namespace)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            self.assertEqual(namespace[self.node.name]('gpt-6.1-sol', 'http://other/v1', '', 'custom'), 272000)
        namespace['_resolve_endpoint_context_length'].assert_not_called()

    def test_local_auth_failure_does_not_blame_provider_credentials(self):
        for code in ('auth', 'auth_permanent'):
            text = self.notice._message_for_connection(code, 'local')
            self.assertIn('Причина отказа пока не подтверждена', text)
            self.assertNotIn('авторизацию или ключ', text)
            self.assertNotIn('Сервис модели отклонил', text)
