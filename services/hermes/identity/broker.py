# ABOUTME: Связывает системный UID профиля с доверенными портами Brai.
# ABOUTME: Проверяет SO_PEERCRED и не передаёт секреты Auth агентам.
"""Корневой broker: Unix JSON-RPC, фиксированный control и проверенные файлы."""
import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import stat
import struct
import uuid

from .memory_registry import load_registry
try:
    from ..files.identity import OwnerFiles
except ImportError:
    from files.identity import OwnerFiles

MAX_FRAME = 2 * 1024 * 1024


def protected_json(path):
    """Прочитать неизменяемую операторскую конфигурацию без symlink."""
    path = Path(path)
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('Unprotected directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > MAX_FRAME:
            raise PermissionError('Unprotected configuration')
        with os.fdopen(fd, 'r', closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def _secure_login_state_path(path):
    """Создать или проверить root-owned SQLite файл в защищённом каталоге."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise PermissionError('Invalid login state path')
    for directory in (path.parent, *path.parent.parents):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('Unprotected login state directory')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise PermissionError('Unprotected login state')
    finally:
        os.close(fd)
    return str(path)


class LoginDeliveryState:
    """Сохраняет только requestId и исход отправки; код и пользовательский текст не записываются."""

    def __init__(self, path, max_records=1_000_000):
        """Открыть root-only state; memory используется только явно внедрёнными тестами."""
        if type(max_records) is not int or max_records < 1:
            raise ValueError('Invalid login state capacity')
        self.max_records = max_records
        self.db = sqlite3.connect(':memory:' if path == ':memory:' else _secure_login_state_path(path),
                                  isolation_level=None, timeout=3)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute("CREATE TABLE IF NOT EXISTS login_receipts (request_id TEXT PRIMARY KEY, outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed','unknown')))")

    def lookup(self, request_id):
        """Прочитать прежний исход без повторной отправки, включая после перезапуска."""
        row = self.db.execute('SELECT outcome FROM login_receipts WHERE request_id=?', (request_id,)).fetchone()
        return row[0] if row else None

    def claim(self, request_id):
        """Зафиксировать unknown до network write; существующий receipt не захватывается повторно."""
        self.db.execute('BEGIN IMMEDIATE')
        try:
            previous = self.lookup(request_id)
            if previous is not None:
                self.db.execute('COMMIT')
                return False, previous
            count = self.db.execute('SELECT count(*) FROM login_receipts').fetchone()[0]
            if count >= self.max_records:
                raise PermissionError('Login delivery state capacity reached')
            self.db.execute("INSERT INTO login_receipts(request_id,outcome) VALUES (?,'unknown')", (request_id,))
            self.db.execute('COMMIT')
            return True, 'unknown'
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def finish(self, request_id, outcome):
        """Сохранить известный исход после квитанции отдельным FULL synchronous commit."""
        if outcome not in ('sent', 'failed', 'unknown'):
            raise ValueError('Invalid login outcome')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.db.execute('UPDATE login_receipts SET outcome=? WHERE request_id=?', (outcome, request_id))
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise

    def close(self):
        """Закрыть SQLite connection при остановке broker."""
        self.db.close()


def login_request_id(uid, profile, chat_id, input_id):
    """Связать receipt с подтверждённым пользователем, профилем и реальным Telegram input."""
    binding = {'uid': uid, 'userId': profile['userId'], 'profileId': profile['profileId'],
               'telegramId': str(profile['telegramId']), 'chatId': str(chat_id), 'inputId': input_id}
    return 'telegram-login:' + hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class ControlPort:
    """Один привилегированный процесс; неизвестные записи автоматически не повторяются."""
    def __init__(self, command, config):
        self.command, self.config = command, config
        self.process = self.reader = None
        self.pending = {}
        self.write_lock = asyncio.Lock()
        self.counter = 0

    async def start(self):
        """Запустить только фиксированный argv из защищённой конфигурации."""
        if not isinstance(self.command, list) or not self.command or not all(isinstance(s, str) and s for s in self.command):
            raise ValueError('Invalid control command')
        self.process = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=MAX_FRAME + 1,
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'BRAI_IDENTITY_CONTROL_CONFIG': self.config})
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        """Доставлять ответы по ID; обрыв завершает все ожидающие вызовы."""
        try:
            while line := await self.process.stdout.readline():
                if len(line) > MAX_FRAME:
                    raise ValueError('Frame too large')
                value = json.loads(line)
                future = self.pending.get(value.get('id'))
                if (future is None and type(value.get('id')) is int and 0 < value['id'] <= self.counter
                        or future is not None and future.cancelled()):
                    continue
                if value.get('jsonrpc') != '2.0' or future is None or future.done():
                    raise ValueError('Invalid control response')
                if 'error' in value:
                    future.set_exception(PermissionError('Control rejected request'))
                elif 'result' in value:
                    future.set_result(value['result'])
                else:
                    raise ValueError('Invalid control result')
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError('Control unavailable'))

    async def call(self, method, params, timeout=35):
        """Послать один вызов с ограниченным сроком и без повтора."""
        if not self.process or self.process.returncode is not None or len(self.pending) >= 32:
            raise ConnectionError('Control unavailable')
        self.counter += 1
        request_id = self.counter
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        payload = json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}).encode() + b'\n'
        try:
            async with self.write_lock:
                self.process.stdin.write(payload)
                await self.process.stdin.drain()
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)

    async def close(self):
        """Завершить дочерний процесс вместе с broker."""
        if self.process and self.process.returncode is None:
            self.process.terminate()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.process.wait(), 10)
            if self.process.returncode is None:
                self.process.kill()
                await self.process.wait()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)


class Broker:
    """Применить права ядра и актуальную идентичность до любого владельческого порта."""
    def __init__(self, config, control):
        self.config, self.control = config, control
        self.turns, self.locks = {}, {}
        self.login_locks, self.login_state = {}, None
        self.files = OwnerFiles(config, control, protected_json)

    def delivery_state(self):
        """Открыть постоянные квитанции из защищённой операторской конфигурации."""
        if self.login_state is None:
            path = self.config.get('loginDeliveryStatePath')
            if not isinstance(path, str) or not Path(path).is_absolute():
                raise PermissionError('Login delivery state unavailable')
            self.login_state = LoginDeliveryState(path, self.config.get('maxLoginReceipts', 1_000_000))
        return self.login_state

    def profiles(self):
        """Повторно прочитать защищённый реестр после каждого обновления."""
        return load_registry(self.config['registryPath'])

    async def authorize(self, uid):
        """Сверить профиль с текущим состоянием Auth."""
        profile = self.profiles().get(uid)
        if not profile or profile['status'] != 'active':
            raise PermissionError('Profile unavailable')
        principal = await self.control.call('authorize', {'uid': uid}, timeout=3)
        if (principal.get('userId') != profile['userId'] or
                principal.get('profileId') != profile['profileId']):
            raise PermissionError('Principal mismatch')
        return profile

    async def resolve(self, telegram_id):
        """Найти только действующую связь Telegram → системный профиль."""
        if not isinstance(telegram_id, str) or not telegram_id.isascii() or not telegram_id.isdecimal():
            raise ValueError('Invalid Telegram identity')
        resolved = await self.control.call('identity.resolve', {'telegramId': telegram_id})
        user = resolved.get('user')
        if not isinstance(user, dict) or user.get('status') != 'active':
            raise PermissionError('Invitation required')
        matches = [(uid, p) for uid, p in self.profiles().items()
                   if p['userId'] == user.get('id') and p['profileId'] == user.get('profileId')
                   and str(p['telegramId']) == telegram_id and p['status'] == 'active']
        if len(matches) != 1:
            raise PermissionError('Profile unavailable')
        uid, profile = matches[0]
        return {'uid': uid, **profile}

    async def publish(self, uid, profile, params):
        """Сохранить внутренний порт публикации через owner-bound snapshot."""
        return await self.files.publish(uid, profile, params)

    async def call(self, peer_uid, method, params):
        """Принять один запрос; worker никогда не выбирает собственный UID или owner."""
        if not isinstance(params, dict):
            raise ValueError('Invalid params')
        ingress = peer_uid == self.config['ingressUid']
        trusted = peer_uid == 0
        if method == 'authorize' and trusted:
            try:
                await self.authorize(params.get('uid'))
                return {'allowed': True}
            except Exception:
                return {'allowed': False}
        if method == 'identity.resolve' and ingress:
            return await self.resolve(params.get('telegramId'))
        if method == 'identity.invite-redeem' and ingress:
            if set(params) - {'telegramId', 'code', 'name'}:
                raise ValueError('Invalid invitation')
            lock = self.locks.setdefault(str(params.get('telegramId')), asyncio.Lock())
            async with lock:
                result = await self.control.call(method, params)
                user = result.get('user')
                if not isinstance(user, dict) or user.get('status') != 'provisioning':
                    raise PermissionError('Invitation unavailable')
                command = self.config.get('provisionCommand')
                if not isinstance(command, list) or not command or not Path(command[0]).is_absolute():
                    raise PermissionError('Provisioning unavailable')
                child = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
                await asyncio.wait_for(child.communicate(json.dumps({'user': user}).encode()), 180)
                if child.returncode != 0:
                    raise PermissionError('Provisioning failed')
                await self.control.call('identity.profile-ready', {'userId': user['id'], 'profileId': user['profileId']})
                return await self.resolve(str(user['telegramId']))
        if method in ('ingress.admit', 'ingress.status', 'ingress.close', 'ingress.prepare', 'ingress.artifact') and ingress:
            if method == 'ingress.admit':
                profile = await self.resolve(params.get('telegramId'))
                turn_id = params.get('turnId')
                if not isinstance(turn_id, str) or len(turn_id) > 128 or not turn_id:
                    raise ValueError('Invalid turn')
                input_id = params.get('inputId', 'legacy:' + turn_id)
                if 'inputId' in params and (not isinstance(input_id, str) or len(input_id) != 64
                        or any(character not in '0123456789abcdef' for character in input_id)):
                    raise ValueError('Invalid input identity')
                private = params.get('privateChat') is True and str(params.get('chatId')) == str(profile['telegramId'])
                thread_id = params.get('threadId')
                old = self.turns.get(profile['uid'])
                request_id = login_request_id(profile['uid'], profile, params.get('chatId'), input_id)
                outcome = self.delivery_state().lookup(request_id)
                if old is not None:
                    if (old['turnId'] != turn_id or old['telegramId'] != profile['telegramId']
                            or old['chatId'] != str(params.get('chatId')) or old['privateChat'] != private
                            or old.get('threadId') != thread_id):
                        raise PermissionError('Another turn active')
                    if old['inputId'] == input_id or outcome is not None:
                        # Повтор старого input не отменяет более новое живое уточнение.
                        return profile
                receipt = {'requestId': request_id, 'outcome': outcome}
                self.turns[profile['uid']] = {'turnId': turn_id, 'privateChat': private, 'chatId': str(params.get('chatId')),
                    'telegramId': profile['telegramId'], 'inputId': input_id, 'threadId': thread_id,
                    'requestId': receipt['requestId'], 'loginRecord': receipt,
                    'suppressFinal': receipt['outcome'] == 'sent'}
                return profile
            uid = params.get('uid')
            turn = self.turns.get(uid)
            if not turn or turn['turnId'] != params.get('turnId'):
                raise PermissionError('Turn unavailable')
            if method == 'ingress.close':
                self.turns.pop(uid, None)
                return {'closed': True}
            profile = await self.authorize(uid)
            if method == 'ingress.prepare':
                if set(params) != {'uid', 'turnId', 'paths'}:
                    raise ValueError('Invalid ingress preparation')
                return await self.files.prepare_ingress(uid, profile, params['paths'])
            if method == 'ingress.artifact':
                if set(params) != {'uid', 'turnId', 'artifactId'}:
                    raise ValueError('Invalid ingress artifact')
                return await self.files.fetch(uid, profile, {'artifactId': params['artifactId']}, ingress=True)
            return {'suppressFinal': turn['suppressFinal']}
        if trusted or ingress:
            raise PermissionError('Method unavailable')
        if method == 'files.configuration' and not params:
            bootstrap = self.profiles().get(peer_uid)
            if bootstrap and bootstrap['status'] == 'provisioning':
                # AIDEV-NOTE: Startup проверяется до активации. Здесь доступна лишь несекретная
                # конфигурация своего профиля; данные и инструменты требуют active Auth.
                return await self.files.configuration(peer_uid, bootstrap)
        profile = await self.authorize(peer_uid)
        if method == 'tools.list' and not params:
            return await self.control.call(method, {'uid': peer_uid})
        if method == 'tools.call':
            if set(params) != {'name', 'args'}:
                raise ValueError('Invalid tool call')
            if params['name'] in ('publish_file', 'fetch_file'):
                raise PermissionError('Use bounded artifact port')
            return await self.control.call(method, {'uid': peer_uid, **params}, timeout=1800)
        if method == 'files.configuration' and not params:
            return await self.files.configuration(peer_uid, profile)
        if method in ('artifacts.publish', 'files.publish'):
            return await self.files.publish(peer_uid, profile, params)
        if method in ('artifacts.fetch', 'files.fetch'):
            return await self.files.fetch(peer_uid, profile, params)
        if method in ('files.get', 'files.list', 'files.prepare'):
            return await self.control.call(method, {'uid': peer_uid, 'args': params}, timeout=1800)
        if method == 'login.send' and not params:
            turn = self.turns.get(peer_uid)
            if not turn or not turn['privateChat']:
                raise PermissionError('Private Telegram turn required')
            receipt = turn['loginRecord']
            lock = self.login_locks.setdefault(peer_uid, asyncio.Lock())
            async with lock:
                if receipt['outcome'] is None:
                    await self.authorize(peer_uid)
                    # AIDEV-NOTE: Unknown фиксируется до записи в control. Обрыв/отмена
                    # не дают автоматического разрешения отправить тот же код ещё раз.
                    claimed, receipt['outcome'] = self.delivery_state().claim(receipt['requestId'])
                    if claimed and self.turns.get(peer_uid) is turn:
                        try:
                            result = await self.control.call('login.send', {'uid': peer_uid,
                                'telegramId': str(turn['telegramId']), 'privateChat': True,
                                'requestId': receipt['requestId'],
                                **({'threadId': turn['threadId']} if turn.get('threadId') is not None else {})})
                        except Exception:
                            result = {'status': 'unknown'}
                        status = result.get('status') if isinstance(result, dict) else None
                        outcome = status if status in ('sent', 'failed', 'unknown') else (
                            'failed' if status in ('denied', 'unavailable') else 'unknown')
                        self.delivery_state().finish(receipt['requestId'], outcome)
                        receipt['outcome'] = outcome
                current = self.turns.get(peer_uid) is turn
                if current:
                    turn['suppressFinal'] = receipt['outcome'] == 'sent'
                return {'status': receipt['outcome'],
                        'suppressFinal': current and receipt['outcome'] == 'sent'}
        raise PermissionError('Method unavailable')


# Только именованные параметры; worker никогда не передаёт свой UID или owner.
PARAMETERS = {
    'authorize': ({'uid'}, set()),
    'identity.resolve': ({'telegramId'}, set()),
    'identity.invite-redeem': ({'telegramId', 'code'}, {'name'}),
    'ingress.admit': ({'telegramId', 'turnId', 'chatId', 'privateChat'}, {'inputId', 'threadId'}),
    'ingress.status': ({'uid', 'turnId'}, set()),
    'ingress.close': ({'uid', 'turnId'}, set()),
    'ingress.prepare': ({'uid', 'turnId', 'paths'}, set()),
    'ingress.artifact': ({'uid', 'turnId', 'artifactId'}, set()),
    'tools.list': (set(), set()),
    'tools.call': ({'name', 'args'}, set()),
    'files.configuration': (set(), set()),
    'files.publish': ({'path', 'requestId'}, set()),
    'artifacts.publish': ({'path', 'requestId'}, set()),
    'files.fetch': ({'artifactId'}, set()),
    'artifacts.fetch': ({'artifactId'}, set()),
    'files.get': ({'artifactId'}, set()),
    'files.list': (set(), {'limit', 'offset'}),
    'files.prepare': ({'mode', 'items'}, set()),
    'login.send': (set(), set()),
}


def rpc_error(identifier, code, message):
    """Вернуть безопасную JSON-RPC ошибку, не раскрывая upstream сообщения."""
    return {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': code, 'message': message}}


def validate_params(method, params):
    """Проверить именованную форму и базовые типы до вызова привилегированного порта."""
    required, optional = PARAMETERS[method]
    if not isinstance(params, dict) or not required <= set(params) or set(params) - required - optional:
        raise ValueError('Invalid params')
    for key in ('turnId', 'requestId', 'path', 'name', 'code', 'telegramId'):
        if key in params and (not isinstance(params[key], str) or not params[key]):
            raise ValueError('Invalid string')
    for key in ('uid', 'limit', 'offset'):
        if key in params and (type(params[key]) is not int or params[key] < (0 if key == 'offset' else 1)):
            raise ValueError('Invalid integer')
    if 'privateChat' in params and type(params['privateChat']) is not bool:
        raise ValueError('Invalid boolean')
    if 'chatId' in params and type(params['chatId']) not in (str, int):
        raise ValueError('Invalid chat')
    if 'args' in params and not isinstance(params['args'], dict):
        raise ValueError('Invalid args')
    if 'threadId' in params and (type(params['threadId']) is not int
            or not 1 <= params['threadId'] <= 9007199254740991):
        raise ValueError('Invalid Telegram thread')
    if 'telegramId' in params and (not params['telegramId'].isascii() or not params['telegramId'].isdecimal()):
        raise ValueError('Invalid Telegram identity')
    if 'inputId' in params and (not isinstance(params['inputId'], str) or len(params['inputId']) != 64
            or any(character not in '0123456789abcdef' for character in params['inputId'])):
        raise ValueError('Invalid input identity')
    if 'turnId' in params and len(params['turnId']) > 128:
        raise ValueError('Invalid turn')
    if 'requestId' in params and len(params['requestId']) > 256:
        raise ValueError('Invalid request ID')
    if 'path' in params and not Path(params['path']).is_absolute():
        raise ValueError('Invalid path')
    if 'paths' in params and (not isinstance(params['paths'], list) or len(params['paths']) > 100
            or any(not isinstance(path, str) or not Path(path).is_absolute() for path in params['paths'])):
        raise ValueError('Invalid input paths')
    if 'artifactId' in params:
        uuid.UUID(params['artifactId'])
    if method == 'files.prepare':
        items = params['items']
        if params['mode'] not in ('files', 'album') or not isinstance(items, list) or not 1 <= len(items) <= 100:
            raise ValueError('Invalid file set')
        for item in items:
            if (not isinstance(item, dict) or 'artifactId' not in item or set(item) - {'artifactId', 'caption', 'presentation'}
                    or 'caption' in item and (not isinstance(item['caption'], str) or len(item['caption']) > 65536)
                    or 'presentation' in item and item['presentation'] not in ('photo', 'video', 'audio', 'document', 'voice', 'animation')):
                raise ValueError('Invalid file item')
            uuid.UUID(item['artifactId'])


async def rpc_request(broker, uid, request):
    """Обслужить один JSON-RPC вызов или notification с неизменным peer UID."""
    valid_id = isinstance(request, dict) and ('id' not in request or request['id'] is None or type(request['id']) in (str, int, float))
    if (not isinstance(request, dict) or request.get('jsonrpc') != '2.0'
            or not isinstance(request.get('method'), str) or not valid_id
            or set(request) - {'jsonrpc', 'id', 'method', 'params'}):
        return rpc_error(None, -32600, 'Invalid Request')
    notification = 'id' not in request
    identifier, method, params = request.get('id'), request['method'], request.get('params', {})
    if method not in PARAMETERS:
        response = rpc_error(identifier, -32601, 'Method not found')
    else:
        try:
            validate_params(method, params)
        except (ValueError, TypeError, AttributeError):
            response = rpc_error(identifier, -32602, 'Invalid params')
        else:
            try:
                result = await broker.call(uid, method, params)
                response = {'jsonrpc': '2.0', 'id': identifier, 'result': result}
            except Exception:
                response = rpc_error(identifier, -32001, 'Request unavailable')
    return None if notification else response


def _invalid_constant(value):
    raise ValueError('Invalid JSON constant')


async def rpc_frame(broker, uid, raw):
    """Принять один NDJSON frame; bounded batch исполняется последовательно."""
    try:
        request = json.loads(raw, parse_constant=_invalid_constant)
    except (ValueError, UnicodeError):
        return rpc_error(None, -32700, 'Parse error')
    if not isinstance(request, list):
        return await rpc_request(broker, uid, request)
    if not 1 <= len(request) <= 16:
        return rpc_error(None, -32600, 'Invalid Request')
    responses = []
    for item in request:
        response = await rpc_request(broker, uid, item)
        if response is not None:
            responses.append(response)
    return responses or None


async def serve(config):
    """Запустить ограниченный Unix listener и закрыть его по сигналу."""
    control = ControlPort(config['controlCommand'], config['controlConfigPath'])
    await control.start()
    broker = Broker(config, control)
    slots = asyncio.Semaphore(32)
    async def accept(reader, writer):
        try:
            if slots.locked():
                return
            async with slots:
                uid = struct.unpack('3i', writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
                raw = await asyncio.wait_for(reader.readline(), 5)
                if len(raw) > MAX_FRAME or not raw.endswith(b'\n'):
                    raise ValueError('Frame too large')
                response = await rpc_frame(broker, uid, raw)
                if response is None:
                    return
                encoded = json.dumps(response, ensure_ascii=False).encode() + b'\n'
                if len(encoded) > MAX_FRAME:
                    raise ValueError('Response too large')
                writer.write(encoded)
                await writer.drain()
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
    path = Path(config['socketPath'])
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode) or path.lstat().st_uid != 0:
            raise PermissionError('Foreign socket')
        path.unlink()
    server = await asyncio.start_unix_server(accept, path=str(path), limit=MAX_FRAME + 1)
    os.chmod(path, 0o666)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        async with server:
            await stopped.wait()
    finally:
        server.close()
        await server.wait_closed()
        await control.close()
        if broker.login_state is not None:
            broker.login_state.close()
        path.unlink(missing_ok=True)


def main():
    """Принять только путь защищённой операторской конфигурации."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError('Root broker required')
    asyncio.run(serve(protected_json(args.config)))


if __name__ == '__main__':
    main()
