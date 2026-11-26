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
from types import SimpleNamespace
from .ipc import RpcError
from .scope import (delivery_scope, input_delivery, ephemeral_input, final_text_session,
                    operator_assignment, prepared_response, prepared_voice)
from .telegram_proxy import BotProxy


def _streamed_batches(items, media, source, force_document):
    """Сохранить native типы и порядок явно запрошенных потоковых файлов."""
    from files.store import delivery_plan
    from gateway.platforms.base import should_send_media_as_audio
    from gateway.run_notifications import _IMAGE_EXTS, _VIDEO_EXTS
    animations, photos, rest = [], [], []
    for index, item in enumerate(items):
        path, voice = media[index] if index < len(media) else (item['file']['filename'], False)
        ext = Path(path).suffix.lower()
        if ext in _IMAGE_EXTS and not voice and not force_document:
            value = {**item, 'presentation': 'animation' if ext == '.gif' else 'photo'}
            (animations if ext == '.gif' else photos).append(value)
        elif should_send_media_as_audio(source.platform, ext, is_voice=voice):
            rest.append(({**item, 'presentation': 'voice' if voice else 'audio'}, bool(voice)))
        elif ext in _VIDEO_EXTS:
            rest.append((item, False))
        else:
            rest.append(({**item, 'presentation': 'document'}, False))
    batches = []
    def append_batch(batch, fallback=False):
        batches.append({'kind': batch['kind'], 'fallback': fallback, 'items': [
            {'artifact': {'artifact_id': item['file']['artifactId']},
             'caption': item.get('caption', ''), 'presentation': item['presentation']}
            for item in batch['items']]})
    for item in animations:
        append_batch({'kind': 'single', 'items': [item]})
    if photos:
        for batch in delivery_plan(photos, 'album', supports_album=True)['batches']:
            append_batch(batch)
    for item, voice in rest:
        if voice:
            batches.append({'action': 'send_voice', 'artifact': {'artifact_id': item['file']['artifactId']},
                            'caption': item.get('caption', ''), 'is_voice': True})
        else:
            append_batch({'kind': 'single', 'items': [item]})
    return batches, [*animations, *photos, *(item for item, voice in rest if not voice)]


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

        async def _process_message_background(self, event, session_key):
            """Следующий queued input несёт собственную квитанцию, а не контекст старой task."""
            external = not getattr(event, 'internal', False)
            token = input_delivery.set(getattr(event, '_brai_identity_input_id', None)) if external else None
            scope_token = delivery_scope.set(getattr(event, '_brai_delivery_scope', None)) if external else None
            response_token = prepared_response.set(None)
            voice_token = prepared_voice.set([0])
            try:
                return await super()._process_message_background(event, session_key)
            finally:
                prepared_response.reset(response_token)
                prepared_voice.reset(voice_token)
                if scope_token is not None:
                    delivery_scope.reset(scope_token)
                if token is not None:
                    input_delivery.reset(token)

        async def _preview_prepared_response(self, response, event, session_key, *, streamed=False, media=None):
            """Сохранить проверенные пути до checkpoint, пока файлы ещё существуют."""
            if streamed:
                media = list(media or [])
                force = '[[as_document]]' in response
                result = SimpleNamespace(text_content='', images=[], media_files=media,
                    local_files=[], force_document_attachments=force, pre_extract=response)
            else:
                from tools.approval_conversation import brand_response
                result = await super()._extract_response_content(brand_response(event, response), event, session_key,
                    is_ephemeral_response=False)
            return {key: getattr(result, key, None) for key in
                    ('text_content', 'images', 'media_files', 'local_files', 'force_document_attachments', 'pre_extract')}

        async def _extract_response_content(self, response, event, session_key, **kwargs):
            """Закрепить содержимое и опубликованные вложения до первой отправки."""
            staged = prepared_response.get()
            journal = getattr(self, '_brai_delivery_journal', None)
            saved = journal.prepared_response(staged[0], staged[1]) if staged and journal else None
            if saved and saved.get('plan'):
                result = SimpleNamespace(**saved['plan']['extracted'])
            elif saved and saved.get('preview') is not None:
                result = SimpleNamespace(**saved['preview'])
            elif getattr(event, '_brai_streamed_response', False):
                media, _ = self.extract_media(response)
                preview = await self._preview_prepared_response(response, event, session_key, streamed=True,
                    media=[] if getattr(event, '_brai_skip_stream_media', False) else self.filter_media_delivery_paths(media))
                result = SimpleNamespace(**preview)
            else:
                result = await super()._extract_response_content(response, event, session_key, **kwargs)
            remote = [url for url, _ in result.images if str(url).lower().startswith(('http://', 'https://'))]
            if remote:
                result.images = [(url, alt) for url, alt in result.images
                                 if not str(url).lower().startswith(('http://', 'https://'))]
                lines = [url for url in dict.fromkeys(remote) if url not in (result.text_content or '')]
                result.text_content = '\n\n'.join(part for part in (result.text_content or '', '\n'.join(lines)) if part)
            event._brai_single_text = not (result.images or result.media_files or result.local_files)
            ident = input_delivery.get()
            if (staged is None and not event._brai_single_text and getattr(event, '_brai_successful_turn', False)
                    and ident is not None and journal is not None):
                event_fields = {key: getattr(event, key, None) for key in
                    ('message_id', 'reply_to_message_id', 'reply_anchor_override', 'ledger_message_id')}
                source = getattr(event, 'source', None)
                source = source.to_dict() if callable(getattr(source, 'to_dict', None)) else None
                preview = {key: getattr(result, key, None) for key in
                    ('text_content', 'images', 'media_files', 'local_files', 'force_document_attachments', 'pre_extract')}
                journal.save_response(session_key, ident, response, event_fields, source, preview)
                staged = (session_key, ident, response)
                prepared_response.set(staged)
                saved = journal.prepared_response(session_key, ident)
            if staged:
                if not saved or not saved.get('plan'):
                    paths = [path for path, _ in result.media_files] + [path for path, _ in result.images] + list(result.local_files)
                    batches, set_ids, cleanup_identity = [], [], None
                    if paths:
                        import brai_files
                        from files.store import delivery_plan
                        items, mode = await asyncio.to_thread(brai_files.output_items, paths)
                        streaming = getattr(event, '_brai_streamed_response', False)
                        explicit = streaming and await asyncio.to_thread(brai_files.explicit_output_set, paths)
                        if streaming and not explicit:
                            batches, checked = _streamed_batches(items, result.media_files, event.source,
                                getattr(result, 'force_document_attachments', False))
                            brai_files.validate_telegram(checked)
                        elif getattr(result, 'force_document_attachments', False):
                            items = [{**item, 'presentation': 'document'} for item in items]
                        if not streaming or explicit:
                            brai_files.validate_telegram(items)
                        set_ids = sorted({item['_setId'] for item in items if '_setId' in item})
                        public_items = [{key: value for key, value in item.items() if key != '_setId'} for item in items]
                        cleanup_identity = brai_files.key([brai_files.source_of(event),
                            str(getattr(event, 'ledger_message_id', None) or event.message_id), public_items, mode])
                        if not streaming or explicit:
                            plan = delivery_plan(items, mode, supports_album=True)
                            for batch in plan['batches']:
                                batches.append({'kind': batch['kind'], 'fallback': plan['fallback'], 'items': [
                                    {'artifact': {'artifact_id': item['file']['artifactId']},
                                     'caption': item.get('caption', ''), 'presentation': item['presentation']}
                                    for item in batch['items']]})
                    fields = {key: getattr(result, key, None) for key in
                        ('text_content', 'images', 'media_files', 'local_files', 'force_document_attachments', 'pre_extract')}
                    journal.save_response_plan(staged[0], staged[1], {'extracted': fields, 'batches': batches,
                        'set_ids': set_ids, 'cleanup_identity': cleanup_identity,
                        'footer': getattr(event, '_brai_stream_footer', None)})
                event._brai_text_delivered = not bool(result.text_content)
            return result

        async def _send_final_text(self, event, session_key, text_content, metadata,
                                   is_ephemeral_response, ephemeral_ttl, record_delivery):
            """Закрепить готовый одиночный текст вместе с durable output."""
            successful = getattr(event, '_brai_successful_turn', False)
            token = final_text_session.set((session_key, getattr(event, '_brai_single_text', False)) if successful else None)
            def record(result):
                if getattr(result, 'success', False) or getattr(result, 'error_kind', None) == 'delivery_pending':
                    event._brai_text_delivered = True
                record_delivery(result)
            try:
                return await super()._send_final_text(event, session_key, text_content, metadata,
                    is_ephemeral_response, ephemeral_ttl, record)
            finally:
                final_text_session.reset(token)

        async def _play_tts_file(self, event, text_content, tts_path, first, metadata, record_delivery):
            """Не отправлять текст повторно, когда voice с подписью уже в outbox."""
            pending = False
            def record(result):
                nonlocal pending
                pending = getattr(result, 'error_kind', None) == 'delivery_pending'
                record_delivery(result)
            delivered = await super()._play_tts_file(event, text_content, tts_path, first, metadata, record)
            caption_queued = pending and first and bool(text_content) and len(text_content) <= 1024
            if delivered or caption_queued:
                event._brai_text_delivered = True
            return delivered or caption_queued

        async def _deliver_attachments(self, event, extracted, metadata, *, anything_sent, record_delivery):
            """Оставить сохранённый ответ, пока набор не принят доставкой."""
            staged = prepared_response.get()
            if staged:
                from .delivery_journal import delivery_id
                journal = self._brai_delivery_journal
                saved = journal.prepared_response(staged[0], staged[1])
                if not saved or not saved.get('plan') or not getattr(event, '_brai_text_delivered', False):
                    return None
                outputs = []
                for index, batch in enumerate(saved['plan']['batches']):
                    action = batch.get('action', 'send_file_set')
                    if action == 'send_voice':
                        payload = {'chat_id': str(event.source.chat_id), 'artifact': batch['artifact'],
                                   'caption': batch['caption'], 'reply_to': None,
                                   'is_voice': True, 'metadata': metadata}
                    else:
                        payload = {'chat_id': str(event.source.chat_id), 'items': batch['items'],
                                   'kind': batch['kind'], 'fallback': batch['fallback'], 'metadata': metadata}
                    wire = {'payload': payload, 'scope_id': None, 'input_delivery_id': staged[1]}
                    outputs.append((delivery_id(['prepared-files', saved['id'], index]), action, wire))
                footer = saved['plan'].get('footer')
                if footer:
                    wire = {'payload': {'chat_id': str(event.source.chat_id), 'content': footer,
                                        'reply_to': None, 'metadata': metadata},
                            'scope_id': None, 'input_delivery_id': staged[1]}
                    outputs.append((delivery_id(['prepared-footer', saved['id']]), 'send', wire))
                journal.enqueue_response(staged[0], staged[1], outputs)
                if outputs:
                    record_delivery(SendResult(success=False, error='Reply saved for delivery',
                        retryable=False, error_kind='delivery_pending'))
                return None
            def record(result):
                if getattr(result, 'success', False) or getattr(result, 'error_kind', None) == 'delivery_pending':
                    event._brai_attachments_delivered = True
                record_delivery(result)
            result = await super()._deliver_attachments(event, extracted, metadata,
                anything_sent=anything_sent, record_delivery=record)
            return result

        async def _release_turn_marker(self, event):
            """После native marker освободить только результат, уже записанный в outbox."""
            result = await super()._release_turn_marker(event)
            staged = prepared_response.get()
            journal = getattr(self, '_brai_delivery_journal', None)
            saved = journal.prepared_response(staged[0], staged[1]) if staged and journal else None
            if saved and saved['phase'] == 'prepared_enqueued':
                binding = journal.continuation(staged[0])
                if binding and binding['input_id'] == staged[1] and binding.get('ready_response') == staged[2]:
                    await self.gateway_runner.async_session_store.clear_resume_pending(staged[0])
                journal.clear_response(*staged)
                if saved.get('plan', {}).get('cleanup_identity'):
                    import brai_files
                    for ident in saved['plan'].get('set_ids', []):
                        try:
                            await asyncio.to_thread(brai_files.release_set, ident)
                        except Exception:
                            logging.getLogger(__name__).warning('identity_prepared_file_cleanup_failed')
                    try:
                        await asyncio.to_thread(brai_files.store().cleanup, saved['plan']['cleanup_identity'])
                    except Exception:
                        logging.getLogger(__name__).warning('identity_prepared_file_cleanup_failed')
            return result

        def _send_retry_is_final(self, result):
            """Сохранить решение ingress об отправке и не создавать новый исходящий ответ."""
            return (getattr(result, 'error_kind', None) in {
                        'delivery_pending', 'forbidden', 'topic_unavailable', 'telegram_rejected', 'delivery_unknown'}
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
            if (delivery_scope.get() is None and ephemeral_input.get() is None and input_delivery.get() is None and name in {
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
                if ephemeral_input.get() is not None and name == 'send':
                    wire['input_delivery_id'] = ephemeral_input.get()
                elif name == 'edit_message' and delivery_scope.get() is None and input_delivery.get() is not None:
                    wire['input_delivery_id'] = input_delivery.get()
                route = (str(payload.get('chat_id')), str(thread or ''))
                value = None
                journal = getattr(self, '_brai_delivery_journal', None)
                persistent = (ephemeral_input.get() is None and journal is not None and input_delivery.get() is not None
                    and name in {'send', 'send_file_set', 'send_image_file', 'send_document', 'send_video', 'send_voice', 'send_animation'})
                if persistent:
                    from .delivery_journal import canonical, delivery_id
                    staged = prepared_response.get()
                    text_part = final_text_session.get()
                    voice = prepared_voice.get() if staged and name == 'send_voice' else None
                    voice_index = voice[0] if voice is not None else None
                    if voice is not None:
                        voice[0] += 1
                    ident = (delivery_id(['prepared-voice', *staged, voice_index]) if voice is not None
                             else delivery_id(['prepared-text', *staged]) if staged and text_part
                             else delivery_id(['prepared-output', *staged, name, payload]) if staged
                             else delivery_id(['output', uuid.uuid4().hex]))
                    wire['input_delivery_id'] = input_delivery.get()
                    # AIDEV-NOTE: Старый model task сохраняет свой input ContextVar даже
                    # после нового steer. Общая граница уже меняется ДО native dispatch,
                    # поэтому новая просьба повторить текст/файл не будет подавлена.
                    boundary = journal.input_boundary()
                    state_reader = getattr(getattr(self, 'gateway_runner', None), '_brai_return_notice_state', None)
                    state = state_reader(*route) if callable(state_reader) else None
                    signature_wire = wire
                    anchor = payload.get('reply_to')
                    if (name == 'send' and route[1] and anchor
                            and str(metadata.get('reply_to_message_id') or '') == str(anchor)):
                        # Streaming repeats the explicit reply anchor in metadata.
                        # The normal final uses the same route without that copy.
                        fingerprint_payload = {**payload, 'metadata': {
                            key: item for key, item in metadata.items() if key != 'reply_to_message_id'}}
                        signature_wire = {**wire, 'payload': fingerprint_payload}
                    signature = (boundary, canonical(state), name, canonical(signature_wire).encode('utf-8'))
                    previous = self._brai_last_outputs.get(route)
                    existing = journal.output(ident) if staged else None
                    if existing is not None:
                        receipt = existing['receipt'] or {}
                        if existing['state'] == 'sent' and receipt.get('success') is True:
                            value = receipt
                        elif existing['state'] == 'blocked':
                            value = receipt or {'success': False, 'retryable': False}
                        else:
                            value = {'success': False, 'retryable': False,
                                     'error': 'Reply already queued', 'error_kind': 'delivery_pending'}
                        reused = True
                    elif not staged and boundary is not None and previous is not None and previous[0] == signature:
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
                        journal.queue_output(ident, name, wire,
                            completed_session=text_part[0] if text_part and text_part[1] and not staged else None)
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
            closing_text = ""
            if metadata and "_brai_scheduled_cancel_hint" in metadata:
                metadata = dict(metadata)
                hint = metadata.pop("_brai_scheduled_cancel_hint")
                if isinstance(hint, str):
                    closing_text = hint
            if isinstance(content, str) and needs_pdf(self, content):
                # Сокращённый текст и PDF идут одной доставкой и одной квитанцией.
                try:
                    workspace = Path(os.environ['HERMES_HOME']) / 'workspace'
                    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(prefix='brai-long-reply-', dir=workspace) as directory:
                        target = Path(directory) / 'Полный ответ.pdf'
                        await asyncio.to_thread(render_pdf, content, target)
                        caption = excerpt(self, content, closing_text=closing_text)
                        return await self.send_document(chat_id, str(target), caption=caption,
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
            # Подтверждённый или поставленный voice уже не требует новой публикации файла.
            staged, voice = prepared_response.get(), prepared_voice.get()
            journal = getattr(self, '_brai_delivery_journal', None)
            if staged and voice is not None and action == 'send_voice' and journal is not None:
                from .delivery_journal import delivery_id
                ident = delivery_id(['prepared-voice', *staged, voice[0]])
                saved = journal.output(ident)
                if saved is not None and saved['action'] == action:
                    return await self._action(action, saved['payload']['payload'])
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
