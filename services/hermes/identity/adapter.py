# ABOUTME: Адаптер Hermes передаёт сообщения и результаты доставки доверенному ingress.
# ABOUTME: Не хранит Telegram token и не отправляет произвольные пути через границу.
"""Создание адаптера отложено до загрузки закреплённого Hermes."""
import asyncio
from .ipc import RpcError
from .scope import delivery_scope
from .telegram_proxy import BotProxy


def make_adapter(config, platform, peer, publish_file):
    """Создать native adapter, отправляющий действия по двустороннему RPC."""
    from gateway.platforms.base import SendResult
    from plugins.platforms.telegram.adapter import TelegramAdapter

    class IpcAdapter(TelegramAdapter):
        """Сохранить native вызовы и вернуть только фактический результат ingress."""
        supports_async_delivery = False
        # AIDEV-NOTE: Личный процесс передаёт файлы ingress и не содержит Telegram bot.
        file_delivery_via_ipc = True

        def __init__(self, config):
            super().__init__(config)
            self._bot = BotProxy(peer)

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
            if callback:
                message = getattr(native.callback_query, 'message', None)
                if message is None or not getattr(message, 'message_id', None):
                    raise PermissionError('Callback message required')
                if str(getattr(native.callback_query, 'data', '') or '').startswith('brai:'):
                    handler = getattr(self, '_brai_human_callback', None)
                    if not callable(handler):
                        raise PermissionError('Human callback unavailable')
                    await handler(native, None)
                else:
                    await self._handle_callback_query(native, None)
            else:
                await self._handle_inline_query(native, None)
            return {'accepted': True}

        def bind_source(self, source):
            """Запомнить только подтверждённый ingress контекст текущего пользователя."""
            if not hasattr(self, '_brai_chats'):
                self._brai_chats = {}
            self._brai_chats[str(source.chat_id)] = {'name': source.chat_name or '', 'type': source.chat_type}

        async def get_chat_info(self, chat_id):
            """Вернуть только известный из подтверждённого входа чат."""
            info = getattr(self, '_brai_chats', {}).get(str(chat_id))
            if info is None:
                raise PermissionError('Unknown chat')
            return dict(info)

        async def connect(self, *, is_reconnect=False):
            """Пометить IPC adapter готовым без HTTP, token и polling."""
            self._bot = BotProxy(peer)
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
            try:
                value = await peer.call('send', {'action': name, 'payload': payload, 'scope_id': delivery_scope.get()})
                if not isinstance(value, dict) or type(value.get('success')) is not bool:
                    raise ValueError('invalid send result')
                fields = ('success', 'message_id', 'error', 'raw_response', 'retryable', 'retry_after', 'continuation_message_ids', 'error_kind')
                return SendResult(**{key: value[key] for key in fields if key in value})
            except (ConnectionError, TimeoutError, RpcError, ValueError):
                return SendResult(success=False, error='Ingress delivery unavailable or outcome unknown')

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            return await self._action('send', dict(chat_id=chat_id, content=content, reply_to=reply_to, metadata=metadata))

        async def edit_message(self, chat_id, message_id, content, *, finalize=False, metadata=None):
            return await self._action('edit_message', dict(chat_id=chat_id, message_id=message_id, content=content, finalize=finalize, metadata=metadata))

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
