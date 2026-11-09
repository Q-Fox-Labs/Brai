# ABOUTME: Подключает штатный Telegram ingress к проверенному личному worker.
# ABOUTME: Авторизует update до media и не помещает коды входа в историю.
"""Только транспорт Telegram; пользовательский агент исполняется в другом UID."""
import asyncio
from dataclasses import asdict, is_dataclass
from datetime import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import socket
import struct
import time
import uuid

from .ingress import Bridge
from .routes import RouteLedger
from .notifications import NotificationTopics
from .scope import UNSCOPED, request_scope

MAX_FRAME = 2 * 1024 * 1024
_resolvers = {}
_notices = {}
_logger = logging.getLogger(__name__)


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


async def _control_reply(adapter, chat, message, text):
    """Ответить в исходную тему; сообщить исход без содержимого, кодов и повтора."""
    thread = getattr(message, 'message_thread_id', None)
    if thread is not None and (type(thread) is not int or thread < 1):
        _logger.warning('telegram_control_reply status=invalid_route')
        return False
    options = {'metadata': {'message_thread_id': thread}} if thread is not None else {}
    try:
        result = _receipt(await adapter.send(str(chat), text, **options))
    except Exception as error:
        # AIDEV-NOTE: Текст исключения может содержать Bot API token или команду.
        _logger.warning('telegram_control_reply status=unknown error=%s', type(error).__name__)
        return False
    if result.get('success') is not True:
        _logger.warning('telegram_control_reply status=unconfirmed')
        return False
    _logger.info('telegram_control_reply status=sent')
    return True


async def _notice(adapter, chat, message, text):
    """Ограничить подтверждённые уведомления отдельно для каждой темы личного чата."""
    now = time.monotonic()
    key = (str(chat), str(getattr(message, 'message_thread_id', None) or ''))
    if now - _notices.get(key, -100) < 30:
        return
    if len(_notices) > 1000:
        _notices.clear()
    if await _control_reply(adapter, chat, message, text):
        _notices[key] = now


def _linked_accounts_text(accounts):
    """Показать только имена и usernames из Telegram, без внутренних идентификаторов."""
    if not isinstance(accounts, list) or not accounts:
        return 'Имена подключённых аккаунтов сейчас недоступны.'
    labels = []
    for account in accounts[:2]:
        if not isinstance(account, dict):
            continue
        name = account.get('name') or 'Имя аккаунта недоступно'
        username = account.get('username')
        labels.append('• ' + name + (' (@' + username + ')' if username else ''))
    return 'Сейчас подключены:\n' + '\n'.join(labels)


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
            await _control_reply(adapter, telegram, message, 'Команда привязки неполная или неверная. Попросите агента подключить второй аккаунт и получите новую команду.')
            return False
        try:
            result = await broker_call('identity.link-redeem', {'telegramId': telegram, 'code': link[1]}, timeout=40)
            text = ('Аккаунт привязан.\n\n' + _linked_accounts_text(result.get('accounts')) +
                    '\n\nОба аккаунта имеют доступ к общей памяти, файлам и другим данным. '
                    'Вы можете отвязать любой из них, в том числе подключённый первым: просто попросите об этом агента. '
                    'Можно продолжать общение.'
                    if result.get('user') else 'Не удалось привязать аккаунт. Команда истекла, уже использована или этот аккаунт подключён отдельно. Попросите агента проверить подключение.')
            if result.get('user') and len(result.get('accounts') or []) == 1:
                text = ('Второй аккаунт не добавлен: команда отправлена с уже подключённого аккаунта.\n\n' +
                        _linked_accounts_text(result['accounts']) +
                        '\n\nПопросите агента выдать новую команду и отправьте её со второго личного аккаунта.')
            elif result.get('user') and not result.get('accounts'):
                text = ('Команда обработана, но проверить список подключённых аккаунтов сейчас не удалось. '
                        'Попросите агента проверить подключение. Повторять команду не нужно.')
        except Exception:
            text = 'Результат привязки не подтверждён. Напишите обычное сообщение, чтобы проверить доступ.'
        await _control_reply(adapter, telegram, message, text)
        return False
    if re.fullmatch(r'/unlink(?:@[A-Za-z0-9_]+)?', raw):
        await _control_reply(adapter, telegram, message, 'Попросите агента отвязать этот или другой ваш аккаунт. Он объяснит последствия и запросит подтверждение.')
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
                'name': str(getattr(user, 'full_name', '') or 'Пользователь')[:120]}, timeout=700)
            await _notice(adapter, telegram, message, 'Профиль готов. Администраторы этого сервиса могут просматривать вашу переписку, память и файлы. Напишите, с чем помочь. Для входа на сайт попросите меня прислать код.')
        except Exception:
            await _notice(adapter, telegram, message, 'Приглашение не удалось активировать. Проверьте его или обратитесь к владельцу.')
        return False
    if str(getattr(chat, 'id', '')) == telegram:
        await _notice(adapter, telegram, message, 'Для доступа нужно приглашение владельца. Попросите прислать приглашение и отправьте полученную команду в этот чат.')
    return False

def _receipt(value):
    if isinstance(value, dict):
        data = value
    elif is_dataclass(value):
        data = asdict(value)
    else:
        data = {key: getattr(value, key) for key in ('success', 'message_id', 'error', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind', 'raw_response') if hasattr(value, key)}
    receipt = {key: data[key] for key in ('success', 'message_id', 'error', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind') if key in data}
    # Native Telegram _send_chunks хранит все части в raw_response; наружу передаём только ID.
    raw = data.get('raw_response')
    parts = raw.get('message_ids') if isinstance(raw, dict) else None
    if isinstance(parts, list):
        existing = receipt.get('continuation_message_ids', [])
        ids = [*(existing if isinstance(existing, list) else []), *parts]
        receipt['continuation_message_ids'] = [str(value) for value in ids
            if re.fullmatch(r'[1-9][0-9]{0,19}', str(value or ''))]
    return receipt


class Resolver:
    """Хранит только транспорт и проверенные связи без общего transcript."""
    def __init__(self, adapter, runner=None, ledger=None):
        self.adapter, self.runner = adapter, runner
        self.bridges, self.turns = {}, {}
        self.ledger = ledger if ledger is not None else RouteLedger()
        self.notifications = NotificationTopics(self.ledger, lambda: self.adapter._bot, self._account)
        self.interactive_scopes = {}
        self.supervisor = None
        self.closed = False
        self.retired = False

    def retire(self):
        """Исключить старый resolver из синхронной перезагрузки plugin."""
        self.retired = True

    def start(self):
        """Держать native lifetime всех active профилей без нового сообщения."""
        if not self.closed and self.supervisor is None:
            self.supervisor = asyncio.create_task(self._supervise())

    async def close(self):
        """Закрыть только каналы этого ingress instance."""
        if self.closed:
            return
        self.closed = True
        if _resolvers.get(id(self.adapter)) is self:
            _resolvers.pop(id(self.adapter))
        if self.supervisor is not None:
            self.supervisor.cancel()
            await asyncio.gather(self.supervisor, return_exceptions=True)
            self.supervisor = None
        for bridge in self.bridges.values():
            if bridge.task is not None:
                bridge.task.cancel()
        await asyncio.gather(*(bridge.task for bridge in self.bridges.values()
                               if bridge.task is not None), return_exceptions=True)
        self.ledger.close()

    async def _supervise(self):
        """Обрыв одного worker не отключает расписания соседних владельцев."""
        semaphore = asyncio.Semaphore(8)
        async def ready(profile):
            async with semaphore:
                try:
                    bridge = self._bridge(profile)
                    peer = await bridge.connect()
                    await peer.call('health', {'require_tools': True}, timeout=240)
                except (Exception, asyncio.CancelledError) as error:
                    if isinstance(error, asyncio.CancelledError):
                        raise
        while True:
            try:
                response = await broker_call('ingress.profiles', {})
                profiles = response.get('profiles') if isinstance(response, dict) else None
                if not isinstance(profiles, list) or len(profiles) > 10000:
                    raise ValueError('Invalid active profiles')
                await asyncio.gather(*(ready(profile) for profile in profiles))
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(10)

    async def __call__(self, source):
        """Выбрать worker по актуальному Auth, не по параметрам модели."""
        profile = await broker_call('identity.resolve', {'telegramId': str(source.user_id)})
        return self._bridge(profile)

    def _bridge(self, profile):
        """Настроить scope/UI delivery общего account-bound транспорта."""
        bridge = self._account_bridge(profile)
        if not bridge.require_scope:
            author = str(profile.get('authorTelegramId', profile['telegramId']))
            binding = {**profile, 'telegramId': author, 'authorTelegramId': author}
            bridge.configure_delivery(
                authorize_delivery=lambda action, payload: self.authorize_delivery(binding, action, payload),
                telegram_api=lambda owner, method, payload, scope_id: self.telegram_api(binding, owner, method, payload, scope_id),
                require_scope=True)
        return bridge

    def _account_bridge(self, profile):
        """Закрепить единственный канал worker за стабильным владельцем UID."""
        uid = profile['uid']
        if uid not in self.bridges:
            async def prepare(event):
                return await self.prepare({**profile, 'telegramId': str(event.source.user_id)}, event)
            async def deliver(owner, action, payload):
                return await self.deliver(profile, owner, action, payload)
            async def started(turn_id):
                current = self.turns.get(uid)
                if current is None:
                    raise PermissionError('Unexpected worker turn')
                # Завершение предыдущей task может прийти во время следующего dispatch.
                # Старый end не закрывает новый native ход того же доверенного маршрута.
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

    async def _account(self, profile, telegram_id):
        """Проверить фактический канал через Auth, сохранив стабильного автора."""
        if not re.fullmatch(r'[1-9][0-9]{0,19}', str(telegram_id)):
            raise PermissionError('Only private Telegram chats are supported')
        active = await broker_call('identity.resolve', {'telegramId': str(telegram_id)})
        if (str(active['telegramId']) != str(telegram_id)
                or self.ledger.owner(active) != self.ledger.owner(profile)):
            raise PermissionError('Owner binding changed')
        return active

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
        route_metadata = getattr(self.runner, '_thread_metadata_for_source', None)
        turn['metadata'] = (dict(route_metadata(event.source, event.message_id) or {}) if callable(route_metadata)
                            else ({'thread_id': route[1]} if route[1] else {}))
        inputs = getattr(event, '_brai_identity_inputs', []) or []
        if not isinstance(inputs, list) or len(inputs) > 10 or any(not isinstance(i, dict) for i in inputs):
            raise ValueError('Invalid media inputs')
        origin = {'messageId': str(event.message_id), 'text': getattr(event, 'text', '') or '',
                  'inputs': [{k: item[k] for k in ('itemId', 'caption', 'groupId') if k in item}
                             for item in inputs]}
        input_id = hashlib.sha256(json.dumps(origin, ensure_ascii=False, sort_keys=True,
                                            separators=(',', ':')).encode()).hexdigest()
        answer = getattr(event, 'text', '') or ''
        turn['inputId'] = input_id
        turn.pop('questionReceipt', None)
        turn.pop('accountOfferId', None)
        await broker_call('ingress.admit', {'inputId': input_id, 'messageId': str(event.message_id), 'expectedUid': uid, 'telegramId': str(profile['telegramId']), 'chatId': route[0],
            'privateChat': getattr(event.source, 'chat_type', '') == 'dm', 'turnId': turn['id'],
            'accountAnswer': answer if isinstance(answer, str) and len(answer) <= 8192 else '',
            'accountRefused': (getattr(event, 'text', '') or '').strip().casefold().rstrip('.!') in
                ('нет', 'отмена', 'не подтверждаю', 'не разрешаю', 'не подключай', 'не отвязывай'),
            **({'threadId': int(route[1])} if route[1] else {})})
        self.ledger.admit(profile, route, turn['metadata'], str(event.message_id))
        fields = ('text', 'user_name', 'message_id', 'media_urls', 'media_types',
                  'media_text_inlined', 'reply_to_message_id', 'reply_expected')
        data = {key: getattr(event, key) for key in fields if getattr(event, key, None) is not None}
        data['delivery_scope'] = turn['id']
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

    def authorize_delivery(self, profile, action, payload):
        """Подтвердить маршрут и принадлежность reply/edit по доверенному журналу."""
        metadata = payload.get('metadata') or {}
        if not isinstance(metadata, dict):
            raise ValueError('Invalid metadata')
        route = (str(payload.get('chat_id') or ''),
                 str(metadata.get('thread_id') or metadata.get('message_thread_id') or ''))
        known = self.ledger.metadata(profile, route)
        if known is None and (route[1] or not re.fullmatch(r'[1-9][0-9]{0,19}', route[0])):
            raise PermissionError('Unknown owner conversation')
        if payload.get('reply_to') and not self.ledger.owns(profile, route, payload['reply_to']):
            raise PermissionError('Unauthorized owner reply')
        if action == 'edit_message' and not self.ledger.owns(profile, route, payload.get('message_id'), outgoing=True):
            raise PermissionError('Unauthorized owner edit')
        return route, known or {}

    async def delivery_context(self, profile, owner, payload):
        """Различить native turn, callback и намеренную фоновую доставку."""
        scope_id = request_scope.get()
        turn = self.turns.get(profile['uid'])
        if not isinstance(payload.get('metadata') or {}, dict):
            raise ValueError('Invalid metadata')
        if scope_id is not UNSCOPED and not (turn is not None and scope_id == turn['id']):
            return await self._background_delivery_context(profile, owner, payload, scope_id)
        uid = profile['uid']
        if owner != profile['userId'] or uid not in self.turns:
            raise PermissionError('No active owner turn')
        metadata = payload.get('metadata') or {}
        route = (str(payload.get('chat_id') or ''),
                 str(metadata.get('thread_id') or metadata.get('message_thread_id') or ''))
        if route != self.turns[uid]['route']:
            raise PermissionError('Delivery outside current conversation')
        input_id = turn.get('inputId')
        def current():
            if self.turns.get(uid) is not turn or turn.get('inputId') != input_id:
                raise PermissionError('Owner turn changed')
        state = await broker_call('ingress.status', {'uid': uid, 'turnId': turn['id'],
            **({'inputId': input_id} if input_id else {})})
        current()
        turn['accountOfferId'] = state.get('accountOfferId') if state.get('needsAccountConsent') is True else None
        interim = metadata.get('_interim_send') is True
        metadata = dict(turn.get('metadata') or ({'thread_id': route[1]} if route[1] else {}))
        if interim:
            metadata['_interim_send'] = True
        return route, metadata, turn, current, bool(state.get('suppressFinal'))

    async def _background_delivery_context(self, profile, owner, payload, scope_id):
        """Проверить callback/proactive маршрут без истекающего native хода."""
        if owner != profile['userId']:
            raise PermissionError('Owner mismatch')
        supplied = payload.get('metadata') or {}
        route = (str(payload.get('chat_id') or ''),
                 str(supplied.get('thread_id') or supplied.get('message_thread_id') or ''))
        grant = self.interactive_scopes.get(scope_id) if isinstance(scope_id, str) else None
        if scope_id is not None and (not grant or grant['owner'] != self.ledger.owner(profile)
                or grant['expires'] <= time.monotonic() or grant['route'] != route):
            raise PermissionError('Expired or foreign delivery scope')
        checked_route, metadata = self.authorize_delivery(profile, 'send', payload)
        await self._account(profile, route[0])
        def current():
            if grant is not None and (self.interactive_scopes.get(scope_id) is not grant
                    or grant['expires'] <= time.monotonic()):
                raise PermissionError('Interactive delivery expired')
        return checked_route, metadata, None, current, False

    async def deliver(self, profile, owner, action, payload):
        """Доставить только проверенные сообщения и артефакты текущего владельца и маршрута."""
        route, metadata, turn, current, suppress = await self.delivery_context(profile, owner, payload)
        if suppress:
            return {'success': True}
        if action == 'send_draft':
            if not re.fullmatch(r'[1-9][0-9]{0,19}', route[0]):
                raise PermissionError('Drafts require owner private chat')
            supports = getattr(self.adapter, 'supports_draft_streaming', None)
            if not callable(supports) or not supports('dm', metadata):
                return {'success': False, 'error': 'Draft transport unavailable'}
        notification = (payload.get('metadata') or {}).get('_brai_notifications') is True
        if notification:
            if (request_scope.get() is not None or turn is not None or route[1]
                    or payload.get('reply_to') or action not in {
                        'send', 'send_file_set', 'send_image_file', 'send_document',
                        'send_video', 'send_voice', 'send_animation'}):
                raise PermissionError('Invalid notification delivery')
            async def send_notification(target, options):
                await self._account(profile, target[0])
                return await self._deliver_route(profile, action, payload, target, options,
                                                 None, current)
            return await self.notifications.deliver(profile, route[0], send_notification,
                                                    text=action == 'send')
        return await self._deliver_route(profile, action, payload, route, metadata, turn, current)

    async def _deliver_route(self, profile, action, payload, route, metadata, turn, current):
        """Отправить в уже проверенный маршрут и сохранить только фактические квитанции."""
        uid = profile['uid']
        input_id = turn.get('inputId') if turn else None
        offer_id = turn.get('accountOfferId') if turn else None
        file_actions = ('send_image_file', 'send_document', 'send_video', 'send_voice', 'send_animation')
        if action == 'send_file_set' or action in file_actions:
            from files.native import telegram_sender, validate_telegram, presentation
            if action == 'send_file_set':
                items, kind, fallback = payload['items'], payload['kind'], payload['fallback']
            else:
                items = [{'artifact': payload['artifact'], 'caption': payload.get('caption') or ''}]
                kind, fallback = 'single', False
            prepared, converted = [], []
            try:
                for item in items:
                    artifact = await broker_call('ingress.artifact' if turn else 'ingress.delivery-artifact',
                        {'uid': uid, **({'turnId': turn['id']} if turn else {}),
                         'artifactId': item['artifact']['artifact_id']}, timeout=120)
                    current()
                    path = artifact.get('localPath')
                    if not isinstance(path, str) or not path.startswith('/'):
                        raise ValueError('Invalid artifact')
                    view = item.get('presentation') or presentation(artifact)
                    if action == 'send_document':
                        view = 'document'
                    elif action == 'send_animation':
                        view = 'animation'
                    elif action == 'send_voice' and payload.get('is_voice'):
                        view = 'voice'
                        if artifact['mimeType'] not in ('audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4'):
                            from gateway.platforms.base import transcode_to_ogg_opus
                            converted_path = await asyncio.to_thread(transcode_to_ogg_opus, path)
                            if not converted_path or converted_path == path:
                                raise ValueError('Voice conversion unavailable')
                            converted.append(converted_path)
                            path = converted_path
                            artifact = {**artifact, 'mimeType': 'audio/ogg', 'sizeBytes': Path(path).stat().st_size}
                    prepared.append({'localPath': path, 'file': artifact,
                        'caption': item['caption'], 'presentation': view})
                validate_telegram(prepared)
                current()
                # Только media API receipt означает доставку файла. Native text fallback
                # после ошибки не может превратиться в успешный голосовой ответ.
                ids = await telegram_sender(self.adapter, payload['chat_id'], metadata, kind, prepared,
                                            fallback, reply_to=payload.get('reply_to'))
                if (not isinstance(ids, list) or len(ids) != len(prepared)
                        or any(type(value) not in (int, str) or not str(value).isdecimal()
                               or int(value) <= 0 for value in ids)):
                    raise ValueError('Incomplete file delivery receipt')
                ids = [str(value) for value in ids]
                for message_id in ids:
                    self.ledger.record(profile, route, message_id)
                return {'success': True, 'message_id': ids[-1], 'continuation_message_ids': ids[:-1],
                        'raw_response': {'message_ids': ids}}
            finally:
                for path in converted:
                    Path(path).unlink(missing_ok=True)
        if action == 'send_image':
            raise PermissionError('Publish local media first')
        values = {**payload, 'metadata': metadata}
        method = getattr(self.adapter, action, None)
        if not callable(method):
            raise ValueError('Native delivery unavailable')
        current()
        result = await method(**values)
        if action == 'send_typing' and result is None:
            return {'success': True}
        receipt = _receipt(result)
        final = (action == 'send' and not metadata.get('_interim_send') or
                 action == 'edit_message' and payload.get('finalize') is True)
        if final and turn is not None and input_id and offer_id:
            ids = [receipt.get('message_id') or payload.get('message_id')]
            continuations = receipt.get('continuation_message_ids', [])
            if isinstance(continuations, list):
                ids.extend(continuations)
            valid = [int(value) for value in ids if re.fullmatch(r'[1-9][0-9]{0,19}', str(value or ''))]
            if self.turns.get(uid) is turn and turn.get('inputId') == input_id:
                if receipt.get('success') is True and valid:
                    try:
                        fresh = await broker_call('ingress.status', {'uid': uid, 'turnId': turn['id'], 'inputId': input_id})
                    except Exception:
                        fresh = {}
                    if (self.turns.get(uid) is turn and turn.get('inputId') == input_id
                            and fresh.get('accountOfferId') == offer_id and fresh.get('needsAccountConsent') is True):
                        previous = turn.get('questionReceipt') or {}
                        if previous.get('inputId') == input_id and previous.get('accountOfferId') == offer_id:
                            valid.append(int(previous['questionMessageId']))
                        turn['questionReceipt'] = {'inputId': input_id, 'accountOfferId': offer_id,
                                                   'questionMessageId': str(max(valid))}
                    else:
                        previous = turn.get('questionReceipt') or {}
                        if previous.get('inputId') == input_id and previous.get('accountOfferId') == offer_id:
                            turn.pop('questionReceipt', None)
                else:
                    previous = turn.get('questionReceipt') or {}
                    if previous.get('inputId') == input_id and previous.get('accountOfferId') == offer_id:
                        turn.pop('questionReceipt', None)

        if receipt.get('success'):
            for message_id in [receipt.get('message_id'), *(receipt.get('continuation_message_ids') or [])]:
                if message_id:
                    self.ledger.record(profile, route, message_id)
        return receipt

    async def interactive_binding(self, update):
        """Проверить настоящего clicker и точное сообщение его личного worker."""
        user = getattr(update, 'effective_user', None)
        telegram = str(getattr(user, 'id', '') or '')
        if not re.fullmatch(r'[1-9][0-9]{0,19}', telegram) or getattr(user, 'is_bot', True):
            raise PermissionError('Invalid interactive sender')
        query = getattr(update, 'callback_query', None)
        inline = getattr(update, 'inline_query', None)
        if query is not None and inline is None:
            message = getattr(query, 'message', None)
            if (message is None or getattr(message, 'sender_chat', None)
                    or getattr(message, 'business_connection_id', None)):
                raise PermissionError('Invalid callback message')
            chat_info = getattr(message, 'chat', None)
            chat = str(getattr(chat_info, 'id', '') or '')
            if getattr(chat_info, 'type', None) != 'private' or chat != telegram:
                raise PermissionError('Only private Telegram callbacks are supported')
            profile = await broker_call('identity.resolve', {'telegramId': telegram})
            resolve_thread = getattr(self.adapter, '_effective_message_thread_id', None)
            thread = resolve_thread(message) if callable(resolve_thread) else getattr(message, 'message_thread_id', None)
            route = (chat, str(thread or ''))
            if not self.ledger.owns(profile, route, str(getattr(message, 'message_id', '')), outgoing=True):
                raise PermissionError('Callback belongs to another owner')
            query_id = str(getattr(query, 'id', '') or '')
            kind = 'callback'
        elif inline is not None and query is None:
            profile = await broker_call('identity.resolve', {'telegramId': telegram})
            route = (telegram, '')
            query_id = str(getattr(inline, 'id', '') or '')
            kind = 'inline'
        else:
            raise PermissionError('Unsupported interactive update')
        if not query_id or len(query_id) > 256:
            raise PermissionError('Invalid interactive query')
        return profile, route, query_id, kind

    async def interactive_admit(self, update):
        """Guard не отправляет callback в общий native gateway."""
        await self.interactive_binding(update)
        return True

    async def interactive(self, update):
        """Отправить подлинный callback только его UID-bound worker."""
        profile, route, query_id, kind = await self.interactive_binding(update)
        now = time.monotonic()
        self.interactive_scopes = {key: value for key, value in self.interactive_scopes.items()
                                   if value['expires'] > now}
        if len(self.interactive_scopes) >= 4096:
            raise PermissionError('Too many interactive scopes')
        scope_id = uuid.uuid4().hex
        self.interactive_scopes[scope_id] = {'owner': self.ledger.owner(profile),
            'route': route, 'actorTelegramId': str(profile['telegramId']),
            'queryId': query_id, 'kind': kind, 'expires': now + 300}
        from types import SimpleNamespace
        bridge = await self(SimpleNamespace(user_id=str(profile['telegramId'])))
        peer = await bridge.connect()
        result = await peer.call('interactive', {'update': update.to_dict(),
                                'owner': profile['userId'], 'scope_id': scope_id,
                                'actor_telegram_id': str(profile['telegramId'])})
        if not isinstance(result, dict) or result.get('accepted') is not True:
            raise PermissionError('Interactive dispatch unconfirmed')
        return result

    async def telegram_api(self, profile, owner, method, payload, scope_id):
        """Исполнять только ограниченные UI операции с проверенным owner/route."""
        if owner != profile['userId'] or not isinstance(payload, dict):
            raise PermissionError('Invalid UI owner')
        payload = {key: value for key, value in payload.items() if value is not None}
        allowed = {
            'send_message': {'chat_id', 'text', 'parse_mode', 'entities', 'disable_web_page_preview',
                'link_preview_options', 'disable_notification', 'protect_content', 'reply_markup',
                'reply_to_message_id', 'allow_sending_without_reply', 'reply_parameters',
                'message_thread_id', 'direct_messages_topic_id'},
            'edit_message_text': {'chat_id', 'message_id', 'text', 'parse_mode', 'entities',
                'disable_web_page_preview', 'link_preview_options', 'reply_markup'},
            'edit_message_reply_markup': {'chat_id', 'message_id', 'reply_markup'},
            'delete_message': {'chat_id', 'message_id'},
            'answer_callback_query': {'callback_query_id', 'text', 'show_alert', 'cache_time'},
            'answer_inline_query': {'inline_query_id', 'results', 'cache_time', 'is_personal', 'next_offset'},
        }
        timeouts = {'connect_timeout', 'read_timeout', 'write_timeout', 'pool_timeout'}
        if method not in allowed or set(payload) - allowed[method] - timeouts:
            raise PermissionError('Telegram UI method or fields denied')
        values = {key: value for key, value in payload.items()
                  if value is not None and key not in timeouts}
        values.update(connect_timeout=5, read_timeout=15, write_timeout=15, pool_timeout=5)
        grant = self.interactive_scopes.get(scope_id) if isinstance(scope_id, str) else None
        if method.startswith('answer_'):
            kind = 'callback' if method == 'answer_callback_query' else 'inline'
            key = 'callback_query_id' if kind == 'callback' else 'inline_query_id'
            if (not grant or grant['owner'] != self.ledger.owner(profile) or grant['kind'] != kind
                    or grant['expires'] <= time.monotonic() or values.get(key) != grant['queryId']):
                raise PermissionError('Foreign interactive query')
            await self._account(profile, grant.get('actorTelegramId', grant['route'][0]))
            if kind == 'inline':
                values['is_personal'] = True
                values['cache_time'] = 0
                results = values.get('results')
                if not isinstance(results, list) or len(results) > 50 or any(
                        not isinstance(item, dict) or item.get('type') != 'article'
                        or not isinstance(item.get('input_message_content'), dict)
                        or not isinstance(item['input_message_content'].get('message_text'), str)
                        for item in results):
                    raise ValueError('Unsupported inline result')
            route = None
        else:
            chat = str(values.get('chat_id') or '')
            thread = str(values.get('message_thread_id') or values.get('direct_messages_topic_id') or '')
            # Native edits identify the original message, without a thread parameter.
            if not thread and grant and grant['route'][0] == chat:
                thread = grant['route'][1]
            elif not thread:
                turn = self.turns.get(profile['uid'])
                if turn and scope_id == turn['id'] and turn['route'][0] == chat:
                    thread = turn['route'][1]
            request = {'chat_id': chat, 'metadata': {'thread_id': thread}}
            token = request_scope.set(scope_id)
            try:
                route, metadata, _, current, _ = await self.delivery_context(profile, owner, request)
            finally:
                request_scope.reset(token)
            if method != 'send_message' and not self.ledger.owns(profile, route, values.get('message_id'), outgoing=True):
                raise PermissionError('Foreign UI message')
            reply = values.get('reply_to_message_id')
            if values.get('reply_parameters'):
                params = values['reply_parameters']
                if not isinstance(params, dict) or set(params) - {'message_id', 'allow_sending_without_reply'}:
                    raise PermissionError('Unsupported reply parameters')
                reply = params.get('message_id')
            if reply and not self.ledger.owns(profile, route, reply):
                raise PermissionError('Foreign UI reply')
            values['chat_id'] = int(chat)
            if method == 'send_message':
                values.pop('message_thread_id', None)
                values.pop('direct_messages_topic_id', None)
                routing = getattr(self.adapter, '_thread_kwargs_for_send', None)
                values.update(routing(chat, route[1] or None, metadata) if callable(routing)
                              else ({'message_thread_id': int(route[1])} if route[1] else {}))
            current()
        bot = getattr(self.adapter, '_bot', None)
        operation = getattr(bot, method, None)
        if not callable(operation):
            raise RuntimeError('Trusted Telegram UI unavailable')
        result = await operation(**values)
        if method.startswith('answer_') or method == 'delete_message':
            if result is not True:
                raise ValueError('Unconfirmed Telegram UI operation')
            return True
        raw = result.to_dict() if callable(getattr(result, 'to_dict', None)) else result
        if not isinstance(raw, dict) or not str(raw.get('message_id', '')).isdecimal():
            raise ValueError('Missing Telegram UI message receipt')
        self.ledger.record(profile, route, raw['message_id'])
        return raw

    async def end(self, profile, worker_turn):
        """Погасить доверенное право входа после завершения соответствующего хода."""
        uid = profile['uid']
        turn = self.turns.get(uid)
        if turn and turn.get('workerTurnId') == worker_turn:
            self.turns.pop(uid, None)
            receipt = turn.get('questionReceipt') or {}
            await broker_call('ingress.close', {'uid': uid, 'turnId': turn['id'],
                **({'inputId': turn['inputId']} if turn.get('inputId') else {}),
                **(receipt if receipt.get('inputId') == turn.get('inputId') else {})})


def create_resolver(adapter, runner):
    """Создать один резолвер на экземпляр native Telegram adapter."""
    key = id(adapter)
    if key not in _resolvers or _resolvers[key].retired:
        home = Path(os.environ['HERMES_HOME'])
        _resolvers[key] = Resolver(adapter, runner, RouteLedger(home / 'identity-delivery.sqlite'))
    return _resolvers[key]
