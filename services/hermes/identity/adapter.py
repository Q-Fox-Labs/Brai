# ABOUTME: Адаптер Hermes передаёт сообщения и результаты доставки доверенному ingress.
# ABOUTME: Не хранит Telegram token и не отправляет произвольные пути через границу.
"""Создание адаптера отложено до загрузки закреплённого Hermes."""
import asyncio
import logging
import os
from pathlib import Path
import tempfile
import uuid
from contextvars import ContextVar
from .ipc import RpcError
from .scope import delivery_scope, input_delivery, operator_assignment
from .telegram_proxy import BotProxy


def make_adapter(config, platform, peer, publish_file):
    """Создать native adapter, отправляющий действия по двустороннему RPC."""
    from gateway.platforms.base import SendResult
    from plugins.platforms.telegram.adapter import TelegramAdapter

    class IpcAdapter(TelegramAdapter):
        """Сохранить native вызовы и вернуть только фактический результат ingress."""
        # AIDEV-NOTE: Личный процесс передаёт файлы ingress и не содержит Telegram bot.
        file_delivery_via_ipc = True

        def __init__(self, config):
            super().__init__(config)
            self._brai_last_outputs = {}
            self._bot = BotProxy(peer, on_content_action=self._brai_last_outputs.clear)
            self._interactive_actor = ContextVar('brai_identity_interactive_actor', default=None)
            self._delivery_source = ContextVar('brai_identity_delivery_source', default=None)

        def _send_retry_is_final(self, result):
            """Outbox владеет повтором сохранённого ответа; запрет прав не лечится fallback."""
            return (getattr(result, 'error_kind', None) in {'delivery_pending', 'forbidden'}
                    or super()._send_retry_is_final(result))

        async def handle_message(self, event):
            assignment = operator_assignment.get()
            if assignment is not None:
                metadata = event.metadata or {}
                if (event.internal is not True or metadata.get('gateway_session_strict') is not True
                        or metadata.get('gateway_session_key') != assignment.session_key
                        or metadata.get('gateway_session_id') != assignment.session_id
                        or not assignment.can_start()):
                    raise PermissionError('Operator assignment session changed before admission')
            return await super().handle_message(event)

        async def _record_delivery_obligation(self, *args, **kwargs):
            """Один владелец ответа: современный IPC input сохраняет worker/ingress outbox."""
            if (operator_assignment.get() is not None
                    or getattr(self, '_brai_delivery_journal', None) is not None and input_delivery.get() is not None):
                return None
            return await super()._record_delivery_obligation(*args, **kwargs)

        def is_interactive_actor(self, user_id):
            """Допустить actual actor только внутри подтверждённого Root callback."""
            return self._interactive_actor.get() == str(user_id)

        async def handle_interactive(self, update, *, telegram_id):
            """Исполнить native callback только для подтверждённого владельца worker."""
            from telegram import Update
            if not isinstance(update, dict):
                raise PermissionError('Invalid interactive update')
            callback, inline = update.get('callback_query'), update.get('inline_query')
            if bool(callback) == bool(inline):
                raise PermissionError('Invalid interactive update')
            incoming = callback or inline
            user = incoming.get('from') if isinstance(incoming, dict) else None
            if (not isinstance(user, dict) or user.get('is_bot') is not False
                    or str(user.get('id', '')) != str(telegram_id)):
                raise PermissionError('Interactive owner mismatch')
            native = Update.de_json(update, self._bot)
            token = self._interactive_actor.set(str(telegram_id))
            try:
                if callback:
                    message = getattr(native.callback_query, 'message', None)
                    if (message is None or not getattr(message, 'message_id', None)
                            or str(getattr(message, 'chat_id', '')) != str(telegram_id)
                            or getattr(getattr(message, 'chat', None), 'type', None) != 'private'):
                        raise PermissionError('Private callback message required')
                    if str(getattr(native.callback_query, 'data', '') or '').startswith('brai:'):
                        handler = getattr(self, '_brai_human_callback', None)
                        if not callable(handler):
                            raise PermissionError('Human callback unavailable')
                        await handler(native, None)
                    else:
                        await self._handle_callback_query(native, None)
                else:
                    await self._handle_inline_query(native, None)
            finally:
                self._interactive_actor.reset(token)
            return {'accepted': True}

        def bind_source(self, source):
            """Запомнить только подтверждённый ingress контекст текущего пользователя."""
            if not hasattr(self, '_brai_chats'):
                self._brai_chats = {}
            self._brai_chats[str(source.chat_id)] = {'name': source.chat_name or '', 'type': source.chat_type}
            self._delivery_source.set((str(source.chat_id), getattr(source, 'thread_id', None), source))

        async def get_chat_info(self, chat_id):
            """Вернуть только известный из подтверждённого входа чат."""
            info = getattr(self, '_brai_chats', {}).get(str(chat_id))
            if info is None:
                raise PermissionError('Unknown chat')
            return dict(info)

        async def connect(self, *, is_reconnect=False):
            """Пометить IPC adapter готовым без HTTP, token и polling."""
            self._brai_last_outputs.clear()
            self._bot = BotProxy(peer, on_content_action=self._brai_last_outputs.clear)
            self._mark_connected()
            return True

        async def disconnect(self):
            """Остановить фоновые UI задачи и снять признак готовности."""
            self._mark_disconnected()
            tasks = tuple(getattr(self, '_background_tasks', ()))
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._bot = None

        async def _action(self, name, payload):
            if operator_assignment.get() is not None:
                return SendResult(success=False, retryable=False, error_kind='operator_assignment_held')
            metadata = payload.get('metadata') or {}
            if (delivery_scope.get() is None and name in {
                    'send', 'send_file_set', 'send_image_file', 'send_document', 'send_video',
                    'send_voice', 'send_animation'} and not payload.get('reply_to')
                    and not metadata.get('thread_id') and not metadata.get('message_thread_id')
                    and not metadata.get('direct_messages_topic_id')):
                payload = {**payload, 'metadata': {**metadata, '_brai_notifications': True}}
            # AIDEV-NOTE: Учитываем фактическую доставку, включая streaming и ответ
            # перед очередью. Завершение модельного хода не заменяет квитанцию.
            pending = None
            source = self._delivery_source.get()
            thread = metadata.get('thread_id') or metadata.get('message_thread_id') or metadata.get('direct_messages_topic_id')
            if (source and getattr(self, 'gateway_runner', None) is not None
                    and str(payload.get('chat_id')) == source[0]
                    and str(thread or '') == str(source[1] or '')
                    and (name == 'send' or (name == 'edit_message' and payload.get('finalize')))):
                from tools.approval_conversation import pending_delivery
                pending = pending_delivery(getattr(self, 'gateway_runner', None), source[2], payload.get('content'))
            ident = None
            saved = False
            reused = False
            try:
                wire = {'payload': payload, 'scope_id': delivery_scope.get()}
                route = (str(payload.get('chat_id')), str(thread or ''))
                value = None
                journal = getattr(self, '_brai_delivery_journal', None)
                persistent = (journal is not None and input_delivery.get() is not None
                    and name in {'send', 'send_file_set', 'send_image_file', 'send_document', 'send_video', 'send_voice', 'send_animation'})
                if persistent:
                    from .delivery_journal import canonical, delivery_id
                    ident = delivery_id(['output', uuid.uuid4().hex])
                    wire['input_delivery_id'] = input_delivery.get()
                    # AIDEV-NOTE: Старый model task сохраняет свой input ContextVar даже
                    # после нового steer. Общая граница уже меняется ДО native dispatch,
                    # поэтому новая просьба повторить текст/файл не будет подавлена.
                    boundary = journal.input_boundary()
                    state_reader = getattr(getattr(self, 'gateway_runner', None), '_brai_return_notice_state', None)
                    state = state_reader(*route) if callable(state_reader) else None
                    signature = (boundary, canonical(state), name, canonical(wire).encode('utf-8'))
                    previous = self._brai_last_outputs.get(route)
                    if boundary is not None and previous is not None and previous[0] == signature:
                        existing = journal.output(previous[1])
                        if existing is not None:
                            receipt = existing['receipt'] or {}
                            if (existing['state'] == 'sent' and receipt.get('success') is True
                                    and receipt.get('message_id')) or (
                                    existing['state'] == 'blocked' and receipt.get('success') is False):
                                value = receipt
                            else:
                                value = {'success': False, 'retryable': False,
                                    'error': 'Identical reply already queued', 'error_kind': 'delivery_pending'}
                            ident, reused = existing['id'], True
                            logging.getLogger(__name__).info('identity_duplicate_output_suppressed action=%s state=%s', name, existing['state'])
                    if not reused:
                        journal.queue_output(ident, name, wire)
                        self._brai_last_outputs[route] = (signature, ident)
                    saved = True
                elif name != 'send_typing':
                    # Edit/delete/draft либо иной content разрывает соседство ответов.
                    self._brai_last_outputs.pop(route, None)
                if value is None:
                    value = await peer.call('send', {'action': name, **wire, **({'delivery_id': ident} if ident else {})})
                if not isinstance(value, dict) or type(value.get('success')) is not bool:
                    raise ValueError('invalid send result')
                if ident and not reused and value.get('success') and value.get('message_id'):
                    journal.output_state(ident, 'sent', value)
                elif ident and not reused and value.get('retryable') is False:
                    journal.output_state(ident, 'blocked', value)
                if ident and not value.get('success') and value.get('retryable') is not False:
                    # Durable outbox owns the retry. Native must not create a second
                    # logical output for the same failed transport attempt.
                    value = {**value, 'retryable': False, 'error_kind': 'delivery_pending'}
                fields = ('success', 'message_id', 'error', 'raw_response', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind')
                result = SendResult(**{key: value[key] for key in fields if key in value})
                if pending and result.success and result.message_id:
                    pending[0].delivered(pending[1], result.message_id)
                return result
            except (ConnectionError, TimeoutError, RpcError, ValueError) as error:
                logging.getLogger(__name__).warning(
                    'identity_delivery_failed action=%s error=%s rpc_code=%s',
                    name, type(error).__name__, getattr(error, 'code', None))
                if isinstance(error, RpcError) and error.code == -32003:
                    return SendResult(success=False, error='Delivery forbidden', retryable=False, error_kind='forbidden')
                if saved:
                    return SendResult(success=False, error='Reply saved for delivery', retryable=False,
                                      error_kind='delivery_pending')
                return SendResult(success=False, error='Ingress delivery unavailable or outcome unknown')

        async def create_handoff_thread(self, parent_chat_id, name):
            """Оставить создание фоновой темы ingress, без отдельной темы на каждое cron-задание."""
            return None

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            from .long_reply import needs_pdf, excerpt, render_pdf
            if isinstance(content, str) and needs_pdf(self, content):
                # Сокращённый текст и PDF идут одной доставкой и одной квитанцией.
                try:
                    workspace = Path(os.environ['HERMES_HOME']) / 'workspace'
                    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(prefix='brai-long-reply-', dir=workspace) as directory:
                        target = Path(directory) / 'Полный ответ.pdf'
                        await asyncio.to_thread(render_pdf, content, target)
                        return await self.send_document(chat_id, str(target), caption=excerpt(self, content),
                                                        reply_to=reply_to, metadata=metadata)
                except Exception as error:
                    logging.getLogger(__name__).warning('identity_long_reply_failed error=%s', type(error).__name__)
                    return SendResult(success=False, error='Full reply preparation failed')
            return await self._action('send', dict(chat_id=chat_id, content=content, reply_to=reply_to, metadata=metadata))

        async def edit_message(self, chat_id, message_id, content, *, finalize=False, metadata=None):
            # AIDEV-NOTE: Native финализатор не передаёт тему. Контекст dispatch
            # наследуется его задачами и не смешивает параллельные разговоры.
            source = self._delivery_source.get()
            if metadata is None and source is not None and source[0] == str(chat_id):
                metadata = {'thread_id': source[1]} if source[1] else None
            return await self._action('edit_message', dict(chat_id=chat_id, message_id=message_id, content=content, finalize=finalize, metadata=metadata))

        def supports_draft_streaming(self, chat_type=None, metadata=None):
            """Сохранить native draft в личном чате; Root проверяет доступность API."""
            return self._bot is not None and (chat_type or '').lower() in {'dm', 'private'}

        async def send_draft(self, chat_id, draft_id, content, metadata=None):
            """Передать preview штатному Root renderer без отдельного Bot API порта."""
            return await self._action('send_draft', dict(chat_id=chat_id, draft_id=draft_id,
                                                       content=content, metadata=metadata))

        async def send_typing(self, chat_id, metadata=None):
            result = await self._action('send_typing', dict(chat_id=chat_id, metadata=metadata))
            if not result.success:
                raise RuntimeError(result.error)

        def _start_typing_refresh(self, event, interrupt_event, metadata):
            # AIDEV-NOTE: Worker обновляет индикатор до конца всей native task,
            # включая инструменты и доставку; внутренние pause/interrupt короче.
            return None

        def start_turn_typing(self, event):
            """Обновлять typing каждые две секунды до отмены владельцем native task."""
            if not getattr(self.config, 'typing_indicator', True):
                return None
            metadata = {'thread_id': event.source.thread_id} if event.source.thread_id else None
            return asyncio.create_task(self._keep_turn_typing(event.source.chat_id, metadata))

        async def _keep_turn_typing(self, chat_id, metadata):
            try:
                while True:
                    try:
                        await asyncio.wait_for(self.send_typing(chat_id, metadata=metadata), timeout=1.5)
                    except (TimeoutError, RuntimeError):
                        pass  # Временный отказ индикатора не отменяет ответ.
                    await asyncio.sleep(2)
            except asyncio.CancelledError:
                pass

        async def _file(self, action, chat_id, path, caption, reply_to, metadata, **kwargs):
            try:
                from files.native import local_path
                descriptor = await publish_file(local_path(path))
                if not isinstance(descriptor, dict) or not descriptor.get('artifact_id'):
                    raise ValueError('missing artifact')
            except Exception:
                return SendResult(success=False, error='File publication failed')
            return await self._action(action, dict(chat_id=chat_id, artifact=descriptor, caption=caption, reply_to=reply_to, metadata=metadata, **kwargs))

        async def send_file_set(self, chat_id, items, kind, fallback, metadata=None):
            """Передать один проверенный batch через owner-bound descriptors, сохранив receipts."""
            payload = [{'artifact': {'artifact_id': item['file']['artifactId']},
                        'caption': item.get('caption', ''), 'presentation': item['presentation']}
                       for item in items]
            result = await self._action('send_file_set', dict(chat_id=chat_id, items=payload,
                kind=kind, fallback=fallback, metadata=metadata))
            ids = (getattr(result, 'raw_response', None) or {}).get('message_ids')
            if (not result.success or not isinstance(ids, list) or len(ids) != len(items)
                    or any(not isinstance(value, str) or not value for value in ids)):
                raise RuntimeError('File set delivery unavailable or outcome unknown')
            return ids

        async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._file('send_image_file', chat_id, image_path, caption, reply_to, metadata)

        async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
            return await self._file('send_document', chat_id, file_path, caption, reply_to, metadata, file_name=file_name)

        async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._file('send_video', chat_id, video_path, caption, reply_to, metadata)

        async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._file('send_voice', chat_id, audio_path, caption, reply_to, metadata,
                                    is_voice=bool(kwargs.get('is_voice')))

        async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None):
            return await self.send_image_file(chat_id, image_url, caption, reply_to, metadata)

        async def send_animation(self, chat_id, animation_url, caption=None, reply_to=None, metadata=None):
            return await self._file('send_animation', chat_id, animation_url, caption, reply_to, metadata)

    return IpcAdapter(config)
