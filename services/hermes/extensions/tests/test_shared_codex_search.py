# ABOUTME: Проверяет secret-free поиск личного Hermes через trusted egress.
# ABOUTME: Реальный CLI, сеть и provider credentials не используются.
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch


class SharedProviderTest(unittest.TestCase):
    def setUp(self):
        base = ModuleType('agent.web_search_provider')
        base.WebSearchProvider = object
        interrupt = ModuleType('tools.interrupt')
        self.interrupted = False
        interrupt.is_interrupted = lambda: self.interrupted
        self.modules = patch.dict(sys.modules, {'agent.web_search_provider': base,
                                               'tools.interrupt': interrupt})
        self.modules.start()
        path = Path(__file__).resolve().parents[1] / 'plugins/codex-cli-search/provider.py'
        spec = importlib.util.spec_from_file_location('codex_shared_search_test', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.env = patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker',
                                         'BRAI_IDENTITY_EGRESS': '/root-owned/egress.sock'})
        self.env.start()
        self.socket = Mock()
        result = {'success': True, 'data': {'web': [{'title': 'Official',
            'url': 'https://example.org', 'description': 'native hit', 'position': 1}]}}
        body = json.dumps(result).encode()
        self.socket.recv.side_effect = [b'HTTP/1.1 200 OK\r\nContent-Length: '
                                        + str(len(body)).encode() + b'\r\n\r\n' + body]

    def tearDown(self):
        self.env.stop()
        self.modules.stop()

    def test_worker_uses_proxy_without_cli_settings_or_credentials(self):
        with patch.object(self.module.socket, 'create_connection', return_value=self.socket) as connect, patch.object(
                self.module, '_settings', side_effect=AssertionError('No worker runtime choices')), patch.object(
                self.module.shutil, 'which', side_effect=AssertionError('No CLI in worker')), patch.object(
                self.module, '_run_search', side_effect=AssertionError('No local fallback')):
            provider = self.module.CodexCLIWebSearchProvider()
            self.assertTrue(provider.is_available())
            result = provider.search('birds', 5)
        self.assertTrue(result['success'])
        connect.assert_called_once_with(('127.0.0.1', 18080), timeout=2)
        raw = self.socket.sendall.call_args.args[0]
        self.assertTrue(raw.startswith(b'POST /search/v1/query'))
        self.assertEqual(json.loads(raw.split(b'\r\n\r\n')[1]), {'query': 'birds', 'limit': 5})
        self.socket.close.assert_called_once()

    def test_interrupt_closes_transport_without_fallback_or_retry(self):
        self.interrupted = True
        with patch.object(self.module.socket, 'create_connection', return_value=self.socket) as connect, patch.object(
                self.module, '_run_search', side_effect=AssertionError('No fallback')):
            result = self.module.CodexCLIWebSearchProvider().search('birds')
        self.assertFalse(result['success'])
        self.assertEqual(result['error'], 'Interrupted')
        connect.assert_called_once()
        self.socket.recv.assert_not_called()
        self.socket.shutdown.assert_called_once()
        self.socket.close.assert_called_once()

    def test_incomplete_reply_is_unknown_and_not_retried(self):
        self.socket.recv.side_effect = [b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}', b'']
        with patch.object(self.module.socket, 'create_connection', return_value=self.socket) as connect:
            result = self.module.CodexCLIWebSearchProvider().search('birds')
        self.assertFalse(result['success'])
        self.assertIn('outcome unknown', result['error'])
        connect.assert_called_once()

    def test_oversized_query_never_opens_socket(self):
        with patch.object(self.module.socket, 'create_connection') as connect:
            result = self.module.CodexCLIWebSearchProvider().search('a' * 16385)
        self.assertFalse(result['success'])
        connect.assert_not_called()
