// ABOUTME: Проверяет конфигурацию запуска и отказ авторизации шлюза памяти.
// ABOUTME: Не запускает root-процесс и не обращается к рабочей памяти.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const options = { cwd: root, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } };

test('CLI проверяет конфиг и не доверяет отказу broker', () => {
  const script = String.raw`
from unittest.mock import patch
from services.hermes.identity import memory_gateway as g
config = {'registryPath':'/etc/test/registry', 'upstream':'http://127.0.0.1:8001',
          'authorizationSocket':'/run/test/auth', 'cursorKey':'ab'*32,
          'socketPath':'/run/test/memory', 'adminSocket':'/run/test/admin'}
assert g.validate_config(config)['cursorKey'] == bytes.fromhex('ab'*32)
q = {'userId':'quarantine-'+'a'*64, 'profileId':'a'*64, 'homeScope':'b'*64,
     'memoryEpoch':'c'*64, 'cubes':['История Куб', 'unknown']}
validated = g.validate_config({**config, 'quarantineProfile':q})
assert validated['quarantineProfile']['_quarantine'] is True
assert g.physical_cube(validated['quarantineProfile'], 'История Куб') == 'a'*64 + '__История Куб'
for key, value in [('upstream','http://example.org:80'), ('socketPath','../bad'),
                   ('adminSocket','/run/test/memory'), ('cursorKey','bad')]:
    bad = {**config, key:value}
    try:
        g.validate_config(bad)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid configuration accepted')
with patch.object(g, 'load_registry', side_effect=ValueError('broken')):
    assert g.broker_authorizer('/etc/test/registry', '/run/test/auth')('u','p') is False
profile = {'userId':'u', 'profileId':'p', 'status':'active'}
class FakeSocket:
    peer = 0
    result = b'{"jsonrpc":"2.0","id":1,"result":{"allowed":true}}\n'
    def __init__(self, *args): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, value): pass
    def getsockopt(self, *args): return g.struct.pack('3i', 10, self.peer, 10)
    def sendall(self, value): pass
    def recv(self, count): return self.result
with patch.object(g, 'load_registry', return_value={123:profile}), patch.object(g.socket, 'socket', FakeSocket):
    check = g.broker_authorizer('/etc/test/registry', '/run/test/auth')
    assert check('u','p') is True
    FakeSocket.peer = 123
    assert check('u','p') is False
    FakeSocket.peer = 0
    FakeSocket.result = b'{"jsonrpc":"2.0","id":1,"result":{"allowed":1}}\n'
    assert check('u','p') is False
`;
  execFileSync('python3', ['-B', '-c', script], options);
});

test('CLI показывает справку без запуска root-сервера', () => {
  execFileSync('python3', ['-B', '-m', 'services.hermes.identity.memory_gateway', '--help'], options);
});
