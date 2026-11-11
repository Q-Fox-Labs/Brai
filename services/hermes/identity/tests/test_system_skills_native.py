# ABOUTME: Проверяет системные и личные навыки настоящим native resolver и двумя UID.
# ABOUTME: Требует Root и BRAI_NATIVE_ENGINE; создаёт только синтетические файлы в /run.
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import skills as policy


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('BRAI_NATIVE_ENGINE'), 'Root native fixture required')
class NativeSystemSkillsTests(unittest.TestCase):
    """Ни модели, ни пользовательские аккаунты и службы не запускаются."""

    def test_shared_documentation_cli_updates_without_touching_code_or_personal_skills(self):
        import json
        import subprocess
        project = Path(__file__).resolve().parents[4]
        helper = project / 'services/hermes/extensions/tools/skill_docs.py'
        with tempfile.TemporaryDirectory(dir=project / 'tmp', prefix='system-skill-git-') as git_directory, \
             tempfile.TemporaryDirectory(dir='/run', prefix='brai-skill-update-') as directory:
            repository = Path(git_directory)
            def git(*arguments):
                return subprocess.check_output(['/usr/bin/git', '-C', str(repository), *arguments], text=True).strip()
            git('init', '-q')
            source = repository / 'docs/user-agent/instructions/hermes/skills/example/SKILL.md'
            source.parent.mkdir(parents=True)
            source.write_text('---\nname: example\n---\nVersion one')
            def commit():
                git('add', '.')
                git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture')
                return git('rev-parse', 'HEAD')
            revision = commit()
            shared = Path(directory) / 'shared'
            sentinel = Path(directory) / 'private/SKILL.md'
            sentinel.parent.mkdir()
            sentinel.write_bytes(b'private skill unchanged')
            before = helper.read_bytes()
            def run(action, revision=None):
                command = ['/usr/bin/python3', '-B', str(helper), action, '--system', '--profile-dir', str(shared)]
                if revision:
                    command += ['--source-root', str(repository), '--revision', revision]
                return json.loads(subprocess.check_output(command, text=True))
            self.assertFalse(shared.exists())
            self.assertTrue(run('plan', revision)['changed'])
            self.assertFalse(shared.exists())
            run('apply', revision)
            self.assertTrue(run('verify')['verified'])
            self.assertEqual(run('apply', revision)['changed'], [])
            source.write_text('---\nname: example\n---\nVersion two')
            revision = commit()
            result = run('apply', revision)
            target = shared / 'skills/example/SKILL.md'
            self.assertTrue(target.read_text().endswith('Version two'))
            self.assertTrue((Path(result['backup']) / 'skills/example/SKILL.md').read_text().endswith('Version one'))
            self.assertEqual(run('verify')['revision'], revision)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(helper.read_bytes(), before)
            self.assertEqual(sentinel.read_bytes(), b'private skill unchanged')
            target.write_text('unknown local edit')
            with self.assertRaises(subprocess.CalledProcessError):
                run('apply', revision)

    def test_two_users_share_protected_skills_and_keep_private_skills_separate(self):
        sys.path.insert(0, os.environ['BRAI_NATIVE_ENGINE'])
        from agent import skill_utils as utils
        import gateway.session_context
        with tempfile.TemporaryDirectory(dir='/run', prefix='brai-skill-test-') as directory:
            root = Path(directory)
            root.chmod(0o755)
            system, bundled = root / 'system', root / 'bundled'
            for base, relative, text in [(system, 'creative/common', 'System common'),
                                         (bundled, 'builtin', 'Bundled common')]:
                path = base / relative / 'SKILL.md'
                path.parent.mkdir(parents=True, mode=0o755)
                path.write_text('---\nname: ' + Path(relative).name + '\n---\n' + text)
                path.chmod(0o644)
            for directory in (system, bundled, *(path for path in root.rglob('*') if path.is_dir())):
                directory.chmod(0o755)
            policy.SYSTEM_SKILLS, policy.BUNDLED_SKILLS = system, bundled
            users = []
            for number, uid in enumerate((62001, 62002)):
                home = root / ('user-' + str(number))
                custom = home / 'usercustom/userdata/skills'
                custom.mkdir(parents=True)
                for path in (custom, *custom.parents):
                    if path == root:
                        break
                    os.chown(path, uid, uid)
                    path.chmod(0o700)
                for name in ('common', 'private-' + str(number)):
                    path = custom / name / 'SKILL.md'
                    path.parent.mkdir()
                    path.write_text('---\nname: ' + name + '\n---\nPrivate text')
                    os.chown(path.parent, uid, uid)
                    os.chown(path, uid, uid)
                users.append((uid, home))
            for number, (uid, home) in enumerate(users):
                child = os.fork()
                if child == 0:
                    try:
                        os.setgroups([])
                        os.setgid(uid)
                        os.setuid(uid)
                        os.environ['HERMES_HOME'] = str(home)
                        utils._skills_cfg = lambda: {'disabled': ['common', 'builtin', 'private-' + str(number)]}
                        policy.install_policy()
                        rows = []
                        for tier, base in utils.get_skill_search_roots(root / 'other'):
                            for path in utils.iter_skill_index_files(base, 'SKILL.md'):
                                front, _ = utils.parse_frontmatter(path.read_text())
                                rows.append({'name': front['name'], 'tier': tier, 'root': base, 'path': path})
                        resolved = utils.resolve_skill_catalog(rows)
                        common = next(row for row in resolved if row['load_name'] == 'common')
                        assert common['path'] == system / 'creative/common/SKILL.md'
                        assert 'common' not in utils.get_disabled_skill_names()
                        assert 'builtin' not in utils.get_disabled_skill_names()
                        assert 'private-' + str(number) in utils.get_disabled_skill_names()
                        assert not any(row['name'] == 'private-' + str(1-number) for row in rows)
                        assert utils.get_skill_create_dir() == home / 'usercustom/userdata/skills'
                        target = utils.get_skill_create_dir() / 'installed/SKILL.md'
                        target.parent.mkdir()
                        target.write_text('My own installed skill')
                        for operation in (lambda: common['path'].write_text('replace'),
                                          lambda: common['path'].unlink(),
                                          lambda: (users[1-number][1] / 'usercustom/userdata/skills').iterdir().__next__()):
                            try:
                                operation()
                            except PermissionError:
                                pass
                            else:
                                raise AssertionError('A user accessed protected or foreign skills')
                    except BaseException:
                        import traceback
                        traceback.print_exc()
                        os._exit(1)
                    os._exit(0)
                _, status = os.waitpid(child, 0)
                self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertEqual((system / 'creative/common/SKILL.md').read_text().splitlines()[-1], 'System common')


if __name__ == '__main__':
    unittest.main()
