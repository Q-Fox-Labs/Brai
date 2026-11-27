# ABOUTME: Проверяет передачу файлов личного worker через настоящий файловый мост.
# ABOUTME: Telegram и broker заменены локальными портами без внешних сообщений.
import ast
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.adapter import make_adapter
from identity.worker import Worker, publish_delivery_file
from identity.ingress import Bridge
from identity.ipc import RpcError
from identity.scope import delivery_scope
from identity import telegram_runtime as runtime
from files import native
from files.tests.test_files import Backend


class LongReplyTests(unittest.TestCase):
    def test_limits_use_the_rendered_rich_payload_and_utf8_bytes(self):
        from identity.long_reply import needs_pdf
        adapter = NS(_rich_message_payload=lambda value: {'markdown': value})
        self.assertFalse(needs_pdf(adapter, 'я' * 32768))
        self.assertTrue(needs_pdf(adapter, 'я' * 32769))
        adapter._rich_message_payload = lambda value: {'markdown': '😀' * 32769}
        self.assertTrue(needs_pdf(adapter, 'short'))

    def test_excerpt_accounts_for_markdown_escaping_and_surrogate_pairs(self):
        from identity.long_reply import excerpt
        adapter = NS(format_message=lambda text: text.replace('_', r'\_'))
        value = excerpt(adapter, '_😀' * 2000)
        self.assertLessEqual(len(adapter.format_message(value).encode('utf-16-le')) // 2, 1024)
        self.assertIn('Полный ответ — в PDF.', value)

    @unittest.skipUnless(importlib.util.find_spec('markdown'), 'Markdown is supplied by the pinned Hermes SDK')
    def test_pdf_html_retains_beginning_and_end_and_disables_external_resources(self):
        from identity.long_reply import report_html
        body = report_html('# Начало\n\n' + ('Текст.\n\n' * 5000) + 'Конечный вывод.', 'Ответ')
        self.assertIn('Начало', body)
        self.assertIn('Конечный вывод.', body)
        self.assertIn('default-src', body)


class PersonalRichDeliveryTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        """Применить именно отправляемый patch к закреплённой fixture-копии native adapter."""
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        fixture = Path(__file__).parent / 'fixtures/ordinary_release/plugins/platforms/telegram/adapter.py'
        target = root / 'plugins/platforms/telegram/adapter.py'
        target.parent.mkdir(parents=True)
        shutil.copyfile(fixture, target)
        patch_text = (Path(__file__).resolve().parents[1] / 'native.patch').read_text()
        marker = '\n--- a/plugins/platforms/telegram/adapter.py\n+++ b/plugins/platforms/telegram/adapter.py\n'
        delta = marker.lstrip('\n') + patch_text.rsplit(marker, 1)[1]
        subprocess.run(['git', 'apply', '--include=plugins/platforms/telegram/adapter.py', '-'],
                       cwd=root, input=delta, text=True, check=True, capture_output=True)
        tree = ast.parse(target.read_text())
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == '_send_text_locked')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        scope = {'os': os, 'asyncio': asyncio, 'SendResult': NS,
                 'utf16_len': lambda text: len(text.encode('utf-16-le')) // 2}
        exec(compile(ast.fix_missing_locations(module), str(target), 'exec'), scope)
        cls.send = staticmethod(scope['_send_text_locked'])

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    async def test_long_answer_uses_one_rich_message_and_never_chunks(self):
        rich = AsyncMock(return_value=NS(success=True, message_id='2621'))
        adapter = NS(_send_flood_cooldown_remaining=lambda chat: None,
                     _chat_outbound_slot_remaining=lambda chat: 0,
                     _hold_chat_outbound_slot=lambda chat: None,
                     _telegram_error_types=lambda: (),
                     _content_fits_rich_limits=lambda text: len(text) <= 32768,
                     _try_send_rich=rich, truncate_message=Mock(side_effect=AssertionError('split')))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
            result = await self.send(adapter, '42', 'Я' * 5536, None, {'thread_id': '7'})
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, '2621')
        rich.assert_awaited_once_with('42', 'Я' * 5536, None, {'thread_id': '7'})
        adapter.truncate_message.assert_not_called()

    async def test_rich_refusal_or_oversize_does_not_fall_back_to_parts(self):
        rich = AsyncMock(return_value=None)
        adapter = NS(_send_flood_cooldown_remaining=lambda chat: None,
                     _chat_outbound_slot_remaining=lambda chat: 0,
                     _hold_chat_outbound_slot=lambda chat: None,
                     _telegram_error_types=lambda: (),
                     _content_fits_rich_limits=lambda text: len(text) <= 32768,
                     _try_send_rich=rich, truncate_message=Mock(side_effect=AssertionError('split')))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
            rejected = await self.send(adapter, '42', 'Я' * 5536, None, {})
            oversized = await self.send(adapter, '42', 'Я' * 32769, None, {})
        self.assertFalse(rejected.success)
        self.assertFalse(oversized.success)
        self.assertEqual(rich.await_count, 1)
        adapter.truncate_message.assert_not_called()

    async def test_markdown_escaping_cannot_force_a_short_reply_into_chunks(self):
        rich = AsyncMock(return_value=NS(success=True, message_id='1'))
        adapter = NS(_send_flood_cooldown_remaining=lambda chat: None,
                     _chat_outbound_slot_remaining=lambda chat: 0,
                     _hold_chat_outbound_slot=lambda chat: None,
                     _telegram_error_types=lambda: (),
                     _content_fits_rich_limits=lambda text: True,
                     format_message=lambda text: text.replace('_', r'\_'),
                     _try_send_rich=rich, truncate_message=Mock(side_effect=AssertionError('split')))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
            result = await self.send(adapter, '42', '_' * 3000, None, {})
        self.assertTrue(result.success)
        rich.assert_awaited_once()
        adapter.truncate_message.assert_not_called()

    async def test_native_rich_api_keeps_personal_topic_and_returns_one_receipt(self):
        try:
            from plugins.platforms.telegram.adapter import TelegramAdapter
        except ModuleNotFoundError as error:
            if error.name not in ('plugins', 'plugins.platforms', 'plugins.platforms.telegram',
                                  'plugins.platforms.telegram.adapter'):
                raise
            self.skipTest('Native Telegram adapter is supplied by the pinned Hermes SDK')
        adapter = object.__new__(TelegramAdapter)
        adapter._bot = NS(do_api_request=AsyncMock(return_value={'message_id': 2621}))
        adapter._reply_to_mode = 'first'
        adapter._send_flood_cooldown_remaining = lambda chat: None
        adapter._chat_outbound_slot_remaining = lambda chat: 0
        adapter._hold_chat_outbound_slot = lambda chat: None
        adapter._record_rich_sent = AsyncMock()
        metadata = {'thread_id': '7', 'direct_messages_topic_id': '7',
                    'telegram_dm_topic_reply_fallback': True}
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
            result = await self.send(adapter, '42', 'Я' * 5536, None, metadata)
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, '2621')
        adapter._bot.do_api_request.assert_awaited_once()
        call = adapter._bot.do_api_request.await_args
        self.assertEqual(call.args[0], 'sendRichMessage')
        self.assertEqual(call.kwargs['api_kwargs']['message_thread_id'], 7)

    async def test_personal_final_deltas_do_not_enter_stream_split_path(self):
        engine = os.environ.get('BRAI_RICH_TEST_ENGINE')
        if not engine:
            self.skipTest('BRAI_RICH_TEST_ENGINE requires the pinned composed engine')
        root = Path(self.temp.name)
        relative = 'gateway/run_turn_runner.py'
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(engine) / relative, target)
        patch_text = (Path(__file__).resolve().parents[1] / 'native.patch').read_text()
        marker = '\n--- a/' + relative + '\n+++ b/' + relative + '\n'
        delta = marker.lstrip('\n') + patch_text.rsplit(marker, 1)[1]
        subprocess.run(['git', 'apply', '--include=' + relative, '-'], cwd=root,
                       input=delta, text=True, check=True, capture_output=True)
        tree = ast.parse(target.read_text())
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                      and node.name == '_setup_stream_consumer')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        scope = {}
        exec(compile(ast.fix_missing_locations(module), str(target), 'exec'), scope)
        ctx = NS(mute_notification_reply=False, streaming_tts_consumer_holder=[None],
                 resolve_display_setting=lambda *args: True, user_config={}, scheduled_heartbeat=False,
                 interim_assistant_messages_enabled=False)
        holder = NS(_ctx=ctx, _runner=NS(config=NS(streaming=NS(enabled_for=lambda value: True))))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            consumer, delta_callback, _, _ = scope['_setup_stream_consumer'](holder, 'telegram')
        self.assertIsNone(consumer)
        self.assertIsNone(delta_callback)


class DeliveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        scope_token = delivery_scope.set('turn')
        self.addCleanup(delivery_scope.reset, scope_token)
        self.profile = {'uid': 101, 'userId': 'owner', 'telegramId': '123',
                        'profileId': 'profile', 'workerSocket': '/unused'}
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.input = self.root / 'input'
        self.input.mkdir()
        self.backend = Backend(self.root / 'cache')
        self.files = native.configure({
            'ownerId': 'owner', 'account': 'personal', 'stateRoot': str(self.root / 'state'),
            'resultRoot': str(self.root / 'cache'), 'readRoots': [str(self.input)]}, self.backend)
        self.base = ModuleType('gateway.platforms.base')
        class Base:
            def __init__(self, config, platform):
                self.config, self.platform = config, platform
                # Закреплённый native Base вызывает этот hook в конструкторе.
                native.install_adapter(self)
            def _send_retry_is_final(self, result):
                return False
        self.base.BasePlatformAdapter = Base
        self.base.SendResult = NS
        self.engine = os.environ.get('HERMES_TEST_ENGINE')
        if self.engine:
            self.base.BasePlatformAdapter.__init__ = self.native_function(
                'gateway/platforms/base.py', 'BasePlatformAdapter', '__init__',
                {'DEFAULT_BUSY_TEXT_DEBOUNCE_SECONDS': 0.2, 'DEFAULT_BUSY_TEXT_HARD_CAP_SECONDS': 1})
        telegram_adapter = ModuleType('plugins.platforms.telegram.adapter')
        class TelegramAdapter(Base):
            def __init__(self, config):
                super().__init__(config, 'telegram')
            def _send_retry_is_final(self, result):
                return getattr(result, 'error_kind', None) == 'forbidden'
            async def _record_delivery_obligation(self, *args, **kwargs):
                return 'native-obligation'
            def _mark_connected(self):
                self._running = True
            def _mark_disconnected(self):
                self._running = False
        telegram_adapter.TelegramAdapter = TelegramAdapter
        self.port = patch.dict(sys.modules, {'gateway.platforms.base': self.base, 'brai_files': native,
            'plugins.platforms.telegram.adapter': telegram_adapter})
        self.port.start()
        async def receive(params, **kwargs):
            self.assertEqual(params['uid'], self.profile['uid'])
            artifact = self.files.fetch(params['artifactId'])
            return artifact, open(artifact['localPath'], 'rb')
        self.reader = patch.object(runtime, 'receive_artifact', receive)
        self.reader.start()

    def native_function(self, relative, class_name, name, scope):
        """Исполнить точное тело установленного native метода без модели и сети."""
        tree = ast.parse((Path(self.engine) / relative).read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
        method = next(n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
        module = ast.Module(body=[ast.ImportFrom(module='__future__',
            names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), relative, 'exec'), scope)
        return scope[name]

    def tearDown(self):
        self.reader.stop()
        self.port.stop()
        self.temp.cleanup()

    def adapter(self, deliver, publish=None, *, sent=()):
        bridge = Bridge('owner', '123', 101, '/unused', deliver, None)
        bridge.routes.add(('123', '77'))
        for message_id in sent:
            bridge.sent.add((('123', '77'), str(message_id)))
        class Peer:
            async def call(self, method, params):
                return await getattr(bridge, method)(**params)
        async def publish_file(path):
            return {'artifact_id': self.files.publish(path, 'ipc-publish')['artifactId']}
        return make_adapter(NS(typing_indicator=True), 'telegram', Peer(), publish or publish_file)

    async def test_native_auto_voice_respects_the_selected_actor_format(self):
        self.base.BasePlatformAdapter._wants_auto_tts = lambda self, event, *args: True
        adapter = self.adapter(AsyncMock())
        source = NS(platform='telegram', chat_id='123', thread_id='77', user_id='123',
                    _brai_actor_id='456')
        event = NS(source=source)
        route = {**native.source_of(event), 'sender': '456'}
        self.assertTrue(adapter._wants_auto_tts(event, 'session', None, 'answer', []))
        for mode in ('video_note', 'off'):
            self.files.set_reply_mode(route, mode)
            self.assertFalse(adapter._wants_auto_tts(event, 'session', None, 'answer', []))
        self.files.set_reply_mode(route, 'voice')
        self.assertTrue(adapter._wants_auto_tts(event, 'session', None, 'answer', []))

    async def test_worker_commits_format_only_for_a_current_successful_delivery(self):
        source = NS(platform='telegram', chat_id='123', thread_id='77', user_id='123',
                    _brai_actor_id='456')
        event = NS(source=source)
        route = {**native.source_of(event), 'sender': '456'}
        worker = Worker(101, 'owner', '123', None)
        delivered = AsyncMock()
        runner = NS(_hmwa_shape_agent_response=AsyncMock(), _hmwa_deliver_turn_response=delivered,
                    _is_session_run_current=lambda key, generation: generation == 2,
                    _delivery_adapter_for=lambda source: None)
        worker._install_failure_recovery(runner)
        warnings = ModuleType('gateway.warning_notifications')
        warnings.diagnostic_wake_muted = lambda event: False
        with patch.dict(sys.modules, {'gateway.warning_notifications': warnings}):
            for generation, completed, expected in ((1, True, None), (2, False, None),
                                                     (2, True, 'video_note')):
                result = {'completed': completed,
                          '_brai_reply_mode': {'source': route, 'mode': 'video_note'}}
                await runner._hmwa_deliver_turn_response(event, source, NS(), 'session', generation,
                                                         result, [], 'Ответ', '', False)
                self.assertEqual(self.files.reply_mode(route), expected)

    async def test_topic_recovery_preserves_authenticated_actor_at_both_copy_points(self):
        source = NS(platform='telegram', chat_id='123', thread_id='old', user_id='123',
                    _brai_actor_id='456')
        def copy_source(original):
            return NS(platform=original.platform, chat_id=original.chat_id,
                      thread_id='new', user_id=original.user_id)
        self.base.BasePlatformAdapter._apply_topic_recovery = lambda self, event: setattr(
            event, 'source', copy_source(event.source))
        adapter = self.adapter(AsyncMock())
        event = NS(source=source)
        adapter._apply_topic_recovery(event)
        self.assertEqual(event.source._brai_actor_id, '456')
        async def resolve(event, source):
            event.source = copy_source(source)
            return event.source, NS(), 'session'
        worker = Worker(101, 'owner', '123', None)
        runner = NS(_hmwa_shape_agent_response=AsyncMock(), _hmwa_resolve_session=resolve)
        worker._install_failure_recovery(runner)
        resolved, _, _ = await runner._hmwa_resolve_session(event, event.source)
        self.assertEqual(resolved._brai_actor_id, '456')
        self.assertEqual(event.source._brai_actor_id, '456')

    async def test_streamed_media_keeps_notes_and_other_attachments_in_order(self):
        from identity.adapter import _streamed_batches
        self.base.should_send_media_as_audio = lambda platform, ext, is_voice=False: ext == '.ogg'
        notifications = ModuleType('gateway.run_notifications')
        notifications._IMAGE_EXTS = {'.png', '.gif'}
        notifications._VIDEO_EXTS = {'.mp4'}
        def item(name, presentation):
            return {'file': {'artifactId': name, 'filename': name, 'mimeType': 'image/png' if name.endswith('.png') else 'video/mp4'},
                    'caption': '', 'presentation': presentation}
        items = [item('first.mp4', 'video_note'), item('a.png', 'photo'), item('b.png', 'photo'),
                 item('voice.ogg', 'voice'), item('last.mp4', 'video_note')]
        media = [(item['file']['filename'], item['presentation'] == 'voice') for item in items]
        with patch.dict(sys.modules, {'gateway.run_notifications': notifications}):
            batches, checked = _streamed_batches(items, media, NS(platform='telegram'), False)
        self.assertEqual([batch.get('action', batch.get('kind')) for batch in batches],
                         ['single', 'album', 'send_voice', 'single'])
        self.assertEqual([item['file']['artifactId'] for item in checked],
                         ['first.mp4', 'a.png', 'b.png', 'last.mp4'])

    async def test_overlong_reply_sends_excerpt_and_full_pdf_as_one_document(self):
        long_reply = importlib.import_module('identity.long_reply')
        sent = []
        document = []
        async def deliver(owner, action, payload):
            sent.append((action, payload))
            artifact = self.files.fetch(payload['artifact']['artifact_id'])
            document.append(Path(artifact['localPath']).read_bytes())
            return {'success': True, 'message_id': '400'}
        def render(content, target):
            self.assertEqual(content, text)
            target.write_bytes(b'%PDF-1.7\ncomplete fixture')
        worker = self.adapter(deliver, sent=('5',))
        text = 'Первый вывод. ' + 'подробности ' * 4000 + 'ЗАКЛЮЧИТЕЛЬНЫЙ ВЫВОД'
        with patch.dict(os.environ, {'HERMES_HOME': str(self.input)}), patch.object(long_reply, 'render_pdf', render):
            result = await worker.send('123', text, reply_to='5', metadata={'thread_id': '77'})
        self.assertTrue(result.success)
        self.assertEqual(document, [b'%PDF-1.7\ncomplete fixture'])
        self.assertEqual(len(sent), 1)
        action, payload = sent[0]
        self.assertEqual(action, 'send_document')
        self.assertEqual(payload['metadata']['thread_id'], '77')
        self.assertEqual(payload['reply_to'], '5')
        self.assertIn('Первый вывод.', payload['caption'])
        self.assertIn('Полный ответ — в PDF.', payload['caption'])
        self.assertLessEqual(len(payload['caption'].encode('utf-16-le')) // 2, 1024)

    async def test_scheduled_pdf_keeps_cancellation_in_visible_caption(self):
        long_reply = importlib.import_module('identity.long_reply')

        deliver = AsyncMock(return_value={'success': True, 'message_id': '400'})
        worker = self.adapter(deliver)
        cancel = 'Чтобы больше не получать такие сообщения, напишите в чат «Отмени задание „Новости“».'
        text = f"Новости\n\n{'сводка ' * 5000}\n\n{cancel}"

        def render(content, target):
            self.assertEqual(content, text)
            target.write_bytes(b'%PDF-1.7\ncomplete fixture')

        with patch.dict(os.environ, {'HERMES_HOME': str(self.input)}), patch.object(long_reply, 'render_pdf', render):
            result = await worker.send('123', text, metadata={
                'thread_id': '77', '_brai_scheduled_cancel_hint': cancel,
            })
        self.assertTrue(result.success)
        args = deliver.await_args.args
        self.assertEqual(args[1], 'send_document')
        self.assertEqual(args[2]['metadata']['thread_id'], '77')
        self.assertNotIn('_brai_scheduled_cancel_hint', args[2]['metadata'])
        self.assertIsNone(args[2]['reply_to'])
        self.assertTrue(args[2]['caption'].endswith(cancel))
        self.assertLessEqual(len(args[2]['caption'].encode('utf-16-le')) // 2, 1024)

    async def test_pdf_render_failure_never_claims_delivery_or_splits(self):
        long_reply = importlib.import_module('identity.long_reply')
        deliver = AsyncMock()
        worker = self.adapter(deliver)
        with patch.dict(os.environ, {'HERMES_HOME': str(self.root)}), \
                patch.object(long_reply, 'render_pdf', side_effect=RuntimeError('unavailable')):
            result = await worker.send('123', 'x' * 32769, metadata={'thread_id': '77'})
        self.assertFalse(result.success)
        deliver.assert_not_awaited()

    async def test_forbidden_rpc_is_a_permanent_native_send_result(self):
        calls = []
        async def denied(owner, action, payload):
            calls.append(action)
            raise RpcError(-32003, 'Forbidden')
        worker = self.adapter(denied)
        result = await worker.send('123', 'Brai онлайн', metadata={'thread_id':'77'})
        self.assertFalse(result.success)
        self.assertEqual(result.error_kind, 'forbidden')
        self.assertTrue(worker._send_retry_is_final(result))
        self.assertFalse(result.retryable)
        self.assertEqual(calls, ['send'])

    async def test_saved_reply_owns_retry_without_claiming_delivery_or_blocking_outbox(self):
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer = NS(call=AsyncMock(return_value={'success': False, 'retryable': True, 'error': 'offline'}))
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, AsyncMock())
        store = DeliveryJournal(self.root / 'delivery.sqlite3', 'owner')
        adapter._brai_delivery_journal = store
        token = input_delivery.set(delivery_id('input'))
        try:
            result = await adapter.send('123', 'Saved reply', metadata={'thread_id': '77'})
            self.assertFalse(result.success)
            self.assertFalse(result.retryable)
            self.assertEqual(result.error_kind, 'delivery_pending')
            self.assertTrue(adapter._send_retry_is_final(result))
            self.assertEqual(store.pending_outputs()[0]['state'], 'pending')
            self.assertEqual(peer.call.await_count, 1)
        finally:
            input_delivery.reset(token)

    async def test_recovered_turn_delivers_through_original_durable_input(self):
        from identity.delivery_journal import DeliveryJournal, delivery_id
        ident, digest = delivery_id('input'), delivery_id('bytes')
        journal = DeliveryJournal(self.root / 'recovered.sqlite3', 'owner')
        journal.begin_input(ident, digest)
        peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': '2621'}))
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, AsyncMock())
        adapter._brai_delivery_journal = journal
        source = NS(chat_id='123', thread_id='77', chat_name='', chat_type='dm')
        event = NS(source=source)
        async def native_resume(native_adapter, received, key):
            self.assertIs(received, event)
            sent = await native_adapter.send('123', 'Готово', metadata={'thread_id': '77'})
            self.assertTrue(sent.success)
        runner = NS(_run_startup_resume_event=native_resume)
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        await worker._resume_failed_turn(runner, adapter, event, 'session', ident)
        call = peer.call.await_args.args[1]
        self.assertEqual(call['input_delivery_id'], ident)
        self.assertIsNone(call['scope_id'])
        self.assertEqual(call['payload']['metadata']['thread_id'], '77')
        self.assertEqual(journal.output(call['delivery_id'])['state'], 'sent')

    async def test_consecutive_identical_output_reuses_receipt_but_new_input_allows_repeat(self):
        """Побайтный дубль отсечён; новый steer с прежним task context разрешает повтор."""
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer=NS(call=AsyncMock(side_effect=[{'success':True,'message_id':str(i)} for i in range(4)]))
        adapter=make_adapter(NS(typing_indicator=True),'telegram',peer,AsyncMock())
        journal=DeliveryJournal(self.root/'output-guard.sqlite3','owner')
        adapter._brai_delivery_journal=journal
        ident,digest=delivery_id('first'),delivery_id('first-bytes')
        journal.begin_input(ident,digest)
        token=input_delivery.set(ident)
        try:
            first=await adapter.send('123','Точный текст',metadata={'thread_id':'77'})
            duplicate=await adapter.send('123','Точный текст',metadata={'thread_id':'77'})
            self.assertEqual(duplicate.message_id,first.message_id)
            self.assertEqual(peer.call.await_count,1)
            # Другой ответ между совпадениями означает A→B→A, а не соседний дубль.
            await adapter.send('123','Другой текст',metadata={'thread_id':'77'})
            await adapter.send('123','Точный текст',metadata={'thread_id':'77'})
            self.assertEqual(peer.call.await_count,3)
            # Модельная task сохраняет первый input ID, но новая реальная просьба уже начата.
            journal.begin_input(delivery_id('new-steer'),delivery_id('repeat-request'))
            repeated=await adapter.send('123','Точный текст',metadata={'thread_id':'77'})
            self.assertTrue(repeated.success)
            self.assertEqual(peer.call.await_count,4)
        finally:input_delivery.reset(token)

    async def test_identical_pending_file_is_not_resent_and_new_request_can_send_it(self):
        """Неизвестная отправка файла не становится успехом или новой сетевой попыткой."""
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer=NS(call=AsyncMock(side_effect=[ConnectionError('offline'),{'success':True,'message_id':'file'}]))
        adapter=make_adapter(NS(typing_indicator=True),'telegram',peer,AsyncMock())
        journal=DeliveryJournal(self.root/'file-guard.sqlite3','owner')
        adapter._brai_delivery_journal=journal
        ident=delivery_id('input');journal.begin_input(ident,delivery_id('bytes'))
        token=input_delivery.set(ident)
        payload={'chat_id':'123','artifact':{'artifactId':'same-file'},'caption':'Подпись',
                 'metadata':{'thread_id':'77'}}
        try:
            first=await adapter._action('send_document',payload)
            duplicate=await adapter._action('send_document',payload)
            self.assertFalse(first.success);self.assertFalse(duplicate.success)
            self.assertEqual(duplicate.error_kind,'delivery_pending')
            self.assertEqual(peer.call.await_count,1)
            self.assertEqual(len(journal.pending_outputs()),1)
            journal.begin_input(delivery_id('another-input'),delivery_id('please-repeat'))
            repeated=await adapter._action('send_document',payload)
            self.assertTrue(repeated.success)
            self.assertEqual(peer.call.await_count,2)
        finally:input_delivery.reset(token)

    async def test_edit_delete_and_pause_generation_invalidate_equal_output_guard(self):
        """Изменённая/удалённая реплика и смена прав не получают старую успешную квитанцию."""
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer=NS(call=AsyncMock(side_effect=[
            {'success':True,'message_id':'1'}, {'success':True,'message_id':'1'},
            {'success':True,'message_id':'2'}, True, {'success':True,'message_id':'3'},
            {'success':True,'message_id':'4'}, {'success':False,'retryable':False,'error':'Forbidden'}]))
        adapter=make_adapter(NS(typing_indicator=True),'telegram',peer,AsyncMock())
        journal=DeliveryJournal(self.root/'invalidation.sqlite3','owner')
        adapter._brai_delivery_journal=journal
        state={'generation':0,'paused':False}
        adapter.gateway_runner=NS(_brai_return_notice_state=lambda *args:dict(state))
        ident=delivery_id('input');journal.begin_input(ident,delivery_id('bytes'))
        token=input_delivery.set(ident)
        try:
            await adapter.send('123','A',metadata={'thread_id':'77'})
            await adapter.edit_message('123','1','B',metadata={'thread_id':'77'})
            result=await adapter.send('123','A',metadata={'thread_id':'77'})
            self.assertEqual(result.message_id,'2')
            with patch('identity.telegram_proxy.telegram_payload',side_effect=lambda value:value):
                await adapter._bot._call('delete_message',{'chat_id':'123','message_id':'2'})
            result=await adapter.send('123','A',metadata={'thread_id':'77'})
            self.assertEqual(result.message_id,'3')
            state['generation']=1
            result=await adapter.send('123','A',metadata={'thread_id':'77'})
            self.assertEqual(result.message_id,'4')
            state['paused']=True
            denied=await adapter.send('123','A',metadata={'thread_id':'77'})
            repeated=await adapter.send('123','A',metadata={'thread_id':'77'})
            self.assertFalse(denied.success);self.assertFalse(repeated.success)
            self.assertEqual(peer.call.await_count,7)
        finally:input_delivery.reset(token)

    async def test_reused_question_receipt_still_confirms_pending_delivery(self):
        """Reuse реальной квитанции сохраняет штатную связь вопроса с его доставкой."""
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer=NS(call=AsyncMock(return_value={'success':True,'message_id':'1'}))
        adapter=make_adapter(NS(typing_indicator=True),'telegram',peer,AsyncMock())
        journal=DeliveryJournal(self.root/'question-guard.sqlite3','owner')
        adapter._brai_delivery_journal=journal
        adapter.gateway_runner=NS()
        adapter._delivery_source.set(('123','77',object()))
        delivered=Mock();port=ModuleType('tools.approval_conversation')
        port.pending_delivery=lambda *args:(NS(delivered=delivered),'question')
        ident=delivery_id('input');journal.begin_input(ident,delivery_id('bytes'))
        token=input_delivery.set(ident)
        try:
            with patch.dict(sys.modules,{'tools.approval_conversation':port}):
                await adapter.send('123','Подтвердить?',metadata={'thread_id':'77'})
                await adapter.send('123','Подтвердить?',metadata={'thread_id':'77'})
            self.assertEqual(peer.call.await_count,1)
            self.assertEqual(delivered.call_args_list,[(('question','1'),),(('question','1'),)])
        finally:input_delivery.reset(token)

    async def test_saved_reply_stops_native_retry_and_plain_text_fallback(self):
        from identity.adapter import make_adapter
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', NS(), None)
        self.assertTrue(adapter._send_retry_is_final(NS(error_kind='delivery_pending')))
        self.assertTrue(adapter._send_retry_is_final(NS(error_kind='forbidden')))
        self.assertFalse(adapter._send_retry_is_final(NS(error_kind='formatting')))

    @unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Pinned native engine required')
    async def test_terminal_topic_failure_cannot_trigger_a_native_resend(self):
        send = self.native_function('gateway/platforms/base.py', 'BasePlatformAdapter', '_send_with_retry',
                                    {'logger': Mock(), 'records_delivery': lambda method: method})
        for kind in ('topic_unavailable', 'telegram_rejected', 'delivery_unknown'):
            with self.subTest(kind=kind):
                peer = NS(call=AsyncMock(return_value={
                    'success': False, 'retryable': False, 'retry_after': None,
                    'error': 'Telegram private topic delivery failed', 'error_kind': kind}))
                adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, None)
                adapter._is_rate_limited_error = lambda _: False
                adapter._is_retryable_error = lambda _: False
                adapter._is_timeout_error = lambda _: False
                adapter._is_partial_delivery = lambda _: False
                fallback = self.native_function('gateway/platforms/base.py', 'BasePlatformAdapter',
                    '_send_plain_fallback', {'t': lambda key, content: f'Fallback: {content}'})
                adapter.warning_text = lambda text, *_args, **_kwargs: text
                adapter.name = 'telegram'
                adapter._send_plain_fallback = AsyncMock(side_effect=fallback.__get__(adapter))
                result = await send(adapter, '123', '**Final reply**', metadata={'thread_id': '77'})
                self.assertEqual(result.error_kind, kind)
                peer.call.assert_awaited_once()
                adapter._send_plain_fallback.assert_not_awaited()

    async def test_unconfirmed_stream_final_and_normal_final_share_a_delivery(self):
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery

        outcome = {'success': False, 'retryable': False, 'error_kind': 'delivery_unknown'}
        peer = NS(call=AsyncMock(return_value=outcome))
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, None)
        journal = DeliveryJournal(self.root / 'stream-final.sqlite3', 'owner')
        adapter._brai_delivery_journal = journal
        first = delivery_id('first input')
        journal.begin_input(first, delivery_id('first bytes'))
        token = input_delivery.set(first)
        try:
            metadata = {'thread_id': '77', 'notify': True}
            stream = await adapter.send('123', 'Final reply', reply_to='5',
                                        metadata={**metadata, 'reply_to_message_id': '5'})
            fallback = await adapter.send('123', 'Final reply', reply_to='5', metadata=metadata)
            self.assertEqual(stream.error_kind, 'delivery_unknown')
            self.assertEqual(fallback.error_kind, 'delivery_unknown')
            self.assertFalse(fallback.success)
            peer.call.assert_awaited_once()

            second = delivery_id('second input')
            journal.begin_input(second, delivery_id('second bytes'))
            next_token = input_delivery.set(second)
            try:
                await adapter.send('123', 'Final reply', reply_to='5', metadata=metadata)
                self.assertEqual(peer.call.await_count, 2)
            finally:
                input_delivery.reset(next_token)
        finally:
            input_delivery.reset(token)

    async def test_login_suppression_finishes_worker_output_without_fabricating_receipt(self):
        from identity.delivery_journal import DeliveryJournal, delivery_id
        from identity.scope import input_delivery
        peer = NS(call=AsyncMock(return_value={'success': False, 'retryable': False,
                                               'error_kind': 'login_reply_suppressed'}))
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, None)
        journal = DeliveryJournal(self.root / 'login-suppressed.sqlite3', 'owner')
        adapter._brai_delivery_journal = journal
        input_id = delivery_id('login-input')
        journal.begin_input(input_id, delivery_id('login-bytes'))
        token = input_delivery.set(input_id)
        try:
            result = await adapter.send('123', 'warning', reply_to='55', metadata={'thread_id': '77'})
            self.assertTrue(result.success)
            self.assertIsNone(getattr(result, 'message_id', None))
            self.assertEqual(journal.pending_outputs(), [])
            self.assertEqual(peer.call.await_count, 1)
        finally:
            input_delivery.reset(token)

    async def test_durable_input_has_one_delivery_owner_without_disabling_legacy(self):
        from identity.scope import input_delivery
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', NS(), None)
        self.assertEqual(await adapter._record_delivery_obligation(), 'native-obligation')
        adapter._brai_delivery_journal = NS()
        self.assertEqual(await adapter._record_delivery_obligation(), 'native-obligation')
        token = input_delivery.set('root-admitted-input')
        try:
            self.assertIsNone(await adapter._record_delivery_obligation())
        finally:
            input_delivery.reset(token)
        self.assertEqual(await adapter._record_delivery_obligation(), 'native-obligation')

    async def test_failed_persistence_does_not_claim_saved_reply_or_call_network(self):
        from identity.delivery_journal import delivery_id
        from identity.scope import input_delivery
        peer = NS(call=AsyncMock())
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, AsyncMock())
        adapter._brai_delivery_journal = NS(input_boundary=lambda:None,
            queue_output=Mock(side_effect=ValueError('Cannot persist')))
        token = input_delivery.set(delivery_id('input'))
        try:
            result = await adapter.send('123', 'Reply', metadata={'thread_id': '77'})
            self.assertFalse(result.success)
            self.assertIsNot(getattr(result, 'retryable', None), False)
            peer.call.assert_not_awaited()
        finally:
            input_delivery.reset(token)

    async def test_final_edit_uses_current_dispatch_topic_without_duplicate_send(self):
        calls = []
        async def deliver(owner, action, payload):
            calls.append((action, payload))
            self.assertEqual(payload['metadata'], {'thread_id': '77'})
            return {'success': True, 'message_id': '42'}
        worker = self.adapter(deliver, sent=['42'])
        worker.bind_source(NS(chat_id='123', thread_id='77', chat_name='', chat_type='dm'))
        result = await worker.edit_message('123', '42', 'Ответ', finalize=True)
        self.assertTrue(result.success)
        self.assertEqual([action for action, _ in calls], ['edit_message'])

    async def test_parallel_dispatch_contexts_keep_their_own_topic(self):
        calls = []
        class Peer:
            async def call(inner, method, params):
                calls.append(params['payload'])
                return {'success': True, 'message_id': '42'}
        worker = make_adapter(NS(), 'telegram', Peer(), None)
        async def dispatch(thread):
            worker.bind_source(NS(chat_id='123', thread_id=thread, chat_name='', chat_type='dm'))
            await asyncio.sleep(0)
            await worker.edit_message('123', '42', thread, finalize=True)
        await asyncio.gather(dispatch('77'), dispatch('88'))
        self.assertEqual([(p['content'], p['metadata']['thread_id']) for p in calls], [('77', '77'), ('88', '88')])

    async def test_voice_crosses_owner_boundary_with_original_bytes_and_receipt(self):
        path = self.input / 'speech.ogg'
        path.write_bytes(b'OggS original voice bytes')
        sent = []
        async def transport(**values):
            sent.append((values['voice'].read(), values))
            return NS(message_id=42)
        root_adapter = NS(platform='telegram', _bot=NS(send_voice=transport))
        telegram = ModuleType('telegram')
        for name in ('InputMediaPhoto', 'InputMediaVideo', 'InputMediaAudio', 'InputMediaDocument'):
            setattr(telegram, name, NS)
        resolver = runtime.Resolver(root_adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77')}
        resolver.ledger.admit(self.profile, ('123', '77'), {'thread_id': '77'}, '1')
        profile = self.profile
        async def deliver(owner, action, payload):
            return await resolver.deliver(profile, owner, action, payload)
        async def broker(method, params, **kwargs):
            if method == 'ingress.artifact':
                self.assertEqual(params['uid'], 101)
                return self.files.fetch(params['artifactId'])
            self.assertEqual(method, 'ingress.status')
            return {'suppressFinal': False}
        worker = self.adapter(deliver)
        with patch.object(runtime, 'broker_call', broker), patch.dict(sys.modules, {'telegram': telegram}):
            result = await worker.send_voice('123', str(path), metadata={'thread_id': '77'}, is_voice=True)
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, '42')
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], b'OggS original voice bytes')
        self.assertIn('voice', sent[0][1])
        self.assertEqual(sent[0][1]['message_thread_id'], 77)
        self.assertNotIn('artifact', sent[0][1])

    async def test_file_sets_preserve_voice_animation_and_album_in_native_sender(self):
        sent = []
        async def single(**values):
            field = next(key for key in ('voice', 'animation', 'document', 'photo') if key in values)
            sent.append((field, [values[field].read()], values))
            return NS(message_id=len(sent) + 100)
        async def album(**values):
            sent.append(('album', [item.media.read() for item in values['media']], values))
            return [NS(message_id=200 + index) for index in range(len(values['media']))]
        root_adapter = NS(platform='telegram', _bot=NS(send_voice=single, send_animation=single,
            send_document=single, send_photo=single, send_media_group=album, send_message=single))
        resolver = runtime.Resolver(root_adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77')}
        resolver.ledger.admit(self.profile, ('123', '77'), {'thread_id': '77'}, '1')
        profile = self.profile
        async def deliver(owner, action, payload):
            return await resolver.deliver(profile, owner, action, payload)
        async def broker(method, params, **kwargs):
            if method == 'ingress.artifact':
                return self.files.fetch(params['artifactId'])
            return {'suppressFinal': False}
        worker = self.adapter(deliver)
        telegram = ModuleType('telegram')
        for name in ('InputMediaPhoto', 'InputMediaVideo', 'InputMediaAudio', 'InputMediaDocument'):
            setattr(telegram, name, NS)
        cases = [('voice', [('a.ogg', b'OggS original')], 'files'),
                 ('animation', [('moon.gif', b'GIF89a original')], 'files'),
                 ('album', [('a.png', b'first original'), ('b.png', b'second original')], 'album')]
        with patch.object(runtime, 'broker_call', broker), patch.dict(sys.modules, {'telegram': telegram}):
            for expected, values, mode in cases:
                paths = []
                for name, raw in values:
                    path = self.input / name
                    path.write_bytes(raw)
                    paths.append(str(path))
                items, _ = native.output_items(paths)
                result = await native.send_set(worker, '123', items, mode, {'thread_id': '77'})
                self.assertTrue(result.success, result.error)
                self.assertEqual(sent[-1][0], expected)
                self.assertEqual(sent[-1][1], [raw for _, raw in values])
                self.assertEqual(sent[-1][2]['message_thread_id'], 77)
        self.assertEqual(len(sent), 3)
        self.assertEqual(result.message_id, '201')

    async def test_video_note_crosses_owner_boundary_to_the_original_topic(self):
        audio = self.input / 'speech.ogg'
        audio.write_bytes(b'OggS speech')
        video = self.input / 'note.mp4'
        video.write_bytes(b'synthetic video')
        artifact = self.files.resolve(str(video), ['test', 'video-note'])
        with patch('files.video_note.render_video_notes', return_value=[artifact]):
            response = native.final_text(f'Ответ\n[[audio_as_video_note]]\nMEDIA:{audio}', 'turn')
        paths = [json.loads(line.removeprefix('MEDIA:')) for line in response.splitlines() if line.startswith('MEDIA:')]
        items, mode = native.output_items(paths)
        sent = []

        async def send_video_note(**values):
            sent.append((values['video_note'].read(), values))
            return NS(message_id=42)

        root_adapter = NS(platform='telegram', _bot=NS(send_video_note=send_video_note))
        resolver = runtime.Resolver(root_adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77'), 'replyTo': '1'}
        resolver.ledger.admit(self.profile, ('123', '77'), {'thread_id': '77'}, '1')

        async def deliver(owner, action, payload):
            return await resolver.deliver(self.profile, owner, action, payload)

        async def broker(method, params, **kwargs):
            if method == 'ingress.artifact':
                return self.files.fetch(params['artifactId'])
            return {'suppressFinal': False}

        telegram = ModuleType('telegram')
        for name in ('InputMediaPhoto', 'InputMediaVideo', 'InputMediaAudio', 'InputMediaDocument'):
            setattr(telegram, name, NS)
        worker = self.adapter(deliver)
        with patch.object(runtime, 'broker_call', broker), patch.dict(sys.modules, {'telegram': telegram}):
            result = await native.send_set(worker, '123', items, mode, {'thread_id': '77'})
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.message_id, '42')
        self.assertEqual(sent[0][0], b'synthetic video')
        self.assertEqual(sent[0][1]['message_thread_id'], 77)
        self.assertEqual(sent[0][1]['reply_to_message_id'], 1)
        self.assertNotIn('caption', sent[0][1])

    async def test_video_note_uses_additive_method_and_old_send_rejects_it(self):
        sent = AsyncMock(return_value={'success': True, 'message_id': '42'})
        bridge = Bridge('owner', '123', 101, '/unused', sent, None)
        bridge.routes.add(('123', '77'))
        payload = {'chat_id': '123', 'metadata': {'thread_id': '77'}, 'kind': 'single',
                   'fallback': False, 'items': [{'artifact': {'artifact_id': 'synthetic'},
                                                'caption': '', 'presentation': 'video_note'}]}
        with self.assertRaises(RpcError):
            await bridge.send('send_file_set', payload)
        sent.assert_not_awaited()
        receipt = await bridge.send_video_note('send_file_set', payload)
        self.assertTrue(receipt['success'])
        self.assertEqual(sent.await_count, 1)
        with self.assertRaises(RpcError):
            await bridge.send_video_note('send_file_set', {**payload, 'kind': 'album'})

    async def test_old_ingress_keeps_video_note_queued_for_compatible_ingress(self):
        from identity.delivery_journal import DeliveryJournal
        from identity.scope import input_delivery
        peer = NS(call=AsyncMock(side_effect=RpcError(-32601, 'Method not found')))
        adapter = make_adapter(NS(typing_indicator=True), 'telegram', peer, None)
        journal = DeliveryJournal(self.root / 'delivery.sqlite3', 'owner')
        ident, digest = '1' * 64, '2' * 64
        journal.begin_input(ident, digest)
        adapter._brai_delivery_journal = journal
        payload = {'chat_id': '123', 'metadata': {'thread_id': '77'}, 'kind': 'single',
                   'fallback': False, 'items': [{'artifact': {'artifact_id': 'synthetic'},
                                                'caption': '', 'presentation': 'video_note'}]}
        token = input_delivery.set(ident)
        try:
            result = await adapter._action('send_file_set', payload)
        finally:
            input_delivery.reset(token)
        self.assertFalse(result.success)
        self.assertEqual(result.error_kind, 'delivery_pending')
        self.assertEqual(peer.call.await_args.args[0], 'send_video_note')
        self.assertEqual(len(journal.pending_outputs()), 1)
        worker = Worker(101, 'owner', '123', None)
        worker.delivery_journal = journal
        worker.peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': '42'}))
        self.assertEqual(await worker.flush_outputs('owner'), {'sent': 1})
        self.assertEqual(worker.peer.call.await_args.args[0], 'send_video_note')
        self.assertEqual(journal.pending_outputs(), [])

    async def test_unknown_voice_outcome_never_becomes_text_success(self):
        path = self.input / 'speech.ogg'
        path.write_bytes(b'OggS original voice')
        calls = []
        async def failed(**values):
            calls.append('voice')
            raise TimeoutError('outcome unknown')
        async def text(**values):
            self.fail('Media error must not downgrade to successful text')
        root_adapter = NS(platform='telegram', _bot=NS(send_voice=failed, send_message=text))
        resolver = runtime.Resolver(root_adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77')}
        resolver.ledger.admit(self.profile, ('123', '77'), {'thread_id': '77'}, '1')
        async def broker(method, params, **kwargs):
            return self.files.fetch(params['artifactId']) if method == 'ingress.artifact' else {}
        async def deliver(owner, action, payload):
            return await resolver.deliver(self.profile, owner, action, payload)
        worker = self.adapter(deliver)
        telegram = ModuleType('telegram')
        for name in ('InputMediaPhoto', 'InputMediaVideo', 'InputMediaAudio', 'InputMediaDocument'):
            setattr(telegram, name, NS)
        with patch.object(runtime, 'broker_call', broker), patch.dict(sys.modules, {'telegram': telegram}):
            result = await worker.send_voice('123', str(path), metadata={'thread_id': '77'}, is_voice=True)
        self.assertFalse(result.success)
        self.assertEqual(calls, ['voice'])

    async def test_pending_native_drain_keeps_turn_and_typing_until_session_idle(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        adapter = self.adapter(AsyncMock())
        worker.adapter = adapter
        worker.peer = NS(closed=False, call=AsyncMock(return_value={'accepted': True}))
        release = asyncio.Event()
        adapter._session_tasks = {}
        adapter._active_sessions = {'key': asyncio.Event()}
        adapter._background_tasks, adapter._expected_cancelled_tasks = set(), set()
        async def drain(*args):
            try:
                await release.wait()
            finally:
                adapter._session_tasks.pop('key', None)
        adapter._drain_after = drain
        if self.engine:
            for name in ('_spawn_drain_task', '_track_session_task', '_clear_session_guard'):
                method = self.native_function('gateway/platforms/base.py', 'BasePlatformAdapter', name,
                                              {'asyncio': asyncio})
                setattr(adapter, name, method.__get__(adapter))
        else:
            def spawn(event, key):
                adapter._session_tasks[key] = asyncio.create_task(drain())
            adapter._spawn_drain_task = spawn
        async def first():
            adapter._spawn_drain_task(NS(), 'key')
        task = asyncio.create_task(first())
        adapter._session_tasks['key'] = task
        typing = asyncio.create_task(asyncio.Event().wait())
        worker.active['turn'] = ('key', task, {})
        worker.typing['turn'] = typing
        task.add_done_callback(lambda done: worker._turn_finished('turn', done))
        try:
            await task
            await asyncio.sleep(0)
            next_task = adapter._session_tasks['key']
            self.assertIs(worker.active['turn'][1], next_task)
            self.assertFalse(typing.done())
            worker.peer.call.assert_not_awaited()
            release.set()
            await next_task
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(worker.active, {})
            self.assertTrue(typing.done())
            worker.peer.call.assert_awaited_once_with('turn_ended', {'owner': 'owner', 'turn_id': 'turn'}, timeout=5)
        finally:
            release.set()
            typing.cancel()
            await asyncio.gather(typing, return_exceptions=True)

    async def test_publication_failure_never_reaches_transport(self):
        transport = AsyncMock()
        async def unavailable(path):
            raise ConnectionError('unavailable')
        worker = self.adapter(transport, unavailable)
        result = await worker.send_voice('123', '/missing', metadata={'thread_id': '77'}, is_voice=True)
        self.assertFalse(result.success)
        transport.assert_not_awaited()

    async def test_delivery_alias_fetches_fresh_descriptor_without_republishing(self):
        artifact_id = '11111111-1111-4111-8111-111111111111'
        calls = []

        def broker(method, params):
            calls.append((method, params))
            return {'artifactId': artifact_id, 'filename': 'file.txt'}

        with patch.object(native, 'reference_metadata',
                          return_value={'artifactId': artifact_id, 'filename': 'file.txt'}):
            result = await publish_delivery_file('/old/alias.txt', broker=broker)
        self.assertEqual(result, {'artifact_id': artifact_id})
        self.assertEqual(calls, [('artifacts.fetch', {'artifactId': artifact_id})])

    async def test_delivery_alias_fetch_failure_never_falls_back_to_publish(self):
        artifact_id = '11111111-1111-4111-8111-111111111111'
        for failure in (PermissionError('foreign artifact'), ConnectionError('fetch failed')):
            calls = []

            def broker(method, params):
                calls.append((method, params))
                raise failure

            with self.subTest(failure=type(failure).__name__), patch.object(
                    native, 'reference_metadata',
                    return_value={'artifactId': artifact_id, 'filename': 'file.txt'}):
                with self.assertRaises(type(failure)):
                    await publish_delivery_file('/old/alias.txt', broker=broker)
            self.assertEqual(calls, [('artifacts.fetch', {'artifactId': artifact_id})])

    async def test_delivery_alias_rejects_mismatched_fetched_id(self):
        artifact_id = '11111111-1111-4111-8111-111111111111'
        calls = []

        def broker(method, params):
            calls.append((method, params))
            return {'artifactId': '22222222-2222-4222-8222-222222222222'}

        with patch.object(native, 'reference_metadata',
                          return_value={'artifactId': artifact_id, 'filename': 'file.txt'}):
            with self.assertRaisesRegex(PermissionError, 'Artifact mismatch'):
                await publish_delivery_file('/old/alias.txt', broker=broker)
        self.assertEqual(calls, [('artifacts.fetch', {'artifactId': artifact_id})])

    async def test_guest_delivery_without_alias_uses_only_files_publish(self):
        calls = []

        def broker(method, params):
            calls.append((method, params))
            if method == 'permissions.get':
                return {'role': 'guest'}
            return {'artifactId': '11111111-1111-4111-8111-111111111111'}

        with patch.object(native, 'reference_metadata', return_value=None):
            result = await publish_delivery_file('/tmp/admitted.txt', broker=broker)
        self.assertEqual(result, {'artifact_id': '11111111-1111-4111-8111-111111111111'})
        self.assertEqual([method for method, _ in calls],
                         ['permissions.get', 'files.publish'])
        self.assertEqual(calls[1][1]['path'], '/tmp/admitted.txt')
        self.assertTrue(calls[1][1]['requestId'])

    async def test_user_delivery_without_alias_uses_generic_artifact_publish(self):
        calls = []

        def broker(method, params):
            calls.append((method, params))
            if method == 'permissions.get':
                return {'role': 'user'}
            return {'artifactId': '11111111-1111-4111-8111-111111111111'}

        with patch.object(native, 'reference_metadata', return_value=None):
            result = await publish_delivery_file('/tmp/output.txt', broker=broker)
        self.assertEqual(result, {'artifact_id': '11111111-1111-4111-8111-111111111111'})
        self.assertEqual([method for method, _ in calls],
                         ['permissions.get', 'artifacts.publish'])
        self.assertEqual(calls[1][1]['path'], '/tmp/output.txt')
        self.assertTrue(calls[1][1]['requestId'])

    async def test_unknown_delivery_role_is_denied_without_publishing(self):
        calls = []

        def broker(method, params):
            calls.append((method, params))
            return {'role': 'unknown'}

        with patch.object(native, 'reference_metadata', return_value=None):
            with self.assertRaisesRegex(PermissionError, 'Access unavailable'):
                await publish_delivery_file('/tmp/output.txt', broker=broker)
        self.assertEqual(calls, [('permissions.get', {})])

    async def test_invalid_voice_flag_and_foreign_route_are_rejected(self):
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), None)
        bridge.routes.add(('123', '77'))
        for route, flag in [('other', True), ('123', 'true')]:
            with self.assertRaises(RpcError):
                await bridge.send('send_voice', {'chat_id': route, 'metadata': {'thread_id': '77'},
                    'artifact': {'artifact_id': 'owned'}, 'is_voice': flag})
        bridge.deliver.assert_not_awaited()

    def patched_typing(self, adapter):
        # Исполняется точное полное тело метода из поставляемого native delta.
        from types import MethodType
        import textwrap
        lines = (Path(__file__).parents[1] / 'native.patch').read_text().splitlines()
        start = next(i for i, line in enumerate(lines)
                     if line[:1] in ('+', ' ') and line[1:].startswith('    async def send_typing('))
        body = []
        for line in lines[start:]:
            if line.startswith(('---', '+++', '@@')):
                break
            if line.startswith('-'):
                continue
            value = line[1:] if line[:1] in ('+', ' ') else line
            if body and value.startswith('    ') and value.lstrip().startswith(('async def ', 'def ')):
                break
            body.append(value)
        scope = {'normalize_telegram_chat_id': int, 'logger': runtime._logger}
        exec('from __future__ import annotations\n' + textwrap.dedent('\n'.join(body)), scope)
        return MethodType(scope['send_typing'], adapter)

    async def test_typing_reaches_native_bot_api_in_original_topic(self):
        from unittest.mock import Mock
        bot = NS(send_chat_action=AsyncMock())
        adapter = NS(_bot=bot, _typing_in_cooldown=lambda chat: False,
            _message_thread_id_for_typing=lambda thread: int(thread) if thread else None,
            _metadata_thread_id=lambda metadata: metadata.get('thread_id'),
            _telegram_typing_cooldown_until={}, _is_transient_typing_error=lambda error: False,
            _record_typing_cooldown=Mock())
        adapter.send_typing = self.patched_typing(adapter)
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77'),
            'metadata': {'thread_id': '77', 'telegram_dm_topic_reply_fallback': True}}
        async def deliver(owner, action, payload):
            return await resolver.deliver(self.profile, owner, action, payload)
        worker = self.adapter(deliver)
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={})):
            result = await worker.send_typing('123', metadata={'thread_id': '77'})
        self.assertIsNone(result)
        bot.send_chat_action.assert_awaited_once_with(chat_id=123, action='typing', message_thread_id=77)

    async def test_native_typing_failure_never_falls_back_to_general_chat(self):
        from unittest.mock import Mock
        bot = NS(send_chat_action=AsyncMock(side_effect=RuntimeError('message thread not found secret-token')))
        adapter = NS(_bot=bot, _typing_in_cooldown=lambda chat: False,
            _message_thread_id_for_typing=lambda thread: int(thread),
            _metadata_thread_id=lambda metadata: metadata['thread_id'],
            _telegram_typing_cooldown_until={}, _is_transient_typing_error=lambda error: True,
            _record_typing_cooldown=Mock())
        send_typing = self.patched_typing(adapter)
        with self.assertLogs(runtime._logger, level='WARNING') as logs:
            await send_typing('123', {'thread_id': '77', 'telegram_dm_topic_reply_fallback': True})
        bot.send_chat_action.assert_awaited_once_with(chat_id=123, action='typing', message_thread_id=77)
        adapter._record_typing_cooldown.assert_called_once()
        self.assertIn('reason=message thread not found', logs.output[0])
        self.assertNotIn('secret-token', logs.output[0])

    async def test_typing_survives_native_pause_and_stops_on_cancel(self):
        ticks = []
        async def deliver(owner, action, payload):
            self.assertEqual(action, 'send_typing')
            ticks.append((asyncio.get_running_loop().time(), payload))
            return {'success': True}
        worker = self.adapter(deliver)
        event = NS(source=NS(chat_id='123', thread_id='77'))
        task = worker.start_turn_typing(event)
        try:
            # Внутренние pause/interrupt при ожидании инструмента не гасят индикатор.
            worker._typing_paused = {'123'}
            await asyncio.sleep(6.2)
            self.assertGreaterEqual(len(ticks), 3)
            self.assertLess(max(b[0] - a[0] for a, b in zip(ticks, ticks[1:])), 4)
            self.assertTrue(all(p['metadata'] == {'thread_id': '77'} for _, p in ticks))
        finally:
            task.cancel()
            await task
        before = len(ticks)
        await asyncio.sleep(0.1)
        self.assertEqual(len(ticks), before)

    async def test_typing_retries_temporary_transport_failure(self):
        ready = asyncio.Event()
        calls = 0
        async def deliver(owner, action, payload):
            nonlocal calls
            calls += 1
            if calls > 1:
                ready.set()
            return {'success': calls > 1, 'error': 'temporary'}
        worker = self.adapter(deliver)
        task = worker.start_turn_typing(NS(source=NS(chat_id='123', thread_id='77')))
        try:
            await asyncio.wait_for(ready.wait(), 4)
        finally:
            task.cancel()
            await task
