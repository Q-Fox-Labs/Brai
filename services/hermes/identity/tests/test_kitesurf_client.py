# ABOUTME: Проверяет отдельный MCP-инструмент управления Kitesurf.
# ABOUTME: Не запускает настоящий браузер и не проверяет установку.
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import kitesurf_client


class KitesurfClientTests(unittest.TestCase):
    def test_tool_catalog_explains_both_browser_choices(self):
        tool = kitesurf_client.handle('tools/list', {})['tools'][0]
        self.assertEqual(tool['name'], 'kitesurf')
        self.assertIn('Kitesurf', tool['description'])
        self.assertIn('Chrome', tool['description'])
        self.assertIn('browser_*', tool['description'])

    def test_commands_are_data_and_reference_only_snapshot_elements(self):
        self.assertEqual(kitesurf_client.command({'action': 'fill', 'ref': '@e7', 'text': '--cdp=evil'}),
                         ['fill', '@e7', '--cdp=evil'])
        for value in ({'action': 'click', 'ref': '--cdp'},
                      {'action': 'open', 'url': 'file:///private'},
                      {'action': 'open', 'url': 'https://user:secret@example.com'},
                      {'action': 'snapshot', 'other': 'x'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                kitesurf_client.command(value)

    def test_mcp_call_returns_browser_result(self):
        with patch.object(kitesurf_client, 'run_browser', return_value={'success': True, 'data': 'page'}) as run:
            result = kitesurf_client.handle('tools/call', {'name': 'kitesurf',
                'arguments': {'action': 'snapshot'}})
        self.assertEqual(json.loads(result['content'][0]['text'])['data'], 'page')
        run.assert_called_once_with({'action': 'snapshot'})

    def test_initialize_and_unknown_tools(self):
        self.assertIn('tools', kitesurf_client.handle('initialize', {})['capabilities'])
        with self.assertRaises(LookupError):
            kitesurf_client.handle('tools/call', {'name': 'browser_navigate'})

    def test_control_port_does_not_conflict_with_on_demand_chrome(self):
        self.assertEqual(kitesurf_client.CDP_URL, 'http://127.0.0.1:19366')

    def test_relay_notifies_only_after_listening(self):
        with tempfile.TemporaryDirectory() as directory:
            notify = str(Path(directory) / 'notify.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as listener:
                listener.bind(notify)
                listener.settimeout(5)
                env = {**os.environ, 'NOTIFY_SOCKET': notify,
                       'PYTHONPATH': str(Path(__file__).resolve().parents[2])}
                process = subprocess.Popen([sys.executable, '-B', '-m', 'identity.network',
                                            '--socket', str(Path(directory) / 'egress.sock'),
                                            '--port', '0'], env=env)
                try:
                    self.assertEqual(listener.recv(128), b'READY=1')
                finally:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
