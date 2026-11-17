# ABOUTME: Проверяет тихую доставку промежуточных сообщений через Telegram ingress.
# ABOUTME: Использует закреплённый адаптер и синтетический транспорт без сети.
import ast
import asyncio
from contextlib import suppress
import logging
import re
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from identity import telegram_runtime as runtime

IDENTITY = Path(__file__).resolve().parents[1]
MARKER = '--- a/plugins/platforms/telegram/adapter.py\n+++ b/plugins/platforms/telegram/adapter.py\n'


def adapter_methods():
    """Применить точечный продуктовый patch к закреплённому адаптеру."""
    fixture = IDENTITY / 'tests/fixtures/ordinary_release/plugins/platforms/telegram/adapter.py'
    patch_text = (IDENTITY / 'native.patch').read_text()
    candidates = [MARKER + part.split('--- a/', 1)[0].split('diff --git ', 1)[0]
                  for part in patch_text.split(MARKER)[1:]]
    suffix = next(part for part in candidates if '_brai_progress' in part)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        target = root / 'plugins/platforms/telegram/adapter.py'
        target.parent.mkdir(parents=True)
        target.write_text(fixture.read_text())
        subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=suffix, text=True,
                       stdout=subprocess.DEVNULL, check=True)
        tree = ast.parse(target.read_text())
    adapter = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'TelegramAdapter')
    methods = [n for n in adapter.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and n.name in {'_notification_kwargs', 'send'}]
    assert len(methods) == 2
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *methods], type_ignores=[]))
    scope = {'SendResult': lambda **kw: SimpleNamespace(**kw)}
    exec(compile(module, 'telegram-notification-fixture', 'exec'), scope)
    return scope['_notification_kwargs'], scope['send']


def fixture_method(filename, classname, name):
    """Загрузить закреплённый метод Hermes для проверки настоящих правил доставки."""
    path = IDENTITY / 'tests/fixtures/ordinary_release/gateway' / filename
    tree = ast.parse(path.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == classname)
    method = next(n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
    method.decorator_list = []
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    scope = {'suppress': suppress}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, method], type_ignores=[])), str(path), 'exec'), scope)
    return scope[name]


class InterimNotificationsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.notification, self.send = adapter_methods()

    def test_only_interim_is_silent_even_if_all_notifications_are_enabled(self):
        for mode in ('important', 'all'):
            adapter = SimpleNamespace(_notifications_mode=mode)
            for metadata in ({'_interim_send': True, '_brai_progress': True},
                             {'_interim_send': True, '_brai_progress': True, 'notify': True}):
                with self.subTest(mode=mode, metadata=metadata):
                    self.assertEqual(self.notification(adapter, metadata), {'disable_notification': True})
            self.assertEqual(self.notification(adapter, {'_interim_send': True, '_brai_progress': True, 'is_approval_prompt': True}), {})
        self.assertEqual(self.notification(SimpleNamespace(_notifications_mode='all'), {'notify': True}), {})
        self.assertEqual(self.notification(SimpleNamespace(_notifications_mode='all'), {'_interim_send': True}), {})
        self.assertEqual(self.notification(SimpleNamespace(_notifications_mode='important'), {'notify': True}), {})
        self.assertEqual(self.notification(SimpleNamespace(_notifications_mode='all'), None), {})

    async def test_model_commentary_gets_specific_marker_without_finishing_turn(self):
        marker = '--- a/gateway/stream_consumer_fallback.py\n+++ b/gateway/stream_consumer_fallback.py\n'
        patch_text = (IDENTITY / 'native.patch').read_text()
        block = marker + patch_text.split(marker, 1)[1].split('--- a/', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'gateway/stream_consumer_fallback.py'
            target.parent.mkdir(parents=True)
            target.write_text((IDENTITY / 'tests/fixtures/ordinary_release/gateway/stream_consumer_fallback.py').read_text())
            subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                           stdout=subprocess.DEVNULL, check=True)
            tree = ast.parse(target.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'StreamFallbackMixin')
        method = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_send_commentary')
        module = ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[]))
        scope = {}
        exec(compile(module, 'commentary-fixture', 'exec'), scope)
        adapter = SimpleNamespace(name='telegram', send=AsyncMock(return_value=SimpleNamespace(success=True)))
        consumer = SimpleNamespace(adapter=adapter, chat_id='123', _initial_reply_to_id=None,
            _clean_for_display=lambda text: text, _metadata_for_send=lambda final: {},
            _notify_new_message=lambda: None, _delivered_commentary_texts=[], _already_sent=False)
        self.assertTrue(await scope['_send_commentary'](consumer, 'Проверяю документы'))
        self.assertEqual(adapter.send.await_args.kwargs['metadata'],
                         {'_interim_send': True, '_brai_progress': True})
        self.assertFalse(consumer._already_sent)
        self.assertEqual(consumer._delivered_commentary_texts, [])

        adapter.name = 'other'
        self.assertTrue(await scope['_send_commentary'](consumer, 'Проверяю документы'))
        self.assertEqual(consumer._delivered_commentary_texts, ['Проверяю документы'])

    async def test_commentary_equal_to_long_final_does_not_suppress_final_delivery(self):
        marker = '--- a/gateway/stream_consumer_fallback.py\n+++ b/gateway/stream_consumer_fallback.py\n'
        patch_text = (IDENTITY / 'native.patch').read_text()
        block = marker + patch_text.split(marker, 1)[1].split('--- a/', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'gateway/stream_consumer_fallback.py'
            target.parent.mkdir(parents=True)
            target.write_text((IDENTITY / 'tests/fixtures/ordinary_release/gateway/stream_consumer_fallback.py').read_text())
            subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                           stdout=subprocess.DEVNULL, check=True)
            tree = ast.parse(target.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'StreamFallbackMixin')
        commentary = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_send_commentary')
        scope = {}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[commentary], type_ignores=[])), 'commentary', 'exec'), scope)
        delivered = []
        async def capture(*args, **kwargs):
            delivered.append((args[1], kwargs.get('metadata')))
            return SimpleNamespace(success=True, message_id='200')
        adapter = SimpleNamespace(name='telegram', _bot=object(), _send_path_degraded=False,
            strip_media_directives_for_display=lambda value: value, _chat_send_lock=lambda chat: asyncio.Lock(),
            _send_text_locked=AsyncMock(side_effect=capture))
        async def send(**kwargs):
            return await self.send(adapter, **kwargs)
        adapter.send = send
        consumer = SimpleNamespace(adapter=adapter, chat_id='123', _initial_reply_to_id=None,
            _clean_for_display=lambda text: text, _metadata_for_send=lambda final: {},
            _notify_new_message=lambda: None, _delivered_commentary_texts=[], _delivered_segment_texts=[],
            _already_sent=False, final_response_sent=False, _visible_prefix=lambda: '')
        consumer.has_durably_delivered_text = lambda text: fixture_method(
            'stream_consumer.py', 'GatewayStreamConsumer', 'has_durably_delivered_text')(consumer, text)
        final = 'Готовый результат. ' * 300
        self.assertTrue(await scope['_send_commentary'](consumer, final))
        self.assertEqual(delivered[0][0], '⏳ Работаю: ' + final)
        confirmed = fixture_method('run_turn.py', 'GatewayTurnMixin', '_run_agent_stream_confirmed_final_delivery')
        self.assertFalse(confirmed(consumer, final))
        await adapter.send(chat_id='123', content=final, metadata={})
        self.assertEqual(delivered[1][0], final)

    async def test_long_messages_keep_all_text_and_each_progress_part_is_marked_and_silent(self):
        class SendResult:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)

        def load_methods(source, names, scope):
            tree = ast.parse(source)
            nodes = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
            self.assertEqual(len(nodes), len(names))
            for node in nodes:
                node.decorator_list = []
            future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
            exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[])), 'telegram', 'exec'), scope)

        scope = {'asyncio': asyncio, 're': re, 'SendResult': SendResult,
                 'logger': logging.getLogger('test-progress-split'),
                 '_separate_chunk_indicator_from_fence': lambda text: text}
        base = IDENTITY / 'tests/fixtures/ordinary_release/gateway/platform_split.py'
        load_methods(base.read_text(), {'fence_state_after', '_custom_unit_to_cp', 'utf16_len', 'truncate_message'}, scope)
        patch_text = (IDENTITY / 'native.patch').read_text()
        candidates = [MARKER + part.split('--- a/', 1)[0].split('diff --git ', 1)[0]
                      for part in patch_text.split(MARKER)[1:]]
        block = next(part for part in candidates if '_brai_progress' in part)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'plugins/platforms/telegram/adapter.py'
            target.parent.mkdir(parents=True)
            target.write_text((IDENTITY / 'tests/fixtures/ordinary_release/plugins/platforms/telegram/adapter.py').read_text())
            subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                           stdout=subprocess.DEVNULL, check=True)
            load_methods(target.read_text(), {'send', '_send_text_locked', '_send_chunks', '_notification_kwargs'}, scope)

        async def send_text(text, metadata):
            captured = []
            adapter = SimpleNamespace(name='telegram', _bot=object(), _send_path_degraded=False,
                strip_media_directives_for_display=lambda value: value, _chat_send_lock=lambda _: asyncio.Lock(),
                _send_flood_cooldown_remaining=lambda _: None, _chat_outbound_slot_remaining=lambda _: 0,
                _hold_chat_outbound_slot=lambda _: None, _telegram_error_types=lambda: (Exception, None, None),
                _should_attempt_rich=lambda *a, **kw: False, truncate_message=scope['truncate_message'],
                format_message=lambda value: value, MAX_MESSAGE_LENGTH=4096, _metadata_thread_id=lambda _: None,
                _message_thread_id_for_send=lambda _: None, _notifications_mode='all', _retrigger_typing=AsyncMock())
            async def send_chunk(chat, body, index, reply, metadata, thread, fallback, errors):
                captured.append((body, scope['_notification_kwargs'](adapter, metadata)))
                return SimpleNamespace(message_id=index + 1), fallback
            adapter._send_chunk_with_retries = send_chunk
            adapter._send_chunks = scope['_send_chunks'].__get__(adapter)
            adapter._send_text_locked = scope['_send_text_locked'].__get__(adapter)
            result = await scope['send'](adapter, '123', text, metadata=metadata)
            self.assertTrue(result.success)
            return captured

        text = 'ПроверочныйТекст🔥' * 900
        final = await send_text(text, {})
        interim = await send_text(text, {'_interim_send': True, '_brai_progress': True})
        strip_indicator = lambda value: re.sub(r' \\\(\d+/\d+\\\)$', '', value)
        self.assertGreater(len(final), 1)
        self.assertGreater(len(interim), 1)
        self.assertTrue(all(scope['utf16_len'](body) <= 4096 for body, _ in final + interim))
        self.assertEqual(''.join(strip_indicator(body) for body, _ in final), text)
        self.assertTrue(all(body.startswith('⏳ Работаю: ') and len(body) > len('⏳ Работаю: ')
                            and options == {'disable_notification': True} for body, options in interim))
        self.assertEqual(''.join(strip_indicator(body)[len('⏳ Работаю: '):] for body, _ in interim), text)

    def test_fallback_commentary_keeps_progress_marker(self):
        marker = '--- a/gateway/run_turn_runner.py\n+++ b/gateway/run_turn_runner.py\n'
        patch_text = (IDENTITY / 'native.patch').read_text()
        block = marker + patch_text.split(marker, 1)[1].split('--- a/', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'gateway/run_turn_runner.py'
            target.parent.mkdir(parents=True)
            target.write_text((IDENTITY / 'tests/fixtures/ordinary_release/gateway/run_turn_runner.py').read_text())
            subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                           stdout=subprocess.DEVNULL, check=True)
            tree = ast.parse(target.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'GatewayTurnRunner')
        method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_setup_stream_consumer')
        future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
        module = ast.fix_missing_locations(ast.Module(body=[future, method], type_ignores=[]))
        scope = {}
        exec(compile(module, 'runner-fixture', 'exec'), scope)
        ctx = SimpleNamespace(mute_notification_reply=False, streaming_tts_consumer_holder=[None],
            resolve_display_setting=lambda *_: False, scheduled_heartbeat=False,
            interim_assistant_messages_enabled=False, user_config={}, _run_still_current=lambda: True,
            _status_adapter=object(), _status_thread_metadata={'thread_id': '77'})
        calls = []
        runner = SimpleNamespace(_ctx=ctx, _runner=SimpleNamespace(
            config=SimpleNamespace(streaming=SimpleNamespace(enabled_for=lambda _: False))),
            _send_status_text=lambda *args: calls.append(args))
        _, _, callback, _ = scope['_setup_stream_consumer'](runner, 'telegram')
        callback('Проверяю документы')
        self.assertEqual(calls[0][1], {'thread_id': '77', '_interim_send': True, '_brai_progress': True})

    async def test_interim_prefix_is_added_once_and_final_is_untouched(self):
        for text, metadata, expected in [
            ('Проверяю документы', {'_interim_send': True, '_brai_progress': True}, '⏳ Работаю: Проверяю документы'),
            ('⏳ Работаю: Проверяю документы', {'_interim_send': True, '_brai_progress': True}, '⏳ Работаю: Проверяю документы'),
            ('Итог готов', {}, 'Итог готов'),
            ('⚠️ Время ожидания истекло', {'_interim_send': True}, '⚠️ Время ожидания истекло'),
            ('Подтвердите действие', {'_interim_send': True, '_brai_progress': True, 'is_approval_prompt': True}, 'Подтвердите действие'),
        ]:
            with self.subTest(text=text, metadata=metadata):
                lock = asyncio.Lock()
                adapter = SimpleNamespace(_bot=object(), _send_path_degraded=False,
                    strip_media_directives_for_display=lambda value: value,
                    _chat_send_lock=lambda chat: lock,
                    _send_text_locked=AsyncMock(return_value=SimpleNamespace(success=True)))
                await self.send(adapter, '123', text, metadata=metadata)
                self.assertEqual(adapter._send_text_locked.await_args.args[1], expected)

    async def test_ingress_preserves_interim_marker_for_silent_adapter(self):
        calls = []
        async def send(**kwargs):
            calls.append(kwargs['metadata'])
            return {'success': True, 'message_id': '200'}
        adapter = SimpleNamespace(send=AsyncMock(side_effect=send), _notifications_mode='all')
        resolver = runtime.Resolver(adapter)
        self.addCleanup(resolver.ledger.close)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', ''), 'inputId': 'a' * 64}
        profile = {'uid': 101, 'userId': 'owner', 'telegramId': '123', 'workerSocket': '/tmp/worker'}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'suppressFinal': False})):
            result = await resolver.deliver(profile, 'owner', 'send',
                {'chat_id': '123', 'content': 'Проверяю документы', 'metadata': {'_interim_send': True, '_brai_progress': True}})
        self.assertTrue(result['success'])
        self.assertEqual(calls, [{'_interim_send': True, '_brai_progress': True}])
        self.assertEqual(self.notification(adapter, calls[0]), {'disable_notification': True})
