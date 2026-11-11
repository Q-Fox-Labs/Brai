// ABOUTME: Проверяет checkpoint на синтетическом профиле памяти.
// ABOUTME: Не читает пользовательский runtime и не обращается к сети.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
test('checkpoint разделяет owner и исходных авторов', () => {
  execFileSync('python3', ['-B', '-c', String.raw`
import copy
from services.hermes.identity.memory_gateway import Boundary, Denied
profile = {'userId':'u', 'profileId':'p', 'authorId':'111', 'homeScope':'h',
           'memoryEpoch':'e', 'cubes':['main'], 'status':'active'}
calls = []
class API:
    def request(self, path, body):
        calls.append(copy.deepcopy(body))
        return {'code':200, 'data':[{'cube_id':'p__main', 'memory_id':'m'}]}
boundary = Boundary('', '', authorize=lambda *args:True, cursor_key=b'x',
                    registry_loader=lambda _: {1:profile}, clients=lambda _:API())
info = {'hermes_kind':'checkpoint', 'hermes_author_id':'multiple_or_unknown',
        'hermes_home_scope':'h', 'hermes_memory_epoch':'e'}
body = {'user_id':'u', 'writable_cube_ids':['main'], 'info':info,
        'messages':[{'role':'user','content':'Alice'}, {'role':'assistant','content':'Reply'},
                    {'role':'user','content':'Unknown speaker'}]}
boundary.handle(1, 'POST', '/product/add', body)
stored = calls[-1]['info']
assert stored['hermes_author_id'] == '111'
assert stored['hermes_owner_id'] == 'u' and stored['hermes_profile_id'] == 'p'
assert stored['hermes_source_author_id'] == 'multiple_or_unknown'
assert stored['hermes_checkpoint']['version'] == 1
assert all(row['author_id'] is None for row in stored['hermes_checkpoint']['authors'])
row = {'id':'m', 'metadata':{'user_id':'u', 'info':stored}}
logical = boundary.checked_row(profile, 'main', row)['metadata']['info']
assert logical['hermes_author_id'] == 'multiple_or_unknown'
for field,value in [('hermes_owner_id',None), ('hermes_profile_id','other'), ('hermes_source_author_id','222')]:
    try:
        boundary.checked_row(profile, 'main', {**row, 'metadata':{'user_id':'u', 'info':{**stored, field:value}}})
    except Denied:
        pass
    else:
        raise AssertionError('foreign checkpoint read accepted: ' + field)
for field,value in [('hermes_owner_id','other'), ('hermes_profile_id','other'), ('hermes_author_id','222')]:
    try:
        boundary.handle(1, 'POST', '/product/add', {**body, 'info':{**info, field:value}})
    except Denied:
        pass
    else:
        raise AssertionError('foreign scope accepted: ' + field)
try:
    boundary.handle(1, 'POST', '/product/add', {**body, 'info':{**info, 'hermes_kind':'turn'}})
except Denied:
    pass
else:
    raise AssertionError('turn cannot use checkpoint normalization')
`], { cwd: root, stdio: 'pipe' });
});

test('постоянный checkpoint не блокирует append, correction сохраняет барьер', () => {
  execFileSync('python3', ['-B', '-c', String.raw`
import importlib.util, json, sys, tempfile, types, urllib.error
from pathlib import Path
plugin = Path('services/hermes/extensions/plugins/memos-rest')
package = types.ModuleType('checkpoint_plugin')
package.__path__ = [str(plugin)]
sys.modules[package.__name__] = package
worker = types.ModuleType('agent.memory_provider')
worker.spawn_context_thread = lambda *a, **k: None
sys.modules['agent'] = types.ModuleType('agent')
sys.modules['agent.memory_provider'] = worker
utility = types.ModuleType('utils')
utility.atomic_json_write = lambda path, value, **kwargs: Path(path).write_text(json.dumps(value))
sys.modules['utils'] = utility
for name in ('client', 'outbox'):
    spec = importlib.util.spec_from_file_location(package.__name__ + '.' + name, plugin / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
admin = types.ModuleType(package.__name__ + '.admin')
admin.json_file = lambda path: json.loads(Path(path).read_text()) if Path(path).exists() else {}
sys.modules[admin.__name__] = admin
client = sys.modules[package.__name__ + '.client']
Outbox = sys.modules[package.__name__ + '.outbox'].Outbox
assert client.MemOSError('forbidden', status=403).permanent
for status in (408,409,425,429,500,503):
    assert not client.MemOSError('retry', status=status).permanent
assert not client.MemOSError('HTTP 403 in prose').permanent
transport = client.Client({'base_url':'http://127.0.0.1:1', 'user_id':'u', 'cube_id':'main'})
for status in (400,403,408,429,503):
    class Opener:
        def open(self, *args, **kwargs):
            raise urllib.error.HTTPError('http://127.0.0.1:1', status, 'synthetic', {}, None)
    transport.opener = Opener()
    try:
        transport.request('/product/add', {})
    except client.MemOSError as error:
        assert error.status == status and error.permanent == (status in (400,403))
    else:
        raise AssertionError('HTTP error not translated')
calls = []
class API:
    def execute(self, job, checkpoint):
        calls.append(job['event_id'])
        if job['event_id'] in ('checkpoint', 'correction'):
            raise client.MemOSError('forbidden', status=403)
        return ['saved-' + job['event_id']]
with tempfile.TemporaryDirectory() as directory:
    outbox = Outbox(directory, API())
    def submit(event, kind='turn', **extra):
        outbox.submit(event, {'operation':'route', 'body':{'info':{'hermes_kind':kind}}, **extra})
    submit('checkpoint', 'checkpoint')
    submit('turn')
    submit('correction', delete_filter={'id':'old'})
    submit('after')
    outbox.process_once()
    assert calls == ['checkpoint','turn'], calls
    assert outbox.status()['failed'] == 1 and outbox.status()['pending'] == 2
    assert (outbox.failed / 'checkpoint.json').exists()
    failure = json.loads((outbox.failed / 'checkpoint.json').read_text())
    assert failure['failure_class'] == 'permanent' and failure['attempts'] == 1
    assert outbox.flush(.01, 'checkpoint') is False
    outbox.process_once()
    assert calls == ['checkpoint','turn'], calls
    assert outbox.submit('checkpoint', {}) == 'checkpoint'
    assert not (outbox.pending / 'checkpoint.json').exists()
with tempfile.TemporaryDirectory() as directory:
    outbox = Outbox(directory, API())
    outbox.submit('correction', {'operation':'forget'})
    outbox.submit('after', {'operation':'route', 'body':{'info':{'hermes_kind':'turn'}}})
    outbox.process_once()
    outbox.process_once()
    assert calls == ['checkpoint','turn','correction'], calls
    assert outbox.status()['failed'] == 1 and outbox.status()['pending'] == 1
with tempfile.TemporaryDirectory() as directory:
    attempted = []
    class TemporaryAPI:
        def execute(self, job, checkpoint):
            attempted.append(job['event_id'])
            if job['event_id'] == 'temporary':
                raise client.MemOSError('unavailable', status=503)
            return ['verified']
    outbox = Outbox(directory, TemporaryAPI())
    for event in ('temporary','ready'):
        outbox.submit(event, {'operation':'route', 'body':{'info':{'hermes_kind':'turn'}}})
    outbox.process_once()
    assert attempted == ['temporary','ready']
    assert outbox.status()['pending'] == 1 and outbox.status()['failed'] == 0
    outbox.submit('later', {'operation':'route', 'body':{'info':{'hermes_kind':'turn'}}})
    outbox.process_once()
    assert attempted == ['temporary','ready','later'], attempted
    assert json.loads((outbox.pending / 'temporary.json').read_text())['failure_class'] == 'temporary'
`], { cwd: root, stdio: 'pipe' });
});
