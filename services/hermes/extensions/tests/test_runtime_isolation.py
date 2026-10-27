# ABOUTME: Проверяет привязку runtime на временной копии закреплённого Hermes.
# ABOUTME: Не использует рабочий профиль, установщик или реальные credentials.
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ENGINE = Path(os.environ['HERMES_TEST_ENGINE']).resolve() if os.environ.get('HERMES_TEST_ENGINE') else None

@unittest.skipUnless(ENGINE, 'Set HERMES_TEST_ENGINE to a disposable patched upstream checkout')
class RuntimeIsolationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binding = ENGINE / '.brai-runtime.json'
        self.assertFalse(os.path.lexists(self.binding))
        self.addCleanup(lambda: self.binding.unlink(missing_ok=True))

    def run_engine(self, code, expected=0):
        env = dict(os.environ, HERMES_HOME=str(self.root / 'data'),
                   HERMES_RUNTIME_DIR=str(self.root / 'untrusted'))
        result = subprocess.run([sys.executable, '-c', code], cwd=ENGINE, env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result.stdout.strip()

    def write_binding(self, value):
        self.binding.write_text(json.dumps(value))
        self.binding.chmod(0o600)

    def test_binding_isolates_store_installs_and_published_launcher(self):
        runtime = self.root / 'runtime'
        self.write_binding({'format': 'brai-hermes-runtime-v1', 'runtimeRoot': str(runtime)})
        python = runtime / 'tools' / 'python-fixture' / 'bin' / 'python3'
        python.parent.mkdir(parents=True)
        python.touch()
        (self.root / 'launchers').mkdir()
        (runtime / 'tools' / 'facts.json').write_text(json.dumps({'packages': {'python': {'entry': 'python-fixture'}}}))
        out = self.run_engine('''from pathlib import Path
from hermes_constants import get_hermes_home
from pm.environments import dependency_home_root, installs_root, store_root
from hermes_cli._launchers import stage_launcher, _launcher_python
root=Path.cwd()
print(get_hermes_home())
print(dependency_home_root())
print(installs_root())
print(store_root(root))
launcher = stage_launcher('hermes', root, Path(__import__('os').environ['HERMES_HOME']).parent / 'launchers')
print(_launcher_python(launcher))''').splitlines()
        self.assertEqual(out, [str(self.root/'data'), str(self.root/'data'), str(runtime/'installs'),
                               str(runtime/'tools'), str(python)])

    def test_owner_uses_binding_not_ambient_home(self):
        runtime = self.root / 'runtime'
        self.write_binding({'format':'brai-hermes-runtime-v1', 'runtimeRoot':str(runtime)})
        out = self.run_engine("from hermes_cli.codex_cli_owner import HOME, CODEX_HOME; print(HOME); print(CODEX_HOME)").splitlines()
        self.assertEqual(out, [str(runtime/'owner'), str(runtime/'owner'/'.codex')])
        self.run_engine("from hermes_cli.codex_cli_owner import roots; roots()", 1)

    def test_legacy_without_binding_keeps_override_and_data_home(self):
        out = self.run_engine('''from pathlib import Path
from hermes_constants import get_hermes_home
from pm.environments import store_root
print(get_hermes_home())
print(store_root(Path.cwd()))''').splitlines()
        self.assertEqual(out, [str(self.root/'data'), str(self.root/'untrusted')])

    def test_invalid_or_unsafe_binding_fails_closed(self):
        code = 'from pathlib import Path; from pm.environments import store_root; store_root(Path.cwd())'
        for value in ({}, {'format':'brai-hermes-runtime-v1','runtimeRoot':'relative'},
                      {'format':'other','runtimeRoot':'/tmp/runtime'}):
            self.write_binding(value)
            self.run_engine(code, 1)
            self.binding.unlink()
        self.binding.symlink_to(self.root/'missing')
        self.run_engine(code, 1)
        self.binding.unlink()
        self.write_binding({'format':'brai-hermes-runtime-v1','runtimeRoot':'/tmp/runtime'})
        self.binding.chmod(0o666)
        self.run_engine(code, 1)

class LegacyOwnerTest(unittest.TestCase):
    def test_old_engine_and_v1_owner_replacement(self):
        source = (Path(__file__).parents[1] / 'tools' / 'codex_cli_owner.py').read_text()
        needle = "HOME = Path('/var/lib/brai-dev/hermes-owner')"
        self.assertEqual(source.count(needle), 1)
        with tempfile.TemporaryDirectory() as temporary:
            engine = Path(temporary)
            (engine / 'hermes_cli').mkdir()
            (engine / 'pm').mkdir()
            (engine / 'pm' / '__init__.py').touch()
            (engine / 'pm' / 'environments.py').write_text('# old upstream without resolver\n')
            helper = engine / 'hermes_cli' / 'codex_cli_owner.py'
            helper.write_text(source.replace(needle, "HOME = Path(os.environ['HOME'])"))
            env = dict(os.environ, HOME=str(engine / 'client-owner'), PYTHONPATH=str(engine))
            command = [sys.executable, '-c', 'from hermes_cli.codex_cli_owner import HOME; print(HOME)']
            result = subprocess.run(command, cwd=engine, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(engine / 'client-owner'))
            (engine / '.brai-runtime.json').write_text('{}')
            result = subprocess.run(command, cwd=engine, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main()
