# ABOUTME: Подключает штатный Telegram ingress к проверенному личному worker.
# ABOUTME: Авторизует update до media и не помещает коды входа в историю.
"""Только транспорт Telegram; пользовательский агент исполняется в другом UID."""
import asyncio
from dataclasses import asdict, is_dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import time
import uuid

from .ingress import Bridge

MAX_FRAME = 2 * 1024 * 1024
_resolvers = {}
_notices = {}


async def broker_call(method, params, timeout=15):
    """Вызвать единственный root broker, проверив его UID ядром."""
    path = os.environ.get('BRAI_IDENTITY_BROKER', '')
    if not path.startswith('/'):
        raise PermissionError('Broker unavailable')
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=MAX_FRAME + 1), 3)
    try:
        uid = struct.unpack('3i', writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
        if uid != 0:
            raise PermissionError('Unexpected broker UID')
        request_id = uuid.uuid4().hex
        wire = json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}).encode() + b'\n'
        if len(wire) > MAX_FRAME:
            raise ValueError('Request too large')
        writer.write(wire)
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout)
        if len(line) > MAX_FRAME:
            raise ValueError('Response too large')
        result = json.loads(line)
        if result.get('jsonrpc') != '2.0' or result.get('id') != request_id or 'error' in result or 'result' not in result:
            raise PermissionError('Broker rejected request')
        return result['result']
    finally:
        writer.close()
        await writer.wait_closed()


async def _notice(adapter, chat, text):
    now = time.monotonic()
    key = str(chat)
    if now - _notices.get(key, -100) < 30:
        return
    if len(_notices) > 1000:
        _notices.clear()
    _notices[key] = now
    await adapter.send(str(chat), text)


async def admit_update(update, adapter):
    """Проверить подлинного отправителя до загрузки вложений штатным адаптером."""
    message = getattr(update, 'effective_message', None)
    user = getattr(update, 'effective_user', None)
    chat = getattr(update, 'effective_chat', None)
    if (message is None or user is None or chat is None or getattr(user, 'is_bot', False)
            or getattr(chat, 'type', None) != 'private' or str(chat.id) != str(user.id)
            or getattr(message, 'sender_chat', None) or getattr(message, 'business_connection_id', None)):
        return False
    telegram = str(getattr(user, 'id', ''))
    if not re.fullmatch(r'[1-9][0-9]{0,19}', telegram):
        return False
    raw = (getattr(message, 'text', '') or '').strip()
    link = re.fullmatch(r'/start(?:@[A-Za-z0-9_]+)?\s+link_(.*)', raw, flags=re.DOTALL)
    if link:
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', link[1]):
            await adapter.send(telegram, 'Команда привязки неполная или неверная. Попросите агента подключить второй аккаунт и получите новую команду.')
            return False
        try:
            result = await broker_call('identity.link-redeem', {'telegramId': telegram, 'code': link[1]})
            text = ('Аккаунт подключён к вашему профилю. Память и файлы общие, беседа отдельная.'
                    if result.get('user') else 'Не удалось привязать аккаунт. Код истёк, использован или аккаунт уже принадлежит другому профилю.')
        except Exception:
            text = 'Результат привязки не подтверждён. Напишите обычное сообщение, чтобы проверить доступ.'
        await adapter.send(telegram, text)
        return False
    if re.fullmatch(r'/unlink(?:@[A-Za-z0-9_]+)?', raw):
        await adapter.send(telegram, 'Попросите агента отвязать этот или другой ваш аккаунт. Он объяснит последствия и запросит подтверждение.')
        return False
    try:
        await broker_call('identity.resolve', {'telegramId': telegram})
        return True
    except Exception:
        pass
    # Приглашение принимается только из личного сообщения самого нового пользователя.
    raw = getattr(message, 'text', '') or ''
    invitation = re.fullmatch(r'/start(?:@[A-Za-z0-9_]+)?\s+(?:invite_)?([A-Za-z0-9_-]{16,128})', raw.strip())
    if str(getattr(chat, 'id', '')) == telegram and invitation:
        try:
            await broker_call('identity.invite-redeem', {'telegramId': telegram, 'code': invitation[1],
                'name': str(getattr(user, 'full_name', '') or 'Пользователь')[:120]}, timeout=180)
            await _notice(adapter, telegram, 'Профиль готов. Администраторы этого сервиса могут просматривать вашу переписку, память и файлы. Напишите, с чем помочь. Для входа на сайт попросите меня прислать код.')
        except Exception:
            await _notice(adapter, telegram, 'Приглашение не удалось активировать. Проверьте его или обратитесь к владельцу.')
        return False
    if str(getattr(chat, 'id', '')) == telegram:
        await _notice(adapter, telegram, 'Для доступа нужно приглашение владельца. Попросите прислать приглашение и отправьте полученную команду в этот чат.')
    return False


def _receipt(value):
    if isinstance(value, dict):
        data = value
    elif is_dataclass(value):
        data = asdict(value)
    else:
        data = {key: getattr(value, key) for key in ('success', 'message_id', 'error', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind') if hasattr(value, key)}
    return {key: data[key] for key in ('success', 'message_id', 'error', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind') if key in data}


class Resolver:
    """Хранит только транспорт и проверенные связи без общего transcript."""
    def __init__(self, adapter):
        self.adapter = adapter
        self.bridges, self.turns = {}, {}

    async def __call__(self, source):
        """Выбрать worker по актуальному Auth, не по параметрам модели."""
        profile = await broker_call('identity.resolve', {'telegramId': str(source.user_id)})
        uid = profile['uid']
        if uid not in self.bridges:
            async def prepare(event):
                return await self.prepare({**profile, 'telegramId': str(event.source.user_id)}, event)
            async def deliver(owner, action, payload):
                return await self.deliver(profile, owner, action, payload)
            async def started(turn_id):
                current = self.turns.get(uid)
                if current is None or current.get('workerTurnId') not in (None, turn_id):
                    raise PermissionError('Unexpected worker turn')
                current['workerTurnId'] = turn_id
            async def ended(turn_id):
                await self.end(profile, turn_id)
            bridge = Bridge(profile['userId'], profile.get('authorTelegramId', profile['telegramId']), uid, profile['workerSocket'],
                            deliver, prepare, on_turn_start=started, on_turn_end=ended,
                            worker_telegram_id=profile.get('authorTelegramId', profile['telegramId']))
            bridge.profile_id = profile.get('profileId')
            self.bridges[uid] = bridge
        bridge = self.bridges[uid]
        if (bridge.owner != profile['userId'] or bridge.profile_id != profile.get('profileId')
                or bridge.worker_uid != uid or bridge.socket_path != profile['workerSocket']
                or bridge.worker_telegram_id != str(profile.get('authorTelegramId', profile['telegramId']))):
            raise PermissionError('Worker identity changed')
        bridge.telegram_ids.add(str(profile['telegramId']))
        return bridge

    async def prepare(self, profile, event):
        """Допустить только личный чат владельца и скопировать его media в профиль."""
        if (getattr(event.source, 'chat_type', '') != 'dm'
                or str(event.source.chat_id) != str(profile['telegramId'])):
            raise PermissionError('Only private Telegram chats are supported')
        uid = profile['uid']
        route = (str(event.source.chat_id), str(event.source.thread_id or ''))
        turn = self.turns.get(uid)
        if turn and turn['route'] != route:
            raise PermissionError('Another conversation is active')
        if not turn:
            turn = {'id': uuid.uuid4().hex, 'route': route}
            self.turns[uid] = turn
        inputs = getattr(event, '_brai_identity_inputs', []) or []
        if not isinstance(inputs, list) or len(inputs) > 10 or any(not isinstance(i, dict) for i in inputs):
            raise ValueError('Invalid media inputs')
        origin = {'messageId': str(event.message_id), 'text': getattr(event, 'text', '') or '',
                  'inputs': [{k: item[k] for k in ('itemId', 'caption', 'groupId') if k in item}
                             for item in inputs]}
        input_id = hashlib.sha256(json.dumps(origin, ensure_ascii=False, sort_keys=True,
                                            separators=(',', ':')).encode()).hexdigest()
        unlink = re.fullmatch(r'подтверждаю отвязку telegram-аккаунта ([1-9][0-9]{0,19})',
                              (getattr(event, 'text', '') or '').strip().casefold().rstrip('.!'))
        await broker_call('ingress.admit', {'inputId': input_id, 'messageId': str(event.message_id), 'expectedUid': uid, 'telegramId': str(profile['telegramId']), 'chatId': route[0],
            'privateChat': getattr(event.source, 'chat_type', '') == 'dm', 'turnId': turn['id'],
            'unlinkConsent': unlink[1] if unlink else '',
            'linkConsent': (getattr(event, 'text', '') or '').strip().casefold().rstrip('.!') in
                ('подтверждаю привязку моего второго аккаунта',),
            **({'threadId': int(route[1])} if route[1] else {})})
        fields = ('text', 'user_name', 'message_id', 'media_urls', 'media_types',
                  'media_text_inlined', 'reply_to_message_id', 'reply_expected')
        data = {key: getattr(event, key) for key in fields if getattr(event, key, None) is not None}
        data['message_type'] = getattr(event.message_type, 'value', event.message_type)
        timestamp = getattr(event, 'timestamp', None)
        if timestamp is not None:
            data['timestamp'] = timestamp.isoformat() if isinstance(timestamp, datetime) else str(timestamp)
        paths = list(data.get('media_urls') or [])
        if any(not isinstance(p, str) or not p.startswith('/') for p in paths):
            raise PermissionError('Only local authenticated media is allowed')
        extra = [i['path'] for i in inputs if i.get('path') not in paths]
        all_paths = paths + extra
        if all_paths:
            prepared = await broker_call('ingress.prepare', {'uid': uid, 'turnId': turn['id'], 'paths': all_paths}, timeout=120)
            mapped = prepared.get('paths')
            if not isinstance(mapped, list) or len(mapped) != len(all_paths):
                raise ValueError('Media preparation failed')
            replacements = dict(zip(all_paths, mapped))
            data['media_urls'] = [replacements[p] for p in paths]
            data['identity_inputs'] = [{**item, 'path': replacements[item['path']]} for item in inputs]
        return data

    async def deliver(self, profile, owner, action, payload):
        """Доставить только проверенные сообщения и артефакты текущего владельца."""
        uid = profile['uid']
        if owner != profile['userId'] or uid not in self.turns:
            raise PermissionError('No active owner turn')
        metadata = payload.get('metadata') or {}
        route = (str(payload.get('chat_id') or ''),
                 str(metadata.get('thread_id') or metadata.get('message_thread_id') or ''))
        if route != self.turns[uid]['route']:
            raise PermissionError('Delivery outside current conversation')
        state = await broker_call('ingress.status', {'uid': uid, 'turnId': self.turns[uid]['id']})
        if state.get('suppressFinal'):
            return {'success': True}
        values = dict(payload)
        if action in ('send_image_file', 'send_document', 'send_video', 'send_voice'):
            descriptor = values.pop('artifact')
            artifact = await broker_call('ingress.artifact', {'uid': uid, 'turnId': self.turns[uid]['id'],
                'artifactId': descriptor['artifact_id']}, timeout=120)
            path = artifact.get('localPath')
            if not isinstance(path, str) or not path.startswith('/'):
                raise ValueError('Invalid artifact')
            field = {'send_image_file': 'image_path', 'send_document': 'file_path',
                     'send_video': 'video_path', 'send_voice': 'audio_path'}[action]
            values[field] = path
        if action in ('send_image', 'send_animation'):
            # Произвольные URL могут заставить привилегированный ingress читать внутренний адрес.
            raise PermissionError('Publish local media first')
        method = getattr(self.adapter, action, None)
        if not callable(method):
            raise ValueError('Native delivery unavailable')
        result = await method(**values)
        if action == 'send_typing' and result is None:
            return {'success': True}
        return _receipt(result)

    async def end(self, profile, worker_turn):
        """Погасить доверенное право входа после завершения соответствующего хода."""
        uid = profile['uid']
        turn = self.turns.get(uid)
        if turn and turn.get('workerTurnId') == worker_turn:
            self.turns.pop(uid, None)
            await broker_call('ingress.close', {'uid': uid, 'turnId': turn['id']})


def create_resolver(adapter, runner):
    """Создать один резолвер на экземпляр native Telegram adapter."""
    key = id(adapter)
    if key not in _resolvers:
        _resolvers[key] = Resolver(adapter)
    return _resolvers[key]
