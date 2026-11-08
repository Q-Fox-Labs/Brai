# ABOUTME: Проверяет передачу файлов личного worker через настоящий файловый мост.
# ABOUTME: Telegram и broker заменены локальными портами без внешних сообщений.
import ast
import asyncio
import contextlib
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.adapter import make_adapter
from identity.ingress import Bridge
from identity.ipc import RpcError
from identity import telegram_runtime as runtime
from files import native
from files.tests.test_files import Backend


class DeliveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
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
        self.base.BasePlatformAdapter = Base
        self.base.SendResult = NS
        self.engine = os.environ.get('HERMES_TEST_ENGINE')
        if self.engine:
            self.base.BasePlatformAdapter.__init__ = self.native_function(
                'gateway/platforms/base.py', 'BasePlatformAdapter', '__init__',
                {'DEFAULT_BUSY_TEXT_DEBOUNCE_SECONDS': 0.2, 'DEFAULT_BUSY_TEXT_HARD_CAP_SECONDS': 1})
        self.port = patch.dict(sys.modules, {'gateway.platforms.base': self.base, 'brai_files': native})
        self.port.start()

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
        self.port.stop()
        self.temp.cleanup()

    def adapter(self, deliver, publish=None):
        bridge = Bridge('owner', '123', 101, '/unused', deliver, None)
        bridge.routes.add(('123', '77'))
        class Peer:
            async def call(self, method, params):
                return await bridge.send(**params)
        async def publish_file(path):
            return {'artifact_id': self.files.publish(path, 'ipc-publish')['artifactId']}
        return make_adapter(NS(typing_indicator=True), 'telegram', Peer(), publish or publish_file)

    async def test_voice_crosses_owner_boundary_with_original_bytes_and_receipt(self):
        path = self.input / 'speech.ogg'
        path.write_bytes(b'OggS original voice bytes')
        sent = []
        native_voice = None
        if self.engine:
            native_voice = self.native_function('plugins/platforms/telegram/adapter.py',
                'TelegramAdapter', 'send_voice', {'os': os, 'asyncio': asyncio,
                    'contextlib': contextlib, 'SendResult': NS,
                    '_probe_voice_duration_seconds': lambda path: 1})
        async def bubble(file, chat_id, reply_to, metadata, caption, duration):
            self.assertEqual(file.read(), b'OggS original voice bytes')
            self.assertEqual(chat_id, '123')
            self.assertEqual(metadata['thread_id'], '77')
            return NS(message_id='telegram-42')
        native_adapter = NS(_bot=object(), _send_voice_bubble=bubble)
        async def transport(**values):
            sent.append((Path(values['audio_path']).read_bytes(), values))
            if native_voice:
                return await native_voice(native_adapter, **values)
            return NS(success=True, message_id='telegram-42')
        root_adapter = NS(platform='telegram', send_voice=transport)
        native.install_adapter(root_adapter)
        resolver = runtime.Resolver(root_adapter)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '77')}
        profile = {'uid': 101, 'userId': 'owner'}
        async def deliver(owner, action, payload):
            return await resolver.deliver(profile, owner, action, payload)
        async def broker(method, params, **kwargs):
            if method == 'ingress.artifact':
                self.assertEqual(params['uid'], 101)
                return self.files.fetch(params['artifactId'])
            self.assertEqual(method, 'ingress.status')
            return {'suppressFinal': False}
        worker = self.adapter(deliver)
        items, mode = native.output_items([str(path)])
        with patch.object(runtime, 'broker_call', broker), patch.object(native, 'telegram_sender',
                side_effect=AssertionError('Worker must never use a Telegram bot')):
            result = await native.send_set(worker, '123', items, mode, {'thread_id': '77'})
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, 'telegram-42')
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], b'OggS original voice bytes')
        self.assertIs(sent[0][1]['is_voice'], True)
        self.assertEqual(sent[0][1]['metadata'], {'thread_id': '77'})
        self.assertNotIn('artifact', sent[0][1])

    async def test_publication_failure_never_reaches_transport(self):
        transport = AsyncMock()
        async def unavailable(path):
            raise ConnectionError('unavailable')
        worker = self.adapter(transport, unavailable)
        result = await worker.send_voice('123', '/missing', metadata={'thread_id': '77'}, is_voice=True)
        self.assertFalse(result.success)
        transport.assert_not_awaited()

    async def test_invalid_voice_flag_and_foreign_route_are_rejected(self):
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), None)
        bridge.routes.add(('123', '77'))
        for route, flag in [('other', True), ('123', 'true')]:
            with self.assertRaises(RpcError):
                await bridge.send('send_voice', {'chat_id': route, 'metadata': {'thread_id': '77'},
                    'artifact': {'artifact_id': 'owned'}, 'is_voice': flag})
        bridge.deliver.assert_not_awaited()

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
