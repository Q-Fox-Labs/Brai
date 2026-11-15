# ABOUTME: Проверяет Unix-сокет watchdog на настоящем закреплённом исходнике Hermes.
# ABOUTME: Патч применяется только к временной копии; рабочие службы и HOME не меняются.
import ast
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from typing import Optional
import unittest
from unittest.mock import patch


ENGINE = os.environ.get('BRAI_NATIVE_ENGINE')
PATCH = Path(__file__).resolve().parents[1] / 'native.patch'


@unittest.skipUnless(ENGINE, 'Pinned native engine required')
class NativeWatchdogTests(unittest.TestCase):
    """Проверить настоящую bind, профильный путь и сохранение обычного режима."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        stage = Path(self.temporary.name)
        source = stage / 'gateway/shutdown_watchdog.py'
        source.parent.mkdir()
        shutil.copyfile(Path(ENGINE) / 'gateway/shutdown_watchdog.py', source)
        subprocess.run(['git', 'apply', '--include=gateway/shutdown_watchdog.py', str(PATCH)],
                       cwd=stage, check=True, capture_output=True)
        tree = ast.parse(source.read_text())
        definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                          and node.name == 'get_loop_tick_socket_path')
        namespace = {'Path': Path, 'Optional': Optional, 'os': os, '_home': lambda value: value}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(source), 'exec'), namespace)
        self.socket_path = namespace['get_loop_tick_socket_path']

    def test_long_uuid_home_binds_and_accepts_real_connection(self):
        home = Path('/var/lib/brai-dev/identity/profiles/46164d93-df0d-4a2e-bc1c-804680b01cf4')
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            path = self.socket_path(home, os.getpid())
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
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            self.assertNotEqual(self.socket_path(Path('/profile'), 1001),
                                self.socket_path(Path('/profile'), 1002))

    def test_parent_and_ordinary_gateway_keep_native_path(self):
        home = Path('/private/profile')
        for mode in ('', 'telegram'):
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': mode}):
                self.assertEqual(self.socket_path(home, 123),
                                 home / 'state/gateway.loop-tick.123.sock')
