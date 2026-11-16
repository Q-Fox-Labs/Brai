# ABOUTME: Выдаёт access существующего Codex owner через закрытый credential RPC.
# ABOUTME: Не хранит token, не реализует OAuth refresh и сохраняет неизвестный исход.
"""Закрытый JSON-RPC к принятому единственному Codex owner."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import struct
import sys
import threading
import time
import uuid

BASE_URL = 'https://chatgpt.com/backend-api/codex'
SAFE_CODES = {'CODEX_OWNER_REJECTED', 'CODEX_OWNER_BUSY', 'CODEX_OWNER_TIMEOUT',
              'CODEX_OWNER_RPC_REJECTED', 'CODEX_OWNER_REFRESH_REJECTED',
              'CODEX_OWNER_LOGIN_REQUIRED', 'CODEX_OWNER_ACCESS_EXPIRED',
              'CODEX_OWNER_UNAVAILABLE', 'HELPER_BINDING_CHANGED',
              'HELPER_STOPPING', 'HELPER_REJECTED', 'OWNER_OUTCOME_UNKNOWN'}


class Rejected(ValueError):
    """Передать через границу только фиксированный публичный код ошибки."""


def require(condition, code='HELPER_REJECTED'):
    """Отклонить неверный config/state без вывода его содержимого."""
    if not condition:
        raise Rejected(code)


def digest(value):
    """Вычислить fingerprint без сохранения исходного credential."""
    return hashlib.sha256(value.encode()).hexdigest()


def safe_code(error):
    """Заменить чужое исключение фиксированной ошибкой без его текста."""
    return str(error) if str(error) in SAFE_CODES else 'HELPER_REJECTED'


def absolute(value):
    """Принять только явный нормализованный абсолютный путь."""
    require(isinstance(value, str) and os.path.isabs(value)
            and os.path.normpath(value) == value and '\x00' not in value)
    return Path(value)


def root_file(path, expected=None):
    """Прочитать стабильный Root файл через защищённые каталоги."""
    path = absolute(str(path))
    for parent in path.parents:
        item = parent.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and before.st_nlink == 1 and not before.st_mode & 0o022)
        raw = source.read()
        after = os.fstat(source.fileno())
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
    require(identity(before) == identity(after) == identity(path.lstat()))
    if expected is not None:
        require(isinstance(expected, str) and re.fullmatch('[a-f0-9]{64}', expected)
                and hashlib.sha256(raw).hexdigest() == expected)
    return raw


def load_config(path):
    """Прочитать Root вход; полную проверку provider выполняет launcher."""
    value = json.loads(root_file(path))
    require(isinstance(value, dict) and set(value) == {'version', 'socket', 'stateRoot', 'peerUid', 'provider'}
            and type(value['version']) is int and value['version'] == 1
            and type(value['peerUid']) is int and value['peerUid'] > 0)
    absolute(value['socket'])
    absolute(value['stateRoot'])
    require(isinstance(value['provider'], dict))
    require(value['peerUid'] != value['provider'].get('uid'))
    return value


def accepted_owner(provider):
    """Загрузить принятый resolver по hash после проверки локальной изоляции."""
    p = provider
    require(type(p['uid']) is int and type(p['gid']) is int
            and p['uid'] > 0 and p['gid'] > 0
            and os.geteuid() == p['uid'] and os.getegid() == p['gid']
            and not os.getgroups())
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode)
    paths = {key: absolute(p[key]) for key in
             ('ownerHome', 'codexHome', 'codex', 'node', 'helperPath', 'componentRoot')}
    require(paths['codexHome'] == paths['ownerHome'] / '.codex'
            and paths['helperPath'] == paths['componentRoot'] / 'services/hermes/extensions/tools/codex_cli_owner.py')
    expected_env = {'HOME': p['ownerHome'], 'CODEX_HOME': p['codexHome'],
                    'PATH': str(paths['node'].parent) + ':/usr/bin:/bin',
                    'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    environment = dict(os.environ)
    # AIDEV-NOTE: CPython сам добавляет LC_CTYPE при locale coercion env -i.
    if environment.get('LC_CTYPE') == 'C.UTF-8':
        del environment['LC_CTYPE']
    require(environment == expected_env)
    helper = paths['helperPath']
    # AIDEV-NOTE: Даже неработающая ссылка запускает чужую runtime-ветку импорта.
    require(not os.path.lexists(helper.parent.parent / '.brai-runtime.json'))
    raw = root_file(helper, p['helperSha256'])
    require(re.fullmatch('[a-f0-9]{64}', p['providerSourceReceipt']['sha256']) is not None)
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        mounts[target] = fields[5].split(',')
    target = paths['codexHome'] / 'config.toml'
    require(str(paths['ownerHome']) in mounts and str(paths['codexHome']) in mounts
            and 'rw' in mounts[str(paths['ownerHome'])] and 'rw' in mounts[str(paths['codexHome'])]
            and 'ro' in mounts.get(str(target), []))
    # ownerHome не принадлежит Root; проверка закрытого bind mount идёт отдельно.
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        item = os.fstat(source.fileno())
        require(stat.S_ISREG(item.st_mode) and item.st_uid == 0
                and item.st_nlink == 1 and not item.st_mode & 0o222
                and hashlib.sha256(source.read()).hexdigest() == p['closedConfig']['sha256'])
    root_file(p['closedConfig']['path'], p['closedConfig']['sha256'])
    spec = importlib.util.spec_from_file_location('_accepted_subscription_codex_owner', helper)
    owner = importlib.util.module_from_spec(spec)
    # AIDEV-NOTE: Исполняются проверенные байты, без повторного открытия пути.
    exec(compile(raw, str(helper), 'exec'), owner.__dict__)
    owner.HOME, owner.CODEX_HOME = owner.owner_paths(p['ownerHome'], p['codexHome'])
    owner.BINARY = paths['codex']
    owner.LOCK = owner.CODEX_HOME / 'hermes-owner.lock'
    owner.roots()
    return owner


class CredentialState:
    """Сериализовать допуск и сохранить неизвестный refresh через restart.

    Переданный owner реализует неизменённый snapshot/resolve. Сохраняются только
    fingerprints access/account и identity файла; token не записывается.
    """

    def __init__(self, owner, state_root, source_ref):
        self.owner, self.root, self.source_ref = owner, Path(state_root), source_ref
        self.mutex = threading.Lock()
        self.stopping = False
        item = self.root.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == os.geteuid()
                and item.st_gid == os.getegid() and stat.S_IMODE(item.st_mode) == 0o700)
        self.lock_fd = self._open_private(self.root / 'helper.lock', os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.path = self.root / 'state.json'
            if os.path.lexists(self.path):
                with os.fdopen(self._open_private(self.path, os.O_RDONLY)) as source:
                    self.state = json.load(source)
                self._validate_state()
            else:
                self.state = {'version': 1, 'epoch': uuid.uuid4().hex, 'observed': None, 'attempt': None}
                self._save()
        except BaseException:
            os.close(self.lock_fd)
            raise

    def _open_private(self, path, flags):
        descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            item = os.fstat(descriptor)
            require(stat.S_ISREG(item.st_mode) and item.st_uid == os.geteuid()
                    and item.st_gid == os.getegid() and item.st_nlink == 1
                    and stat.S_IMODE(item.st_mode) == 0o600)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def _validate_state(self):
        value = self.state
        require(isinstance(value, dict) and set(value) == {'version', 'epoch', 'observed', 'attempt'}
                and type(value['version']) is int and value['version'] == 1
                and isinstance(value['epoch'], str) and re.fullmatch('[a-f0-9]{32}', value['epoch']))
        observed = value['observed']
        if observed is not None:
            require(isinstance(observed, dict) and set(observed) == {'sourceRef', 'accountHash', 'accessHash', 'file'}
                    and all(isinstance(observed[key], str) and re.fullmatch('[a-f0-9]{64}', observed[key])
                            for key in ('sourceRef', 'accountHash', 'accessHash'))
                    and isinstance(observed['file'], list) and len(observed['file']) == 5
                    and all(type(number) is int for number in observed['file']))
        attempt = value['attempt']
        if attempt is not None:
            require(isinstance(attempt, dict) and set(attempt) == {'state', 'beforeAccessHash'}
                    and attempt['state'] in ('pending', 'unknown')
                    and isinstance(attempt['beforeAccessHash'], str)
                    and re.fullmatch('[a-f0-9]{64}', attempt['beforeAccessHash']))

    def _save(self):
        temporary = self.root / ('state-' + uuid.uuid4().hex + '.tmp')
        fd = self._open_private(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        try:
            with os.fdopen(fd, 'w') as target:
                json.dump(self.state, target, separators=(',', ':'))
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.lexists(temporary):
                temporary.unlink()

    def close(self):
        """Освободить singleton lock после завершения допущенных вызовов."""
        os.close(self.lock_fd)

    def _snapshot(self):
        path = self.owner.CODEX_HOME / 'auth.json'
        identity = lambda item: [item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns]
        before = identity(path.lstat())
        value = self.owner.snapshot()
        require(before == identity(path.lstat()), 'HELPER_BINDING_CHANGED')
        require(isinstance(value['api_key'], str) and value['api_key']
                and all(33 <= ord(char) <= 126 for char in value['api_key'])
                and isinstance(value['account_id'], str) and value['account_id']
                and all(33 <= ord(char) <= 126 for char in value['account_id'])
                and type(value['expires_at']) is int)
        observed = {'sourceRef': self.source_ref, 'accountHash': digest(value['account_id']),
                    'accessHash': digest(value['api_key']), 'file': before}
        if observed != self.state['observed']:
            self.state.update(epoch=uuid.uuid4().hex, observed=observed)
            self._save()
        return value

    def _metadata(self, value):
        return {'binding': self.state['epoch'], 'accountId': value['account_id'],
                'expiresAt': value['expires_at'], 'baseUrl': BASE_URL, 'sourceRef': self.source_ref}

    def status(self):
        """Вернуть metadata без refresh и без общего owner flock."""
        with self.mutex:
            try:
                require(not self.stopping, 'HELPER_STOPPING')
                value = self._snapshot()
                code = ('OWNER_OUTCOME_UNKNOWN' if self.state['attempt'] else
                        'READY' if value['expires_at'] > time.time() + 120 else 'CODEX_OWNER_ACCESS_EXPIRED')
                return {**self._metadata(value), 'ready': code == 'READY', 'code': code}
            except Exception as error:
                if self.state['observed'] is not None:
                    self.state.update(epoch=uuid.uuid4().hex, observed=None)
                    self._save()
                code = 'OWNER_OUTCOME_UNKNOWN' if self.state['attempt'] else safe_code(error)
                return {'ready': False, 'code': code, 'binding': None,
                        'accountId': None, 'expiresAt': None, 'baseUrl': BASE_URL, 'sourceRef': self.source_ref}

    def resolve(self, expected_binding=None):
        """Вызвать owner один раз, проверив binding до и после вызова.

        До возможного refresh надёжно сохраняется intent. BUSY доказывает, что
        refresh не начался; прочие ошибки оставляют unknown. Восстановление
        использует только read_only и требует свежего отличающегося access.
        """
        with self.mutex:
            require(not self.stopping, 'HELPER_STOPPING')
            try:
                before = self._snapshot()
            except Exception:
                if self.state['attempt']:
                    raise Rejected('OWNER_OUTCOME_UNKNOWN') from None
                raise
            require(expected_binding is None or expected_binding == self.state['epoch'], 'HELPER_BINDING_CHANGED')
            attempt = self.state['attempt']
            fresh = before['expires_at'] > time.time() + 120
            if not attempt and not fresh:
                self.state['attempt'] = {'state': 'pending', 'beforeAccessHash': digest(before['api_key'])}
                self._save()
            try:
                value = self.owner.resolve(read_only=bool(attempt) or fresh)
                after = self._snapshot()
                require(value['api_key'] == after['api_key'] and value['account_id'] == after['account_id']
                        and value['expires_at'] == after['expires_at'], 'HELPER_BINDING_CHANGED')
                require(after['expires_at'] > time.time() + 120, 'CODEX_OWNER_ACCESS_EXPIRED')
                if attempt:
                    require(digest(after['api_key']) != attempt['beforeAccessHash'], 'OWNER_OUTCOME_UNKNOWN')
            except Exception as error:
                if self.state['attempt']:
                    if not attempt and safe_code(error) == 'CODEX_OWNER_BUSY':
                        self.state['attempt'] = None
                    else:
                        self.state['attempt']['state'] = 'unknown'
                    self._save()
                    if self.state['attempt']:
                        raise Rejected('OWNER_OUTCOME_UNKNOWN') from None
                raise Rejected(safe_code(error)) from None
            if self.state['attempt']:
                self.state['attempt'] = None
                self._save()
            require(expected_binding is None or expected_binding == self.state['epoch'], 'HELPER_BINDING_CHANGED')
            return {**self._metadata(after), 'access': after['api_key']}


def rpc_error(identifier, code, message):
    """Собрать ошибку JSON-RPC без диагностики и чужого содержимого."""
    return {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': code, 'message': message}}


def dispatch(request, credentials):
    """Обработать JSON-RPC single/batch; уведомления не получают ответа."""
    if isinstance(request, list):
        if not request:
            return rpc_error(None, -32600, 'Invalid Request')
        responses = [rpc_error(None, -32600, 'Invalid Request') if isinstance(item, list)
                     else dispatch(item, credentials) for item in request]
        responses = [item for item in responses if item is not None]
        return responses or None
    if not isinstance(request, dict):
        return rpc_error(None, -32600, 'Invalid Request')
    identifier = request.get('id')
    valid_id = identifier is None or isinstance(identifier, (str, int, float)) and not isinstance(identifier, bool)
    if request.get('jsonrpc') != '2.0' or not isinstance(request.get('method'), str) or not valid_id:
        return rpc_error(None, -32600, 'Invalid Request')
    notification = 'id' not in request
    method, params = request['method'], request.get('params', {})
    if method not in ('credentials.status', 'credentials.resolve'):
        response = rpc_error(identifier, -32601, 'Method not found')
    elif (not isinstance(params, dict) or set(params) - ({'expectedBinding'} if method == 'credentials.resolve' else set())
          or 'expectedBinding' in params and (not isinstance(params['expectedBinding'], str) or not params['expectedBinding'])):
        response = rpc_error(identifier, -32602, 'Invalid params')
    else:
        try:
            result = (credentials.status() if method == 'credentials.status'
                      else credentials.resolve(params.get('expectedBinding')))
            response = {'jsonrpc': '2.0', 'id': identifier, 'result': result}
        except Exception as error:
            response = rpc_error(identifier, -32000, safe_code(error))
    return None if notification else response


def parse_line(raw, credentials):
    """Разобрать UTF-8 JSON и вернуть ответ либо молчание для уведомления."""
    try:
        request = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        return rpc_error(None, -32700, 'Parse error')
    return dispatch(request, credentials)


class Server:
    """Обслужить фиксированный peer UID, завершая resolve после разрыва/stop."""

    def __init__(self, credentials, listener, peer_uid):
        self.credentials, self.listener, self.peer_uid = credentials, listener, peer_uid
        self.connections, self.threads = set(), set()
        self.guard = threading.Lock()
        self.stopped = False
        self.wake_read, self.wake_write = socket.socketpair()

    def _connection(self, connection):
        try:
            with connection, connection.makefile('rb') as source:
                while not self.stopped:
                    raw = source.readline()
                    if not raw:
                        break
                    response = parse_line(raw, self.credentials)
                    if response is not None:
                        connection.sendall(json.dumps(response, separators=(',', ':')).encode() + b'\n')
        except Exception:
            pass
        finally:
            with self.guard:
                self.connections.discard(connection)
                self.threads.discard(threading.current_thread())

    def stop(self):
        """Закрыть допуск и peers, сохранив текущий локальный вызов owner."""
        if self.stopped:
            return
        self.stopped = True
        self.credentials.stopping = True
        self.wake_write.send(b'x')

    def serve(self):
        """Принимать только заданный SO_PEERCRED UID до запроса остановки."""
        import selectors
        selector = selectors.DefaultSelector()
        selector.register(self.listener, selectors.EVENT_READ)
        selector.register(self.wake_read, selectors.EVENT_READ)
        try:
            while not self.stopped:
                for key, _ in selector.select():
                    if self.stopped:
                        break
                    if key.fileobj is self.wake_read:
                        continue
                    connection, _ = self.listener.accept()
                    peer_uid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
                    if peer_uid != self.peer_uid:
                        connection.close()
                        continue
                    thread = threading.Thread(target=self._connection, args=(connection,))
                    with self.guard:
                        self.connections.add(connection)
                        self.threads.add(thread)
                    thread.start()
        finally:
            selector.close()
            self.listener.close()
            with self.guard:
                connections, threads = list(self.connections), list(self.threads)
            for connection in connections:
                try:
                    # AIDEV-NOTE: Медленный peer не должен задержать drain на sendall.
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            for thread in threads:
                thread.join()
            self.wake_read.close()
            self.wake_write.close()


def make_listener(path, descriptor=None):
    """Принять Root listener либо создать private socket того же UID для fixture."""
    path = absolute(path)
    if descriptor is not None:
        listener = socket.socket(fileno=descriptor)
        try:
            require(listener.family == socket.AF_UNIX and listener.type == socket.SOCK_STREAM
                    and listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1
                    and listener.getsockname() == str(path))
            listener.set_inheritable(False)
            return listener
        except BaseException:
            listener.close()
            raise
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid()
            and parent.st_gid == os.getegid() and stat.S_IMODE(parent.st_mode) == 0o700
            and not os.path.lexists(path))
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
        os.chmod(path, 0o600)
        listener.listen()
        return listener
    except BaseException:
        listener.close()
        raise


def main():
    """Запуститься по Root входу; при сбое вывести одну фиксированную ошибку."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--listen-fd', type=int)
    args = parser.parse_args()
    credentials = None
    try:
        config = load_config(args.config)
        owner = accepted_owner(config['provider'])
        credentials = CredentialState(owner, config['stateRoot'], config['provider']['providerSourceReceipt']['sha256'])
        listener = make_listener(config['socket'], args.listen_fd)
        server = Server(credentials, listener, config['peerUid'])
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda number, frame: server.stop())
        server.serve()
        return 0
    except Exception:
        sys.stderr.write('HELPER_REJECTED\n')
        return 1
    finally:
        if credentials is not None:
            credentials.close()


if __name__ == '__main__':
    raise SystemExit(main())
