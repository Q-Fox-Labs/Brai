# ABOUTME: Исполняет обязательные границы на функциях из проверочной копии pinned Hermes.
# ABOUTME: Не вызывает модель или сеть; использует настоящий файловый адаптер и SQLite.
import ast
import base64
import importlib.util
import asyncio
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sys
import tempfile
import struct
import zlib
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from files import native
from files.store import FileError
from files.tests.test_files import Backend

ENGINE = Path(os.environ['HERMES_TEST_ENGINE'])


def function(path, names, namespace):
    """Исполнять точные тела patched функций, заменяя только внешние model/channel ports."""
    tree = ast.parse((ENGINE / path).read_text())
    nodes = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    if len(nodes) != len(names):
        raise AssertionError('Missing engine boundary')
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(ENGINE / path), 'exec'), namespace)
    return namespace


def module(**values):
    """Создать узкий внешний порт без импорта зависимостей модели."""
    result = ModuleType('test_port')
    vars(result).update(values)
    return result


class EngineTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[4] / 'tmp'
        root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temporary.name)
        self.input = self.root / 'input'
        self.input.mkdir()
        self.backend = Backend(self.root / 'cache')
        self.store = native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(self.root / 'state'),
            'resultRoot': str(self.root / 'cache'), 'readRoots': [str(self.input)]}, self.backend)

    def tearDown(self):
        self.temporary.cleanup()

    def input_file(self):
        path = self.input / 'input.txt'
        path.write_text('user input')
        return path

    def loop(self, callback):
        ports = {'brai_files': native,
            'agent.turn_context': module(export_current_turn_boundary=lambda a, r, u: r),
            'agent.voice_turn_route': module(end_voice_turn_route=lambda a: None),
            'tools.vision_tools_history_budget': module(native_turn_images=lambda message: nullcontext())}
        scope = {'_run_conversation_turn': callback, '_close_durable_failed_turn': lambda a, r: None}
        function('agent/conversation_loop.py', ['run_conversation'], scope)
        return scope['run_conversation'], ports

    def test_actual_loop_routes_cli_api_background_and_child(self):
        seen = []
        def turn(agent, message, **kwargs):
            seen.append(message)
            args = native.before_tool('write_file', {'path': 'result.txt'}, task_id=kwargs.get('task_id'))
            Path(args['path']).write_text(agent.session_id)
            return {'final_response': native.final_text('MEDIA:' + args['path'], agent.session_id)}
        run, ports = self.loop(turn)
        for channel in ['cli', 'api', 'background', 'child']:
            agent = SimpleNamespace(session_id=channel, platform=channel if channel in {'cli', 'api'} else '')
            with patch.dict(sys.modules, ports):
                result = run(agent, '@file:' + str(self.input_file()), task_id=channel)
            self.assertIn('artifactId=', seen[-1])
            self.assertIn('artifact:', result['final_response'])
            aid = result['fileSets'][0]['items'][0]['file']['artifactId']
            self.assertEqual(Path(self.store.fetch(aid)['localPath']).read_text(), channel)
            self.assertFalse(Path(agent._brai_workspace).exists())

    def test_actual_loop_commits_inbound_only_after_input_preparation(self):
        source = SimpleNamespace(platform='telegram', chat_id='1', thread_id=None, user_id='2', profile=None)
        calls = []
        run, ports = self.loop(lambda *a, **kw: calls.append('turn') or {'final_response': 'ok'})
        agent = SimpleNamespace(session_id='handoff', platform='telegram')
        with patch.dict(sys.modules, ports), patch.object(native, 'commit_inbound', side_effect=lambda *a: calls.append('commit')):
            self.backend.fail_publish = True
            with native.inbound_handoff(source, 'message'), self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
                run(agent, '@file:' + str(self.input_file()))
            self.assertEqual(calls, [])
            self.backend.fail_publish = False
            with native.inbound_handoff(source, 'message'):
                run(agent, '@file:' + str(self.input_file()))
            self.assertEqual(calls, ['commit', 'turn'])

    async def test_proxy_gateway_refuses_unconfirmed_file_handoff(self):
        scope = {}
        function('gateway/run_turn.py', ['_run_agent_inner'], scope)
        source = SimpleNamespace(platform='telegram', chat_id='1', thread_id=None, user_id='2', profile=None)
        called = []
        async def proxy(**kwargs):
            called.append(kwargs)
        gateway = SimpleNamespace(_get_proxy_url=lambda: 'https://proxy.invalid', _run_agent_via_proxy=proxy)
        event = SimpleNamespace(source=source)
        ticket = native._prepared_inbound.set((native.source_of(event), '10', 'ticket'))
        try:
            with patch.dict(sys.modules, {'brai_files': native}), self.assertRaisesRegex(FileError, 'FILES_PROXY_UNSUPPORTED'):
                await scope['_run_agent_inner'](gateway, 'file', '', [], source, 'session', inbound_message_id='10')
            self.assertEqual(called, [])
        finally:
            native._prepared_inbound.reset(ticket)

    async def album_event(self):
        """Принять два реальных PNG через общий адаптер до native vision builder."""
        source = SimpleNamespace(platform='telegram', chat_id='1', thread_id=None, user_id='2', profile=None)
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        events = []
        for index in range(2):
            color = bytes((255 if index == 0 else 0, 0, 255 if index == 1 else 0))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
                   + chunk(b'IDAT', zlib.compress(b'\0' + color)) + chunk(b'IEND', b''))
            path = self.input / ('image-' + str(index) + '.png')
            path.write_bytes(png)
            event = SimpleNamespace(source=source, message_id=str(10 + index), text='caption',
                raw_message=SimpleNamespace(media_group_id='album'), media_urls=[str(path)],
                media_types=['image/png'], metadata={})
            await native.accept_event(event, admit=False)
            events.append(event)
        native.merge_events(events[0], events[1])
        events[0].media_urls.extend(events[1].media_urls)
        await native.accept_event(events[0])
        return events[0]

    def image_builder(self, event):
        """Исполнить точный gateway builder и настоящую image_routing из pinned engine."""
        spec = importlib.util.spec_from_file_location('real_image_routing', ENGINE / 'agent/image_routing.py')
        routing = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(routing)
        scope = {}
        function('gateway/run_turn_runner.py', ['_native_image_run_message'], scope)
        runner = SimpleNamespace(_ctx=SimpleNamespace(message=event.text, session_key='album'),
            _runner=SimpleNamespace(_consume_pending_native_image_paths=lambda _: list(event.media_urls)))
        return scope['_native_image_run_message'], runner, routing

    async def test_actual_gateway_image_album_reaches_loop_without_reupload(self):
        event = await self.album_event()
        publications = sum(method == 'files.publish' for method, _ in self.backend.calls)
        build, runner, routing = self.image_builder(event)
        seen = []
        run, ports = self.loop(lambda agent, message, **kwargs: seen.append(message) or {'final_response': 'ok'})
        try:
            with patch.dict(sys.modules, {**ports, 'agent.image_routing': routing}):
                message = build(runner)
                images = [part['image_url']['url'] for part in message if part.get('type') == 'image_url']
                self.assertEqual(len(images), 2)
                self.assertTrue(all(url.startswith('data:image/png;base64,') for url in images))
                self.assertNotEqual(images[0], images[1])
                for url, path in zip(images, event.media_urls):
                    self.assertEqual(base64.b64decode(url.split(',', 1)[1]), Path(path).read_bytes())
                with self.assertRaisesRegex(FileError, 'ARTIFACT_REQUIRED'):
                    native.input_text(message, 'direct-api')
                with native.inbound_handoff(event.source, event.message_id, inline_images=runner._brai_inline_images):
                    run(SimpleNamespace(session_id='album', platform='telegram'), message)
                    for field, url in [('image_url', images[0] + 'changed'), ('file_url', images[0]),
                                       ('image_url', 'https://example.test/image.png')]:
                        with self.assertRaisesRegex(FileError, 'ARTIFACT_REQUIRED'):
                            native.input_text([{'type': field, field: {'url': url}}], 'forged')
                with self.assertRaisesRegex(FileError, 'ARTIFACT_REQUIRED'):
                    native.input_text(message, 'after-handoff')
                with native.inbound_handoff(event.source, 'another-message', inline_images=runner._brai_inline_images):
                    with self.assertRaisesRegex(FileError, 'ARTIFACT_REQUIRED'):
                        native.input_text(message, 'wrong-ticket')
            self.assertEqual(len(seen), 1)
            self.assertEqual(sum(method == 'files.publish' for method, _ in self.backend.calls), publications)
            with self.store.db() as db:
                self.assertEqual(len(json.loads(db.execute('SELECT admitted FROM groups').fetchone()[0])), 2)
        finally:
            native.release_event(event)

    async def test_actual_gateway_rejects_partial_image_album_before_admission(self):
        event = await self.album_event()
        build, runner, routing = self.image_builder(event)
        original = routing._file_to_data_url
        skipped = Path(event.media_urls[-1])
        try:
            with patch.dict(sys.modules, {'brai_files': native, 'agent.image_routing': routing}), \
                 patch.object(routing, '_file_to_data_url', side_effect=lambda path: None if path == skipped else original(path)):
                with self.assertRaisesRegex(FileError, 'NATIVE_IMAGE_INPUT_UNAVAILABLE'):
                    build(runner)
            with self.store.db() as db:
                self.assertIsNone(db.execute('SELECT admitted FROM groups').fetchone()[0])
            self.assertEqual(runner._brai_inline_images, ())
        finally:
            native.release_event(event)

    def test_actual_loop_has_no_fail_open_when_artifacts_fail(self):
        self.backend.fail_publish = True
        called = []
        run, ports = self.loop(lambda *a, **kw: called.append(True))
        with patch.dict(sys.modules, ports), self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
            run(SimpleNamespace(session_id='failure', platform='api'), '@file:' + str(self.input_file()))
        self.assertEqual(called, [])

    def test_actual_transform_survives_optional_hook_failure_and_publishes_image(self):
        path = self.input / 'image.png'
        path.write_bytes(b'image fixture')
        scope = {'logger': SimpleNamespace(debug=lambda *a, **kw: None),
                 '_tool_result_observer_fields': lambda *a: ('success', None, None)}
        function('model_tools.py', ['_apply_transform_tool_result_hook', '_brai_optional_transform_tool_result_hook'], scope)
        def broken(*a, **kw):
            raise RuntimeError('optional plugin failed')
        ports = {'brai_files': native, 'hermes_cli.lifecycle': module(has_hook=lambda _: True, invoke_hook=broken)}
        with patch.dict(sys.modules, ports):
            result = scope['_apply_transform_tool_result_hook']('image_generate', {}, json.dumps({'success': True, 'image': str(path)}),
                                                               1, SimpleNamespace(hook_kwargs=lambda: {}))
        value = json.loads(result)
        self.assertIn(value['artifactId'], self.backend.remote)
        self.assertNotEqual(value['image'], str(path))

    async def test_actual_base_delivery_uses_full_album_preflight_and_unknown_receipt(self):
        namespace = {}
        function('gateway/platforms/base.py', ['_deliver_attachments'], namespace)
        send = namespace['_deliver_attachments']
        class Result(SimpleNamespace):
            pass
        class Media:
            def __init__(self, media, caption=None, parse_mode=None):
                self.media, self.caption = media, caption
        class Bot:
            def __init__(self):
                self.calls, self.lost = [], False
            async def send_media_group(self, **kwargs):
                self.calls.append(('album', len(kwargs['media'])))
                if self.lost:
                    raise TimeoutError('accepted but reply lost')
                return [SimpleNamespace(message_id=index + 1) for index in range(len(kwargs['media']))]
            async def send_photo(self, **kwargs):
                self.calls.append(('single', 1))
                return SimpleNamespace(message_id=100)
        telegram = module(**{'InputMedia' + kind: Media for kind in ['Photo', 'Video', 'Audio', 'Document']})
        ports = {'brai_files': native, 'telegram': telegram, 'gateway.platforms.base': module(SendResult=Result)}
        for count in [1, 2, 10, 11]:
            items = []
            for index in range(count):
                path = self.input / (str(count) + '-' + str(index) + '.jpg')
                path.write_bytes(b'photo')
                value = self.store.publish(path, [count, index])
                items.append({'artifactId': value['artifactId'], 'caption': str(index)})
            text = native.final_text('BRAI_FILES:' + json.dumps({'mode': 'album', 'items': items}), str(count))
            paths = [json.loads(line.removeprefix('MEDIA:')) for line in text.splitlines()]
            extracted = SimpleNamespace(images=[], media_files=[(path, False) for path in paths], local_files=[], force_document_attachments=False)
            event = SimpleNamespace(source=SimpleNamespace(platform='telegram', chat_id='1', thread_id='2', user_id='3', profile=None),
                                    message_id=str(count), ledger_message_id=None)
            bot = Bot()
            adapter, receipts = SimpleNamespace(platform='telegram', _bot=bot), []
            if count == 2:
                bot.lost = True
            with patch.dict(sys.modules, ports):
                await send(adapter, event, extracted, {'thread_id': '2'}, anything_sent=False, record_delivery=receipts.append)
                if count == 2:
                    await send(adapter, event, extracted, {'thread_id': '2'}, anything_sent=False, record_delivery=receipts.append)
                    self.assertEqual(bot.calls, [('album', 2)])
                    self.assertFalse(receipts[-1].success)
                    self.assertEqual(receipts[-1].raw_response['state'], 'unknown')
                else:
                    self.assertTrue(receipts[-1].success)
                    self.assertEqual(bot.calls, [('single', 1)] if count == 1 else [('album', min(count, 10))] + ([('single', 1)] if count == 11 else []))


if __name__ == '__main__':
    unittest.main()
