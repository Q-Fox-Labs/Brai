# ABOUTME: Проверяет подключение расширений к временному профилю Hermes.
# ABOUTME: Не использует рабочий профиль, сеть или установленный движок.
import json
import hashlib
import importlib.util
import shutil
import stat
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

EXT = Path(__file__).resolve().parents[1]
PROJECT = EXT.parents[2]
CONNECT = EXT / 'tools/connect.py'


class ConnectTests(unittest.TestCase):
    def setUp(self):
        (PROJECT / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=PROJECT / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'profile'

    def run_connect(self, *args, ok=True):
        result = subprocess.run([sys.executable, '-B', str(CONNECT), '--profile-dir', str(self.home),
                                 '--owner-name', 'Тест', *args], text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result

    def test_plan_fresh_and_idempotence(self):
        self.assertGreater(len(self.run_connect('--plan')['changed']), 10)
        self.assertFalse(self.home.exists())
        self.run_connect('--apply')
        self.assertTrue((self.home / 'plugins/memos-rest/provider.py').is_file())
        self.assertIn(str(self.home), (self.home / 'plugins/codex-cli-search/README.txt').read_text())
        self.assertIn('Ты — Hermes Agent', (self.home / 'SOUL.md').read_text())
        self.assertEqual(stat.S_IMODE((self.home / 'SOUL.md').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.home / 'scripts/silero_voice.py').stat().st_mode), stat.S_IMODE((EXT / 'scripts/silero_voice.py').stat().st_mode))
        self.assertTrue((self.home / 'skills/media/youtube-content/scripts/video_workflow.py').is_file())
        self.assertTrue((self.home / 'OWNER_IDENTITY.md').read_text().find('Тест') >= 0)
        self.assertFalse((self.home / 'AGENTS.md').exists())
        self.assertFalse((self.home / 'usercustom').exists())
        self.assertEqual(self.run_connect('--plan')['changed'], [])
        self.assertIn('docs/user-agent/instructions/hermes/INDEX.md', (self.home / 'SOUL.md').read_text())

    def test_soul_and_conflict_before_write(self):
        self.home.mkdir()
        (self.home / 'SOUL.md').write_text('до\n<!-- docshermes:begin -->\nстарое\n<!-- docshermes:end -->\nпосле\n')
        conflict = self.home / 'plugins/memos-rest/provider.py'
        conflict.parent.mkdir(parents=True)
        conflict.write_text('чужое')
        before = (self.home / 'SOUL.md').read_text()
        self.run_connect('--apply', ok=False)
        self.assertEqual((self.home / 'SOUL.md').read_text(), before)
        self.assertEqual(conflict.read_text(), 'чужое')
        result = self.run_connect('--apply', '--overwrite')
        self.assertTrue(Path(result['backup']).is_dir())
        self.assertTrue((self.home / 'SOUL.md').read_text().startswith('до\n'))
        self.assertTrue((self.home / 'SOUL.md').read_text().endswith('\nпосле\n'))

    def test_symlink_and_invalid_only_rejected(self):
        self.home.mkdir()
        (self.home / 'plugins').symlink_to(Path(self.temp.name))
        self.run_connect('--apply', ok=False)
        self.assertFalse((self.home / 'SOUL.md').exists())
        self.run_connect('--plan', '--only', '../x', ok=False)
        self.run_connect('--apply-core', ok=False)

    def test_modes_and_hardlink_rejected_before_write(self):
        self.home.mkdir()
        target = self.home / 'scripts/silero_voice.py'
        target.parent.mkdir()
        target.write_text('старое'); target.chmod(0o640)
        result = self.run_connect('--apply', '--only', 'scripts', '--overwrite')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        backup = Path(result['backup']) / 'scripts/silero_voice.py'
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(backup.parent.stat().st_mode), 0o700)
        target.unlink()
        external = Path(self.temp.name) / 'external'
        external.write_text('shared')
        os.link(external, target)
        self.run_connect('--apply', '--overwrite', ok=False)
        self.assertEqual(external.read_text(), 'shared')
        self.assertFalse((self.home / 'SOUL.md').exists())

    def test_outer_manifest_and_source_hardlink(self):
        fixture = Path(self.temp.name) / 'payload'
        package = fixture / 'services/hermes/extensions'
        shutil.copytree(EXT, package)
        spec = importlib.util.spec_from_file_location('connect_test', package / 'tools/connect.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        runtime = json.loads((package / 'manifest.json').read_text())['runtimeFiles']
        rows = [{'path': 'services/hermes/extensions/' + rel,
                 'sha256': hashlib.sha256((package / rel).read_bytes()).hexdigest()}
                for rel in runtime + ['manifest.json']]
        (fixture / 'artifact-manifest.json').write_text(json.dumps({'files': rows}))
        self.assertTrue(module.check_source()[1])
        target = package / 'plugins/codex-cli-search/README.txt'
        target.write_text('изменено')
        with self.assertRaises(ValueError): module.check_source()
        target.unlink()
        os.link(package / 'manifest.json', target)
        with self.assertRaises(ValueError): module.check_source()

    def test_check_and_only(self):
        self.assertFalse(self.run_connect('--check')['outerHashesChecked'])
        self.run_connect('--apply', '--only', 'scripts')
        self.assertTrue((self.home / 'scripts/silero_voice.py').is_file())
        self.assertFalse((self.home / 'plugins').exists())
        self.assertFalse((self.home / 'SOUL.md').exists())


if __name__ == '__main__': unittest.main()
