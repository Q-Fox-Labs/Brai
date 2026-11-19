# ABOUTME: Проверяет credential RPC, durable unknown и закрытую выдачу access.
# ABOUTME: Использует только синтетические credentials, fake CLI и временные UDS.
"""Запуск: python3 -B -m unittest discover -s services/bug-hunt/credentials."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


def module(name, path):
    """Загрузить продуктовый модуль без установки пакетов и чужих импортов."""
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


HERE = Path(__file__).parent
helper = module('credential_helper_test', HERE / 'helper.py')
client = module('credential_client_test', HERE / 'client.py')
SOURCE = 'a' * 64


class FakeOwner:
    """Представить синтетического owner со счётчиками refresh/read-only вызовов."""

    def __init__(self, home):
        self.CODEX_HOME = home / '.codex'
        self.CODEX_HOME.mkdir(mode=0o700)
        self.calls, self.refreshes = [], 0
        self.operation = None
        self.write('synthetic.old.access', fresh=False)

    def write(self, access, *, fresh=True, account='synthetic-account'):
        """Атомарно заменить fake state, как при обычном сохранении credential."""
        temporary = self.CODEX_HOME / 'auth.next'
        temporary.write_text(json.dumps({'api_key': access, 'account_id': account,
                                         'expires_at': int(time.time()) + (3600 if fresh else -1)}))
        temporary.replace(self.CODEX_HOME / 'auth.json')

    def snapshot(self):
        """Прочитать только синтетические metadata access текущего теста."""
        return json.loads((self.CODEX_HOME / 'auth.json').read_text())

    def resolve(self, *, read_only=False):
        """Имитировать политику owner без второго настоящего refresh механизма."""
        self.calls.append(read_only)
        if self.operation:
            return self.operation(read_only)
        value = self.snapshot()
        if value['expires_at'] <= time.time() + 120:
            if read_only:
                raise ValueError('CODEX_OWNER_ACCESS_EXPIRED')
            self.refreshes += 1
            self.write('synthetic.new.access')
        return self.snapshot()


class Fixture(unittest.TestCase):
    """Дать каждому сценарию отдельный private state без настоящего аккаунта."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bh-cred-')
        self.root = Path(self.temporary.name)
        self.owner = FakeOwner(self.root)
        self.state_root = self.root / 'state'
        self.state_root.mkdir(mode=0o700)
        self.state = helper.CredentialState(self.owner, self.state_root, SOURCE)
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.stop()
            self.server_thread.join(5)
            self.assertFalse(self.server_thread.is_alive())
        self.state.close()
        self.temporary.cleanup()

    def restart(self):
        """Открыть сохранённый state после предыдущего запуска helper."""
        self.state.close()
        self.state = helper.CredentialState(self.owner, self.state_root, SOURCE)

    def start_server(self, peer_uid=None):
        """Запустить настоящий AF_UNIX socket с kernel peer credentials."""
        self.path = str(self.root / 'socket')
        listener = helper.make_listener(self.path)
        self.server = helper.Server(self.state, listener, os.getuid() if peer_uid is None else peer_uid)
        self.server_thread = threading.Thread(target=self.server.serve)
        self.server_thread.start()

    def request(self, value):
        """Передать один JSON-RPC вызов через настоящий закрытый socket."""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(self.path)
            connection.sendall(json.dumps(value).encode() + b'\n')
            with connection.makefile('rb') as source:
                return json.loads(source.readline())


class StateTests(Fixture):
    """Проверить допуск refresh, binding fences и unknown после crash."""

    def test_fresh_access_does_not_refresh_and_state_has_no_credentials(self):
        self.owner.write('synthetic.private.access')
        status = self.state.status()
        self.assertTrue(status['ready'])
        self.assertNotIn('access', status)
        result = self.state.resolve(status['binding'])
        self.assertEqual(result['access'], 'synthetic.private.access')
        self.assertEqual(self.owner.calls, [True])
        self.assertEqual(self.owner.refreshes, 0)
        on_disk = ''.join(path.read_text() for path in self.state_root.iterdir())
        self.assertNotIn('synthetic.private.access', on_disk)
        self.assertNotIn('synthetic-account', on_disk)

    def test_refresh_rotates_binding_and_fences_old_phase(self):
        old = self.state.status()['binding']
        with self.assertRaisesRegex(helper.Rejected, '^HELPER_BINDING_CHANGED$'):
            self.state.resolve(old)
        status = self.state.status()
        self.assertNotEqual(status['binding'], old)
        self.assertTrue(status['ready'])
        self.assertEqual(self.state.resolve(status['binding'])['access'], 'synthetic.new.access')
        self.assertEqual(self.owner.refreshes, 1)

    def test_unfenced_preflight_refresh_returns_new_binding(self):
        previous = self.state.status()['binding']
        result = self.state.resolve()
        self.assertNotEqual(result['binding'], previous)
        self.assertEqual(result['baseUrl'], helper.BASE_URL)
        self.assertEqual(result['sourceRef'], SOURCE)

    def test_wrong_binding_rejects_before_owner_resolve(self):
        with self.assertRaisesRegex(helper.Rejected, 'HELPER_BINDING_CHANGED'):
            self.state.resolve('other-phase')
        self.assertEqual(self.owner.calls, [])

    def test_account_race_rejects_before_access_output(self):
        self.owner.write('synthetic.fresh.access')
        binding = self.state.status()['binding']

        def replace(read_only):
            self.owner.write('synthetic.other.access', account='other-account')
            return self.owner.snapshot()

        self.owner.operation = replace
        with self.assertRaisesRegex(helper.Rejected, 'HELPER_BINDING_CHANGED'):
            self.state.resolve(binding)
        self.assertEqual(self.state.status()['accountId'], 'other-account')

    def test_external_touch_and_source_change_rotate_binding_across_restart(self):
        self.owner.write('synthetic.fresh.access')
        binding = self.state.status()['binding']
        os.utime(self.owner.CODEX_HOME / 'auth.json', ns=(1, 1))
        touched = self.state.status()['binding']
        self.assertNotEqual(touched, binding)
        self.restart()
        self.assertEqual(self.state.status()['binding'], touched)
        self.state.source_ref = 'b' * 64
        self.assertNotEqual(self.state.status()['binding'], touched)

    def test_missing_then_restored_owner_invalidates_phase(self):
        self.owner.write('synthetic.fresh.access')
        binding = self.state.status()['binding']
        path = self.owner.CODEX_HOME / 'auth.json'
        backup = self.owner.CODEX_HOME / 'backup'
        path.rename(backup)
        self.assertFalse(self.state.status()['ready'])
        backup.rename(path)
        self.assertNotEqual(self.state.status()['binding'], binding)

    def test_busy_proves_no_refresh_and_can_retry(self):
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(ValueError('CODEX_OWNER_BUSY'))
        with self.assertRaisesRegex(helper.Rejected, '^CODEX_OWNER_BUSY$'):
            self.state.resolve()
        self.assertIsNone(json.loads((self.state_root / 'state.json').read_text())['attempt'])
        self.owner.operation = None
        self.assertIn('access', self.state.resolve())

    def test_unknown_and_restart_never_blindly_repeat_refresh(self):
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(ValueError('CODEX_OWNER_TIMEOUT'))
        with self.assertRaisesRegex(helper.Rejected, '^OWNER_OUTCOME_UNKNOWN$'):
            self.state.resolve()
        self.restart()
        self.owner.operation = None
        self.assertEqual(self.state.status()['code'], 'OWNER_OUTCOME_UNKNOWN')
        with self.assertRaisesRegex(helper.Rejected, '^OWNER_OUTCOME_UNKNOWN$'):
            self.state.resolve()
        self.assertEqual(self.owner.calls, [False, True])
        self.assertEqual(self.owner.refreshes, 0)
        self.owner.write('synthetic.saved.after.unknown')
        recovered = self.state.resolve()
        self.assertEqual(recovered['access'], 'synthetic.saved.after.unknown')
        self.assertTrue(self.state.status()['ready'])

    def test_pending_after_process_interruption_is_unknown_on_restart(self):
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.state.resolve()
        self.restart()
        self.owner.operation = None
        with self.assertRaisesRegex(helper.Rejected, 'OWNER_OUTCOME_UNKNOWN'):
            self.state.resolve()
        self.assertEqual(self.owner.calls, [False, True])

    def test_lost_refresh_ack_recovers_only_by_read_only(self):
        def save_and_lose_ack(read_only):
            self.owner.write('synthetic.saved.access')
            raise ValueError('CODEX_OWNER_RPC_REJECTED')

        self.owner.operation = save_and_lose_ack
        with self.assertRaisesRegex(helper.Rejected, 'OWNER_OUTCOME_UNKNOWN'):
            self.state.resolve()
        self.owner.operation = None
        self.assertEqual(self.state.resolve()['access'], 'synthetic.saved.access')
        self.assertEqual(self.owner.calls, [False, True])

    def test_same_access_cannot_resolve_unknown_even_when_expiry_changes(self):
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(ValueError('CODEX_OWNER_RPC_REJECTED'))
        with self.assertRaises(helper.Rejected):
            self.state.resolve()
        self.owner.operation = None
        self.owner.write('synthetic.old.access', fresh=True)
        with self.assertRaisesRegex(helper.Rejected, 'OWNER_OUTCOME_UNKNOWN'):
            self.state.resolve()

    def test_unreadable_owner_keeps_unknown_after_restart(self):
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(ValueError('CODEX_OWNER_TIMEOUT'))
        with self.assertRaises(helper.Rejected):
            self.state.resolve()
        self.restart()
        (self.owner.CODEX_HOME / 'auth.json').unlink()
        self.assertEqual(self.state.status()['code'], 'OWNER_OUTCOME_UNKNOWN')
        with self.assertRaisesRegex(helper.Rejected, 'OWNER_OUTCOME_UNKNOWN'):
            self.state.resolve()
        self.assertEqual(self.owner.calls, [False])

    def test_parallel_requests_refresh_once(self):
        entered, release = threading.Event(), threading.Event()

        def resolve(read_only):
            if not read_only:
                self.owner.refreshes += 1
                entered.set()
                self.assertTrue(release.wait(5))
                self.owner.write('synthetic.parallel.access')
            return self.owner.snapshot()

        self.owner.operation = resolve
        results = []
        first = threading.Thread(target=lambda: results.append(self.state.resolve()))
        second = threading.Thread(target=lambda: results.append(self.state.resolve()))
        first.start()
        self.assertTrue(entered.wait(5))
        second.start()
        release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(len(results), 2)
        self.assertEqual(self.owner.refreshes, 1)
        self.assertEqual(results[0]['binding'], results[1]['binding'])

    def test_singleton_and_corrupt_state_fail_closed(self):
        with self.assertRaises(BlockingIOError):
            helper.CredentialState(self.owner, self.state_root, SOURCE)
        self.state.close()
        (self.state_root / 'state.json').write_text('{"secret":"not-a-state"}')
        with self.assertRaises(helper.Rejected):
            helper.CredentialState(self.owner, self.state_root, SOURCE)
        (self.state_root / 'state.json').unlink()
        self.state = helper.CredentialState(self.owner, self.state_root, SOURCE)


class RpcTests(Fixture):
    """Проверить настоящие UDS peers, протокол и ошибки JSON-RPC."""

    def test_jsonrpc_parse_invalid_method_params_batch_and_notifications(self):
        def execute(value):
            return helper.parse_line(json.dumps(value).encode(), self.state)

        self.assertEqual(helper.parse_line(b'{bad\n', self.state)['error']['code'], -32700)
        self.assertEqual(helper.parse_line(b'NaN\n', self.state)['error']['code'], -32700)
        for invalid in (None, 1, {}, [], {'jsonrpc': '2.0', 'method': 1, 'id': 'x'},
                        {'jsonrpc': '2.0', 'method': 'credentials.status', 'id': True}):
            self.assertEqual(execute(invalid)['error']['code'], -32600)
        unknown = execute({'jsonrpc': '2.0', 'method': 'other', 'id': 'keep'})
        self.assertEqual(unknown['id'], 'keep')
        self.assertEqual(unknown['error']['code'], -32601)
        for params in ([], {'extra': 1}, {'expectedBinding': ''}, {'expectedBinding': None}):
            response = execute({'jsonrpc': '2.0', 'method': 'credentials.resolve', 'id': 5, 'params': params})
            self.assertEqual(response['id'], 5)
            self.assertEqual(response['error']['code'], -32602)
        notice = {'jsonrpc': '2.0', 'method': 'credentials.status', 'params': {}}
        self.assertIsNone(execute(notice))
        self.assertIsNone(execute([notice, {'jsonrpc': '2.0', 'method': 'absent'}]))
        result = execute([notice, dict(notice, id='a'), 3, []])
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]['id'], 'a')
        self.assertEqual(result[1]['error']['code'], -32600)
        self.assertEqual(result[2]['error']['code'], -32600)

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux SO_PEERCRED is required')
    def test_real_uds_status_and_fixed_peer(self):
        self.start_server()
        response = self.request({'jsonrpc': '2.0', 'method': 'credentials.status', 'id': 'one', 'params': {}})
        self.assertEqual(response['id'], 'one')
        self.assertNotIn('access', response['result'])
        self.assertEqual(self.owner.calls, [])

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux SO_PEERCRED is required')
    def test_real_uds_rejects_wrong_peer_before_resolve(self):
        self.start_server(os.getuid() + 1)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(self.path)
            try:
                connection.sendall(b'{"jsonrpc":"2.0","method":"credentials.resolve","id":"x"}\n')
                self.assertEqual(connection.recv(4096), b'')
            except ConnectionResetError:
                pass
        self.assertEqual(self.owner.calls, [])

    def test_disconnect_and_shutdown_do_not_cancel_local_resolve(self):
        entered, release = threading.Event(), threading.Event()

        def resolve(read_only):
            entered.set()
            self.assertTrue(release.wait(5))
            self.owner.write('synthetic.saved.without.client')
            return self.owner.snapshot()

        self.owner.operation = resolve
        self.start_server()
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(self.path)
        connection.sendall(b'{"jsonrpc":"2.0","method":"credentials.resolve","id":"lost"}\n')
        self.assertTrue(entered.wait(5))
        connection.close()
        self.server.stop()
        release.set()
        self.server_thread.join(5)
        self.assertFalse(self.server_thread.is_alive())
        self.assertEqual(self.owner.snapshot()['api_key'], 'synthetic.saved.without.client')
        self.assertIsNone(json.loads((self.state_root / 'state.json').read_text())['attempt'])
        self.server = None

    def test_inherited_listener_is_validated(self):
        path = str(self.root / 'inherited')
        listener = helper.make_listener(path)
        adopted = helper.make_listener(path, os.dup(listener.fileno()))
        self.assertFalse(adopted.get_inheritable())
        adopted.close()
        with self.assertRaises(helper.Rejected):
            helper.make_listener(str(self.root / 'wrong'), os.dup(listener.fileno()))
        listener.close()

    def test_shutdown_closes_partial_idle_request(self):
        self.start_server()
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(self.path)
        connection.sendall(b'{"jsonrpc":"2.0","method":')
        self.server.stop()
        self.server_thread.join(5)
        self.assertFalse(self.server_thread.is_alive())
        connection.close()
        self.assertEqual(self.owner.calls, [])
        self.server = None

    def test_client_stdout_is_only_access_and_binding_failure_is_silent(self):
        self.owner.write('synthetic.auth.command.access')
        self.start_server()
        binding = self.state.status()['binding']
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = client.main(['--socket', self.path, '--binding', binding])
        self.assertEqual((code, stdout.getvalue(), stderr.getvalue()), (0, 'synthetic.auth.command.access\n', ''))
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = client.main(['--socket', self.path, '--binding', 'old-binding'])
        self.assertEqual((code, stdout.getvalue(), stderr.getvalue()), (1, '', 'HELPER_BINDING_CHANGED\n'))

    def test_malicious_reply_or_exception_never_reaches_stdout_or_diagnostics(self):
        self.owner.write('synthetic.fresh.access')
        self.owner.operation = lambda read_only: (_ for _ in ()).throw(ValueError('SYNTHETIC_SECRET_IN_EXCEPTION'))
        packet = helper.dispatch({'jsonrpc': '2.0', 'method': 'credentials.resolve', 'id': 'x'}, self.state)
        self.assertEqual(packet['error']['message'], 'HELPER_REJECTED')
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(packet))
        path = str(self.root / 'bad-reply')
        listener = helper.make_listener(path)

        def reply():
            connection, _ = listener.accept()
            with connection, connection.makefile('rb') as source:
                source.readline()
                value = {'access': 'SYNTHETIC_BEARER', 'binding': 'different-binding',
                         'accountId': 'fake-account', 'expiresAt': int(time.time()) + 3600,
                         'baseUrl': helper.BASE_URL, 'sourceRef': SOURCE}
                connection.sendall(json.dumps({'jsonrpc': '2.0', 'id': 'credential', 'result': value}).encode() + b'\n')
            listener.close()

        thread = threading.Thread(target=reply)
        thread.start()
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = client.main(['--socket', path, '--binding', 'expected-binding'])
        thread.join(5)
        self.assertEqual((code, stdout.getvalue(), stderr.getvalue()), (1, '', 'HELPER_REJECTED\n'))

    def test_actual_sigterm_drains_resolve_without_output(self):
        directory = self.root / 'signal'
        directory.mkdir(mode=0o700)
        program = '''import importlib.util,json,signal,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('signal_fixture',sys.argv[1])
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
root=Path(sys.argv[2]);owner=fixture.FakeOwner(root)
state_root=root/'state';state_root.mkdir(mode=0o700)
state=fixture.helper.CredentialState(owner,state_root,fixture.SOURCE)
def operation(read_only):
    (root/'entered').write_text('1')
    while not (root/'release').exists(): time.sleep(.01)
    owner.write('synthetic.sigterm.saved.access')
    return owner.snapshot()
owner.operation=operation
listener=fixture.helper.make_listener(str(root/'socket'))
server=fixture.helper.Server(state,listener,__import__('os').getuid())
def stop(number,frame):
    server.stop();(root/'signal-seen').write_text('1')
signal.signal(signal.SIGTERM,stop)
(root/'ready').write_text('1')
server.serve();state.close()
'''
        process = subprocess.Popen([sys.executable, '-B', '-c', program, str(HERE / 'test_credentials.py'), str(directory)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def wait_for(path):
            deadline = time.monotonic() + 5
            while not path.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(path.exists(), path.name)

        try:
            wait_for(directory / 'ready')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.connect(str(directory / 'socket'))
                connection.sendall(b'{"jsonrpc":"2.0","method":"credentials.resolve","id":"signal"}\n')
                wait_for(directory / 'entered')
            process.send_signal(signal.SIGTERM)
            wait_for(directory / 'signal-seen')
            self.assertIsNone(process.poll())
            (directory / 'release').write_text('1')
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual((process.returncode, stdout, stderr), (0, b'', b''))
            saved = json.loads((directory / '.codex/auth.json').read_text())
            self.assertEqual(saved['api_key'], 'synthetic.sigterm.saved.access')
            self.assertIsNone(json.loads((directory / 'state/state.json').read_text())['attempt'])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_isolated_python_client(self):
        self.owner.write('synthetic.isolated.client.access')
        self.start_server()
        binding = self.state.status()['binding']
        process = subprocess.run([sys.executable, '-I', '-S', '-B', str(HERE / 'client.py'),
                                  '--socket', self.path, '--binding', binding], capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(process.stdout, b'synthetic.isolated.client.access\n')
        self.assertEqual(process.stderr, b'')


class RealOwnerTests(Fixture):
    """Загрузить неизменённый owner с синтетическим state и fake stdio CLI."""

    def test_real_owner_fake_cli_refresh_and_fresh_without_shared_lock(self):
        path = HERE.parents[1] / 'hermes/extensions/tools/codex_cli_owner.py'
        owner = module('unchanged_credential_owner_test', path)
        home = self.root / 'real-owner'
        home.mkdir(mode=0o700)
        codex_home = home / '.codex'
        codex_home.mkdir(mode=0o700)
        owner.HOME, owner.CODEX_HOME = home, codex_home
        owner.LOCK = codex_home / 'hermes-owner.lock'
        binary = home / 'fake-codex'
        binary.write_text('''#!/usr/bin/python3
import base64,json,os,time
from pathlib import Path
root=Path(os.environ['CODEX_HOME'])
for line in __import__('sys').stdin:
    request=json.loads(line)
    if request.get('method')=='initialize':
        print(json.dumps({'id':request['id'],'result':{}}),flush=True)
    elif request.get('method')=='account/read':
        claims={'exp':int(time.time())+3600,'https://api.openai.com/auth':{'chatgpt_account_id':'fake-account'}}
        part=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        value={'tokens':{'access_token':'new.'+part+'.signature','account_id':'fake-account'}}
        target=root/'auth.json'
        target.write_text(json.dumps(value));target.chmod(0o600)
        (root/'refresh-count').write_text('1')
        print(json.dumps({'id':request['id'],'result':{'account':{'type':'chatgpt'}}}),flush=True)
''')
        binary.chmod(0o700)
        owner.BINARY = binary
        claims = {'exp': int(time.time()) - 1, 'https://api.openai.com/auth': {'chatgpt_account_id': 'fake-account'}}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        auth = codex_home / 'auth.json'
        auth.write_text(json.dumps({'tokens': {'access_token': 'old.' + payload + '.signature',
                                             'account_id': 'fake-account', 'refresh_token': 'synthetic.refresh.secret'}}))
        auth.chmod(0o600)
        self.state.close()
        self.state = helper.CredentialState(owner, self.state_root, SOURCE)
        with patch.dict(os.environ, {'HOME': str(home), 'CODEX_HOME': str(codex_home)}):
            result = self.state.resolve()
            self.assertTrue(result['access'].startswith('new.'))
            self.assertEqual((codex_home / 'refresh-count').read_text(), '1')
            with owner.owner_lock():
                self.assertEqual(self.state.resolve(result['binding'])['access'], result['access'])
        self.assertNotIn('synthetic.refresh.secret', (self.state_root / 'state.json').read_text())


if __name__ == '__main__':
    unittest.main()
