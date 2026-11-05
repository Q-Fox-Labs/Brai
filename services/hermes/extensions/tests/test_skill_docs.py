# ABOUTME: Проверяет независимое обновление текстов навыков и сохранение скриптов.
# ABOUTME: Работает только с временным Git и синтетическим профилем без сети.
import importlib.util
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

EXT = Path(__file__).resolve().parents[1]
PROJECT = EXT.parents[2]
sys.path.insert(0, str(EXT / 'tools'))
import skill_docs as docs


class SkillDocumentationTests(unittest.TestCase):
    def setUp(self):
        (PROJECT / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=PROJECT / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repository = self.root / 'repository'
        self.repository.mkdir()
        self.home = self.root / 'profile'
        self.source = self.repository / docs.PREFIXES[0] / 'media/example/SKILL.md'
        self.source.parent.mkdir(parents=True)
        self.source.write_text('version one')
        self.run_git('init', '-q')
        self.run_git('config', 'user.name', 'Synthetic')
        self.run_git('config', 'user.email', 'synthetic@example.invalid')
        self.commit()

    def run_git(self, *args):
        return subprocess.check_output(['/usr/bin/git', '-C', str(self.repository), *args], text=True).strip()

    def commit(self):
        self.run_git('add', '--all')
        self.run_git('commit', '-qm', 'synthetic fixture')
        self.revision = self.run_git('rev-parse', 'HEAD')

    def plan(self, adopt=False):
        entries = docs.collect(self.repository, self.revision, self.home, 'Test')
        return docs.plan(self.home, entries, self.revision, adopt)[0]

    def test_code_connector_without_bundled_skill_texts_preserves_installed_documents(self):
        import connect
        instructions = self.root / 'instructions'
        shutil.copytree(connect.SOURCE / 'docs/user-agent/instructions/hermes', instructions,
                        ignore=shutil.ignore_patterns('skills'))
        target = self.home / 'skills/media/example/SKILL.md'
        target.parent.mkdir(parents=True)
        target.write_text('independently installed text')
        changes = connect.build_plan(self.home, instructions, connect.check_source()[0], [], False, 'Test')
        self.assertFalse(any(row[0] == target for row in changes))
        self.assertTrue(any(row[1].endswith('scripts/video_workflow.py') for row in changes))
        self.assertEqual(target.read_text(), 'independently installed text')

    def test_extension_references_use_a_stable_profile_alias(self):
        self.source.write_text('read ${HERMESCUSTOM_ROOT}/scripts/example.py')
        self.commit()
        entries = docs.collect(self.repository, self.revision, self.home, 'Test')
        content = entries['skills/media/example/SKILL.md']['content']
        self.assertEqual(content.decode(), 'read ' + str(self.home / 'usercustom/hermescustom/scripts/example.py'))

    def test_update_is_idempotent_and_preserves_code_and_soul(self):
        docs.apply(self.home, self.plan())
        target = self.home / 'skills/media/example/SKILL.md'
        script = target.parent / 'scripts/code.py'
        script.parent.mkdir()
        script.write_bytes(b'code sentinel')
        soul = self.home / 'SOUL.md'
        soul.write_bytes(b'personal identity')
        self.source.write_text('version two')
        self.commit()
        backup = docs.apply(self.home, self.plan())
        self.assertEqual(target.read_text(), 'version two')
        self.assertEqual((Path(backup) / 'skills/media/example/SKILL.md').read_text(), 'version one')
        self.assertEqual(script.read_bytes(), b'code sentinel')
        self.assertEqual(soul.read_bytes(), b'personal identity')
        self.assertEqual(docs.verify(self.home)['revision'], self.revision)
        self.assertEqual(self.plan(), [])

    def test_adoption_preserves_overrides_and_unknown_edits_stop_the_whole_plan(self):
        target = self.home / 'skills/media/example/SKILL.md'
        target.parent.mkdir(parents=True)
        target.write_text('local version')
        with self.assertRaisesRegex(ValueError, 'ADOPTION_REQUIRED'):
            self.plan()
        docs.apply(self.home, self.plan(adopt=True))
        self.source.write_text('new common version')
        self.commit()
        docs.apply(self.home, self.plan())
        self.assertEqual(target.read_text(), 'local version')
        self.assertEqual(docs.verify(self.home)['overrides'], ['skills/media/example/SKILL.md'])
        target.write_text('another unreviewed local edit')
        with self.assertRaisesRegex(ValueError, 'LOCAL_CHANGE'):
            self.plan()

    def test_git_code_and_symlink_are_rejected_without_profile_writes(self):
        code = self.source.parent / 'script.py'
        code.write_text('raise Exception()')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'NON_TEXT_ENTRY'):
            self.plan()
        code.unlink()
        link = self.source.parent / 'reference.md'
        link.symlink_to('/etc/passwd')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'NON_TEXT_ENTRY'):
            self.plan()
        self.assertFalse(self.home.exists())

    def test_write_failure_restores_previously_written_files(self):
        docs.apply(self.home, self.plan())
        marker = (self.home / docs.RECEIPT).read_bytes()
        self.source.write_text('new text')
        self.commit()
        changes = self.plan()
        original_atomic = docs.atomic
        def failing(path, raw, mode):
            if path == self.home / docs.RECEIPT:
                raise OSError('synthetic write failure')
            return original_atomic(path, raw, mode)
        # Receipt sorts last in the planned transaction, after the document.
        with patch.object(docs, 'atomic', side_effect=failing):
            with self.assertRaises(OSError):
                docs.apply(self.home, changes)
        self.assertEqual((self.home / 'skills/media/example/SKILL.md').read_text(), 'version one')
        self.assertEqual((self.home / docs.RECEIPT).read_bytes(), marker)
        self.assertTrue(docs.verify(self.home)['verified'])


if __name__ == '__main__':
    unittest.main()
