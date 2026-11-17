# ABOUTME: Проверяет тихую доставку промежуточных сообщений через Telegram ingress.
# ABOUTME: Использует закреплённый адаптер и синтетический транспорт без сети.
import ast
import asyncio
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
        self.assertEqual(consumer._delivered_commentary_texts, ['Проверяю документы'])

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
