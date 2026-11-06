# ABOUTME: Принимает события одного владельца и запускает его native Hermes gateway.
# ABOUTME: Не принимает соединения от UID пользователя и не содержит Telegram token.
"""Жизненный цикл worker; политика UID, сети и файлов задаётся оператором."""
import argparse
import asyncio
import errno
import json
import os
import signal
import socket
import stat
import sys
from types import SimpleNamespace
import uuid
from datetime import datetime
from pathlib import Path
from .adapter import make_adapter
from .ipc import MAX_FRAME, Peer, RpcError, peer_uid


class Worker:
    """Один профиль и единственный подтверждённый ingress на соединение."""
    def __init__(self, ingress_uid, user_id, telegram_id, publish_file, runner_factory=None):
        if type(ingress_uid) is not int or ingress_uid < 0 or ingress_uid == os.getuid():
            raise ValueError('ingress UID must differ from worker UID')
        if not isinstance(user_id, str) or not user_id or not isinstance(telegram_id, str) or not telegram_id.isdecimal():
            raise ValueError('owner required')
        self.ingress_uid, self.user_id, self.telegram_id, self.publish_file = ingress_uid, user_id, telegram_id, publish_file
        self.runner_factory = runner_factory
        self.peer = self.runner = self.adapter = None
        self.active = {}

    async def serve_connection(self, reader, writer):
        """Проверить SO_PEERCRED и обслуживать один ingress; остальные отклонить."""
        if self.peer is not None or peer_uid(writer) != self.ingress_uid:
            writer.close()
            await writer.wait_closed()
            return
        peer = Peer(reader, writer, {'dispatch': self.dispatch, 'cancel': self.cancel, 'health': self.health})
        self.peer = peer
        try:
            await self.start(peer)
            await peer.run()
        finally:
            # До нового подключения остановить старые session tasks и потомков.
            # Иначе два runner одной личности разделили бы profile state.
            try:
                if self.runner:
                    await self.runner.stop()
            finally:
                self.adapter = self.runner = self.peer = None

    async def start(self, peer):
        """Создать изолированный runner и native IPC adapter без polling Telegram."""
        from gateway.run import GatewayRunner
        from gateway.config import Platform, PlatformConfig
        self.runner = self.runner_factory() if self.runner_factory else GatewayRunner()
        if getattr(self.runner.config, 'multiplex_profiles', False):
            raise RuntimeError('worker cannot multiplex profiles')
        self.adapter = make_adapter(PlatformConfig(), Platform.TELEGRAM, peer, self.publish_file)
        self.adapter.gateway_runner = self.runner
        # Только вход, проверенный SO_PEERCRED и привязкой Telegram ID в dispatch.
        self.runner._is_user_authorized_for_source = lambda source, **kwargs: (
            source.platform == Platform.TELEGRAM and str(source.user_id) == self.telegram_id)
        self.runner._wire_adapter_handlers(self.adapter, authorization_check=lambda *args, **kwargs: True)
        if not await self.adapter.connect():
            raise RuntimeError('worker adapter unavailable')
        self.runner._publish_primary_adapter(Platform.TELEGRAM, self.adapter)
        self.runner.delivery_router.adapters = self.runner.adapters

    async def health(self):
        """Подтвердить готовность и привязку после полного запуска runner."""
        if self.runner is None or self.adapter is None:
            raise RpcError(-32603, 'Worker not ready')
        return {'ready': True, 'userId': self.user_id, 'telegramId': self.telegram_id}

    async def dispatch(self, event, owner):
        """Принять только событие привязанного владельца, не доверяя его metadata."""
        from gateway.platforms.event import MessageEvent, MessageType
        from gateway.session import SessionSource
        if owner != self.user_id or not isinstance(event, dict):
            raise RpcError(-32602, 'Invalid owner or event')
        source = SessionSource.from_dict(event['source'])
        if source.platform.value != 'telegram' or str(source.user_id) != self.telegram_id or source.is_bot:
            raise RpcError(-32602, 'Invalid source')
        allowed = {'text', 'user_id', 'user_name', 'message_id', 'media_urls', 'media_types', 'media_text_inlined', 'reply_to_message_id', 'reply_to_text', 'timestamp', 'reply_expected'}
        if set(event) - allowed - {'source', 'message_type', 'identity_inputs'}:
            raise RpcError(-32602, 'Unsupported event fields')
        fields = {key: event[key] for key in allowed if key in event}
        if 'timestamp' in fields:
            fields['timestamp'] = datetime.fromisoformat(fields['timestamp'])
        fields['user_id'] = self.telegram_id
        self.adapter.bind_source(source)
        message = MessageEvent(source=source, message_type=MessageType(event.get('message_type', 'text')), **fields)
        inputs = event.get('identity_inputs', [])
        if not isinstance(inputs, list) or len(inputs) > 10:
            raise RpcError(-32602, 'Invalid input files')
        home = os.environ.get('HERMES_HOME', '')
        for item in inputs:
            if (not isinstance(item, dict) or set(item) - {'path', 'itemId', 'caption', 'groupId'}
                    or not isinstance(item.get('path'), str) or not home.startswith('/')
                    or not os.path.isabs(item['path'])
                    or os.path.commonpath((os.path.abspath(item['path']), os.path.abspath(home))) != os.path.abspath(home)
                    or not isinstance(item.get('itemId'), str) or not item['itemId']
                    or any(key in item and item[key] is not None and not isinstance(item[key], str) for key in ('caption', 'groupId'))):
                raise RpcError(-32602, 'Invalid input file')
        message._brai_identity_inputs = inputs
        if not isinstance(message.message_id, str) or not message.message_id:
            raise RpcError(-32602, 'Message ID required')
        key = self.adapter._event_session_key(message)
        before = self.adapter._session_tasks.get(key)
        await self.adapter.handle_message(message)
        task = self.adapter._session_tasks.get(key)
        token = None
        if message._gateway_accepted and task is not None and task is not before:
            token = uuid.uuid4().hex
            self.active[token] = (key, task, source.to_dict())
            task.add_done_callback(lambda done: self._turn_finished(token, done))
        return {'accepted': bool(message._gateway_accepted), 'turn_id': token}

    def _turn_finished(self, token, done):
        """Сообщить ingress точный завершённый ход без повторной доставки."""
        if self.active.get(token, (None, None))[1] is not done:
            return
        self.active.pop(token, None)
        peer = self.peer
        if peer is not None and not peer.closed:
            async def notify():
                try:
                    await peer.call('turn_ended', {'owner': self.user_id, 'turn_id': token}, timeout=5)
                except (ConnectionError, TimeoutError, RpcError):
                    pass  # Разрыв не доказывает, доставлено ли уведомление.
            asyncio.create_task(notify())

    async def cancel(self, turn_id, owner):
        """Остановить только проверенный живой ход; таймаут не подтверждает остановку."""
        if owner != self.user_id or not isinstance(turn_id, str):
            raise RpcError(-32602, 'Invalid owner or turn')
        record = self.active.get(turn_id)
        if record is None:
            return {'state': 'not_running'}
        key, task, source = record
        if task.done() or self.adapter._session_tasks.get(key) is not task:
            return {'state': 'not_running'}
        await self.dispatch({'text': '/stop', 'source': source, 'message_type': 'command',
                             'message_id': 'cancel:' + turn_id}, owner)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except asyncio.TimeoutError:
            return {'state': 'stopping'}
        except asyncio.CancelledError:
            if not task.cancelled():
                raise
        return {'state': 'stopped'}



def _prepare_socket(path):
    """Удалить только собственный неработающий сокет после аварийного завершения."""
    try:
        old = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.getuid():
        raise PermissionError('Existing socket is not owned by worker')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        result = probe.connect_ex(path)
    if result != errno.ECONNREFUSED:
        raise FileExistsError('Worker socket is active or inaccessible')
    current = os.lstat(path)
    if (current.st_dev, current.st_ino) != (old.st_dev, old.st_ino):
        raise RuntimeError('Worker socket changed')
    os.unlink(path)


async def serve(path, worker, stop=None):
    """Слушать в собственном каталоге; UID вызывающего проверяется ядром."""
    _prepare_socket(path)
    server = await asyncio.start_unix_server(worker.serve_connection, path=path, limit=MAX_FRAME + 1)
    item = os.lstat(path)
    os.chmod(path, 0o666)
    try:
        async with server:
            if stop is None:
                await server.serve_forever()
            else:
                await stop.wait()
    finally:
        try:
            current = os.lstat(path)
            if (current.st_dev, current.st_ino) == (item.st_dev, item.st_ino):
                os.unlink(path)
        except FileNotFoundError:
            pass


def load_config(path, environ):
    """Проверить локальный worker.json и зафиксировать сокет внутри HERMES_HOME."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
                or info.st_mode & 0o022 or info.st_size > 4096):
            raise PermissionError('Invalid worker config')
        with os.fdopen(fd, 'rb', closefd=False) as data:
            config = json.load(data)
    finally:
        os.close(fd)
    if not isinstance(config, dict) or set(config) != {'socketPath'}:
        raise ValueError('Invalid worker config shape')
    home = environ.get('HERMES_HOME', '')
    expected = Path(home) / 'control' / 'worker.sock'
    if not home.startswith('/') or config['socketPath'] != str(expected):
        raise ValueError('Worker socket outside profile')
    ingress = environ.get('BRAI_IDENTITY_INGRESS_UID', '')
    owner = environ.get('BRAI_IDENTITY_USER_ID', '')
    telegram = environ.get('BRAI_IDENTITY_TELEGRAM_ID', '')
    egress = environ.get('BRAI_IDENTITY_EGRESS', '')
    if not ingress.isascii() or not ingress.isdecimal() or not owner or not telegram or not egress.startswith('/'):
        raise ValueError('Incomplete worker environment')
    return config['socketPath'], int(ingress), owner, telegram, egress


async def run(config_path):
    """Запустить relay и worker; остановить оба при штатном SIGTERM."""
    from .network import start_relay
    from .tool_client import broker_call
    # У файлового bootstrap только привязанный по UID broker; старый fixed-owner порт запрещён.
    os.environ['BRAI_IDENTITY_MODE'] = 'worker'
    sys.modules['_brai_identity_worker'] = SimpleNamespace(
        call=lambda method, params, timeout: broker_call(method, params, timeout=timeout))
    path, ingress, owner, telegram, egress = load_config(config_path, os.environ)
    async def publish_file(file_path):
        descriptor = await asyncio.to_thread(broker_call, 'artifacts.publish', {'path': file_path, 'requestId': str(uuid.uuid4())})
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get('artifactId'), str) or not descriptor['artifactId']:
            raise RuntimeError('Broker returned no artifact')
        return {'artifact_id': descriptor['artifactId']}
    worker = Worker(ingress, owner, telegram, publish_file)
    relay = await start_relay(egress, port=18080)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)
    try:
        await serve(path, worker, stop)
    finally:
        relay.close()
        await relay.wait_closed()


def main():
    """Запустить worker из подготовленного systemd профиля."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    asyncio.run(run(args.config))


if __name__ == '__main__':
    main()
