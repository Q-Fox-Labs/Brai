# ABOUTME: Проверяет независимую приёмку службы и сохранение закрытых ключей.
# ABOUTME: Использует изолированные подмены; реальную службу и секреты не читает.
from pathlib import Path
from types import SimpleNamespace
import hashlib
import stat
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[1]
ROLE = ROOT / 'roles/brai_duplicati'


def verifier():
    source = (ROLE / 'templates/verify-duplicati.py.j2').read_text()
    source = source.replace('{{ duplicati_version | to_json }}', '"2.4.0.1"')
    source = source.replace("{{ lookup('template', 'duplicati.service.j2') | hash('sha256') | to_json }}",
                            repr(hashlib.sha256(b'unit').hexdigest()))
    namespace = {'__name__': 'fixture'}
    exec(compile(source, 'verify-duplicati.py', 'exec'), namespace)
    return namespace


class BackupVerification(unittest.TestCase):
    def check(self, *, listener='127.0.0.1:8200', http=None, mode=None, unit=b'unit', version='2.4.0.1'):
        module = verifier()
        def output(*args):
            if 'dpkg-query' in args[0]: return version
            if args[1] == 'is-active': return 'active'
            if args[1] == 'is-enabled': return 'enabled'
            return 'LISTEN 0 512 ' + listener + ' 0.0.0.0:*'
        def metadata(path):
            file = str(path).endswith('.env')
            return SimpleNamespace(st_mode=(stat.S_IFREG if file else stat.S_IFDIR) |
                (mode if mode is not None else (0o600 if file else 0o700)), st_uid=0, st_gid=0)
        module['output'] = output
        module['status'] = lambda path: (http if http is not None else (401 if path.startswith('/api/') else 404))
        with patch.object(Path, 'lstat', metadata), patch.object(Path, 'read_bytes', return_value=unit):
            module['verify']()

    def test_closed_service_passes_ipv4_and_ipv6(self):
        self.check()
        self.check(listener='[::1]:8200')

    def test_public_listener_ui_bad_rights_and_drift_fail(self):
        for kwargs in [dict(listener='0.0.0.0:8200'), dict(listener='[::]:8200'),
                       dict(http=200), dict(mode=0o755), dict(unit=b'changed'), dict(version='other')]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError): self.check(**kwargs)

    def test_initialization_never_overwrites_existing_keys(self):
        tasks = yaml.safe_load((ROLE / 'tasks/main.yml').read_text())
        task = next(t for t in tasks if t.get('name', '').startswith('Generate new private'))
        command = task['ansible.builtin.command']
        with tempfile.TemporaryDirectory(prefix='duplicati-key-fixture-') as scratch:
            environment = Path(scratch) / 'server.env'
            source = command['argv'][-1].replace('/etc/duplicati/server.env', str(environment))
            exec(compile(source, 'initialize.py', 'exec'), {})
            original = environment.read_bytes()
            self.assertEqual(len(original.splitlines()), 2)
            self.assertEqual(stat.S_IMODE(environment.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                exec(compile(source, 'initialize.py', 'exec'), {})
            self.assertEqual(environment.read_bytes(), original)
        self.assertEqual(command['creates'], '/etc/duplicati/server.env')
        self.assertTrue(task['no_log'])
        defaults = yaml.safe_load((ROLE / 'defaults/main.yml').read_text())
        self.assertFalse(defaults['duplicati_initialize_secrets'])


if __name__ == '__main__': unittest.main()
