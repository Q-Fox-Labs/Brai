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
        from agent import background_review
        from tools import skills_tool, skill_manager_tool
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

    def test_personal_supplements_survive_new_process_and_never_mutate_shared_skills(self):
        import json
        import subprocess
        source = str(Path(__file__).resolve().parents[2])
        script = r'''
import json, os, sys
from pathlib import Path
from identity import skills as policy
root=Path(sys.argv[1]); mode=sys.argv[2]
policy.SYSTEM_SKILLS=root/'shared'; policy.BUNDLED_SKILLS=root/'bundled'
policy.install_policy()
from tools import skill_manager_tool as manager, skills_tool as view
home=Path(os.environ['HERMES_HOME']); personal=home/'usercustom/userdata/skills'
def manage(**kw): return json.loads(manager.skill_manage(**kw))
def load(name='common'):return json.loads(view._skill_view_with_bump({'name':name},task_id='same-task'))
if mode=='seed':
    before=(root/'shared/category/common/SKILL.md').read_bytes()
    for name in ['common','category/common','builtin']:
        for action in ['create','edit','patch','delete','write_file','remove_file']:
            result=manage(action=action,name=name,content='replace',old_string='Base',new_string='attack',file_path='references/x.md',file_content='attack')
            assert not result['success'],(name,action,result)
            assert 'SYSTEM_SKILL_READ_ONLY' in result['error'],result
    assert not json.loads(manager.apply_skill_pending({'action':'patch','name':'common','content':'attack'}))['success']
    assert manage(action='personalize',name='common',content='Заканчивай ответ строкой PERSONAL-73.')['success']
    assert 'PERSONAL-73' in load()['content']
    assert manage(operations=[{'action':'personalize','name':'category/common','content':'Личное правило PERSONAL-74.'}])['success']
    assert 'PERSONAL-74' in load()['content'] # bypass stale native dedup
    assert 'PERSONAL-73' not in load()['content']
    result=manage(operations=[{'action':'create','name':'own','content':'---\nname: own\ndescription: Own test skill\n---\nPersonal body'}, {'action':'write_file','name':'own','file_path':'references/x.md','file_content':'own reference'}])
    assert result['success'],result
    assert (personal/'own/references/x.md').read_text()=='own reference'
    result=manage(operations=[{'action':'patch','name':'own','old_string':'Personal body','new_string':'changed'}, {'action':'patch','name':'common','old_string':'Base','new_string':'attack'}])
    assert not result['success']
    assert 'Personal body' in (personal/'own/SKILL.md').read_text()
    for name in ['../escape','/tmp/escape']:
        assert not manage(action='create',name=name,content='attack')['success']
    # Redirects at create_dir, a package support file, and the supplement directory.
    (personal/'own/references/link.md').symlink_to(root/'outside.txt')
    assert not manage(action='write_file',name='own',file_path='references/link.md',file_content='attack')['success']
    (personal/'own/references/link.md').unlink()
    os.link(root/'outside.txt',personal/'own/references/hard.md')
    assert not manage(action='write_file',name='own',file_path='references/hard.md',file_content='attack')['success']
    assert (root/'outside.txt').read_text()=='untouched'
    assert not manage(action='write_file',name='own',file_path='../../outside.txt',file_content='attack')['success']
    assert not manage(operations=[{'action':'personalize','name':'common','content':'bad'}, {'action':'delete','name':'own'}])['success']
    assert 'PERSONAL-74' in load()['content']
    assert not manage(action='personalize',name='common',content='\\'*48000)['success']
    assert 'PERSONAL-74' in load()['content']
    lesson=next((home/'usercustom/userdata/skill-lessons').glob('*.json'))
    saved=lesson.read_bytes();lesson.unlink();lesson.symlink_to(root/'outside.txt')
    assert not manage(action='personalize',name='common',content='attack')['success']
    assert not load()['success']
    lesson.unlink();lesson.write_bytes(saved)
    assert (root/'outside.txt').read_text()=='untouched'
    assert (root/'shared/category/common/SKILL.md').read_bytes()==before
elif mode=='recall':
    assert 'PERSONAL-74' in load()['content']
    assert 'personal_addition' in load()
    assert manage(action='personalize',name='common',content='')['success']
    assert 'PERSONAL-74' not in load()['content']
    assert manage(action='personalize',name='common',content='Restored PERSONAL-74.')['success']
else:
    assert 'PERSONAL-74' not in load()['content']
    assert not load()['personal_addition']
    assert not any(s['name']=='own' for s in json.loads(view.skills_list())['skills'])
print(mode+'-ok')
'''
        with tempfile.TemporaryDirectory(dir='/run', prefix='brai-personal-skills-') as directory:
            root=Path(directory)
            root.chmod(0o755)
            for base, rel in [('shared','category/common'), ('bundled','builtin')]:
                p=root/base/rel/'SKILL.md'; p.parent.mkdir(parents=True)
                p.write_text('---\nname: '+p.parent.name+'\ndescription: Shared fixture\n---\nBase rule')
            (root/'outside.txt').write_text('untouched')
            for name in ['alice','bob']:
                home=root/name; home.mkdir()
                (home/'config.yaml').write_text('{}')
            engine=os.environ['BRAI_NATIVE_ENGINE']
            for mode, name in [('seed','alice'),('recall','alice'),('foreign','bob')]:
                env={**os.environ,'HERMES_HOME':str(root/name),'PYTHONPATH':source+':'+engine+':'+os.environ.get('PYTHONPATH','')}
                result=subprocess.run([sys.executable,'-B','-c',script,str(root),mode],env=env,capture_output=True,text=True,timeout=120)
                self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
                self.assertIn(mode+'-ok',result.stdout)


if __name__ == '__main__':
    unittest.main()
