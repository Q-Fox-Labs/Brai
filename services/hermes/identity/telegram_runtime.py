# ABOUTME: Подключает штатный Telegram ingress к проверенному личному worker.
# ABOUTME: Авторизует update до media и не помещает коды входа в историю.
"""Только транспорт Telegram; пользовательский агент исполняется в другом UID."""
import asyncio
from contextlib import closing, nullcontext
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
import sqlite3
from types import SimpleNamespace
from weakref import WeakValueDictionary

from .ingress import Bridge, serve_chat_control
from .ipc import RpcError
from .artifact_read import receive_artifact, transcode_voice
from .routes import RouteLedger
from .notifications import NotificationTopics
from .scope import UNSCOPED, request_scope
from .ordinary_admission import disabled_command, group_chat_id, group_message, message_thread, start_command

MAX_FRAME = 2 * 1024 * 1024
_resolvers = {}
_notices = {}
_logger = logging.getLogger(__name__)

_WAIT = r'(?:пожалуйста[ ,]+)?(?:жди|ждите|подожди|подождите)(?:[ ,]+пожалуйста)?'
_SOURCE_FILE = r'это (?:таблица|файл|документ|первый (?:файл|документ|протокол))'
_INCOMING_FILES = (
    r'(?:(?:сейчас|скоро) (?:будет|будут)|(?:я )?(?:(?:сейчас|скоро) )?(?:пришлю|отправлю|загружу)) '
    r'(?:ещ[её] )?(?:(?:один|одну|два|две|три|пару|несколько|следующий|следующее) )?'
    r'(?:файл(?:а|ы|ов)?|документ(?:а|ы|ов)?|протокол(?:а|ы|ов)?|таблиц(?:а|у|ы)?)'
)
_WAITING_TEXT = re.compile(
    rf'(?:{_WAIT}|{_SOURCE_FILE}[,.! ]+{_WAIT}|{_WAIT}[,.! ]+{_INCOMING_FILES}|{_INCOMING_FILES})[.!]*'
)


def _waiting_for_files(event, message_type, inputs):
    """Permit silence only for a standalone wait or incoming-file notice."""
    text = getattr(event, 'text', None)
    if (message_type != 'text' or not isinstance(text, str) or not text.strip() or inputs
            or getattr(event, 'media_urls', None) or getattr(event, 'media_types', None)
            or getattr(event, 'media_text_inlined', None)):
        return False
    return all(_WAITING_TEXT.fullmatch(' '.join(line.casefold().split()))
               for line in text.splitlines() if line.strip())


def _private_topic_failure(error):
    """Classify a refusal without conflating it with a lost acceptance."""
    from plugins.platforms.telegram.adapter import _BraiPrivateTopicRetryFailed
    from telegram.error import BadRequest, Forbidden
    if isinstance(error, _BraiPrivateTopicRetryFailed):
        kind = error.args[0]
    elif isinstance(error, (BadRequest, Forbidden)):
        kind = 'telegram_rejected'
    else:
        return None
    return {'success': False, 'retryable': False, 'error_kind': kind}


async def broker_call(method, params, timeout=15):
    """Вызвать единственный root broker, проверив его UID ядром."""
    path = os.environ.get('BRAI_IDENTITY_BROKER', '')
    if not path.startswith('/'):
        raise PermissionError('Broker unavailable')
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=MAX_FRAME + 1),
                                            None if timeout is None else 3)
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
            or getattr(message, 'sender_chat', None) or getattr(message, 'business_connection_id', None)):
        return False
    telegram = str(getattr(user, 'id', ''))
    private = getattr(chat, 'type', None) == 'private' and str(chat.id) == telegram
    grouped = group_message(chat, message)
    if not (private or grouped) or not re.fullmatch(r'[1-9][0-9]{0,19}', telegram):
        return False
    text = getattr(message, 'text', None)
    starting = start_command(text)
    if disabled_command(text) or grouped and starting:
        return False
    resolver = _resolvers.get(id(adapter))
    mirror = getattr(resolver, 'mirror', None)
    snapshot = mirror.snapshot(f'{adapter._bot.id}:{update.update_id}') if mirror is not None else None
    if snapshot is not None and snapshot.get('state') in ('outside', 'forbidden'):
        return False
    if snapshot is not None:
        try:
            latest = await broker_call('ingress.resolve-known', {'telegramId': telegram}, timeout=None)
            same = isinstance(latest, dict) and latest.get('state') == snapshot.get('state')
            if same and snapshot.get('state') == 'known':
                before, after = snapshot['profile'], latest.get('profile')
                same = isinstance(after, dict) and all(before.get(key) == after.get(key)
                    for key in ('uid','profileId','userId','telegramId','authorTelegramId','role','generation'))
            if not same:
                if snapshot.get('state') == 'known':
                    await asyncio.to_thread(mirror.inbox.markblocked, snapshot['profile'], adapter._bot.id, update.update_id)
                    if getattr(mirror, 'transport', None) is not None:
                        await asyncio.to_thread(mirror.transport.transition, adapter._bot.id, update.update_id,
                                                'handing_off','blocked')
                elif snapshot.get('state') == 'unregistered' and getattr(mirror, 'transport', None) is not None:
                    await asyncio.to_thread(mirror.transport.transition, adapter._bot.id, update.update_id,
                                            'handing_off','blocked')
                snapshot['state'] = 'binding_changed'
                if private:
                    await _notice(adapter, telegram, message, 'Состояние доступа изменилось. Отправьте сообщение ещё раз после проверки доступа.')
                return False
        except Exception:
            if snapshot.get('state') == 'known':
                try:
                    await asyncio.to_thread(mirror.inbox.markblocked, snapshot['profile'], adapter._bot.id, update.update_id)
                except Exception:
                    pass
                snapshot['state'] = 'binding_unknown'
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
            if snapshot is not None:
                snapshot['state'] = 'outcome_unknown'
            text = 'Результат привязки не подтверждён. Напишите обычное сообщение, чтобы проверить доступ.'
        await _control_reply(adapter, telegram, message, text)
        return False
    try:
        if snapshot is not None and snapshot.get('state') == 'unregistered':
            # После проверки исходный outsider проходит только onboarding.
            raise PermissionError('Snapshot was unregistered')
        if snapshot is not None and snapshot.get('state') != 'known':
            return False
        profile = await broker_call('identity.resolve', {'telegramId': telegram})
        if snapshot is not None:
            before = snapshot['profile']
            if any(profile.get(key) != before.get(key) for key in ('uid','profileId','userId','telegramId','authorTelegramId','role','generation')):
                await asyncio.to_thread(mirror.inbox.markblocked, before, adapter._bot.id, update.update_id)
                snapshot['state'] = 'binding_changed'
                return False
        if resolver is not None and resolver.journal is not None:
            try:
                await asyncio.to_thread(resolver.journal.incoming, profile, message, chat, user)
                route = (str(chat.id), message_thread(chat, message))
                if route[1] == '1':
                    route = (route[0], '')
                if starting:
                    state = resolver.journal.chat_state(profile, route)
                    text = ('Бот на связи. Ответы в этом диалоге сейчас приостановлены.' if state['paused']
                            else 'Здравствуйте! Я Brai. Напишите, с чем помочь — можно прислать текст, фото, голосовое сообщение или файл.')
                    await _control_reply(adapter, telegram, message, text)
                    return False
                if not resolver.journal.chat_admission(profile, route, str(message.message_id)):
                    return False
            except Exception:
                if snapshot is not None:
                    snapshot['state'] = 'processing_failed'
                _logger.warning('BRAI_TELEGRAM_JOURNAL_WRITE_FAILED')
                return False
        if starting:
            await _control_reply(adapter, telegram, message, 'Здравствуйте! Я Brai. Напишите, с чем помочь.')
            return False
        if getattr(resolver, 'topic_names', None) is not None:
            try:
                resolver.observe_topic(update, profile)
            except Exception as error:
                _logger.warning('BRAI_TELEGRAM_TOPIC_ADMISSION_FAILED error=%s', type(error).__name__)
        return True
    except Exception:
        if snapshot is not None and snapshot.get('state') != 'unregistered':
            return False
    # Приглашение принимается только из личного сообщения самого нового пользователя.
    raw = getattr(message, 'text', '') or ''
    invitation = re.fullmatch(r'/start(?:@[A-Za-z0-9_]+)?\s+(?:invite_)?([A-Za-z0-9_-]{16,128})', raw.strip())
    if private and invitation:
        try:
            await broker_call('identity.invite-redeem', {'telegramId': telegram, 'code': invitation[1],
                'name': str(getattr(user, 'full_name', '') or 'Пользователь')[:120]}, timeout=700)
            await _control_reply(adapter, telegram, message, 'Профиль готов. Администраторы этого сервиса могут просматривать вашу переписку, память и файлы. Напишите, с чем помочь. Для входа на сайт попросите меня прислать код.')
        except Exception:
            if snapshot is not None:
                snapshot['state'] = 'outcome_unknown'
            await _control_reply(adapter, telegram, message, 'Приглашение не удалось активировать. Проверьте его или обратитесь к владельцу.')
        return False
    if private:
        reply = _control_reply if starting else _notice
        await reply(adapter, telegram, message, 'Здравствуйте! Для доступа нужно приглашение владельца. Попросите прислать приглашение и отправьте полученную команду в этот чат.')
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
    if isinstance(raw, dict) and any(raw.get(key) for key in (
            'partial_overflow', 'delivered_chunks', 'delivered_message_ids', 'last_message_id')):
        # AIDEV-NOTE: Не терять доказательство частичной доставки при очистке metadata.
        # Сам текст недоставленных частей через ingress не возвращается.
        receipt['raw_response'] = {'partial_overflow': True}
    parts = raw.get('message_ids') if isinstance(raw, dict) else None
    if isinstance(parts, list):
        existing = receipt.get('continuation_message_ids', [])
        ids = [*(existing if isinstance(existing, list) else []), *parts]
        receipt['continuation_message_ids'] = [str(value) for value in ids
            if re.fullmatch(r'[1-9][0-9]{0,19}', str(value or ''))]
    return receipt


class Resolver:
    """Хранит проверенные маршруты; журнал Telegram изолирован по личному профилю."""
    def __init__(self, adapter, runner=None, ledger=None, journal=None):
        self.adapter, self.runner = adapter, runner
        self.journal = journal
        self.mirror = None
        if journal is not None:
            from .ordinary_admission import Mirror
            from .update_inbox import UpdateInbox, ProfileGateStore
            from .transport_inbox import TransportInbox
            inbox = UpdateInbox(journal)
            async def resolve_known(actor):
                return await broker_call('ingress.resolve-known', {'telegramId': actor}, timeout=None)
            async def inventory():
                return await broker_call('ingress.profiles-strict', {}, timeout=None)
            async def observe(profile):
                reader, writer = await asyncio.open_unix_connection(profile['workerSocket'])
                try:
                    sock = writer.get_extra_info('socket')
                    pid, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != profile['uid']:
                        raise PermissionError('Worker UID changed')
                    stat = Path(f'/proc/{pid}/stat').read_text()
                    return pid, stat.rsplit(')', 1)[1].split()[19]
                finally:
                    writer.close()
                    await writer.wait_closed()
            self.mirror = Mirror(inbox, resolve_known, inventory=inventory, observe=observe,
                                 gate_store=ProfileGateStore(inbox), transport=TransportInbox(journal))
            self.mirror.input_ready = self.input_ready
            self.mirror.reconcile_delivery = self.reconcile_delivery
        self.ready_profiles = set()
        self.bridges, self.turns = {}, {}
        self.turn_locks = {}
        self.ledger = ledger if ledger is not None else RouteLedger()
        self.reply_outbox = None
        self.operator_assignment = None
        if self.mirror is not None and self.mirror.restartable:
            from .reply_outbox import ReplyOutbox
            from .operator_assignment_control import OperatorAssignmentControl
            self.reply_outbox = ReplyOutbox(
                self.ledger.db, self._deliver_saved_reply,
                retry_unknown=os.environ.get('BRAI_IDENTITY_INSTANCE') != 'release')
            self.operator_assignment = OperatorAssignmentControl(self, broker_call)
        self.notifications = NotificationTopics(self.ledger, lambda: self.adapter._bot, self._account)
        self.interactive_scopes = {}
        self.supervisor = None
        self.control_server = None
        self.release_gate = None
        self.release_workers = {}
        self.control_locks = {}
        self.command_menu_lock = asyncio.Lock()
        self.cleared_command_menus = set()
        self.closed = False
        self.retired = False
        self.topic_names = self.topic_rename = None
        self.topic_tasks = set()
        self.topic_locks = WeakValueDictionary()

    def enable_topic_naming(self, names, rename):
        """Подключить генерацию к уже авторизованному входу этого экземпляра."""
        self.topic_names, self.topic_rename = names, rename
        if self.mirror is not None:
            self.mirror.observe_topic_edit = self.observe_topic_edit

    def _topic_event(self, update):
        chat = getattr(update, 'effective_chat', None)
        message = getattr(update, 'message', None) or getattr(update, 'edited_message', None)
        if (self.topic_names is None or not message or not chat
                or getattr(message, 'business_connection_id', None)
                or not (chat.type == 'private' or chat.type == 'supergroup' and getattr(chat, 'is_forum', False))):
            return None
        event = self.topic_names.topic_update(message, getattr(update, 'edited_message', None) is not None)
        if event is None:
            return None
        thread, action, text = event
        if action == 'claim' and message_thread(chat, message) != str(thread):
            return None
        return (str(self.adapter._bot.id), str(chat.id), str(thread)), action, text

    def observe_topic_edit(self, update):
        """Учесть правку от Telegram и до допуска отправителя к обычному разговору."""
        try:
            event = self._topic_event(update)
            if event and event[1] == 'cancel':
                self.ledger.cancel_topic_name(event[0])
        except Exception as error:
            _logger.warning('BRAI_TELEGRAM_TOPIC_EDIT_OBSERVATION_FAILED error=%s', type(error).__name__)

    def observe_topic(self, update, profile):
        """Запланировать одну фоновую попытку после подтверждённого первого сообщения."""
        event = self._topic_event(update)
        if self.closed or event is None:
            return
        route, action, text = event
        if action == 'cancel':
            self.ledger.cancel_topic_name(route)
        elif action == 'create':
            self.ledger.stage_topic_name(route, profile)
        elif self.ledger.claim_topic_name(route, profile):
            task = asyncio.create_task(self._name_topic(profile, route, text))
            self.topic_tasks.add(task)
            task.add_done_callback(self.topic_tasks.discard)

    def _topic_lock(self, route):
        lock = self.topic_locks.get(route)
        if lock is None:
            lock = self.topic_locks[route] = asyncio.Lock()
        return lock

    async def _suggest_topic(self, profile, actor, text, *, bot=None):
        icons = []
        if bot is not None:
            stickers = await bot.get_forum_topic_icon_stickers()
            icons = [{'id': str(item.custom_emoji_id), 'emoji': item.emoji} for item in stickers
                     if getattr(item, 'custom_emoji_id', None) and getattr(item, 'emoji', None)]
            if not icons:
                raise ValueError('Topic icons unavailable')
        result = await broker_call('ingress.topic-suggestion', {'telegramId': actor, 'profileId': profile['profileId'],
            'input': {'request': text, 'icons': [icon['emoji'] for icon in icons]}}, timeout=1800)
        return self.topic_names.validate_suggestion(result, icons)

    async def _name_topic(self, profile, route, text):
        state, outcome = 'claimed', 'skipped'
        try:
            bot = self.adapter._bot
            actor = str(profile['telegramId'])
            generation = self._chat_generation(profile, route[1:])
            suggestion = await self._suggest_topic(profile, actor, text, bot=bot)
            async with self._topic_lock(route):
                active = await self._account(profile, actor)
                self._chat_generation(profile, route[1:], generation)
                if (self.closed or self.adapter._bot is not bot or str(bot.id) != route[0]
                        or any(active.get(key) != profile.get(key) for key in ('role', 'generation'))
                        or not self.ledger.topic_name_current(route, profile)):
                    return
                self.ledger.change_topic_name_state(route, profile, state, 'editing')
                state, outcome = 'editing', 'unconfirmed'
                if await bot.edit_forum_topic(chat_id=int(route[1]), message_thread_id=int(route[2]),
                        name=suggestion['title'], icon_custom_emoji_id=suggestion['iconId']) is not True:
                    raise ValueError('Telegram edit unconfirmed')
                outcome = 'applied'
        except Exception as error:
            _logger.warning('BRAI_TELEGRAM_TOPIC_FAILED error=%s', type(error).__name__)
        finally:
            try:
                self.ledger.change_topic_name_state(route, profile, state, outcome)
            except sqlite3.Error as error:
                _logger.warning('BRAI_TELEGRAM_TOPIC_RECEIPT_FAILED error=%s', type(error).__name__)

    async def rename_current_topic(self, profile, owner, payload, scope_id):
        """Применить запрос от личного worker только к теме его текущего хода."""
        turn = self.turns.get(profile['uid'])
        if (self.closed or self.topic_rename is None or owner != profile['userId'] or not isinstance(scope_id, str)
                or not turn or turn['id'] != scope_id or not isinstance(payload, dict)
                or set(payload) != {'messageId', 'args'} or payload['messageId'] != turn.get('messageId')):
            raise PermissionError('Current topic scope required')
        args = self.topic_rename.rename_arguments(payload['args'])
        chat, thread = turn['route']
        if not re.fullmatch(r'[1-9][0-9]*', thread) or thread == '1':
            raise PermissionError('Current topic required')
        token = request_scope.set(scope_id)
        try:
            _, _, _, current, _ = await self.delivery_context(profile, owner,
                {'chat_id': chat, 'metadata': {'thread_id': thread}})
        finally:
            request_scope.reset(token)
        if self.ledger.metadata(profile, (chat, thread)) is None:
            raise PermissionError('Unknown owner topic')
        bot = self.adapter._bot
        route = (str(bot.id), chat, thread)
        actor = turn.get('actor', chat)
        async def check_group_access():
            if actor == chat:
                return
            member = await bot.get_chat_member(chat_id=int(chat), user_id=int(actor))
            if (member.status != 'creator'
                    and (member.status != 'administrator' or getattr(member, 'can_manage_topics', False) is not True)):
                raise PermissionError('Current topic edit is not permitted')
            current()
        title = args.get('title')
        if title is None:
            await check_group_access()
            try:
                title = (await self._suggest_topic(profile, actor, args['text']))['title']
            except Exception:
                return {'ok': False, 'code': 'TOPIC_GENERATOR_UNAVAILABLE'}
        async with self._topic_lock(route):
            active = await self._account(profile, actor)
            await check_group_access()
            current()
            if (self.closed or self.adapter._bot is not bot
                    or any(active.get(key) != profile.get(key) for key in ('role', 'generation'))):
                raise PermissionError('Current topic scope changed')
            self.ledger.cancel_topic_name(route)
            if await bot.edit_forum_topic(chat_id=int(chat), message_thread_id=int(thread), name=title) is not True:
                raise ValueError('Telegram edit unconfirmed')
        return {'ok': True, 'title': title}

    def _known_forum_chats(self):
        """Нативный adapter ранее создавал Chat scope только для тем."""
        if self.journal is None:
            return set()
        chats = set()
        for path in self.journal.root.glob('*/telegram.sqlite3'):
            with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE name='messages' AND type='table'").fetchone():
                    chats.update(str(row[0]) for row in db.execute("SELECT DISTINCT chat FROM messages WHERE CAST(telegram_id AS INTEGER)>0 AND (thread<>'' OR chat LIKE '-%')"))
        return {int(chat) for chat in chats if re.fullmatch(r'-?[1-9][0-9]*', chat)}

    async def _clear_command_scope(self, scope, key):
        if key in self.cleared_command_menus:
            return
        bot = self.adapter._bot
        if await bot.delete_my_commands(scope=scope, language_code='') is not True:
            raise RuntimeError('Telegram command menu removal unconfirmed')
        if await bot.get_my_commands(scope=scope, language_code=''):
            raise RuntimeError('Telegram command menu remains populated')
        self.cleared_command_menus.add(key)
        _logger.info('telegram_command_menu_removed scope=%s', scope.type)

    async def hide_command_menu(self):
        """Заменить native menu writer удалением всех его прежних scope."""
        from telegram import BotCommandScopeDefault, BotCommandScopeAllPrivateChats, BotCommandScopeAllGroupChats, BotCommandScopeChat
        async with self.command_menu_lock:
            for scope in (BotCommandScopeDefault(), BotCommandScopeAllPrivateChats(), BotCommandScopeAllGroupChats()):
                await self._clear_command_scope(scope, scope.type)
            for chat in sorted(await asyncio.to_thread(self._known_forum_chats)):
                await self._clear_command_scope(BotCommandScopeChat(chat), ('chat', chat))

    async def hide_forum_command_menu(self, message):
        """Новые темы не должны возвращать список команд в Telegram."""
        from telegram import BotCommandScopeChat
        chat = getattr(message, 'chat', None)
        if not chat or not getattr(chat, 'is_forum', False):
            return
        try:
            ident = int(chat.id)
            async with self.command_menu_lock:
                await self._clear_command_scope(BotCommandScopeChat(ident), ('chat', ident))
        except Exception as error:
            # Как у native menu writer: сбой интерфейса не теряет обычный input.
            _logger.warning('telegram_command_menu_cleanup_unconfirmed error=%s', type(error).__name__)

    def retire(self):
        """Исключить старый resolver из синхронной перезагрузки plugin."""
        self.retired = True
        if self.journal is not None and self.journal.restore is not None:
            self.journal.restore()

    def start(self):
        """Держать native lifetime всех active профилей без нового сообщения."""
        path = os.environ.get('BRAI_IDENTITY_INGRESS_CONTROL_SOCKET')
        if path and not self.closed and self.control_server is None:
            self.control_server = asyncio.create_task(serve_chat_control(
                path, self.chat_control, self.release_gate, self.operator_assignment))
        if not self.closed and self.supervisor is None:
            self.supervisor = asyncio.create_task(self._supervise())

    async def chat_control(self, userId, profileId, chat, thread, paused=None):
        """Применить root-selected owner/route; commit запрета предшествует отмене duplex."""
        if (not isinstance(userId, str) or not userId or not isinstance(profileId, str)
                or not isinstance(chat, str) or re.fullmatch(r'[1-9][0-9]{0,19}', chat) is None
                or not isinstance(thread, str) or thread == '1'
                or thread and re.fullmatch(r'[1-9][0-9]{0,15}', thread) is None
                or paused is not None and type(paused) is not bool or self.journal is None):
            raise RpcError(-32602, 'Invalid chat control')
        profile, route = {'userId': userId, 'profileId': profileId}, (chat, thread)
        key = (profileId, *route)
        async with self.control_locks.setdefault(key, asyncio.Lock()):
            state = (self.journal.chat_state(profile, route) if paused is None
                     else self.journal.set_chat_pause(profile, route, paused))
            bridge = next((value for value in self.bridges.values()
                           if value.profile_id == profileId and value.owner == userId), None)
            stopping = state['paused']
            if (paused is not None or state['paused']) and bridge is not None and bridge.peer is not None and not bridge.peer.closed:
                try:
                    receipt = await bridge.peer.call('chat_pause', {'owner': userId, 'chat': chat, 'thread': thread,
                        'paused': state['paused'], 'generation': state['generation']}, timeout=8)
                    stopping = receipt.get('state') != 'stopped' or bridge.dispatch_inflight > 0
                except (ConnectionError, TimeoutError, RpcError):
                    stopping = True
            if paused is False:
                # AIDEV-NOTE: Telegram date имеет секундную точность. Receipt ждёт границу,
                # чтобы новый input после ответа не был принят за накопленный backlog.
                await asyncio.sleep(max(0, state['resumeAfter'] - time.time()))
            return {'paused': state['paused'], 'state': ('stopping' if stopping else 'stopped') if state['paused'] else 'resumed'}

    async def release_status(self, operationId):
        """Проверить каждого active worker после удержания входного транспорта."""
        blocked = {'operationId': operationId, 'state': 'blocked', 'reason': 'worker_control_unavailable'}
        try:
            if self.operator_assignment is not None and (self.operator_assignment.tasks or self.operator_assignment.deliveries):
                return {'operationId': operationId, 'state': 'draining', 'reason': 'operator_assignments'}
            # Native batch callbacks outlive PTB queue.task_done and can still dispatch.
            for name in ('_pending_text_batches', '_pending_text_batch_tasks',
                         '_pending_photo_batches', '_pending_photo_batch_tasks',
                         '_media_group_events', '_media_group_tasks', '_held_inbound_events'):
                pending = getattr(self.adapter, name, None)
                if not isinstance(pending, (dict, list)):
                    return blocked
                if pending:
                    return {'operationId': operationId, 'state': 'draining', 'reason': 'telegram_batches'}
            if not hasattr(self.adapter, '_held_inbound_redispatch_task'):
                return blocked
            redispatch = self.adapter._held_inbound_redispatch_task
            if redispatch is not None and not redispatch.done():
                return {'operationId': operationId, 'state': 'draining', 'reason': 'telegram_batches'}
            if any(bridge.dispatch_inflight for bridge in self.bridges.values()):
                return {'operationId': operationId, 'state': 'draining', 'reason': 'telegram_dispatch'}
            response = await broker_call('ingress.profiles', {})
            profiles = response.get('profiles') if isinstance(response, dict) else None
            if not isinstance(profiles, list):
                return blocked
            for profile in profiles:
                bridge = self._bridge(profile)
                # AIDEV-NOTE: Учитываем worker до RPC: timeout не доказывает отказ begin.
                self.release_workers[bridge.worker_uid] = bridge
            states = []
            for bridge in self.release_workers.values():
                peer = await bridge.connect()
                for method in ('release.begin', 'release.status'):
                    result = await peer.call(method, {'operationId': operationId})
                    if (not isinstance(result, dict) or result.get('operationId') != operationId
                            or result.get('state') not in ('draining', 'blocked', 'ready')):
                        return blocked
                states.append(result)
            if any(item['state'] == 'blocked' for item in states):
                reason = next(item.get('reason') for item in states if item['state'] == 'blocked')
                return {'operationId': operationId, 'state': 'blocked',
                        'reason': reason if isinstance(reason, str) and reason else 'worker_blocked'}
            if any(item['state'] == 'draining' for item in states):
                return {'operationId': operationId, 'state': 'draining', 'reason': 'workers'}
            return {'operationId': operationId, 'state': 'ready', 'reason': None}
        except Exception:
            return blocked

    async def release_resume(self, operationId):
        """Снять все подтверждённые и неопределённые worker fences до входного gate."""
        try:
            for bridge in self.release_workers.values():
                peer = await bridge.connect()
                result = await peer.call('release.resume', {'operationId': operationId}, timeout=None)
                if (not isinstance(result, dict) or result.get('operationId') != operationId
                        or result.get('state') != 'resumed'):
                    return False
        except Exception:
            return False
        self.release_workers.clear()
        return True

    async def close(self):
        """Закрыть только каналы этого ingress instance."""
        if self.closed:
            return
        self.closed = True
        for task in self.topic_tasks:
            task.cancel()
        await asyncio.gather(*self.topic_tasks, return_exceptions=True)
        if self.journal is not None and self.journal.restore is not None:
            self.journal.restore()
        if _resolvers.get(id(self.adapter)) is self:
            _resolvers.pop(id(self.adapter))
        if self.control_server is not None:
            self.control_server.cancel()
            await asyncio.gather(self.control_server, return_exceptions=True)
            self.control_server = None
        if self.operator_assignment is not None:
            await self.operator_assignment.close()
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

    def _startup_held(self):
        operation = os.environ.get('BRAI_IDENTITY_RELEASE_HOLD_OPERATION')
        return operation is not None and getattr(self.release_gate, 'operation', None) == operation

    async def _supervise(self):
        """Обрыв одного worker не отключает расписания соседних владельцев."""
        semaphore = asyncio.Semaphore(8)
        async def ready(profile):
            async with semaphore:
                try:
                    bridge = self._bridge(profile)
                    peer = await bridge.connect()
                    await peer.call('health', {'require_tools': True}, timeout=240)
                    self.ready_profiles.add(profile['uid'])
                    await self.retry_pending_close(profile, bridge)
                    if self.mirror is not None and self.mirror.restartable and not self._startup_held():
                        turn = self.turns.get(profile['uid'])
                        if turn is not None and turn.get('delivery'):
                            await self.reconcile_delivery(profile, turn['delivery'])
                        try:
                            await peer.call('outbox.flush', {'owner': profile['userId']})
                        except (ConnectionError, TimeoutError, RpcError):
                            _logger.warning('DURABLE_REPLY_WAITING')
                except (Exception, asyncio.CancelledError) as error:
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    self.ready_profiles.discard(profile['uid'])
        while True:
            try:
                response = await broker_call('ingress.profiles', {})
                profiles = response.get('profiles') if isinstance(response, dict) else None
                if not isinstance(profiles, list) or len(profiles) > 10000:
                    raise ValueError('Invalid active profiles')
                await asyncio.gather(*(ready(profile) for profile in profiles))
                if not self._startup_held():
                    if self.mirror is not None:
                        await self.mirror.pump()
                    if self.reply_outbox is not None:
                        await self.reply_outbox.flush()
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
        if self.journal is not None:
            self.journal.routes[str(profile['telegramId'])] = profile
        bridge = self._account_bridge(profile)
        if self.mirror is not None:
            bridge.input_receipt = self.mirror.accepted
            if self.mirror.restartable:
                async def before_delivery(event):
                    binding = await self.mirror.before_delivery(event)
                    turn = self.turns.get(profile['uid'])
                    if turn is not None and binding and 'delivery_id' in binding:
                        if not group_chat_id(turn['route'][0]):
                            if turn.get('messageId') != str(event.message_id):
                                raise PermissionError('Delivery input changed')
                            confirmed = await broker_call('ingress.bind-delivery', {'uid': profile['uid'],
                                'turnId': turn['id'], 'inputId': turn['inputId'], 'deliveryId': binding['delivery_id']})
                            if not isinstance(confirmed, dict) or confirmed.get('bound') is not True:
                                raise PermissionError('Delivery binding unavailable')
                        turn['delivery'] = binding
                    return binding
                bridge.before_delivery = before_delivery
                bridge.durable_delivery = lambda owner, action, payload, ident, source: self.durable_reply(profile, owner, action, payload, ident, source)
                bridge.recovery_authorize = lambda owner, source, chat, thread: self.authorize_recovery(profile, owner, source, chat, thread)
        if self.journal is not None:
            bridge.chat_state = lambda route: self.journal.chat_state(profile, route)
            bridge.chat_admission = lambda route, mid: self.journal.chat_admission(profile, route, mid)
            bridge.chat_started = lambda route, generation: self.journal.chat_started(profile, route, generation)
            bridge.chat_states = lambda: self.journal.chat_states(profile)
        if not bridge.require_scope:
            author = str(profile.get('authorTelegramId', profile['telegramId']))
            binding = {**profile, 'telegramId': author, 'authorTelegramId': author}
            bridge.configure_delivery(
                authorize_delivery=lambda action, payload: self.authorize_delivery(binding, action, payload),
                telegram_api=lambda owner, method, payload, scope_id: self.telegram_api(binding, owner, method, payload, scope_id),
                require_scope=True)
        return bridge

    async def input_ready(self, profile, route):
        """Ожидать реальную готовность и свободную тему без отклонения сообщения."""
        if profile['uid'] not in self.ready_profiles:
            return False
        if (self.mirror is not None and self.mirror.restartable
                and os.environ.get('BRAI_IDENTITY_INSTANCE') == 'dev'):
            try:
                status = await broker_call('ingress.input-ready', {})
            except (ConnectionError, TimeoutError, OSError, RpcError):
                return False
            if not isinstance(status, dict) or status.get('ready') is not True:
                return False
        turn = self.turns.get(profile['uid'])
        if turn is None:
            return True
        chat, thread = turn['route']
        canonical_route = (route[0], '' if route[1] == '1' else route[1])
        return ((chat, '' if thread == '1' else thread) == canonical_route
                and turn.get('actor', str(profile['telegramId'])) == str(profile['telegramId']))

    async def retry_pending_close(self, profile, bridge):
        """Повторять лишь завершение хода, у которого нет активного dispatch/worker."""
        async with self.turn_locks.setdefault(profile['uid'], asyncio.Lock()):
            turn = self.turns.get(profile['uid'])
            if (turn and turn.get('closePending') == (turn.get('inputId'), turn.get('workerTurnId'))
                    and not bridge.dispatch_inflight and not bridge.known_turns):
                await self._end(profile, turn.get('workerTurnId'))

    async def reconcile_delivery(self, profile, binding):
        """Сверить факт приёма worker после потерянного RPC receipt."""
        peer = await self._bridge(profile).connect()
        result = await peer.call('dispatch.status', {'owner': profile['userId'], **binding})
        receipt = result.get('receipt') or {}
        turn = self.turns.get(profile['uid'])
        if turn is not None and receipt.get('turn_id'):
            turn['workerTurnId'] = receipt['turn_id']
            bridge = self._bridge(profile)
            bridge.known_turns.add(receipt['turn_id'])
            if result.get('state') in ('completed', 'interrupted'):
                await bridge._close_turn(receipt['turn_id'])
        elif turn is not None and result.get('state') == 'not_received' and turn.get('workerTurnId') is None:
            await self.end(profile, None)
        return result

    async def _input_delivery_body(self, profile, owner, action, payload, source_id, *, strict_thread=False):
        """Восстановить автора и маршрут из принятого исходного входа."""
        profile = {**profile, 'authorTelegramId': profile.get('authorTelegramId', profile['telegramId'])}
        if owner != profile['userId'] or self.reply_outbox is None:
            raise PermissionError('Reply owner mismatch')
        source = await asyncio.to_thread(self.mirror.inbox.delivery_source, profile, source_id, payload.get('reply_to'))
        original = json.loads(source['payload']).get('message', {})
        chat = source['chat']
        grouped = group_chat_id(chat)
        if str(payload.get('chat_id')) != chat or (not grouped and source.get('actor_id') != chat):
            raise PermissionError('Reply input route changed')
        if grouped:
            # Chat ID не идентифицирует владельца общей темы после перезапуска.
            if (source.get('auth_author') != str(profile['authorTelegramId'])
                    or not isinstance(source.get('auth_role'), str)
                    or type(source.get('auth_generation')) is not int):
                raise PermissionError('Group reply has no admitted author binding')
            profile.update(telegramId=source['actor_id'], role=source['auth_role'], generation=source['auth_generation'])
        topic = message_thread(SimpleNamespace(**original.get('chat', {})), SimpleNamespace(**original))
        route = (chat, topic)
        anchor = str(original.get('message_id') or '') if grouped else None
        auth = (str(profile['authorTelegramId']), profile.get('role'), profile.get('generation'))
        if auth != (source.get('auth_author'), source.get('auth_role'), source.get('auth_generation')):
            raise PermissionError('Reply input binding changed')
        if source['state'] == 'handing_off':
            # AIDEV-NOTE: Native может отправить ответ внутри dispatch до входной квитанции.
            turn = self.turns.get(profile['uid'])
            if (turn is None or request_scope.get() != turn['id'] or turn['route'] != route
                    or (turn.get('delivery') or {}).get('delivery_id') != source_id):
                return None, {'pending': {'success': False, 'retryable': True, 'error': 'Waiting for input acceptance'}}
        elif source['state'] != 'accepted':
            raise PermissionError('Reply input not accepted')
        supplied = payload.get('metadata') or {}
        thread = supplied.get('thread_id') or supplied.get('message_thread_id') or supplied.get('direct_messages_topic_id')
        if (strict_thread or thread is not None) and str(thread or '') != route[1]:
            raise PermissionError('Reply input thread changed')
        metadata = self.ledger.metadata(profile, route)
        if metadata is None or (payload.get('reply_to') and not self.ledger.owns(profile, route, payload['reply_to'])):
            metadata = await self._recover_reply_admission(profile, route, source, original, payload.get('reply_to'), metadata)
        if metadata is None:
            raise PermissionError('Reply input admission unavailable')
        self.authorize_delivery(profile, action, payload)
        if supplied.get('_interim_send') is True:
            metadata['_interim_send'] = True
            if supplied.get('_brai_progress') is True:
                metadata['_brai_progress'] = True
        values = {**payload, 'metadata': metadata}
        if anchor is not None and action != 'edit_message':
            # AIDEV-NOTE: Recovered input may enter debounce after a newer message.
            # The bound inbox batch proves the original author and anchor independently of arrival order.
            self.ledger.record(profile, route, anchor, outgoing=False)
            values['reply_to'] = anchor
        body = {'profile': profile, 'action': action, 'payload': values, 'generation': source['chat_generation']}
        return body, {'auth': auth, 'source': source, 'original': original, 'grouped': grouped, 'route': route,
                      'metadata': metadata, 'values': values, 'anchor': anchor}

    async def authorize_recovery(self, profile, owner, source_id, chat_id, thread_id):
        """Не запускать старую задачу после отзыва доступа или смены чата."""
        if not isinstance(chat_id, str) or not isinstance(thread_id, str):
            raise PermissionError('Invalid recovery route')
        body, details = await self._input_delivery_body(profile, owner, 'send',
            {'chat_id': chat_id, 'metadata': {'thread_id': thread_id}}, source_id, strict_thread=True)
        if body is None:
            raise PermissionError('Recovery input not yet accepted')
        bound, payload = body['profile'], body['payload']
        route = (chat_id, thread_id)
        active = await self._account(bound, bound['telegramId'] if group_chat_id(chat_id) else chat_id)
        if any(active.get(key) != bound.get(key) for key in ('role', 'generation')):
            raise PermissionError('Recovery owner binding changed')
        self._chat_generation(bound, route, body['generation'])
        self.authorize_delivery(bound, 'send', payload)
        return {'allowed': True}

    async def durable_reply(self, profile, owner, action, payload, ident, source_id):
        """Сохранить ответ только к реально допущенному исходному input этого worker."""
        body, details = await self._input_delivery_body(profile, owner, action, payload, source_id)
        if body is None:
            return details['pending']
        profile = body['profile']
        silence_warning = '⚠️ Не удалось получить ответ. Попробуйте ещё раз или переформулируйте сообщение.'
        if (not details['grouped'] and action == 'send'
                and payload.get('content', '').strip() == silence_warning):
            turn = self.turns.get(profile['uid'])
            input_id = None
            if (turn and request_scope.get() == turn['id'] and turn['route'] == details['route']
                    and (turn.get('delivery') or {}).get('delivery_id') == source_id):
                input_id = turn.get('inputId')
            original = details['original']
            if input_id is None and isinstance(original.get('text'), str) and original.get('message_id'):
                # AIDEV-NOTE: После перезапуска проверяем тот же текстовый input по исходному Telegram Update.
                origin = {'messageId': str(original['message_id']), 'text': original['text'], 'inputs': []}
                input_id = hashlib.sha256(json.dumps(origin, ensure_ascii=False, sort_keys=True,
                    separators=(',', ':')).encode()).hexdigest()
            body['loginDeliveryId'] = source_id
            if input_id:
                body['loginInputId'] = input_id
        if ident is None:
            # Предупреждение актуально только сейчас и не должно попасть в outbox.
            return await self._deliver_saved_reply(body)
        if (action == 'send_file_set' and any(item.get('presentation') == 'video_note'
                for item in payload.get('items', []))):
            # Older ingress treats this reserved non-UUID assignment as a terminal
            # failure, so a queued video note cannot stall its ordinary outbox.
            # Assignment identifiers are canonical UUIDs; this namespace cannot collide.
            body['operatorAssignmentId'] = 'video-note:' + ident
            body['videoNoteDelivery'] = True
        key = self.ledger.owner(profile)
        auth, source, grouped, route, metadata, values, anchor = (details[name] for name in
            ('auth', 'source', 'grouped', 'route', 'metadata', 'values', 'anchor'))
        from .delivery_journal import delivery_id
        digest = delivery_id([key, auth, source_id, action, payload])

        def matches_saved_reply(saved):
            # Сверяем устойчивые данные доставки. Метаданные действующего маршрута могут обновиться.
            saved_profile = saved['profile']
            if (self.ledger.owner(saved_profile) != key
                    or (grouped and saved_profile.get('telegramId') != profile['telegramId'])
                    or (saved_profile.get('role'), saved_profile.get('generation')) != auth[1:]
                    or saved.get('action') != action or saved.get('generation') != source['chat_generation']):
                return False
            if 'loginDeliveryId' in saved and saved['loginDeliveryId'] != body.get('loginDeliveryId'):
                return False
            old_values = dict(saved['payload'])
            old_metadata = old_values.pop('metadata')
            old_thread = str(old_metadata.get('thread_id') or old_metadata.get('message_thread_id')
                             or old_metadata.get('direct_messages_topic_id') or '')
            if old_thread != route[1] or any(
                    (old_metadata.get(flag) is True) != (metadata.get(flag) is True)
                    for flag in ('_interim_send', '_brai_progress')):
                return False
            expected = {name: value for name, value in values.items() if name != 'metadata'}
            if grouped and action != 'edit_message':
                # Прежний DEV отвечал на первый вход native batch.
                first = str(source.get('batch_first_message_id') or anchor)
                if str(old_values.get('reply_to')) == first:
                    expected['reply_to'] = old_values['reply_to']
            return old_values == expected

        self.reply_outbox.enqueue(ident, key, body, request_digest=digest, matches=matches_saved_reply)
        previous = self.reply_outbox.result(ident)
        if previous and previous.get('success') and previous.get('message_id'):
            return previous
        await self.reply_outbox.flush_owner(key)
        return self.reply_outbox.result(ident) or {'success': False, 'retryable': True, 'error': 'Delivery pending'}

    async def _recover_reply_admission(self, profile, route, source, original, reply_to, metadata):
        """Восстановить запись только для подтверждённого входа сохранённого ответа."""
        chat = route[0]
        message_id = str(original.get('message_id') or '')
        if (group_chat_id(chat) or chat == str(profile['authorTelegramId']) or source['state'] != 'accepted'
                or not message_id or (reply_to and str(reply_to) != message_id)):
            return metadata
        legacy = {**profile, 'authorTelegramId': chat}
        old_metadata = self.ledger.metadata(legacy, route)
        if old_metadata is None or not self.ledger.owns(legacy, route, message_id, outgoing=False):
            return metadata
        active = await self._account(profile, chat)
        if any(active.get(key) != profile.get(key) for key in ('role', 'generation')):
            raise PermissionError('Reply owner binding changed')
        self._chat_generation(profile, route, source['chat_generation'])
        # AIDEV-NOTE: После проверки Auth оставляем более свежие параметры канонического маршрута.
        metadata = self.ledger.metadata(profile, route)
        if metadata is None:
            metadata = old_metadata
        self.ledger.admit(profile, route, metadata, message_id)
        return metadata

    async def _deliver_saved_reply(self, body, *, begin_attempt=None):
        """Восстановить доставку готового ответа при актуальных Auth и поколении беседы."""
        profile, payload = body['profile'], body['payload']
        metadata = payload['metadata']
        route = (str(payload['chat_id']), str(metadata.get('thread_id') or metadata.get('message_thread_id') or metadata.get('direct_messages_topic_id') or ''))
        active = await self._account(profile, profile['telegramId'] if group_chat_id(route[0]) else route[0])
        # _account уже сверил UID, профиль, владельца и канонического автора
        # через RouteLedger.owner; supervisor profile может не дублировать автора.
        if any(active.get(key) != profile.get(key) for key in ('role', 'generation')):
            raise PermissionError('Reply owner binding changed')
        self._chat_generation(profile, route, body['generation'])
        self.authorize_delivery(profile, body['action'], payload)
        if 'loginDeliveryId' in body:
            try:
                receipt = await broker_call('ingress.login-receipt', {'uid': profile['uid'],
                    'telegramId': route[0], 'chatId': route[0], 'deliveryId': body['loginDeliveryId'],
                    **({'inputId': body['loginInputId']} if 'loginInputId' in body else {})})
                if not isinstance(receipt, dict) or type(receipt.get('sent')) is not bool:
                    raise ValueError('Login receipt unavailable')
            except (ConnectionError, TimeoutError, RpcError, ValueError):
                return {'success': False, 'retryable': True, 'error_kind': 'login_receipt_unavailable'}
            if receipt['sent']:
                return {'success': False, 'retryable': False, 'error_kind': 'login_reply_suppressed'}
            if receipt.get('unknown') is True:
                payload = {**payload, 'content': '⚠️ Не удалось подтвердить отправку кода. Проверьте, пришло ли сообщение с кодом.'}
        def current():
            self._chat_generation(profile, route, body['generation'])
        current.generation = body['generation']
        if body.get('videoNoteDelivery') is True:
            ident = body.get('operatorAssignmentId')
            if (not isinstance(ident, str) or not re.fullmatch(r'video-note:[0-9a-f]{64}', ident)
                    or body['action'] != 'send_file_set' or not callable(begin_attempt)):
                raise PermissionError('Invalid video note delivery')
            async def before_send():
                current()
                begin_attempt()

            async def before_retry():
                # The first API call may already have succeeded; never send twice.
                raise PermissionError('Video note retry withheld')

            return await self._deliver_route(profile, body['action'], payload, route, metadata, None, current,
                                             before_send=before_send, before_retry=before_retry,
                                             require_reply=False)
        if 'operatorAssignmentId' in body:
            from telegram.error import BadRequest, Forbidden
            from .reply_outbox import DeliveryDeferred
            ident = body['operatorAssignmentId']
            control = self.operator_assignment
            async def before_send():
                await control.check_delivery(body, route)
                current()
                control.begin_delivery(body, begin_attempt)

            async def before_retry():
                try:
                    await control.check_delivery(body, route, expected_state='sending')
                except (DeliveryDeferred, ConnectionError, TimeoutError) as error:
                    raise PermissionError('Operator assignment retry withheld') from error

            control.deliveries.add(ident)
            try:
                return await self._deliver_route(profile, body['action'], payload, route, metadata, None, current,
                                                 before_send=before_send, before_retry=before_retry)
            except (BadRequest, Forbidden):
                return {'success': False, 'retryable': False, 'error_kind': 'telegram_rejected'}
            finally:
                control.deliveries.discard(ident)
        turn = self.turns.get(profile['uid'])
        if (not group_chat_id(route[0]) and turn is not None and turn['route'] == route
                and request_scope.get() == turn['id']):
            return await self.deliver(profile, profile['userId'], body['action'], payload)
        return await self._deliver_route(profile, body['action'], payload, route, metadata, None, current)

    async def input_filtered(self, event):
        if self.mirror is not None:
            await self.mirror.accepted(event, {'accepted': False})

    async def input_blocked(self, event):
        if self.mirror is not None:
            await self.mirror.block_event(event)

    async def validate_event_binding(self, event):
        """Recheck the original Auth snapshot after native debounce or media batching."""
        binding = getattr(event, '_brai_release_binding', None)
        if not isinstance(binding, tuple) or len(binding) != 7:
            raise PermissionError('Ingress profile binding unavailable')
        resolved = await broker_call('ingress.resolve-known', {'telegramId':binding[3]}, timeout=None)
        profile = resolved.get('profile') if isinstance(resolved, dict) and resolved.get('state') == 'known' else None
        current = None if not isinstance(profile, dict) else tuple(profile.get(key) for key in
            ('uid','profileId','userId','telegramId','authorTelegramId','role','generation'))
        if current != binding:
            await self.input_blocked(event)
            raise PermissionError('Ingress profile binding changed')

    def _account_bridge(self, profile):
        """Закрепить единственный канал worker за стабильным владельцем UID."""
        uid = profile['uid']
        if uid not in self.bridges:
            author = profile.get('authorTelegramId', profile['telegramId'])
            async def prepare(event):
                return await self.prepare({**profile, 'authorTelegramId': author,
                                           'telegramId': str(event.source.user_id)}, event)
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
            bridge = Bridge(profile['userId'], author, uid, profile['workerSocket'],
                            deliver, prepare, on_turn_start=started, on_turn_end=ended)
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
            raise PermissionError('Invalid Telegram account')
        active = await broker_call('identity.resolve', {'telegramId': str(telegram_id)})
        if (str(active['telegramId']) != str(telegram_id)
                or self.ledger.owner(active) != self.ledger.owner(profile)):
            raise PermissionError('Owner binding changed')
        return active

    async def prepare(self, profile, event):
        async with self.turn_locks.setdefault(profile['uid'], asyncio.Lock()):
            turn = self.turns.get(profile['uid'])
            if turn and turn.get('closePending') == (turn.get('inputId'), turn.get('workerTurnId')):
                await self._end(profile, turn.get('workerTurnId'))
            return await self._prepare(profile, event)

    async def _prepare(self, profile, event):
        """Проверить автора и маршрут, затем скопировать его media в профиль."""
        route = (str(event.source.chat_id), str(event.source.thread_id or ''))
        chat_type = getattr(event.source, 'chat_type', '')
        private = chat_type == 'dm' and route[0] == str(profile['telegramId'])
        grouped = (chat_type in ('group', 'supergroup', 'forum') and group_chat_id(route[0])
                   and str(getattr(event.source, 'user_id', '')) == str(profile['telegramId']))
        if not (private or grouped):
            raise PermissionError('Invalid Telegram conversation')
        uid = profile['uid']
        generation = self._chat_generation(profile, route)
        voice_retry = False
        update_ids = getattr(event, '_brai_release_updates', [])
        if getattr(self, 'mirror', None) is not None and len(update_ids) == 1:
            from .transport_inbox import VOICE_RETRY_BASE
            attempt = update_ids[0]
            if attempt >= VOICE_RETRY_BASE:
                bot_id = self.adapter._bot.id
                if not await asyncio.to_thread(self.mirror.transport.is_voice_retry, bot_id, attempt):
                    raise PermissionError('VOICE_RETRY_SOURCE_CHANGED')
                prior = await asyncio.to_thread(self.mirror.inbox.observe, profile, bot_id, attempt % VOICE_RETRY_BASE)
                if prior['state'] != 'accepted' or prior['chat_generation'] != generation:
                    raise PermissionError('VOICE_RETRY_CONSENT_CHANGED')
                self._chat_generation(profile, route, generation)
                voice_retry = True
        turn = self.turns.get(uid)
        if turn and (turn['route'] != route or grouped and turn.get('actor') != str(profile['telegramId'])):
            raise PermissionError('Another conversation is active')
        if not turn:
            turn = {'id': uuid.uuid4().hex, 'route': route}
            self.turns[uid] = turn
        turn['chatGeneration'] = generation
        route_metadata = getattr(self.runner, '_thread_metadata_for_source', None)
        turn['metadata'] = (dict(route_metadata(event.source, event.message_id) or {}) if callable(route_metadata)
                            else ({'thread_id': route[1]} if route[1] else {}))
        inputs = getattr(event, '_brai_identity_inputs', []) or []
        if not isinstance(inputs, list) or len(inputs) > 10 or any(not isinstance(i, dict) for i in inputs):
            raise ValueError('Invalid media inputs')
        origin = {'messageId': str(event.message_id), 'text': getattr(event, 'text', '') or '',
                  'inputs': [{k: item[k] for k in ('itemId', 'caption', 'groupId') if k in item}
                             for item in inputs]}
        if grouped:
            origin.update(chatId=route[0], threadId=route[1])
            turn['actor'] = str(profile['telegramId'])
            turn['replyTo'] = str(event.message_id)
        input_id = hashlib.sha256(json.dumps(origin, ensure_ascii=False, sort_keys=True,
                                            separators=(',', ':')).encode()).hexdigest()
        answer = getattr(event, 'text', '') or ''
        turn['inputId'] = input_id
        turn['messageId'] = str(event.message_id)
        turn.pop('questionReceipt', None)
        turn.pop('accountOfferId', None)
        admitted = await broker_call('ingress.admit', {'inputId': input_id, 'messageId': str(event.message_id), 'expectedUid': uid, 'telegramId': str(profile['telegramId']), 'chatId': route[0],
            'privateChat': private, 'turnId': turn['id'],
            'accountAnswer': answer if private and isinstance(answer, str) and len(answer) <= 8192 else '',
            'accountRefused': (getattr(event, 'text', '') or '').strip().casefold().rstrip('.!') in
                ('нет', 'отмена', 'не подтверждаю', 'не разрешаю', 'не подключай', 'не отвязывай'),
            **({'threadId': int(route[1])} if route[1] else {})})
        if grouped:
            if (not isinstance(admitted, dict) or not isinstance(admitted.get('role'), str)
                    or type(admitted.get('generation')) is not int):
                raise PermissionError('Group admission binding unavailable')
            turn['auth'] = (admitted['role'], admitted['generation'])
        turn.pop('closePending', None)
        self.ledger.admit(profile, route, turn['metadata'], str(event.message_id))
        fields = ('text', 'user_name', 'message_id', 'media_urls', 'media_types',
                  'media_text_inlined', 'reply_to_message_id', 'reply_expected')
        data = {key: getattr(event, key) for key in fields if getattr(event, key, None) is not None}
        if grouped:
            data.pop('reply_to_message_id', None)
        data['delivery_scope'] = turn['id']
        if voice_retry:
            data['voice_retry'] = True
        data['message_type'] = getattr(event.message_type, 'value', event.message_type)
        if _waiting_for_files(event, data['message_type'], inputs):
            data['reply_expected'] = False
        document = getattr(getattr(event, 'raw_message', None), 'document', None)
        declared = getattr(document, 'mime_type', None)
        if (data['message_type'] == 'video' and isinstance(declared, str) and declared.startswith('audio/')
                and len(data.get('media_urls') or []) == 1):
            # AIDEV-NOTE: Native Telegram routes .webm through video even for an audio document.
            # STT still independently validates the actual container and audio stream.
            data['message_type'] = 'audio'
            data['media_types'] = [declared]
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
        if self.journal is not None and self.journal.chat_state(profile, (route[0], '' if route[1] == '1' else route[1]))['paused']:
            raise PermissionError('Conversation paused')
        if '_brai_return_notice_generation' in metadata:
            generation = metadata['_brai_return_notice_generation']
            if type(generation) is not int or generation < 0:
                raise PermissionError('Invalid return notice generation')
            self._chat_generation(profile, route, generation)
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
        generation = self._chat_generation(profile, route, turn.get('chatGeneration'))
        def current():
            if self.turns.get(uid) is not turn or turn.get('inputId') != input_id:
                raise PermissionError('Owner turn changed')
            self._chat_generation(profile, route, generation)
        current.generation = generation
        state = await broker_call('ingress.status', {'uid': uid, 'turnId': turn['id'],
            **({'inputId': input_id} if input_id else {})})
        current()
        if 'actor' in turn:
            active = await self._account(profile, turn['actor'])
            if (active.get('role'), active.get('generation')) != turn['auth']:
                raise PermissionError('Group reply author binding changed')
            current()
        turn['accountOfferId'] = state.get('accountOfferId') if state.get('needsAccountConsent') is True else None
        interim = metadata.get('_interim_send') is True
        progress = interim and metadata.get('_brai_progress') is True
        metadata = dict(turn.get('metadata') or ({'thread_id': route[1]} if route[1] else {}))
        if interim:
            metadata['_interim_send'] = True
            if progress:
                metadata['_brai_progress'] = True
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
        generation = self._chat_generation(profile, route, grant.get('generation') if grant is not None else UNSCOPED)
        checked_route, metadata = self.authorize_delivery(profile, 'send', payload)
        await self._account(profile, route[0])
        def current():
            self._chat_generation(profile, route, generation)
            if grant is not None and (self.interactive_scopes.get(scope_id) is not grant
                    or grant['expires'] <= time.monotonic()):
                raise PermissionError('Interactive delivery expired')
        current.generation = generation
        current()
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
                generation = self._chat_generation(profile, target)
                await self._account(profile, target[0])
                self._chat_generation(profile, target, generation)
                def target_current():
                    current()
                    self._chat_generation(profile, target, generation)
                target_current.generation = generation
                target_current()
                return await self._deliver_route(profile, action, payload, target, options,
                                                 None, target_current)
            return await self.notifications.deliver(profile, route[0], send_notification,
                                                    text=action == 'send')
        return await self._deliver_route(profile, action, payload, route, metadata, turn, current)

    async def _deliver_route(self, profile, action, payload, route, metadata, turn, current, *,
                             before_send=None, before_retry=None, require_reply=True):
        """Отправить в уже проверенный маршрут и сохранить только фактические квитанции."""
        uid = profile['uid']
        input_id = turn.get('inputId') if turn else None
        offer_id = turn.get('accountOfferId') if turn else None
        async def recheck_anchor(anchor):
            try:
                active = await self._account(profile, route[0])
                if (any(active.get(key) != profile.get(key) for key in ('role', 'generation'))
                        or not self.ledger.owns(profile, route, anchor, outgoing=False)):
                    raise PermissionError('Telegram reply anchor is no longer admitted')
                current()
            except (ConnectionError, TimeoutError, RpcError) as error:
                raise PermissionError('Telegram reply authorization unavailable') from error

        file_actions = ('send_image_file', 'send_document', 'send_video', 'send_voice', 'send_animation')
        if turn is not None and turn.get('replyTo') and action in ('send', 'send_file_set', *file_actions):
            payload = {**payload, 'reply_to': turn['replyTo']}
        if action == 'send_file_set' or action in file_actions:
            from files.native import telegram_sender, validate_telegram, presentation
            if action == 'send_file_set':
                items, kind, fallback = payload['items'], payload['kind'], payload['fallback']
            else:
                items = [{'artifact': payload['artifact'], 'caption': payload.get('caption') or ''}]
                kind, fallback = 'single', False
            prepared, opened = [], []
            try:
                for item in items:
                    artifact, stream = await receive_artifact(
                        {'uid': uid, **({'turnId': turn['id']} if turn else {}),
                         **({'inputId': input_id} if input_id else {}),
                         'artifactId': item['artifact']['artifact_id']}, timeout=120)
                    opened.append(stream)
                    current()
                    view = item.get('presentation') or presentation(artifact)
                    if action == 'send_document':
                        view = 'document'
                    elif action == 'send_animation':
                        view = 'animation'
                    elif action == 'send_voice' and payload.get('is_voice'):
                        view = 'voice'
                        if artifact['mimeType'] not in ('audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4'):
                            stream = await transcode_voice(stream)
                            opened.append(stream)
                            artifact = {**artifact, 'mimeType': 'audio/ogg',
                                        'sizeBytes': stream.getbuffer().nbytes}
                    prepared.append({'readHandle': stream, 'file': artifact,
                        'caption': item['caption'], 'presentation': view})
                validate_telegram(prepared)
                current()
                anchor = payload.get('reply_to') or metadata.get('telegram_reply_to_message_id')
                private_topic = (route[1] and metadata.get('telegram_dm_topic_reply_fallback')
                                 and callable(getattr(self.adapter, '_brai_send_with_private_topic_retry', None)))
                parameters = {'strict': True, 'before_send': before_send, 'require_reply': require_reply} if before_send is not None else {}
                if private_topic and anchor and (before_retry is not None
                        or self.ledger.owns(profile, route, anchor, outgoing=False)):
                    async def check_retry():
                        if before_retry is not None:
                            await before_retry()
                            current()
                        else:
                            await recheck_anchor(anchor)

                    parameters.update(before_retry=check_retry, topic_anchor=anchor)
                try:
                    with self.journal.scope(profile, prepared, route[1]) if self.journal is not None else nullcontext():
                        ids = await telegram_sender(self.adapter, payload['chat_id'], metadata, kind, prepared,
                                                    fallback, reply_to=payload.get('reply_to'), **parameters)
                except Exception as error:
                    failure = _private_topic_failure(error) if private_topic else None
                    if failure is None:
                        raise
                    return failure
                if (not isinstance(ids, list) or len(ids) != len(prepared)
                        or any(type(value) not in (int, str) or not str(value).isdecimal()
                               or int(value) <= 0 for value in ids)
                        or len({int(value) for value in ids}) != len(ids)):
                    return {'success': False, 'retryable': False, 'error_kind': 'delivery_unknown'}
                ids = [str(value) for value in ids]
                for message_id in ids:
                    self._index_delivery(profile, route, message_id, current.generation, created=True)
                return {'success': True, 'message_id': ids[-1], 'continuation_message_ids': ids[:-1],
                        'raw_response': {'message_ids': ids}}
            finally:
                for stream in opened:
                    stream.close()
        if action == 'send_image':
            raise PermissionError('Publish local media first')
        values = {**payload, 'metadata': metadata}
        if before_send is not None:
            from files.native import telegram_format, telegram_target, text_units, verify_telegram_target
            formatted = telegram_format(self.adapter, values['content'])
            if action != 'send' or text_units(formatted) > 3500:
                raise PermissionError('Operator assignment requires one complete message')
            target = telegram_target(self.adapter, values['chat_id'], values['reply_to'], metadata, exact=True)
            await before_send()
            with self.journal.scope(profile, thread=route[1]) if self.journal is not None else nullcontext():
                send = getattr(self.adapter, '_brai_send_with_private_topic_retry', None)
                if callable(send):
                    async def check_retry():
                        await before_retry()
                        current()

                    try:
                        anchor = values['reply_to']
                        trusted = {**metadata, 'telegram_reply_to_message_id': anchor}
                        sent = await send(lambda options: self.adapter._send_chunk_markdown_or_plain(formatted, options),
                                          trusted, target, anchor, before_retry=check_retry)
                    except Exception as error:
                        failure = _private_topic_failure(error)
                        if failure is None:
                            raise
                        return failure
                else:
                    sent = await self.adapter._bot.send_message(**target, text=formatted, parse_mode='MarkdownV2')
            from files.store import FileError
            try:
                verify_telegram_target(sent, target)
            except FileError:
                return {'success': False, 'retryable': False, 'error_kind': 'delivery_unknown'}
            message_id = getattr(sent, 'message_id', None)
            if type(message_id) is not int or message_id <= 0:
                return {'success': False, 'retryable': False, 'error_kind': 'delivery_unknown'}
            self._index_delivery(profile, route, message_id, current.generation, created=True)
            return {'success': True, 'message_id': str(message_id)}
        anchor = values.get('reply_to') or metadata.get('telegram_reply_to_message_id')
        if (action == 'send' and metadata.get('telegram_dm_topic_reply_fallback') and anchor
                and self.ledger.owns(profile, route, anchor, outgoing=False)):
            values['metadata'] = {**metadata, 'telegram_reply_to_message_id': anchor,
                                  '_brai_before_topic_retry': lambda: recheck_anchor(anchor)}
        method = getattr(self.adapter, action, None)
        if not callable(method):
            raise ValueError('Native delivery unavailable')
        current()
        with self.journal.scope(profile, thread=route[1]) if self.journal is not None else nullcontext():
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
                    self._index_delivery(profile, route, message_id, current.generation, created=action != 'edit_message')
        return receipt

    def _chat_generation(self, profile, route, expected=UNSCOPED):
        """Проверить pause/generation; неизвестная legacy provenance допустима только до первой паузы."""
        canonical = (route[0], '' if route[1] == '1' else route[1])
        state = self.journal.chat_state(profile, canonical) if self.journal is not None else {'paused': False, 'generation': 0}
        if state['paused'] or expected is not UNSCOPED and state['generation'] != (0 if expected is None else expected):
            raise PermissionError('Paused or stale conversation action')
        return state['generation']

    def _record_delivery(self, profile, route, message_id, generation, *, created):
        """Запомнить принадлежность receipt; поколение рождения пишется только для нового сообщения."""
        self.ledger.record(profile, route, message_id)
        if created and self.journal is not None:
            canonical = (route[0], '' if route[1] == '1' else route[1])
            self.journal.record_presentation(profile, canonical, message_id, generation)

    def _index_delivery(self, profile, route, message_id, generation, *, created):
        """Retain Telegram's receipt if the secondary route index is unavailable."""
        try:
            self._record_delivery(profile, route, message_id, generation, created=created)
        except (sqlite3.Error, OSError) as error:
            _logger.warning('telegram_receipt_index_failed error=%s', type(error).__name__)

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
            canonical = (route[0], '' if route[1] == '1' else route[1])
            presentation = self.journal.presentation_generation(profile, canonical, str(getattr(message, 'message_id', ''))) if self.journal is not None else None
            generation = self._chat_generation(profile, route, presentation)
            if not self.ledger.owns(profile, route, str(getattr(message, 'message_id', '')), outgoing=True):
                raise PermissionError('Callback belongs to another owner')
            query_id = str(getattr(query, 'id', '') or '')
            kind = 'callback'
        elif inline is not None and query is None:
            bound = self.journal.routes.get(telegram) if self.journal is not None else None
            observed = self._chat_generation(bound, (telegram, '')) if bound is not None else None
            profile = await broker_call('identity.resolve', {'telegramId': telegram})
            route = (telegram, '')
            if bound is not None and bound['profileId'] != profile['profileId']:
                raise PermissionError('Interactive owner binding changed')
            generation = self._chat_generation(profile, route, observed)
            query_id = str(getattr(inline, 'id', '') or '')
            kind = 'inline'
        else:
            raise PermissionError('Unsupported interactive update')
        if not query_id or len(query_id) > 256:
            raise PermissionError('Invalid interactive query')
        if getattr(self, 'mirror', None) is not None:
            snapshot = self.mirror.snapshot(f'{self.adapter._bot.id}:{update.update_id}')
            before = snapshot.get('profile')
            if (snapshot.get('state') != 'known' or not isinstance(before, dict)
                    or any(profile.get(key) != before.get(key) for key in
                           ('uid','profileId','userId','telegramId','authorTelegramId','role','generation'))):
                if snapshot.get('state') == 'known' and isinstance(before, dict):
                    await asyncio.to_thread(self.mirror.inbox.markblocked, before, self.adapter._bot.id, update.update_id)
                snapshot['state'] = 'binding_changed'
                raise PermissionError('Interactive binding changed')
        return profile, route, query_id, kind, generation

    async def interactive_admit(self, update):
        """Guard не отправляет callback в общий native gateway."""
        await self.interactive_binding(update)
        return True

    async def interactive(self, update):
        """Отправить подлинный callback только его UID-bound worker."""
        profile, route, query_id, kind, generation = await self.interactive_binding(update)
        from types import SimpleNamespace
        bridge = await self(SimpleNamespace(user_id=str(profile['telegramId'])))
        peer = await bridge.connect()
        self._chat_generation(profile, route, generation)
        now = time.monotonic()
        self.interactive_scopes = {key: value for key, value in self.interactive_scopes.items()
                                   if value['expires'] > now}
        if len(self.interactive_scopes) >= 4096:
            raise PermissionError('Too many interactive scopes')
        scope_id = uuid.uuid4().hex
        self.interactive_scopes[scope_id] = {'owner': self.ledger.owner(profile),
            'route': route, 'actorTelegramId': str(profile['telegramId']),
            'queryId': query_id, 'kind': kind, 'expires': now + 300, 'generation': generation}
        result = await peer.call('interactive', {'update': update.to_dict(),
                                'owner': profile['userId'], 'scope_id': scope_id,
                                'actor_telegram_id': str(profile['telegramId']), 'chat_generation': generation})
        if not isinstance(result, dict) or result.get('accepted') is not True:
            raise PermissionError('Interactive dispatch unconfirmed')
        if self.mirror is not None:
            from types import SimpleNamespace
            await self.mirror.accepted(SimpleNamespace(_brai_release_updates=[update.update_id]), result)
        return result

    async def telegram_api(self, profile, owner, method, payload, scope_id):
        """Исполнять только ограниченные UI операции с проверенным owner/route."""
        if method == 'rename_current_topic':
            return await self.rename_current_topic(profile, owner, payload, scope_id)
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
            generation = self._chat_generation(profile, grant['route'], grant.get('generation'))
            await self._account(profile, grant.get('actorTelegramId', grant['route'][0]))
            def current():
                self._chat_generation(profile, grant['route'], generation)
                if self.interactive_scopes.get(scope_id) is not grant or grant['expires'] <= time.monotonic():
                    raise PermissionError('Interactive delivery expired')
            current.generation = generation
            current()
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
                route, metadata, source_turn, current, _ = await self.delivery_context(profile, owner, request)
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
                if group_chat_id(route[0]):
                    anchor = source_turn.get('replyTo') if source_turn else None
                    if not anchor or not self.ledger.owns(profile, route, anchor, outgoing=False):
                        raise PermissionError('Group UI reply has no admitted input')
                    values.pop('reply_parameters', None)
                    values.pop('allow_sending_without_reply', None)
                    values['reply_to_message_id'] = int(anchor)
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
        current()
        journal_route = route if route is not None else grant['route']
        with self.journal.scope(profile, thread=journal_route[1]) if self.journal is not None else nullcontext():
            result = await operation(**values)
        if method.startswith('answer_') or method == 'delete_message':
            if result is not True:
                raise ValueError('Unconfirmed Telegram UI operation')
            return True
        raw = result.to_dict() if callable(getattr(result, 'to_dict', None)) else result
        if not isinstance(raw, dict) or not str(raw.get('message_id', '')).isdecimal():
            raise ValueError('Missing Telegram UI message receipt')
        self._record_delivery(profile, route, raw['message_id'], current.generation, created=method == 'send_message')
        return raw

    async def end(self, profile, worker_turn):
        """Погасить доверенное право входа после завершения соответствующего хода."""
        async with self.turn_locks.setdefault(profile['uid'], asyncio.Lock()):
            await self._end(profile, worker_turn)

    async def _end(self, profile, worker_turn):
        uid = profile['uid']
        turn = self.turns.get(uid)
        if turn and turn.get('workerTurnId') == worker_turn:
            input_id = turn.get('inputId')
            receipt = turn.get('questionReceipt') or {}
            try:
                closed = await broker_call('ingress.close', {'uid': uid, 'turnId': turn['id'],
                    **({'inputId': input_id} if input_id else {}),
                    **(receipt if receipt.get('inputId') == input_id else {})})
                if not isinstance(closed, dict) or closed.get('closed') is not True:
                    raise ConnectionError('Broker close receipt unavailable')
            except BaseException:
                if (self.turns.get(uid) is turn and turn.get('inputId') == input_id
                        and turn.get('workerTurnId') == worker_turn):
                    turn['closePending'] = (input_id, worker_turn)
                raise
            # AIDEV-NOTE: Новый input может поступить, пока broker подтверждает старый close.
            if (self.turns.get(uid) is turn and turn.get('inputId') == input_id
                    and turn.get('workerTurnId') == worker_turn):
                self.turns.pop(uid, None)


def create_resolver(adapter, runner):
    """Создать один резолвер на экземпляр native Telegram adapter."""
    key = id(adapter)
    if key not in _resolvers or _resolvers[key].retired:
        home = Path(os.environ['HERMES_HOME'])
        from .chat_journal import IdentityJournal
        journal = IdentityJournal(home / 'identity-chats')
        _resolvers[key] = Resolver(adapter, runner, RouteLedger(home / 'identity-delivery.sqlite'), journal)
    return _resolvers[key]
