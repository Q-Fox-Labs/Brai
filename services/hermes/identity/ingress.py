# ABOUTME: Маршрутизирует допущенные Telegram события в личные процессы Hermes.
# ABOUTME: Перед доставкой заново проверяет владельца, маршрут и тип действия.
"""Подключение вызывается доверенным ingress после нативной проверки отправителя."""
import asyncio
import errno
import os
from pathlib import Path
import socket
import stat
import struct
from contextlib import asynccontextmanager
from contextvars import ContextVar
from .ipc import MAX_FRAME, Peer, RpcError, peer_uid
from .scope import UNSCOPED, request_scope

_ACTIONS = {'send_file_set', 'send', 'edit_message', 'send_draft', 'send_typing', 'send_image', 'send_animation', 'send_image_file', 'send_document', 'send_video', 'send_voice'}
_FILES = {'send_image_file', 'send_document', 'send_video', 'send_voice', 'send_animation'}


class Bridge:
    """Доверенный мост одного владельца к единственному системному UID."""
    def __init__(self, owner, telegram_id, worker_uid, socket_path, deliver, prepare_event, on_turn_end=None, on_turn_start=None, worker_telegram_id=None):
        if not isinstance(owner, str) or not owner or not str(telegram_id).isdecimal() or type(worker_uid) is not int:
            raise ValueError('invalid worker binding')
        self.owner, self.telegram_id, self.worker_uid = owner, str(telegram_id), worker_uid
        self.socket_path, self.deliver, self.prepare_event = socket_path, deliver, prepare_event
        self.telegram_ids = {str(telegram_id)}
        self.worker_telegram_id = str(worker_telegram_id or telegram_id)
        if not self.worker_telegram_id.isdecimal():
            raise ValueError('invalid worker Telegram identity')
        self.on_turn_end = on_turn_end
        self.on_turn_start = on_turn_start
        self.authorize_delivery, self.telegram_api = None, None
        self.require_scope = False
        self.known_turns, self.early_ends = set(), set()
        self.dispatch_inflight = 0
        self.peer = self.task = None
        self.lock = asyncio.Lock()
        self.routes = set()
        self.received = set()
        self.sent = set()
        self.chat_state = self.chat_admission = self.chat_started = self.chat_states = None
        self.input_receipt = None
        if not self.worker_telegram_id.isascii():
            raise ValueError('invalid worker Telegram identity')

    async def connect(self):
        """Соединиться с worker и проверить его UID по данным ядра."""
        async with self.lock:
            if self.peer is not None and not self.peer.closed:
                return self.peer
            reader, writer = await asyncio.open_unix_connection(self.socket_path, limit=MAX_FRAME + 1)
            if peer_uid(writer) != self.worker_uid:
                writer.close()
                await writer.wait_closed()
                raise PermissionError('Unexpected worker UID')
            self.peer = Peer(reader, writer, {'send': self.send, 'turn_ended': self.turn_ended,
                             'telegram_api': self.call_telegram_api, 'chat_states': self.read_chat_states})
            self.task = asyncio.create_task(self.peer.run())
            return self.peer

    async def read_chat_states(self, owner):
        """Отдать snapshot только worker этого duplex; ошибка store закрывает startup."""
        if owner != self.owner or not callable(self.chat_states):
            raise RpcError(-32602, 'Chat state unavailable')
        return {'owner': self.owner, 'routes': self.chat_states()}

    def configure_delivery(self, *, authorize_delivery=None, telegram_api=None, require_scope=False):
        """Подключить доверенные порты до открытия IPC-соединения."""
        if self.peer is not None:
            raise RuntimeError('Delivery ports already connected')
        self.authorize_delivery, self.telegram_api = authorize_delivery, telegram_api
        self.require_scope = require_scope
        return self

    @asynccontextmanager
    async def _dispatch_scope(self):
        self.dispatch_inflight += 1
        scope = {'turn_id': None}
        try:
            yield scope
        finally:
            self.dispatch_inflight -= 1
            if self.dispatch_inflight == 0:
                for finished in list(self.early_ends & self.known_turns):
                    self.early_ends.remove(finished)
                    await self._close_turn(finished)
                if scope['turn_id'] is None and not self.known_turns and self.on_turn_end is not None:
                    await self.on_turn_end(None)

    async def dispatch(self, event):
        """Отправить ранее допущенное событие без общего transcript/history."""
        source = event.source
        if source.platform.value != 'telegram' or str(source.user_id) not in self.telegram_ids or source.is_bot:
            raise PermissionError('Event owner mismatch')
        route = (str(getattr(source, 'chat_id', '')), str(getattr(source, 'thread_id', None) or ''))
        route = (route[0], '' if route[1] == '1' else route[1])
        state = self.chat_state(route) if callable(self.chat_state) else None
        if state and (state['paused'] or callable(self.chat_admission) and not self.chat_admission(route, event.message_id)):
            return {'accepted': False, 'turn_id': None}
        # Отказ подключения не должен занимать беседу или допускать input,
        # который worker заведомо не сможет получить.
        peer = await self.connect()
        async with self._dispatch_scope() as scope:
            return await self._dispatch(event, source, peer, scope, state)

    async def _dispatch(self, event, source, peer, scope, initial_state=None):
        """Подготовить и передать допущенное событие внутри dispatch fence."""
        data = await self.prepare_event(event)
        if not isinstance(data, dict):
            raise ValueError('Event preparation failed')
        data['source'] = source.to_dict()
        # AIDEV-NOTE: Внутри профиля автор канонический; исходный личный chat_id
        # сохраняет Telegram-аккаунт и отдельную native session. Права задаёт Auth.
        data['source']['user_id'] = self.worker_telegram_id
        # Не переносить текст другого пользователя или общий групповой контекст.
        data.pop('reply_to_text', None)
        route = (str(source.chat_id), str(source.thread_id or ''))
        self.routes.add(route)
        if event.message_id:
            self.received.add((route, str(event.message_id)))
        route = (route[0], '' if route[1] == '1' else route[1])
        state = self.chat_state(route) if callable(self.chat_state) else None
        if state and (state['paused'] or state['generation'] != initial_state['generation']
                      or callable(self.chat_admission) and not self.chat_admission(route, event.message_id)):
            return {'accepted': False, 'turn_id': None}
        if state:
            data['chat_generation'] = state['generation']
        result = await peer.call('dispatch', {'event': data, 'owner': self.owner})
        if not isinstance(result, dict) or type(result.get('accepted')) is not bool:
            raise ConnectionError('Invalid dispatch receipt')
        if result['accepted'] and state and callable(self.chat_started):
            self.chat_started(route, state['generation'])
        turn_id = result.get('turn_id')
        scope['turn_id'] = turn_id
        if turn_id is not None:
            if not isinstance(turn_id, str) or not turn_id:
                raise ConnectionError('Invalid turn identity')
            if self.on_turn_start is not None:
                await self.on_turn_start(turn_id)
            self.known_turns.add(turn_id)
            if turn_id in self.early_ends:
                self.early_ends.remove(turn_id)
                asyncio.get_running_loop().call_soon(lambda: asyncio.create_task(self._close_turn(turn_id)))
        if callable(self.input_receipt):
            await self.input_receipt(event, result)
        return result

    async def _close_turn(self, turn_id):
        if turn_id not in self.known_turns:
            return
        if self.dispatch_inflight:
            self.early_ends.add(turn_id)
            return
        self.known_turns.remove(turn_id)
        if self.on_turn_end is not None:
            await self.on_turn_end(turn_id)

    async def turn_ended(self, owner, turn_id):
        """Принять завершение только известного хода текущего worker."""
        if owner != self.owner or not isinstance(turn_id, str) or not turn_id:
            raise RpcError(-32602, 'Invalid turn')
        if turn_id in self.known_turns:
            await self._close_turn(turn_id)
        elif len(self.early_ends) < 64:
            self.early_ends.add(turn_id)
        else:
            raise RpcError(-32600, 'Too many pending turn completions')
        return {'accepted': True}

    async def call_telegram_api(self, method, payload, scope_id):
        """Native UI использует отдельный ограниченный порт доверенного bot."""
        if not callable(self.telegram_api):
            raise RpcError(-32601, 'Interactive API unavailable')
        return await self.telegram_api(self.owner, method, payload, scope_id)

    async def send(self, action, payload, scope_id=UNSCOPED):
        """Доставить только в разрешённый исходный chat/thread и вернуть реальный результат."""
        if action not in _ACTIONS or not isinstance(payload, dict):
            raise RpcError(-32602, 'Unsupported action')
        if self.require_scope and scope_id is UNSCOPED:
            raise RpcError(-32602, 'Delivery scope required')
        if scope_id is not UNSCOPED and scope_id is not None and (not isinstance(scope_id, str) or not 1 <= len(scope_id) <= 128):
            raise RpcError(-32602, 'Invalid delivery scope')
        metadata = payload.get('metadata') or {}
        if not isinstance(metadata, dict):
            raise RpcError(-32602, 'Invalid metadata')
        thread = str(metadata.get('thread_id') or metadata.get('message_thread_id') or '')
        route = (str(payload.get('chat_id') or ''), thread)
        persistent = callable(self.authorize_delivery)
        if persistent:
            self.authorize_delivery(action, payload)
        if not persistent and route not in self.routes:
            raise RpcError(-32602, 'Unauthorized destination')
        reply_to = payload.get('reply_to')
        if not persistent and reply_to and (route, str(reply_to)) not in self.received | self.sent:
            raise RpcError(-32602, 'Unauthorized reply')
        if not persistent and action == 'edit_message' and (route, str(payload.get('message_id') or '')) not in self.sent:
            raise RpcError(-32602, 'Unauthorized edit')
        allowed_keys = {
            'send': {'chat_id', 'content', 'reply_to', 'metadata'},
            'edit_message': {'chat_id', 'message_id', 'content', 'finalize', 'metadata'},
            'send_typing': {'chat_id', 'metadata'},
            'send_draft': {'chat_id', 'draft_id', 'content', 'metadata'},
            'send_file_set': {'chat_id', 'items', 'kind', 'fallback', 'metadata'},
            'send_image': {'chat_id', 'image_url', 'caption', 'reply_to', 'metadata'},
            'send_animation': {'chat_id', 'animation_url', 'caption', 'reply_to', 'metadata'},
        }
        for file_action in _FILES:
            allowed_keys[file_action] = {'chat_id', 'artifact', 'caption', 'reply_to', 'metadata'}
        allowed_keys['send_document'].add('file_name')
        allowed_keys['send_voice'].add('is_voice')
        if action == 'send_voice' and 'is_voice' in payload and type(payload['is_voice']) is not bool:
            raise RpcError(-32602, 'Invalid voice flag')
        if set(payload) - allowed_keys[action]:
            raise RpcError(-32602, 'Unexpected delivery fields')
        if action == 'send_draft' and (type(payload.get('draft_id')) is not int or payload['draft_id'] == 0
                or not isinstance(payload.get('content'), str) or len(payload['content']) > 65536):
            raise RpcError(-32602, 'Invalid draft')
        if action == 'send_file_set':
            items = payload.get('items')
            if (payload.get('kind') not in ('single', 'album') or type(payload.get('fallback')) is not bool
                    or not isinstance(items, list) or not 1 <= len(items) <= 10
                    or payload['kind'] == 'single' and len(items) != 1
                    or payload['kind'] == 'album' and len(items) < 2):
                raise RpcError(-32602, 'Invalid file batch')
            for item in items:
                if (not isinstance(item, dict) or set(item) != {'artifact', 'caption', 'presentation'}
                        or not isinstance(item['caption'], str) or len(item['caption']) > 65536
                        or item['presentation'] not in ('photo', 'video', 'audio', 'voice', 'animation', 'document')
                        or not isinstance(item['artifact'], dict) or set(item['artifact']) != {'artifact_id'}
                        or not isinstance(item['artifact']['artifact_id'], str) or not item['artifact']['artifact_id']):
                    raise RpcError(-32602, 'Invalid file item')
        if action in _FILES:
            descriptor = payload.get('artifact')
            if not isinstance(descriptor, dict) or not isinstance(descriptor.get('artifact_id'), str) or not descriptor['artifact_id']:
                raise RpcError(-32602, 'Artifact required')
        token = request_scope.set(scope_id)
        try:
            result = await self.deliver(self.owner, action, payload)
        finally:
            request_scope.reset(token)
        if not isinstance(result, dict) or type(result.get('success')) is not bool:
            raise RpcError(-32603, 'Invalid delivery receipt')
        if result['success'] and result.get('message_id'):
            self.sent.add((route, str(result['message_id'])))
            for message_id in result.get('continuation_message_ids') or []:
                self.sent.add((route, str(message_id)))
        return result


_authorized_telegram = ContextVar('brai_identity_authorized_telegram', default=None)


async def serve_chat_control(path, handler, release=None):
    """Открыть private UDS существующего ingress только для root Control."""
    target = Path(path)
    if not target.is_absolute() or not target.parent.is_dir():
        raise PermissionError('Invalid ingress control path')
    for parent in target.parents:
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o002:
            raise PermissionError('Untrusted ingress control parent')
    parent = target.parent.stat()
    if parent.st_mode & 0o007:
        raise PermissionError('Public ingress control parent')
    if parent.st_mode & 0o070:
        # AIDEV-NOTE: POSIX ACL отражает mask в group mode; доступ разрешён только ingress.
        acl = os.getxattr(target.parent, 'system.posix_acl_access')
        if len(acl) < 4 or struct.unpack_from('<I', acl)[0] != 2 or (len(acl) - 4) % 8:
            raise PermissionError('Invalid ingress control ACL')
        entries = {struct.unpack_from('<HHI', acl, offset) for offset in range(4, len(acl), 8)}
        expected = {(1, 7, 4294967295), (2, 7, os.geteuid()), (4, 0, 4294967295),
                    (16, 7, 4294967295), (32, 0, 4294967295)}
        if entries != expected:
            raise PermissionError('Unexpected ingress control ACL')
    try:
        old = target.lstat()
    except FileNotFoundError:
        old = None
    if old is not None:
        if not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.geteuid():
            raise PermissionError('Untrusted ingress control socket')
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(1)
            if probe.connect_ex(str(target)) != errno.ECONNREFUSED:
                raise PermissionError('Ingress control socket active')
        finally:
            probe.close()
        current = target.lstat()
        if (old.st_ino, old.st_dev) != (current.st_ino, current.st_dev):
            raise PermissionError('Ingress control socket changed')
        target.unlink()
    clients = set()
    async def accept(reader, writer):
        if peer_uid(writer) != 0 or len(clients) >= 16:
            writer.close()
            await writer.wait_closed()
            return
        task = asyncio.current_task()
        clients.add(task)
        try:
            methods = {'chats.control': handler}
            if release is not None:
                methods.update({'release.begin': release.begin, 'release.status': release.status,
                                'release.resume': release.resume, 'release.commit': release.commit,
                                'profile.release.try': release.profile_try,
                                'profile.release.status': release.profile_status,
                                'profile.release.resume': release.profile_resume})
            await Peer(reader, writer, methods).run()
        finally:
            clients.discard(task)
            writer.close()
            await writer.wait_closed()
    server = await asyncio.start_unix_server(accept, path=str(target), limit=MAX_FRAME + 1)
    os.chmod(target, 0o600)
    identity = target.lstat()
    try:
        async with server:
            await server.serve_forever()
    finally:
        for task in clients:
            task.cancel()
        await asyncio.gather(*clients, return_exceptions=True)
        current = target.lstat()
        if (identity.st_ino, identity.st_dev) == (current.st_ino, current.st_dev):
            target.unlink()


def install(runner, adapter, resolve_bridge):
    """Допустить broker-resolved sender до native guard и личного worker."""
    original_authorize = runner._is_user_authorized_for_source

    def authorize(source, **kwargs):
        if getattr(getattr(source, 'platform', None), 'value', None) == 'telegram':
            sender = str(getattr(source, 'user_id', '') or '')
            return bool(sender and sender == _authorized_telegram.get() and not getattr(source, 'is_bot', False))
        return original_authorize(source, **kwargs)

    runner._is_user_authorized_for_source = authorize

    async def forward(event):
        if getattr(event, 'internal', False):
            raise PermissionError('Internal event cannot enter worker via Telegram')
        source = event.source
        sender = str(getattr(source, 'user_id', '') or '')
        original_route = (str(getattr(source, 'chat_id', '') or ''), str(getattr(source, 'thread_id', '') or ''))
        if (getattr(getattr(source, 'platform', None), 'value', None) != 'telegram'
                or not sender.isascii() or not sender.isdecimal() or getattr(source, 'is_bot', False)):
            raise PermissionError('Invalid Telegram sender')
        # Broker до любых native hooks проверяет запись или выполняет onboarding.
        bridge = await resolve_bridge(source)
        if bridge is None:
            return
        if not isinstance(bridge, Bridge) or sender not in bridge.telegram_ids:
            raise PermissionError('No owner binding')
        original_event = event
        binding = getattr(original_event, '_brai_release_binding', None)
        if binding is not None and (not isinstance(binding, tuple) or len(binding) != 7
                or binding[:3] != (bridge.worker_uid, bridge.profile_id, bridge.owner)
                or binding[3] != sender or binding[4] != bridge.worker_telegram_id):
            block = getattr(resolve_bridge, 'input_blocked', None)
            if callable(block):
                await block(original_event)
            raise PermissionError('Ingress profile binding changed')
        if binding is not None:
            validate = getattr(resolve_bridge, 'validate_event_binding', None)
            if not callable(validate):
                raise PermissionError('Ingress binding validation unavailable')
            await validate(original_event)
        token = _authorized_telegram.set(sender)
        try:
            admitted = await runner._hm_admit_event(event)
            if admitted is None:
                filtered = getattr(resolve_bridge, 'input_filtered', None)
                if callable(filtered):
                    await filtered(original_event)
                return
            event, source, internal = admitted
            if event is not original_event and binding is not None:
                event._brai_release_binding = binding
                event._brai_release_updates = list(getattr(original_event, '_brai_release_updates', []))
            if (internal or str(getattr(source, 'user_id', '')) != sender
                    or getattr(getattr(source, 'platform', None), 'value', None) != 'telegram'
                    or (str(getattr(source, 'chat_id', '') or ''), str(getattr(source, 'thread_id', '') or '')) != original_route):
                raise PermissionError('Admission changed event identity')
            receipt = await bridge.dispatch(event)
            event._gateway_accepted = bool(receipt.get('accepted'))
        finally:
            _authorized_telegram.reset(token)
    # AIDEV-NOTE: set_message_handler недостаточен: base handle_message прежде
    # строит общий session key и включает чужие busy guards.
    adapter._brai_identity_dispatch = forward
    if callable(getattr(resolve_bridge, 'start', None)):
        resolve_bridge.start()
    forward._brai_close_resolver = getattr(resolve_bridge, 'close', None)
    forward._brai_retire_resolver = getattr(resolve_bridge, 'retire', None)
    if callable(getattr(resolve_bridge, 'interactive_admit', None)):
        adapter._brai_identity_interactive_admit = resolve_bridge.interactive_admit
        adapter._brai_identity_interactive = resolve_bridge.interactive
    forward._brai_restore_authorize = lambda: setattr(runner, '_is_user_authorized_for_source', original_authorize) if runner._is_user_authorized_for_source is authorize else None
    return forward
