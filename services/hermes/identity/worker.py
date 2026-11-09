# ABOUTME: Принимает события одного владельца и запускает его native Hermes gateway.
# ABOUTME: Не принимает соединения от UID пользователя и не содержит Telegram token.
"""Жизненный цикл worker; политика UID, сети и файлов задаётся оператором."""
import argparse
import asyncio
import errno
import json
import os
import re
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
        self.typing = {}
        self.turn_scopes = {}
        self.tools_ready = False
        self.tools_lock = asyncio.Lock()
        self.operational = asyncio.Event()
        self.lifecycle_task = None
        self.activation = asyncio.Event()
        self.exited = asyncio.Event()
        self.exit_code = None
        self.lifecycle_error = None
        self.peer_released = asyncio.Event()
        self.peer_released.set()

    async def serve_connection(self, reader, writer):
        """Читать duplex RPC до startup sends; не допускать второй native runtime."""
        if peer_uid(writer) != self.ingress_uid:
            writer.close()
            await writer.wait_closed()
            return
        if self.peer is not None and self.peer.closed:
            # EOF уже получен, но native drain ещё удерживает прежний канал.
            try:
                await asyncio.wait_for(self.peer_released.wait(), 30)
            except TimeoutError:
                writer.close()
                await writer.wait_closed()
                return
        if self.peer is not None:
            # Операторская health-проверка не забирает основной duplex канал
            # и не останавливает работающий native lifecycle при своём EOF.
            async def inspect_health(require_tools=False):
                if require_tools:
                    raise RpcError(-32602, 'Operational health requires the active ingress channel')
                return await self.health()
            try:
                await asyncio.wait_for(Peer(reader, writer, {'health': inspect_health}).run(), 15)
            except (TimeoutError, ConnectionError):
                pass
            return
        peer = Peer(reader, writer, {'dispatch': self.dispatch, 'cancel': self.cancel,
                    'health': self.health, 'interactive': self.interactive})
        self.peer = peer
        self.peer_released.clear()
        reading = asyncio.create_task(peer.run())
        try:
            await self.start(peer)
            await asyncio.wait((reading, self.lifecycle_task), return_when=asyncio.FIRST_COMPLETED)
        except Exception as error:
            self.lifecycle_error = error
            self.exit_code = 1
            self.exited.set()
        finally:
            try:
                await self.stop_runtime()
            finally:
                writer.close()
                if not reading.done():
                    reading.cancel()
                await asyncio.gather(reading, return_exceptions=True)
                for task in list(self.typing.values()):
                    task.cancel()
                await asyncio.gather(*self.typing.values(), return_exceptions=True)
                self.typing.clear()
                self.active.clear()
                self.turn_scopes.clear()
                self.operational.clear()
                self.adapter = self.runner = self.peer = None
                self.peer_released.set()

    async def start(self, peer):
        """Подготовить bootstrap; полный native startup ждёт active Auth."""
        os.environ['HERMES_EXEC_ASK'] = '1'
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            self._install_telegram_profile()
        from gateway.run import GatewayRunner
        from gateway.config import Platform, PlatformConfig
        self.runner = self.runner_factory() if self.runner_factory else GatewayRunner()
        if getattr(self.runner.config, 'multiplex_profiles', False):
            raise RuntimeError('worker cannot multiplex profiles')
        self.tools_ready = False
        self.operational.clear()
        self.activation.clear()
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            from .images import install_shared_provider
            install_shared_provider()
        configured = getattr(self.runner.config, 'platforms', {})
        config = configured.get(Platform.TELEGRAM) or PlatformConfig()
        config.enabled = True
        self.runner.config.platforms = {Platform.TELEGRAM: config}
        self.adapter = make_adapter(config, Platform.TELEGRAM, peer, self.publish_file)
        self.adapter.gateway_runner = self.runner
        self.runner._is_user_authorized_for_source = lambda source, **kwargs: (
            source.platform == Platform.TELEGRAM and str(source.user_id) == self.telegram_id
            and not source.is_bot)
        self.runner._make_adapter_auth_check = lambda platform, profile_name=None: (
            lambda user_id, *args, **kwargs: platform == Platform.TELEGRAM
            and (str(user_id) == self.telegram_id or self.adapter.is_interactive_actor(user_id)))
        # AIDEV-NOTE: Native сохраняет wiring/connect/recovery. Подменяется только transport.
        def adapter_factory(platform, platform_config):
            if platform != Platform.TELEGRAM or peer.closed:
                raise RuntimeError('Worker transport unavailable')
            return self.adapter
        self.runner._instantiate_adapter = adapter_factory
        self.lifecycle_task = asyncio.create_task(self._run_lifecycle())

    def _install_telegram_profile(self):
        """Установить несекретный профиль до любого native plugin discovery."""
        os.environ['BRAI_IDENTITY_TELEGRAM_ID'] = self.telegram_id
        sys.modules.setdefault('_brai_identity_human', SimpleNamespace(
            telegram_id=self.telegram_id, game_core_enabled=False, attach=None))

    async def _startup_gate(self, runner):
        """Provisioning даёт только bootstrap; tools и recovery требуют active."""
        await self.activation.wait()
        from .tool_client import broker_call
        await asyncio.to_thread(broker_call, 'tools.list', {})

    async def _operational_ready(self, runner):
        """Подтвердить native startup вместе с MCP и scheduler."""
        from tools.registry import registry
        if registry.get_entry('mcp__brai__brai_login') is None:
            raise RpcError(-32603, 'Worker login tool unavailable')
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            human = sys.modules.get('_brai_identity_human')
            attach = getattr(human, 'attach', None)
            if not callable(attach):
                raise RpcError(-32603, 'Worker human plugin unavailable')
            await attach(self.adapter)
        if os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1':
            # Проверяется установленный файл профиля, который читает native GatewayRunner.
            from hermes_cli.config import load_config_readonly
            prompt = load_config_readonly().get('agent', {}).get('system_prompt', '')
            if not all(value in prompt for value in ('mcp__brai__dialogues_exchange',
                    'mcp__brai__dialogues_context_ack', 'context_request_id', 'finish')):
                raise RpcError(-32603, 'Worker Dialogues instruction unavailable')
            for name in ('mcp__brai__dialogues_exchange', 'mcp__brai__dialogues_context_ack'):
                if registry.get_entry(name) is None:
                    raise RpcError(-32603, 'Worker Dialogues tool unavailable')
        self.tools_ready = True
        self.operational.set()

    async def _run_lifecycle(self):
        """Выполнить native daemon lifecycle и сохранить service restart verdict."""
        # Bootstrap health EOF не завершает ещё не активированный native daemon.
        # Отмена до try оставляет listener для будущего постоянного ingress.
        await self.activation.wait()
        try:
            from gateway.run import start_gateway
            result = await start_gateway(
                runner_factory=lambda config: self.runner,
                startup_gate=self._startup_gate,
                operational_ready=self._operational_ready)
            self.exit_code = getattr(self.runner, 'exit_code', None)
            if self.exit_code is None:
                self.exit_code = 0 if result else 1
        except SystemExit as error:
            self.exit_code = error.code if type(error.code) is int else 1
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.lifecycle_error = error
            self.exit_code = 1
        finally:
            self.operational.clear()
            self.exited.set()

    async def stop_runtime(self):
        """Дождаться native drain и внешней обвязки до освобождения peer."""
        task = self.lifecycle_task
        if task is not None and not self.activation.is_set() and not task.done():
            task.cancel()
        if self.runner is not None:
            await self.runner.stop()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def ensure_tools(self):
        """Однократно активировать полный startup и дождаться operational-ready."""
        async with self.tools_lock:
            if self.operational.is_set():
                return
            if self.lifecycle_task is None or self.lifecycle_task.done():
                raise RpcError(-32603, 'Worker startup unavailable')
            self.activation.set()
            ready = asyncio.create_task(self.operational.wait())
            try:
                await asyncio.wait((ready, self.lifecycle_task), return_when=asyncio.FIRST_COMPLETED)
                if not self.operational.is_set():
                    raise RpcError(-32603, 'Worker startup unavailable')
            finally:
                ready.cancel()
                await asyncio.gather(ready, return_exceptions=True)

    async def health(self, require_tools=False):
        """Различить доступный bootstrap и полный operational lifecycle."""
        if type(require_tools) is not bool:
            raise RpcError(-32602, 'Invalid health check')
        if self.runner is None or self.adapter is None:
            raise RpcError(-32603, 'Worker not ready')
        if require_tools:
            await self.ensure_tools()
        return {'ready': True, 'operational': self.operational.is_set(),
                'userId': self.user_id, 'telegramId': self.telegram_id}

    async def interactive(self, update, owner, scope_id, actor_telegram_id):
        """Передать проверенное интерактивное событие owner-bound адаптеру."""
        if (owner != self.user_id or not isinstance(update, dict)
                or not isinstance(scope_id, str) or not 1 <= len(scope_id) <= 128
                or not isinstance(actor_telegram_id, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', actor_telegram_id)):
            raise RpcError(-32602, 'Invalid interactive event')
        await self.ensure_tools()
        from .scope import delivery_scope
        token = delivery_scope.set(scope_id)
        try:
            await self.adapter.handle_interactive(update, telegram_id=actor_telegram_id)
            return {'accepted': True}
        finally:
            delivery_scope.reset(token)

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
        if set(event) - allowed - {'source', 'message_type', 'identity_inputs', 'delivery_scope'}:
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
        scope_id = event.get('delivery_scope')
        if (os.environ.get('BRAI_IDENTITY_MODE') == 'worker'
                and (not isinstance(scope_id, str) or not 1 <= len(scope_id) <= 128)):
            raise RpcError(-32602, 'Delivery scope required')
        from .scope import delivery_scope
        scope_token = delivery_scope.set(scope_id)
        typing = None
        try:
            key = self.adapter._event_session_key(message)
            before = self.adapter._session_tasks.get(key)
            typing = self.adapter.start_turn_typing(message)
            await self.ensure_tools()
            await self.adapter.handle_message(message)
            task = self.adapter._session_tasks.get(key)
            token = None
            if message._gateway_accepted and task is not None and task is not before:
                # Native переносит pending follow-up в новую drain task того же session key.
                # Один живой допуск ingress покрывает всю цепочку до освобождения сессии.
                token = next((value for value, record in self.active.items() if record[0] == key), None)
                previous = self.active.get(token)
                token = token or uuid.uuid4().hex
                self.active[token] = (key, task, source.to_dict())
                self.turn_scopes[token] = scope_id
                if typing is not None and token not in self.typing:
                    self.typing[token] = typing
                    typing = None
                if previous is None or previous[1] is not task:
                    task.add_done_callback(lambda done: self._turn_finished(token, done))
            return {'accepted': bool(message._gateway_accepted), 'turn_id': token}
        finally:
            delivery_scope.reset(scope_token)
            if typing is not None:
                typing.cancel()
                await asyncio.gather(typing, return_exceptions=True)

    def _turn_finished(self, token, done):
        """Сообщить ingress точный завершённый ход без повторной доставки."""
        if self.active.get(token, (None, None))[1] is not done:
            return
        key, _, source = self.active[token]
        replacement = self.adapter._session_tasks.get(key) if self.adapter is not None else None
        if replacement is not None and replacement is not done and not replacement.done():
            self.active[token] = (key, replacement, source)
            replacement.add_done_callback(lambda next_done: self._turn_finished(token, next_done))
            return
        self.active.pop(token, None)
        self.turn_scopes.pop(token, None)
        typing = self.typing.pop(token, None)
        if typing is not None:
            typing.cancel()
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
        replacement = self.adapter._session_tasks.get(key)
        if replacement is not None and replacement is not task and not replacement.done():
            task = replacement
            self.active[turn_id] = (key, task, source)
            task.add_done_callback(lambda done: self._turn_finished(turn_id, done))
        if task.done() or self.adapter._session_tasks.get(key) is not task:
            return {'state': 'not_running'}
        await self.dispatch({'text': '/stop', 'source': source, 'message_type': 'command',
                             'message_id': 'cancel:' + turn_id,
                             'delivery_scope': self.turn_scopes.get(turn_id)}, owner)
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
    serving = asyncio.create_task(serve(path, worker, stop))
    exited = asyncio.create_task(worker.exited.wait())
    try:
        await asyncio.wait((serving, exited), return_when=asyncio.FIRST_COMPLETED)
        stop.set()
        await worker.stop_runtime()
        await serving
    finally:
        exited.cancel()
        await asyncio.gather(exited, return_exceptions=True)
        relay.close()
        await relay.wait_closed()
    if worker.exit_code:
        raise SystemExit(worker.exit_code)


def main():
    """Запустить worker из подготовленного systemd профиля."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(args.config))
    except SystemExit as error:
        exit_code = 0 if error.code is None else error.code if type(error.code) is int else 1
    else:
        exit_code = 0
    if 'gateway.run' in sys.modules:
        sys.modules['gateway.run']._exit_after_graceful_shutdown(exit_code)
    raise SystemExit(exit_code)


if __name__ == '__main__':
    main()
