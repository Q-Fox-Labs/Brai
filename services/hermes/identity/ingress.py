# ABOUTME: Маршрутизирует допущенные Telegram события в личные процессы Hermes.
# ABOUTME: Перед доставкой заново проверяет владельца, маршрут и тип действия.
"""Подключение вызывается доверенным ingress после нативной проверки отправителя."""
import asyncio
from contextvars import ContextVar
from .ipc import MAX_FRAME, Peer, RpcError, peer_uid

_ACTIONS = {'send', 'edit_message', 'send_typing', 'send_image', 'send_animation', 'send_image_file', 'send_document', 'send_video', 'send_voice'}
_FILES = {'send_image_file', 'send_document', 'send_video', 'send_voice'}


class Bridge:
    """Доверенный мост одного владельца к единственному системному UID."""
    def __init__(self, owner, telegram_id, worker_uid, socket_path, deliver, prepare_event, on_turn_end=None, on_turn_start=None):
        if not isinstance(owner, str) or not owner or not str(telegram_id).isdecimal() or type(worker_uid) is not int:
            raise ValueError('invalid worker binding')
        self.owner, self.telegram_id, self.worker_uid = owner, str(telegram_id), worker_uid
        self.socket_path, self.deliver, self.prepare_event = socket_path, deliver, prepare_event
        self.on_turn_end = on_turn_end
        self.on_turn_start = on_turn_start
        self.known_turns, self.early_ends = set(), set()
        self.dispatch_inflight = 0
        self.peer = self.task = None
        self.lock = asyncio.Lock()
        self.routes = set()
        self.received = set()
        self.sent = set()

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
            self.peer = Peer(reader, writer, {'send': self.send, 'turn_ended': self.turn_ended})
            self.task = asyncio.create_task(self.peer.run())
            return self.peer

    async def dispatch(self, event):
        """Отправить ранее допущенное событие без общего transcript/history."""
        source = event.source
        if source.platform.value != 'telegram' or str(source.user_id) != self.telegram_id or source.is_bot:
            raise PermissionError('Event owner mismatch')
        # Отказ подключения не должен занимать беседу или допускать input,
        # который worker заведомо не сможет получить.
        peer = await self.connect()
        data = await self.prepare_event(event)
        if not isinstance(data, dict):
            raise ValueError('Event preparation failed')
        data['source'] = source.to_dict()
        # Не переносить текст другого пользователя или общий групповой контекст.
        data.pop('reply_to_text', None)
        route = (str(source.chat_id), str(source.thread_id or ''))
        self.routes.add(route)
        if event.message_id:
            self.received.add((route, str(event.message_id)))
        self.dispatch_inflight += 1
        try:
            result = await peer.call('dispatch', {'event': data, 'owner': self.owner})
            if not isinstance(result, dict) or type(result.get('accepted')) is not bool:
                raise ConnectionError('Invalid dispatch receipt')
            turn_id = result.get('turn_id')
            if turn_id is not None:
                if not isinstance(turn_id, str) or not turn_id:
                    raise ConnectionError('Invalid turn identity')
                if self.on_turn_start is not None:
                    await self.on_turn_start(turn_id)
                self.known_turns.add(turn_id)
                if turn_id in self.early_ends:
                    self.early_ends.remove(turn_id)
                    asyncio.get_running_loop().call_soon(lambda: asyncio.create_task(self._close_turn(turn_id)))
        finally:
            self.dispatch_inflight -= 1
        if self.dispatch_inflight == 0:
            for finished in list(self.early_ends & self.known_turns):
                self.early_ends.remove(finished)
                await self._close_turn(finished)
            if turn_id is None and not self.known_turns and self.on_turn_end is not None:
                await self.on_turn_end(None)
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

    async def send(self, action, payload):
        """Доставить только в разрешённый исходный chat/thread и вернуть реальный результат."""
        if action not in _ACTIONS or not isinstance(payload, dict):
            raise RpcError(-32602, 'Unsupported action')
        metadata = payload.get('metadata') or {}
        if not isinstance(metadata, dict):
            raise RpcError(-32602, 'Invalid metadata')
        thread = str(metadata.get('thread_id') or metadata.get('message_thread_id') or '')
        route = (str(payload.get('chat_id') or ''), thread)
        if route not in self.routes:
            raise RpcError(-32602, 'Unauthorized destination')
        reply_to = payload.get('reply_to')
        if reply_to and (route, str(reply_to)) not in self.received | self.sent:
            raise RpcError(-32602, 'Unauthorized reply')
        if action == 'edit_message' and (route, str(payload.get('message_id') or '')) not in self.sent:
            raise RpcError(-32602, 'Unauthorized edit')
        allowed_keys = {
            'send': {'chat_id', 'content', 'reply_to', 'metadata'},
            'edit_message': {'chat_id', 'message_id', 'content', 'finalize', 'metadata'},
            'send_typing': {'chat_id', 'metadata'},
            'send_image': {'chat_id', 'image_url', 'caption', 'reply_to', 'metadata'},
            'send_animation': {'chat_id', 'animation_url', 'caption', 'reply_to', 'metadata'},
        }
        for file_action in _FILES:
            allowed_keys[file_action] = {'chat_id', 'artifact', 'caption', 'reply_to', 'metadata'}
        allowed_keys['send_document'].add('file_name')
        if set(payload) - allowed_keys[action]:
            raise RpcError(-32602, 'Unexpected delivery fields')
        if action in _FILES:
            descriptor = payload.get('artifact')
            if not isinstance(descriptor, dict) or not isinstance(descriptor.get('artifact_id'), str) or not descriptor['artifact_id']:
                raise RpcError(-32602, 'Artifact required')
        result = await self.deliver(self.owner, action, payload)
        if not isinstance(result, dict) or type(result.get('success')) is not bool:
            raise RpcError(-32603, 'Invalid delivery receipt')
        if result['success'] and result.get('message_id'):
            self.sent.add((route, str(result['message_id'])))
        return result


_authorized_telegram = ContextVar('brai_identity_authorized_telegram', default=None)


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
        if not isinstance(bridge, Bridge) or bridge.telegram_id != sender:
            raise PermissionError('No owner binding')
        token = _authorized_telegram.set(sender)
        try:
            admitted = await runner._hm_admit_event(event)
            if admitted is None:
                return
            event, source, internal = admitted
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
    forward._brai_restore_authorize = lambda: setattr(runner, '_is_user_authorized_for_source', original_authorize) if runner._is_user_authorized_for_source is authorize else None
    return forward
