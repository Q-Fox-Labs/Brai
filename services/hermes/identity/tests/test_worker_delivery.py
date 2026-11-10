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
from identity.worker import Worker, publish_delivery_file
from identity.ingress import Bridge
from identity.ipc import RpcError
from identity.scope import delivery_scope
from identity import telegram_runtime as runtime
from files import native
from files.tests.test_files import Backend


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
                return await bridge.send(**params)
        async def publish_file(path):
            return {'artifact_id': self.files.publish(path, 'ipc-publish')['artifactId']}
        return make_adapter(NS(typing_indicator=True), 'telegram', Peer(), publish or publish_file)

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
