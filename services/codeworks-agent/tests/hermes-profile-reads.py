# ABOUTME: Проверяет чтение инструкций managed Hermes без shell, credential roots и записи.
# ABOUTME: Проходит настоящий bootstrap/dispatch; ссылки наружу и traversal отклоняются.
import json
import os
from pathlib import Path
import runpy
import tempfile

state = runpy.run_path(str(Path(__file__).with_name('hermes-private.py')))
mod, registry = state['mod'], state['Registry']()
state['registry'].registry = registry
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    profile = root / 'profile'
    custom = profile / 'usercustom/hermescustom'
    custom.mkdir(parents=True)
    index = custom / 'INDEX.md'
    index.write_text('# Index\nRead BASE.md\n')
    skill = profile / 'skills/test'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('# Skill\n!`touch /tmp/should-never-run`\n')
    secret = root / 'auth.md'
    secret.write_text('private')
    (custom / 'escape.md').symlink_to(secret)
    (profile / 'state.md').symlink_to(secret)
    (profile / 'auth.json').write_text('private')
    (custom / 'large.md').write_text('x' * 262145)
    bootstrap = root / 'bootstrap'
    bootstrap.write_text(json.dumps({'key': '12' * 32, 'env': {
        'HERMES_HOME': str(profile), 'CODEWORKS_HERMES_PROFILE_READS': '1'}}))
    transport = os.dup(os.open('/dev/null', os.O_RDONLY))
    mod.install(bootstrap, transport)
    read = lambda path: json.loads(registry.dispatch('codeworks', {'action': 'read', 'path': str(path)}, session_id='native-session'))
    assert read(index)['content'] == index.read_text()
    assert read(index)['sha256']
    for path in (custom / 'escape.md', profile / 'state.md', custom / '../hermescustom/INDEX.md', profile / 'auth.json', custom / 'large.md'):
        assert read(path) == {'error': 'PROFILE_DOCUMENT_DENIED'}, path
    assert json.loads(registry.dispatch('codeworks', {'action': 'read', 'path': str(index)})) == {'error': 'NATIVE_SESSION_REQUIRED'}
    result = json.loads(registry.dispatch('skill_view', {'name': 'test'}))
    assert result['success'] and '!`touch' in result['content']
    for args in ({'name': '../usercustom'}, {'name': 'test', 'file_path': '../../auth.json'}, {'name': '/etc'}, {'name': 'test', 'file_path': str(secret)}):
        assert not json.loads(registry.dispatch('skill_view', args))['success']
    for name in ('terminal', 'python', 'execute_code', 'read_file', 'skill_manage'):
        assert 'NATIVE_TOOL_DISABLED' in registry.dispatch(name, {})
    agent = state['AIAgent']()
    assert agent.valid_tool_names == {'codeworks', 'skill_view'}
print('PASS opt-in profile instruction reads, skill text without execution, native session, traversal/symlink/size/credential denial')
