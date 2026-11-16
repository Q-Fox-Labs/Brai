# ABOUTME: Проверяет повторный вход логирования при выборе профиля без блокировки redaction.
# ABOUTME: Применяет native patch к исходному fixture; значений runtime не читает.
import ast
import logging
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

BASE = Path(__file__).resolve().parents[1]


class RedactionLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / 'agent').mkdir()
        (root / 'agent/redact.py').write_bytes((BASE / 'tests/fixtures/ordinary_release/agent/redact.py').read_bytes())
        source = (BASE / 'native.patch').read_text()
        section = source.split('diff --git a/agent/redact.py b/agent/redact.py\n', 1)[1].split('\n--- a/plugins/', 1)[0]
        subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=section, text=True, check=True, stdout=subprocess.DEVNULL)
        tree = ast.parse((root / 'agent/redact.py').read_text())
        # Only the registry under test; its external home resolver is injected below.
        nodes = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign, ast.FunctionDef))]
        self.scope = {'threading': threading, 'logging': logging, '__name__': '_redaction_fixture'}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pinned-redaction>', 'exec'), self.scope)
        self.scope['_vault_scope'] = lambda: 'profile-a'

    def test_home_resolution_can_log_and_redact_without_holding_registry_lock(self):
        registry = self.scope
        registry['register_vault_redaction_value']('private-value')
        entered = False
        def scope():
            nonlocal entered
            lock = registry['_VAULT_REDACTION_LOCK']
            owned = lock._is_owned() if hasattr(lock, '_is_owned') else lock.locked()
            self.assertFalse(owned, 'home resolver must not run under registry lock')
            if not entered:
                entered = True
                try:
                    self.assertEqual(registry['redact_registered_vault_values']('private-value'), '«redacted-vault-secret»')
                finally:
                    entered = False
            return 'profile-a'
        registry['_vault_scope'] = scope
        registry['register_vault_redaction_value']('second-private-value')
        self.assertEqual(registry['redact_registered_vault_values']('second-private-value'), '«redacted-vault-secret»')
        registry['clear_vault_redaction_values']()
        registry['_vault_scope'] = lambda: 'profile-a'
        self.assertEqual(registry['redact_registered_vault_values']('private-value'), 'private-value')

    def test_registry_stays_isolated_between_profiles(self):
        self.scope['register_vault_redaction_value']('private-value')
        self.scope['_vault_scope'] = lambda: 'profile-b'
        self.assertEqual(self.scope['redact_registered_vault_values']('private-value'), 'private-value')
        self.scope['_vault_scope'] = lambda: 'profile-a'
        self.assertEqual(self.scope['redact_registered_vault_values']('private-value'), '«redacted-vault-secret»')
