# ABOUTME: Проверяет Unix-сокет watchdog на настоящем закреплённом исходнике Hermes.
# ABOUTME: Адаптер устанавливается на native reader; рабочие службы и HOME не меняются.
import ast
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch


ENGINE = os.environ.get('BRAI_NATIVE_ENGINE')
POLICY = Path(__file__).resolve().parents[1] / 'native_policy.py'
definitions = [node for node in ast.parse(POLICY.read_text()).body
               if isinstance(node, ast.FunctionDef) and node.name in
               ('worker_loop_tick_socket_path', 'install_worker_watchdog')]
namespace = {'Path': Path, 'os': os}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(POLICY), 'exec'), namespace)
watchdog = SimpleNamespace(**namespace)


@unittest.skipUnless(ENGINE, 'Pinned native engine required')
class NativeWatchdogTests(unittest.TestCase):
    """Проверить настоящую bind, профильный путь и сохранение обычного режима."""

    def setUp(self):
        source = Path(ENGINE) / 'gateway/shutdown_watchdog.py'
        tree = ast.parse(source.read_text())
        definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                          and node.name == 'get_loop_tick_socket_path')
        namespace = {'Path': Path, 'Optional': Optional, 'os': os, '_home': lambda value: value}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(source), 'exec'), namespace)
        self.native = SimpleNamespace(get_loop_tick_socket_path=namespace['get_loop_tick_socket_path'])
        self.original = self.native.get_loop_tick_socket_path

    def test_long_uuid_home_binds_and_accepts_real_connection(self):
        home = Path('/var/lib/brai-dev/identity/profiles/11111111-2222-4333-8444-555555555555')
        self.assertGreaterEqual(len(os.fsencode(self.original(home, 1234567))), 108)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            with patch.dict(sys.modules, {'gateway': SimpleNamespace(shutdown_watchdog=self.native)}):
                watchdog.install_worker_watchdog()
            path = self.native.get_loop_tick_socket_path(home, os.getpid())
        self.assertNotIn(str(home), str(path))
        created = not path.parent.exists()
        path.parent.mkdir(exist_ok=True)
        if created:
            self.addCleanup(path.parent.rmdir)
        self.addCleanup(path.unlink, missing_ok=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(path))
            server.listen()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(path))
                connection, _ = server.accept()
                with connection:
                    connection.sendall(b'OK')
                    self.assertEqual(client.recv(2), b'OK')

    def test_pid_identity_is_preserved(self):
        self.assertNotEqual(watchdog.worker_loop_tick_socket_path(Path('/profile'), 1001),
                            watchdog.worker_loop_tick_socket_path(Path('/profile'), 1002))

    def test_parent_and_ordinary_gateway_keep_native_path(self):
        home = Path('/private/profile')
        for mode in ('', 'telegram'):
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': mode}):
                with patch.dict(sys.modules, {'gateway': SimpleNamespace(shutdown_watchdog=self.native)}):
                    watchdog.install_worker_watchdog()
                self.assertIs(self.native.get_loop_tick_socket_path, self.original)
                self.assertEqual(self.native.get_loop_tick_socket_path(home, 123),
                                 home / 'state/gateway.loop-tick.123.sock')
