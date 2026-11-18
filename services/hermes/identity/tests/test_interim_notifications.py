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

    async def test_queued_partial_gets_explanation_without_repeating_delivered_text(self):
        marker = '--- a/gateway/run_turn.py\n+++ b/gateway/run_turn.py\n'
        candidates = (IDENTITY / 'native.patch').read_text().split(marker)[1:]
        block = marker + next(part.split('--- a/', 1)[0] for part in candidates if '_first_failed' in part)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'gateway/run_turn.py'
            target.parent.mkdir(parents=True)
            target.write_text((IDENTITY / 'tests/fixtures/ordinary_release/gateway/run_turn.py').read_text())
            subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                           stdout=subprocess.DEVNULL, check=True)
            tree = ast.parse(target.read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)
                      and n.name == '_run_agent_deliver_first_response')
        future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
        def explanation(response, source, *, result, failure_notice):
            return (result.get('brai_delivered_partial', '') + '\n⚠️ Работа не завершена.').lstrip()
        scope = {'logger': logging.getLogger('test-queue'), 'suppress': suppress,
                 '_telegram_failure_explanation': explanation}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, method], type_ignores=[])),
                     'queued-failure-fixture', 'exec'), scope)
        deliver = scope['_run_agent_deliver_first_response']
        ctx = SimpleNamespace(mute_notification_reply=False, session_key='s', stream_consumer_holder=[None],
            source=SimpleNamespace(platform='telegram'), _status_thread_metadata={}, event_message_id=None,
            inbound_message_id='inbound', run_generation=1, persist_user_display_kind='human', reply_expected=True)
        sender = AsyncMock(return_value=True)
        runner = SimpleNamespace(_run_agent_stream_confirmed_final_delivery=lambda *_a, **_kw: False,
            _is_intentional_silence=lambda *_: False, _deliver_queued_first_response=sender,
            _hmwa_failed_turn_notice=lambda *_: None, _pop_post_delivery_callback=lambda *_: None)
        result = {'final_response': 'English technical error', 'partial': True, 'error': 'обрыв',
                  'brai_delivered_partial': 'Сохранённая часть'}
        await deliver(runner, ctx, None, result, result, None)
        self.assertEqual(sender.await_args.args[0], 'Сохранённая часть\n⚠️ Работа не завершена.')
        self.assertFalse(sender.await_args.kwargs['deliver_media'])
        self.assertTrue(result['already_sent'])

        # Если часть уже пришла потоковой доставкой, повторяем только предупреждение.
        runner._run_agent_stream_confirmed_final_delivery = lambda *_a, **_kw: True
        sender.reset_mock()
        await deliver(runner, ctx, None, result, result, None)
        self.assertEqual(sender.await_args.args[0], '⚠️ Работа не завершена.')
        self.assertFalse(sender.await_args.kwargs['text_already_delivered'])

        # Поток подтвердил только часть, а итог также содержит техническую ошибку.
        runner._run_agent_stream_confirmed_final_delivery = lambda *_a, **_kw: False
        ctx.stream_consumer_holder[0] = SimpleNamespace(
            has_durably_delivered_text=lambda text: text == 'Сохранённая часть')
        result['final_response'] = 'Сохранённая часть\n\nEnglish error'
        sender.reset_mock()
        await deliver(runner, ctx, None, result, result, None)
        self.assertEqual(sender.await_args.args[0], '⚠️ Работа не завершена.')

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
                 '_separate_chunk_indicator_from_fence': lambda text: text,
                 '_brai_hide_bare_urls': lambda text: text, '_wrap_markdown_tables': lambda text: text,
                 '_MDV2_ESCAPE_RE': re.compile(r'([_*\[\]()~`>#\+\-=|{}.!\\])')}
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
            load_methods(target.read_text(), {'send', '_send_text_locked', '_send_chunks', '_notification_kwargs',
                                             'format_message', '_escape_bare_bracket', '_escape_mdv2'}, scope)
        scope['TelegramAdapter'] = SimpleNamespace(_escape_bare_bracket=scope['_escape_bare_bracket'])

        async def send_text(text, metadata):
            captured = []
            adapter = SimpleNamespace(name='telegram', _bot=object(), _send_path_degraded=False,
                strip_media_directives_for_display=lambda value: value, _chat_send_lock=lambda _: asyncio.Lock(),
                _send_flood_cooldown_remaining=lambda _: None, _chat_outbound_slot_remaining=lambda _: 0,
                _hold_chat_outbound_slot=lambda _: None, _telegram_error_types=lambda: (Exception, None, None),
                _should_attempt_rich=lambda *a, **kw: False, truncate_message=scope['truncate_message'],
                MAX_MESSAGE_LENGTH=4096, _metadata_thread_id=lambda _: None,
                _message_thread_id_for_send=lambda _: None, _notifications_mode='all', _retrigger_typing=AsyncMock())
            async def send_chunk(chat, body, index, reply, metadata, thread, fallback, errors):
                captured.append((body, scope['_notification_kwargs'](adapter, metadata)))
                return SimpleNamespace(message_id=index + 1), fallback
            adapter._send_chunk_with_retries = send_chunk
            adapter.format_message = scope['format_message'].__get__(adapter)
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

        bold_text = 'Проверка🔥' * 900
        for metadata in ({}, {'_interim_send': True, '_brai_progress': True}):
            with self.subTest(metadata=metadata):
                parts = await send_text('**' + bold_text + '**', metadata)
                self.assertGreater(len(parts), 1)
                decoded = []
                for body, options in parts:
                    self.assertLessEqual(scope['utf16_len'](body), 4096)
                    body = strip_indicator(body)
                    if metadata:
                        self.assertEqual(options, {'disable_notification': True})
                        self.assertTrue(body.startswith('⏳ Работаю: '))
                        body = body[len('⏳ Работаю: '):]
                    self.assertTrue(body.startswith('*') and body.endswith('*'))
                    decoded.append(body[1:-1])
                self.assertEqual(''.join(decoded), bold_text)

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
            ('> Важная цитата', {'_interim_send': True, '_brai_progress': True}, '⏳ Работаю:\n> Важная цитата'),
            ('⏳ Работаю: > Важная цитата', {'_interim_send': True, '_brai_progress': True}, '⏳ Работаю:\n> Важная цитата'),
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
