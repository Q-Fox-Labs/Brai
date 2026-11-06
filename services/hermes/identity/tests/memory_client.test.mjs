// ABOUTME: Проверяет транспорт клиента MemOS через настоящий Unix-сокет.
// ABOUTME: Использует временный сокет и синтетический HTTP-сервер без MemOS.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const options = { cwd: root, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } };

test('Unix-сокет не обращается к TCP и возвращает ответ сервера', () => {
  const script = String.raw`
import importlib.util, os, socketserver, tempfile, threading
from http.server import BaseHTTPRequestHandler
spec = importlib.util.spec_from_file_location('client', 'services/hermes/extensions/plugins/memos-rest/client.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
legacy = client.Client({'base_url':'http://127.0.0.1:8001', 'user_id':'u', 'cube_id':'c'})
assert not legacy.unix_socket
for invalid in ('relative.sock', 0, False, '/tmp/invalid\x00socket'):
    try:
        client.Client({'socket_path':invalid, 'user_id':'u', 'cube_id':'c'})
    except ValueError:
        pass
    else:
        raise AssertionError('invalid socket path accepted')
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', 'http://127.0.0.1:1/foreign')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"code":200,"data":{"ok":true}}')
    def log_message(self, *args):
        pass
with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, 'memory.sock')
    with socketserver.UnixStreamServer(path, Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            api = client.Client({'socket_path':path, 'user_id':'u', 'cube_id':'c'})
            value = api.health()
            assert value['data']['ok'] is True
            try:
                api.request('/redirect')
            except client.MemOSError:
                pass
            else:
                raise AssertionError('redirect accepted')
            api._request_json = lambda *args, **kwargs: {'data': {}}
            for operation in (lambda: api.get({}), lambda: api.indexed_search(
                    'test', cubes=['c'], scope={}, author_id='u')):
                try:
                    operation()
                except client.MemOSError:
                    pass
                else:
                    raise AssertionError('secure transport accepted missing capabilities')
        finally:
            server.shutdown()
            thread.join()
`;
  execFileSync('python3', ['-c', script], options);
});

test('сохранён прежний потоковый протокол и legacy fallback', () => {
  execFileSync('python3', ['services/hermes/extensions/plugins/memos-rest/tests/test_stream_transport.py'], options);
});

test('реестр отклоняет конфликты профилей и неподтверждённый путь', () => {
  const script = String.raw`
import importlib.util, json, tempfile
spec = importlib.util.spec_from_file_location('registry', 'services/hermes/identity/memory_registry.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
one = {'userId':'u1', 'profileId':'p1', 'telegramId':'101', 'home':'/srv/user1', 'homeScope':'h1', 'memoryEpoch':'e1',
       'authorId':'a1', 'cubes':['main'], 'status':'active'}
two = {**one, 'userId':'u2', 'profileId':'p2', 'telegramId':'102', 'home':'/srv/user2', 'authorId':'a2'}
registry = {'version':1, 'profiles':{'1001':one, '1002':two}}
try:
    module.parse_registry(json.dumps(registry))
except ValueError:
    pass
else:
    raise AssertionError('conflicting scope accepted')
two['homeScope'] = 'h2'
assert module.parse_registry(json.dumps(registry))[1002]['userId'] == 'u2'
for raw in ('{"version":1,"version":1,"profiles":{}}',
            json.dumps({'version':1, 'profiles':{'0':one}}),
            json.dumps({'version':1, 'profiles':{'1001':one, '1002':{**two, 'profileId':'p1'}}}),
            json.dumps({'version':1, 'profiles':{'1001':one, '1002':{**two, 'userId':'u1'}}}),
            json.dumps({'version':1, 'profiles':{'1001':one, '1002':{**two, 'telegramId':'101'}}})):
    try:
        module.parse_registry(raw)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid registry accepted')
with tempfile.NamedTemporaryFile() as source:
    try:
        module.load_registry(source.name)
    except ValueError:
        pass
    else:
        raise AssertionError('unprotected registry path accepted')
`;
  execFileSync('python3', ['-c', script], options);
});
