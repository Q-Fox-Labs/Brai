# ABOUTME: Исполняет обязательные границы на функциях из проверочной копии pinned Hermes.
# ABOUTME: Не вызывает модель или сеть; использует настоящий файловый адаптер и SQLite.
import ast
import base64
import dataclasses
import importlib.util
import asyncio
from contextlib import nullcontext, suppress
from datetime import datetime, timezone
import json
import logging
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import struct
import threading
import zlib
from types import SimpleNamespace, ModuleType, MethodType
import time
import unittest
import uuid
import wave
from unittest.mock import AsyncMock, patch

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

    async def test_hidden_result_persisted_before_crash_is_not_owed_on_startup(self):
        from identity.scope import operator_assignment
        from identity.worker import Worker

        now = datetime.now(timezone.utc)
        source = SimpleNamespace(platform='telegram', chat_id='101', thread_id='202')
        hidden = SimpleNamespace(session_key='held', session_id='private', origin=source,
                                 active_turn_token=None, active_turn_started_at=None, suspended=False)
        normal = SimpleNamespace(session_key='ordinary', session_id='normal', origin=source,
                                 active_turn_token='ordinary-token', active_turn_started_at=now,
                                 suspended=False, transport_profile=None)
        entries = {entry.session_key: entry for entry in (hidden, normal)}
        written = []
        stored = {'private': 'Private result', 'normal': 'Ordinary result'}
        async_store = SimpleNamespace(load_transcript=AsyncMock(side_effect=stored.get),
                                      clear_turn_active=AsyncMock(return_value=True),
                                      recover_interrupted_turns=AsyncMock(return_value=0))
        native_store = SimpleNamespace(_lock=threading.RLock(), _entries=entries, _ensure_loaded_locked=lambda: None)
        runner = SimpleNamespace(session_store=native_store, async_session_store=async_store,
                                 _crash_left_reply=lambda transcript, timestamp, origin: transcript,
                                 _hmwa_shape_agent_response=AsyncMock(), _hmwa_agent_error_reply=AsyncMock(),
                                 _hmwa_deliver_turn_response=AsyncMock(), _run_startup_resume_event=AsyncMock())

        async def native_mark(event, session_key):
            entries[session_key].active_turn_token = 'new-token'
            entries[session_key].active_turn_started_at = now
            return True

        runner._mark_durable_active_turn = native_mark
        worker = Worker(os.getuid() + 1, 'owner', '101', AsyncMock())
        worker._install_failure_recovery(runner)
        token = operator_assignment.set(SimpleNamespace(session_key='held', session_id='private'))
        try:
            self.assertFalse(await runner._mark_durable_active_turn(None, 'held'))
        finally:
            operator_assignment.reset(token)
        restart = function('gateway/run_startup.py', {'_recover_unclean_sessions', '_ledger_crash_left_replies'},
                           {'asyncio': asyncio, 'time': time, 'logging': SimpleNamespace(WARNING=1),
                            '_log_suppressed': lambda *_: nullcontext()})
        runner._ledger_crash_left_replies = MethodType(restart['_ledger_crash_left_replies'], runner)
        with patch.dict(sys.modules, {
            'gateway.run': module(_float_env=lambda _name, default: default),
            'gateway.delivery_ledger': module(ledger_enabled=lambda: True,
                compute_obligation_id=lambda *parts: parts, record_crash_left_reply=lambda **value: written.append(value)),
        }):
            self.assertEqual(await restart['_recover_unclean_sessions'](runner), (0, 1))
        self.assertEqual([(value['session_key'], value['content']) for value in written], [('ordinary', 'Ordinary result')])
        async_store.load_transcript.assert_awaited_once_with('normal')

    async def test_hidden_assignment_cannot_schedule_or_send_a_separate_caption(self):
        from identity.scope import operator_assignment

        token = operator_assignment.set(SimpleNamespace())
        try:
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
                for name, args in [('cronjob_manage', {}), ('delegate_task', {}), ('terminal', {'heartbeat': True})]:
                    with self.assertRaisesRegex(FileError, 'OPERATOR_ASSIGNMENT_REQUIRES_FOREGROUND_TOOLS'):
                        native.before_tool(name, args)
        finally:
            operator_assignment.reset(token)
        bot = SimpleNamespace(send_message=AsyncMock(), send_media_group=AsyncMock())
        adapter = SimpleNamespace(_bot=bot, format_message=lambda value: value.replace('!', '\\!'))
        telegram = module(**{name: object for name in ('InputMediaPhoto', 'InputMediaVideo', 'InputMediaAudio', 'InputMediaDocument')})
        with patch.dict(sys.modules, {'telegram': telegram}):
            with self.assertRaisesRegex(FileError, 'TELEGRAM_CAPTION_TOO_LONG'):
                await native.telegram_sender(adapter, '101', {'thread_id': '202'}, 'album',
                                             [{'caption': '!' * 700}], False, reply_to='203', strict=True)
        bot.send_message.assert_not_awaited()
        bot.send_media_group.assert_not_awaited()

        with self.assertRaisesRegex(FileError, 'DELIVERY_ROUTE_UNCONFIRMED'):
            native.verify_telegram_target(SimpleNamespace(chat_id=101, message_thread_id=202), {'chat_id': 101})

    def test_hidden_terminal_cannot_promote_timeout_or_yield_to_a_watcher(self):
        from identity.scope import operator_assignment

        class Rejected(Exception):
            def __init__(self, result):
                self.result_json = result

        acquired = []
        invoked = []
        hooks = function('tools/terminal_tool.py', {'terminal_tool', '_yield_kwargs'}, {
            '_plan_execution': lambda *args, **kwargs: SimpleNamespace(promoted_from_foreground_timeout=600),
            '_acquire_env': lambda *args: acquired.append(args),
            '_Rejected': Rejected, '_error_json': str, 'EnvironmentConnectionError': OSError,
            'yield_to_background_handler': lambda **kwargs: invoked.append(kwargs) or 'yield handler',
        })
        token = operator_assignment.set(SimpleNamespace())
        try:
            with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), patch.dict(sys.modules, {
                'brai_files': native,
                'hermes_cli.observability.shared_metrics_loop': module(record_terminal_backend=lambda *_: None),
            }):
                self.assertEqual(hooks['_yield_kwargs']('sleep 5'), {})
                self.assertIn('requires a foreground', hooks['terminal_tool']('sleep 5', timeout=600))
        finally:
            operator_assignment.reset(token)
        self.assertEqual(acquired, [])
        self.assertEqual(invoked, [])

    async def test_hidden_result_keeps_files_from_shaped_native_response(self):
        from identity.scope import operator_assignment
        from identity.worker import Worker

        file = self.input_file()
        response = native.final_text(f'Готово.\nMEDIA:"{file}"', 'hidden')
        expected = native.result_envelope({'final_response': response}, SimpleNamespace(platform='telegram'))
        artifact = expected['fileSets'][0]['items'][0]['file']['artifactId']
        worker = Worker(os.getuid() + 1, 'owner', '101', AsyncMock())
        worker.adapter = SimpleNamespace(strip_media_directives_for_display=lambda text: text.split('\n', 1)[0])
        runner = SimpleNamespace(_hmwa_shape_agent_response=AsyncMock(return_value=(response, False, [])))
        worker._install_failure_recovery(runner)

        assignment = SimpleNamespace(session_key='current', result=None)
        token = operator_assignment.set(assignment)
        try:
            with patch.dict(sys.modules, {'brai_files': native}):
                await runner._hmwa_shape_agent_response({'completed': True}, None, [], None, 'current')
        finally:
            operator_assignment.reset(token)
        self.assertEqual(assignment.result, {'text': 'Готово.', 'artifactIds': [artifact]})

    async def test_managed_command_resumes_same_media_after_new_temporary_output(self):
        from identity.audio_parts import PART_SECONDS, RATE
        from identity.transcribe import PART_TIMEOUT, transcribe_audio

        source = self.input / 'long audio.wav'
        frames = RATE * 830
        with wave.open(str(source), 'wb') as audio:
            audio.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
            for _ in range(830):
                audio.writeframesraw(bytes(RATE * 2))
        self.assertGreater(source.stat().st_size, 25 * 1024 * 1024)
        model = {'modelId': 'fixture', 'revision': 'v1', 'profileId': 'asr'}
        (self.root / 'workspace').mkdir()
        published, requests, invocations = [], {}, []

        def broker(method, params, *, timeout):
            if method == 'files.publish':
                with wave.open(params['path'], 'rb') as part:
                    published.append(part.getnframes())
                return {'artifactId': str(uuid.uuid4()), 'mimeType': 'audio/wav'}
            self.assertEqual(method, 'tools.call')
            args = params['args']
            if params['name'] == 'transcription_request_submit':
                request = str(uuid.uuid4())
                requests[request] = f'part {len(requests) + 1}'
                return {'request': {'taskState': 'succeeded', 'requestId': request,
                                    'actualModel': model, 'requestedModel': args['requestedModel']}}
            self.assertEqual(params['name'], 'transcription_result_get')
            return {'state': 'available', 'result': {'requestId': args['requestId'], 'actualModel': model,
                                                     'text': requests[args['requestId']]}}

        def run_command(command, timeout, *, env_passthrough):
            name, input_flag, audio, output_flag, output, key_flag, operation = shlex.split(command)
            self.assertEqual((name, input_flag, output_flag, key_flag),
                             ('fixture', '--input', '--output', '--operation-id'))
            self.assertEqual(Path(audio), source)
            self.assertGreater(timeout, PART_TIMEOUT)
            invocations.append((output, operation))
            transcribe_audio(audio, output, model, call=broker, operation_id=operation)
            return SimpleNamespace(stdout='HERMES_IDENTITY_STT_PART 1')

        render = function('tools/tts_command_provider.py',
                          {'render_command_template', 'shell_quote_context', 'quote_command_placeholder'},
                          {'os': os, 're': re, 'shlex': shlex, 'subprocess': subprocess})['render_command_template']
        command = function('tools/transcription_command.py', {'_transcribe_command_stt', '_read_command_stt_output'}, {
            'tempfile': tempfile, 'Path': Path, 'subprocess': subprocess, 'logger': logging.getLogger(__name__),
            '_get_command_stt_timeout': lambda config: config['timeout'], '_get_command_stt_output_format': lambda _: 'txt',
            '_command_stt_env_passthrough': lambda _: [], '_normalize_command_stt_input': lambda audio, *_: (str(audio), None),
            '_render_command_stt_template': render, '_run_command_stt': run_command,
            '_ok_result': lambda result, name: (result, name),
        })['_transcribe_command_stt']
        config = {'command': 'fixture --input {input_path} --output {output_path}', 'timeout': 200, 'language': 'ru'}

        def reject_generic_route(*args, **kwargs):
            self.fail('Managed long audio entered the generic remote splitting path')

        hooks = function('tools/transcription_tools.py', {'transcribe_audio', '_transcribe_prepared_audio'}, {
            'Path': Path, '_read_block_error': lambda *_: None, '_validate_audio_file': lambda *_, **__: None,
            '_validate_audio_source_file': lambda *_, **__: None, '_load_stt_config': lambda: config,
            '_prepare_audio_for_transcription': lambda path: (path, None, None), 'is_stt_enabled': lambda _: True,
            '_get_provider': lambda _: 'brai_local_ai', '_is_local_stt_provider': reject_generic_route,
            '_dispatch_stt_provider': lambda path, name, stt, *_: command(path, name, stt, stt),
        })

        async def transcribe(path):
            return await asyncio.to_thread(hooks['transcribe_audio'], path)

        operation = 'd' * 64
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker', 'HERMES_HOME': str(self.root)}), \
                patch.dict(sys.modules, {'brai_files': native,
                                        'tools.transcription_tools': module(_resolve_stt_language=lambda *_: 'ru')}):
            first = await native.transcribe_voice_once(SimpleNamespace(_brai_voice_operations={str(source): operation}),
                                                       str(source), transcribe)
            recovered = await native.transcribe_voice_once(SimpleNamespace(_brai_voice_operations={str(source): operation}),
                                                           str(source), transcribe)
        self.assertEqual(first, recovered)
        self.assertEqual(first, ('\n'.join(requests.values()), 'brai_local_ai'))
        self.assertEqual(sum(published), frames)
        self.assertTrue(all(part <= RATE * PART_SECONDS for part in published))
        self.assertEqual(len(published), len(requests))
        self.assertEqual([value[1] for value in invocations], [operation, operation])
        self.assertNotEqual(invocations[0][0], invocations[1][0])

    async def test_pending_voice_merge_shares_computation_and_echoes_each_clip_once(self):
        ready, release = asyncio.Event(), asyncio.Event()
        compute, echoes, consent_transcripts = [], [], []

        async def transcribe(path):
            compute.append(path)
            if path == '/first.ogg':
                ready.set()
                await release.wait()
            return path

        async def enrich(text, paths, *, event):
            results = [await native.transcribe_voice_once(event, path, transcribe) for path in paths]
            return text, results

        async def echo(adapter, source, transcripts, **kwargs):
            echoes.extend(transcripts)

        inbound = function('gateway/run_inbound.py', {
            '_transcribe_pending_audio_event_once', '_echo_pending_stt_transcripts_once',
        }, {})
        base = function('gateway/platforms/base.py', {'merge_pending_message_event'}, {
            'MessageType': SimpleNamespace(PHOTO='photo', TEXT='text'),
            'BasePlatformAdapter': SimpleNamespace(_merge_caption=lambda previous, later: previous + ' ' + later),
        })
        runner = SimpleNamespace(_enrich_message_with_transcription=enrich, _echo_stt_transcripts=echo,
                                 _should_echo_stt_transcripts=lambda: True,
                                 _pending_event_audio_paths=lambda event: list(event.media_urls))

        def event(path, text):
            return SimpleNamespace(text=text, message_type='voice', media_urls=[path], media_types=['audio/ogg'],
                                   media_text_inlined=[], absorb_reply_expected=lambda incoming: None)

        first = event('/first.ogg', 'start')
        pending = inbound['_transcribe_pending_audio_event_once']
        earlier = asyncio.create_task(pending(runner, first, first.text))
        duplicate = asyncio.create_task(pending(runner, first, first.text))
        await ready.wait()
        with patch.dict(sys.modules, {'brai_files': SimpleNamespace(merge_events=lambda *_: None)}):
            base['merge_pending_message_event']({'session': first}, 'session', event('/second.ogg', 'append'))
        approvals = module(record_transcripts=lambda _, _event, text: consent_transcripts.append(list(text)))
        with patch.dict(sys.modules, {'tools.approval_conversation': approvals}):
            release.set()
            results = await asyncio.gather(earlier, duplicate)
        self.assertEqual(results, [('start append', ['/first.ogg', '/second.ogg'])] * 2)
        echo_once = inbound['_echo_pending_stt_transcripts_once']
        await asyncio.gather(*(echo_once(runner, first, object(), object(), result) for _, result in results))
        recovered = event('/first.ogg', 'start')
        recovered.metadata = {'recovered': True}
        await echo_once(runner, recovered, object(), object(), ['/first.ogg'])
        self.assertCountEqual(compute, ['/first.ogg', '/second.ogg'])
        self.assertEqual(echoes, ['/first.ogg', '/second.ogg'])
        self.assertEqual(consent_transcripts, [['/first.ogg', '/second.ogg']])

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

    def test_actual_loop_preserves_interrupted_and_failed_results_without_text(self):
        """Неполный ход сохраняет исходную причину и не создаёт файловую доставку."""
        for result in ({'final_response': None, 'interrupted': True},
                       {'final_response': None, 'error': 'synthetic provider failure'},
                       {'error': 'synthetic provider failure'},
                       {'final_response': []}):
            with self.subTest(result=result):
                run, ports = self.loop(lambda *args, **kwargs: dict(result))
                closed = []
                run.__globals__['_close_durable_failed_turn'] = lambda a, r: closed.append(r)
                with patch.dict(sys.modules, ports):
                    actual = run(SimpleNamespace(session_id='no-text', platform='telegram'), 'test album')
                self.assertEqual({k:v for k,v in actual.items() if k!='user_intervened'}, result)
                self.assertEqual(closed, [actual])
                self.assertNotIn('fileSets', actual)
                self.assertEqual(self.backend.calls, [])

    async def test_actual_telegram_album_waits_for_fifo_publication_before_dispatch(self):
        """Альбом ждёт медленную публикацию без отдельного хода."""
        await self._assert_telegram_fifo_publication(photo_burst=False)

    async def test_actual_telegram_photo_burst_waits_for_fifo_publication_before_dispatch(self):
        """Фото без media_group_id ждут медленный update и передаются целиком."""
        await self._assert_telegram_fifo_publication(photo_burst=True)

    async def _assert_telegram_fifo_publication(self, photo_burst):
        """Проверить живые границы FIFO, debounce и Artifacts на синтетическом потоке."""
        scope = {'asyncio': asyncio, 'logger': SimpleNamespace(info=lambda *a:None)}
        function('plugins/platforms/telegram/update_admission.py',
                 ['do_process_update', 'wait_for_chat_idle'], scope)
        processor = SimpleNamespace(_tails={})
        processor.do_process_update = MethodType(scope['do_process_update'], processor)
        real_wait = MethodType(scope['wait_for_chat_idle'], processor)
        waiting = asyncio.Event()
        async def wait(chat_id):
            waiting.set()
            await real_wait(chat_id)
        processor.wait_for_chat_idle = wait
        function('plugins/platforms/telegram/adapter.py',
                 ['_queue_media_group_event', '_flush_media_group_event', '_flush_buffered', '_merge_into_pending',
                  '_route_photo_event', '_enqueue_photo_event', '_flush_photo_batch'], scope)
        dispatched, held, active = [], [], []
        async def handle(event):
            try:
                if not await native.accept_event(event):
                    return
                data = [item for group in event.metadata['fileSets'] for item in group['items']]
                native.commit_inbound(event.source, event.message_id)
                dispatched.append(([i['source']['messageId'] for i in data], [i['caption'] for i in data]))
            finally:
                native.release_event(event)
        adapter = SimpleNamespace(_media_group_events={}, _media_group_tasks={},
            _app=SimpleNamespace(update_processor=processor), MEDIA_GROUP_WAIT_SECONDS=0.02,
            _pending_photo_batches={}, _pending_photo_batch_tasks={}, _media_batch_delay_seconds=0.02,
            _drop_unresolved=lambda event:False, _photo_batch_key=lambda event,msg:'photo-burst',
            _should_drop_delayed_delivery=lambda:False, _accept_update=lambda:None,
            _hold_inbound_event=lambda event, **kw:held.append(event), handle_message=handle,
            _merge_caption=lambda a,b:(a+'\n'+b if a else b),
            gateway_runner=SimpleNamespace(_is_user_authorized_for_source=lambda source:True))
        for name in ['_queue_media_group_event','_flush_media_group_event','_flush_buffered','_merge_into_pending',
                     '_route_photo_event','_enqueue_photo_event','_flush_photo_batch']:
            setattr(adapter,name,MethodType(scope[name],adapter))
        source = SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        def event(index):
            path=self.input/('delayed-'+str(index)+'.jpg');path.write_bytes(('image-'+str(index)).encode())
            return SimpleNamespace(source=source,message_id=str(10+index),text=['album caption','second caption','','fourth caption','late caption'][index],
                raw_message=SimpleNamespace(media_group_id=None if photo_burst else 'one-album'),media_urls=[str(path)],media_types=['image/jpeg'],metadata={})
        entered, release = threading.Event(), threading.Event()
        original = self.backend.call
        def backend(method,args,**kw):
            if method=='files.publish' and Path(args['path']).name=='delayed-1.jpg':
                entered.set()
                if not release.wait(5):raise RuntimeError('synthetic publication timeout')
            return original(method,args,**kw)
        self.backend.call=backend
        tasks = adapter._pending_photo_batch_tasks if photo_burst else adapter._media_group_tasks
        async def route(ev):
            if photo_burst:
                await adapter._route_photo_event(ev.raw_message,ev)
            else:
                await adapter._queue_media_group_event('one-album',ev)
        update = SimpleNamespace(effective_chat=SimpleNamespace(id=1))
        try:
            with patch.dict(sys.modules,{'brai_files':native}):
                inputs=[event(i) for i in range(4)]
                active=[asyncio.create_task(processor.do_process_update(update,route(ev))) for ev in inputs]
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                await asyncio.wait_for(waiting.wait(),2)
                self.assertEqual(dispatched,[])
                with self.store.db() as db:
                    self.assertIsNone(db.execute('SELECT admitted FROM groups').fetchone()[0])
                previous_flush=next(iter(tasks.values()))
                other=[]
                async def independent():other.append(True)
                await asyncio.wait_for(processor.do_process_update(SimpleNamespace(effective_chat=SimpleNamespace(id=9)),independent()),2)
                self.assertEqual(other,[True])
                release.set()
                await asyncio.wait_for(asyncio.gather(*active),3)
                await asyncio.wait_for(asyncio.gather(*list(tasks.values())),3)
                self.assertEqual(dispatched,[(['10','11','12','13'],['album caption','second caption','','fourth caption'])])
                with self.store.db() as db:
                    persisted = db.execute('SELECT DISTINCT group_key FROM items').fetchall()
                self.assertEqual(len(persisted), 1)
                self.assertTrue(previous_flush.cancelled())
                self.assertEqual(processor._tails,{})
                self.assertEqual(held,[])
                # Настоящее позднее дополнение получает только новый элемент.
                await processor.do_process_update(update,route(event(4)))
                await asyncio.wait_for(asyncio.gather(*list(tasks.values())),3)
                self.assertEqual(dispatched[-1],(['14'],['late caption']))
                # Другой update того же исходного message не создаёт публикацию/ход повторно.
                await processor.do_process_update(update,route(event(4)))
                await asyncio.wait_for(asyncio.gather(*list(tasks.values())),3)
                self.assertEqual(len(dispatched),2)
                self.assertEqual(sum(name=='files.publish' for name,_ in self.backend.calls),5)
        finally:
            release.set()
            if active:await asyncio.gather(*active,return_exceptions=True)
            for task in list(tasks.values()):task.cancel()
            await asyncio.gather(*list(tasks.values()),return_exceptions=True)
            for ev in inputs:native.release_event(ev)

    async def test_actual_photo_batch_recovers_once_after_restart_before_flush(self):
        """Настоящая сборка Telegram сохраняет серию как единый набор до запуска агента."""
        scope = {'asyncio': asyncio, 'logger': SimpleNamespace(info=lambda *a:None)}
        function('plugins/platforms/telegram/adapter.py',
                 ['_route_photo_event', '_enqueue_photo_event', '_flush_photo_batch', '_flush_buffered', '_merge_into_pending'], scope)
        adapter = SimpleNamespace(_pending_photo_batches={}, _pending_photo_batch_tasks={},
            _media_batch_delay_seconds=60, _drop_unresolved=lambda event:False,
            _photo_batch_key=lambda event, msg:'same-topic', _should_drop_delayed_delivery=lambda:False,
            _accept_update=lambda:None, _merge_caption=lambda a,b:(a+'\n'+b if a else b),
            gateway_runner=SimpleNamespace(_is_user_authorized_for_source=lambda source:True))
        for name in ['_route_photo_event', '_enqueue_photo_event', '_flush_photo_batch', '_flush_buffered', '_merge_into_pending']:
            setattr(adapter, name, MethodType(scope[name], adapter))
        source = SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        events=[]
        try:
            with patch.dict(sys.modules, {'brai_files':native}):
                for number in (86,87,88):
                    path=self.input/(str(number)+'.jpg'); path.write_bytes(str(number).encode())
                    event=SimpleNamespace(source=source,message_id=str(number),text='подпись '+str(number),
                        raw_message=SimpleNamespace(media_group_id=None),media_urls=[str(path)],
                        media_types=['image/jpeg'],metadata={})
                    events.append(event)
                    await adapter._route_photo_event(event.raw_message,event)
            for task in adapter._pending_photo_batch_tasks.values(): task.cancel()
            await asyncio.gather(*adapter._pending_photo_batch_tasks.values(),return_exceptions=True)
            for event in events: native.release_event(event)
            native.configure({'ownerId':'owner','account':'test','stateRoot':str(self.root/'state'),
                'resultRoot':str(self.root/'cache'),'readRoots':[str(self.input)]},self.backend)
            observed=[]
            class RecoveredAdapter:
                platform='telegram'
                async def handle_message(self, event):
                    if await native.accept_event(event):
                        observed.append([(item['source']['messageId'],item['caption'])
                            for group in event.metadata['fileSets'] for item in group['items']])
                        native.commit_inbound(event.source,event.message_id)
                        native.release_event(event)
            ports={'gateway.config':module(Platform=lambda value:value),
                'gateway.session':module(SessionSource=lambda **kw:SimpleNamespace(**kw)),
                'gateway.platforms.event':module(MessageType=SimpleNamespace(DOCUMENT='document'),
                    MessageEvent=lambda **kw:SimpleNamespace(**kw))}
            with patch.dict(sys.modules,ports):
                await native.recover(RecoveredAdapter())
                await native.recover(RecoveredAdapter())
            self.assertEqual(observed,[[('86','подпись 86'),('87','подпись 87'),('88','подпись 88')]])
        finally:
            for task in adapter._pending_photo_batch_tasks.values():task.cancel()
            await asyncio.gather(*adapter._pending_photo_batch_tasks.values(),return_exceptions=True)
            for event in events:native.release_event(event)

    async def test_later_text_waits_for_earlier_telegram_photo_batch(self):
        """Текст не должен обгонять ожидающие фотографии того же маршрута."""
        scope={'asyncio':asyncio}
        function('plugins/platforms/telegram/adapter.py',['_flush_buffered'],scope)
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        photo=SimpleNamespace(source=source,message_id='86')
        text_event=SimpleNamespace(source=source,message_id='89')
        received=[]
        async def wait_for_chat_idle(chat):pass
        async def handle(event):received.append(event.message_id)
        adapter=SimpleNamespace(_app=SimpleNamespace(update_processor=SimpleNamespace(wait_for_chat_idle=wait_for_chat_idle)),
            _should_drop_delayed_delivery=lambda:False, _hold_inbound_event=lambda *a,**kw:None,
            _pending_photo_batches={'photo':photo},_pending_photo_batch_tasks={},
            _media_group_events={},_media_group_tasks={}, handle_message=handle)
        photo_task=asyncio.create_task(scope['_flush_buffered'](adapter,adapter._pending_photo_batches,
            adapter._pending_photo_batch_tasks,'photo',0.05,'photo'))
        adapter._pending_photo_batch_tasks['photo']=photo_task
        text_pending={'text':text_event};text_tasks={}
        text_task=asyncio.create_task(scope['_flush_buffered'](adapter,text_pending,text_tasks,'text',0,'text'))
        text_tasks['text']=text_task
        with patch.dict(sys.modules,{'brai_files':native}):
            await asyncio.wait_for(asyncio.gather(photo_task,text_task),2)
        self.assertEqual(received,['86','89'])

    async def test_text_is_held_if_prior_media_dispatch_fails(self):
        """Ошибка предыдущего набора сохраняет текст вместо нарушения порядка."""
        scope={'asyncio':asyncio}
        function('plugins/platforms/telegram/adapter.py',['_flush_buffered'],scope)
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        photo=SimpleNamespace(source=source,message_id='86')
        text_event=SimpleNamespace(source=source,message_id='89')
        failed=asyncio.get_running_loop().create_future(); failed.set_exception(RuntimeError('synthetic failure'))
        held=[];received=[]
        async def idle(chat):pass
        async def handle(event):received.append(event)
        adapter=SimpleNamespace(_app=SimpleNamespace(update_processor=SimpleNamespace(wait_for_chat_idle=idle)),
            _should_drop_delayed_delivery=lambda:False, _hold_inbound_event=lambda event,**kw:held.append(event),
            _pending_photo_batches={'photo':photo},_pending_photo_batch_tasks={'photo':failed},
            _media_group_events={},_media_group_tasks={},handle_message=handle)
        pending={'text':text_event};tasks={}
        task=asyncio.create_task(scope['_flush_buffered'](adapter,pending,tasks,'text',0,'text'));tasks['text']=task
        with patch.dict(sys.modules,{'brai_files':native}):await asyncio.wait_for(task,2)
        self.assertEqual(held,[text_event])
        self.assertEqual(received,[])
        self.assertEqual(pending,{})

    async def test_actual_album_flush_holds_once_when_app_is_missing_or_dispatch_cancelled(self):
        """Teardown и отмена после pop сохраняют событие без отправки или двойного hold."""
        scope={'asyncio':asyncio}
        function('plugins/platforms/telegram/adapter.py',['_flush_buffered'],scope)
        for where,cancel in [('media-group',False),('media-group',True),('photo',False),('photo',True)]:
            with self.subTest(where=where,cancel_after_pop=cancel):
                entered=asyncio.Event();held=[]
                event=SimpleNamespace(source=SimpleNamespace(chat_id='1'))
                pending={'album':event};tasks={}
                async def wait(chat_id):pass
                async def handle(ev):
                    entered.set()
                    await asyncio.Event().wait()
                adapter=SimpleNamespace(_app=SimpleNamespace(update_processor=SimpleNamespace(wait_for_chat_idle=wait)) if cancel else None,
                    _should_drop_delayed_delivery=lambda:False,
                    _hold_inbound_event=lambda event,**kw:held.append(event),handle_message=handle)
                task=asyncio.create_task(scope['_flush_buffered'](adapter,pending,tasks,'album',0,'media-group'))
                tasks['album']=task
                if cancel:
                    await asyncio.wait_for(entered.wait(),2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):await task
                else:
                    await asyncio.wait_for(task,2)
                    self.assertFalse(entered.is_set())
                self.assertEqual(held,[event])
                self.assertEqual(pending,{})
                self.assertEqual(tasks,{})

    def edit_allowed(self, adapter, message):
        """Предоставить enum канала при проверке действующего runtime guard."""
        with patch.dict(sys.modules,{'gateway.platforms.event':module(MessageType=SimpleNamespace(TEXT='text'))}):
            return native.active_telegram_edit(adapter,message)

    def steering_runner(self, source, *, preparing=False):
        """Реальный steer движка; подменены только канальные и модельные порты."""
        scope = {'_ic_lock': lambda a, _: a._pending_steer_lock,
                 '_ic_slot': lambda a, _, name: getattr(a, name)}
        function('agent/interrupt_control.py', ['steer'], scope)
        agent = SimpleNamespace(_pending_steer=None, _pending_steer_lock=threading.Lock())
        agent.steer = MethodType(scope['steer'], agent)
        ctx = SimpleNamespace(source=source, inbound_message_id='initial', session_key='session')
        turn = SimpleNamespace(agent=agent, ctx=None if preparing else ctx, event=None, started_ts=1, busy_ack_ts=0)
        state = SimpleNamespace(turn=turn)
        runner = SimpleNamespace(_peek_session_state=lambda _:state, _session_state=lambda _:state,
            _is_user_authorized_for_source=lambda _:True, _admit_bot_message_for_source=lambda _:True,
            _steer_text_with_origin=lambda text,event:'message=' + str(event.message_id) + '\n' + text,
            _effective_busy_input_mode=lambda _:'interrupt', _draining=False,
            _delivery_adapter_for=lambda _:object(),
            _queue_or_replace_pending_event=lambda *a:self.fail('Unexpected next-turn queue'),
            _hm_merge_pending_for_source=lambda *a,**kw:self.fail('Unexpected next-turn merge'))
        if not preparing:
            native.bind_steer_turn(agent, runner, ctx)
        return runner, agent, turn, ctx

    async def _check_busy_entrypoint(self, primary):
        """Проверить поступление текста и файлов в один настоящий steer."""
        event = await self.album_event()
        event.internal = False
        event.allow_gateway_control = True
        event.message_type = 'photo'
        event.get_command = lambda:None
        runner,agent,turn,ctx = self.steering_runner(event.source)
        async def approval(*a):return False
        runner._route_plaintext_approval_while_busy = approval
        scope = {'MessageType':SimpleNamespace(TEXT='text')}
        path = 'gateway/run_busy.py' if primary else 'gateway/run_inbound.py'
        name = '_handle_active_session_busy_message' if primary else '_hm_busy_slash_or_photo'
        function(path,[name],scope)
        ports = {'brai_files':native,'gateway.run':module(_AGENT_PENDING_SENTINEL=object()),
                 'hermes_cli.commands':module(resolve_command=lambda _:None)}
        routing_spec=importlib.util.spec_from_file_location('real_image_routing',ENGINE/'agent/image_routing.py')
        routing=importlib.util.module_from_spec(routing_spec);routing_spec.loader.exec_module(routing)
        ports['agent.image_routing']=routing
        try:
            with patch.dict(sys.modules,ports):
                if primary:self.assertTrue(await scope[name](runner,event,'session'))
                else:self.assertEqual(await scope[name](runner,event,event.source,'session'),(True,None))
                self.assertTrue(event._gateway_accepted)
                guidance=SimpleNamespace(source=event.source,message_id='later',text='Уточнение маршрута',
                    media_urls=[],media_types=[],metadata={},internal=False)
                self.assertTrue(await native.steer_active_input(runner,guidance,'session'))
            payload=agent._pending_steer
            self.assertIn('Уточнение маршрута',payload)
            self.assertEqual(len(payload.images),2)
            self.assertTrue(all(p['image_url']['url'].startswith('data:image/png;base64,') for p in payload.images))
            content=native.steer_content(payload,'marker '+payload)
            self.assertEqual(len(content),3)
            self.assertIn('Уточнение маршрута',content[0]['text'])
            runner._session_key_for_source=lambda _:'session'
            self.assertTrue(self.edit_allowed(SimpleNamespace(gateway_runner=runner,
                _build_message_event=lambda *a:SimpleNamespace(source=event.source)),SimpleNamespace(message_id='later')))
            with self.store.db() as db:
                self.assertEqual(len(json.loads(db.execute('SELECT admitted FROM groups ORDER BY rowid LIMIT 1').fetchone()[0])),2)
            # Повтор тех же фото не добавляется к steer второй раз.
            with patch.dict(sys.modules,ports):
                self.assertTrue(await native.steer_active_input(runner,event,'session'))
            self.assertIs(agent._pending_steer,payload)
        finally:
            native.release_steer_inputs(agent)
            native.release_event(event)

    async def test_primary_busy_entrypoint_steers_text_and_images(self):
        await self._check_busy_entrypoint(True)

    async def test_secondary_busy_entrypoint_steers_text_and_images(self):
        await self._check_busy_entrypoint(False)

    async def test_single_photos_steer_immediately_after_artifacts_without_debounce(self):
        """Отдельные реальные фото после Artifacts сразу идут в steer, не ждут сборки."""
        template=await self.album_event()
        source=template.source
        paths=[]
        for i,value in enumerate(template.media_urls):
            path=self.input/('single-'+str(i)+'.png');path.write_bytes(Path(value).read_bytes());paths.append(str(path))
        native.release_event(template)
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        routing_spec=importlib.util.spec_from_file_location('real_image_routing',ENGINE/'agent/image_routing.py')
        routing=importlib.util.module_from_spec(routing_spec);routing_spec.loader.exec_module(routing)
        scope={};function('plugins/platforms/telegram/adapter.py',['_route_photo_event'],scope)
        adapter=SimpleNamespace(gateway_runner=runner,_drop_unresolved=lambda _:False,_accept_update=lambda:None,
            _pending_photo_batches={},_photo_batch_key=lambda *a:'unused',
            _enqueue_photo_event=lambda *a:self.fail('Ready photo entered debounce'),
            _queue_media_group_event=lambda *a:self.fail('Standalone photo became an album'))
        events=[SimpleNamespace(source=source,message_id=str(101+i),text='Подпись '+str(i),
            raw_message=SimpleNamespace(media_group_id=None),media_urls=[path],media_types=['image/png'],
            metadata={},internal=False) for i,path in enumerate(paths)]
        try:
            with patch.dict(sys.modules,{'brai_files':native,'agent.image_routing':routing}):
                before=sum(name=='files.publish' for name,_ in self.backend.calls)
                for i,event in enumerate(events):
                    await scope['_route_photo_event'](adapter,event.raw_message,event)
                    self.assertEqual(sum(name=='files.publish' for name,_ in self.backend.calls),before+i+1)
                    self.assertEqual(len(agent._pending_steer.images),i+1)
                    self.assertFalse(await native.capture_authorized(adapter,event))
                    self.assertTrue(event.metadata['_brai_steered'])
        finally:
            native.release_steer_inputs(agent)
            for event in events:native.release_event(event)

    async def test_real_album_is_assembled_before_one_multimodal_steer(self):
        """media_group_id удерживает пакет, готовый альбом передаётся в текущий ход один раз."""
        template=await self.album_event();source=template.source;paths=[]
        for i,value in enumerate(template.media_urls):
            path=self.input/('album-'+str(i)+'.png');path.write_bytes(Path(value).read_bytes());paths.append(str(path))
        native.release_event(template)
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        routing_spec=importlib.util.spec_from_file_location('real_image_routing',ENGINE/'agent/image_routing.py')
        routing=importlib.util.module_from_spec(routing_spec);routing_spec.loader.exec_module(routing)
        scope={};function('plugins/platforms/telegram/adapter.py',['_route_photo_event'],scope)
        collected=[]
        async def collect(group,event):collected.append(event)
        adapter=SimpleNamespace(gateway_runner=runner,_drop_unresolved=lambda _:False,
            _accept_update=lambda:None,_queue_media_group_event=collect)
        events=[SimpleNamespace(source=source,message_id=str(201+i),text='Подпись '+str(i),
            raw_message=SimpleNamespace(media_group_id='actual-album'),media_urls=[path],media_types=['image/png'],
            metadata={},internal=False) for i,path in enumerate(paths)]
        try:
            with patch.dict(sys.modules,{'brai_files':native,'agent.image_routing':routing}):
                for event in events:await scope['_route_photo_event'](adapter,event.raw_message,event)
                self.assertEqual(collected,events);self.assertIsNone(agent._pending_steer)
                self.assertEqual(len(turn._brai_preparing_inputs),1)
                self.assertFalse(next(iter(turn._brai_preparing_inputs.values())).is_set())
                # Настоящий native merge сохраняет состав и подписи целого пакета.
                merge={};function('plugins/platforms/telegram/adapter.py',['_merge_into_pending'],merge)
                adapter._merge_caption=lambda a,b:a+'\n'+b
                pending={}
                for event in collected:merge['_merge_into_pending'](adapter,pending,'album',event)
                album=pending['album']
                self.assertTrue(await native.steer_active_input(runner,album,'session'))
                self.assertEqual(len(agent._pending_steer.images),2)
                self.assertIn('Подпись 0',agent._pending_steer);self.assertIn('Подпись 1',agent._pending_steer)
                self.assertTrue(next(iter(turn._brai_preparing_inputs.values())).is_set())
        finally:
            native.release_steer_inputs(agent)
            for event in events:native.release_event(event)

    async def test_failed_artifact_publication_never_reaches_steer(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        event=SimpleNamespace(source=source,message_id='file',text='Документ',
            raw_message=SimpleNamespace(media_group_id=None),media_urls=[str(self.input_file())],
            media_types=['text/plain'],metadata={},internal=False)
        self.backend.fail_publish=True
        with self.assertRaises(FileError):
            await native.capture(SimpleNamespace(gateway_runner=runner),event)
        self.assertIsNone(agent._pending_steer)
        self.assertFalse(getattr(turn,'_brai_steer_events',[]))

    async def test_actual_text_handler_steers_without_text_debounce(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        event=SimpleNamespace(source=source,message_id='new-text',text='Уточнение',
            media_urls=[],media_types=[],metadata={},internal=False,get_command=lambda:None)
        async def noop(*a):return None
        async def build(*a):return event
        adapter=SimpleNamespace(gateway_runner=runner,_effective_update_message=lambda _:SimpleNamespace(text='Уточнение'),
            _is_user_authorized_from_message=lambda _:True,_gate_or_observe=lambda *a:True,
            _ensure_forum_commands=noop,_build_triggered_event=build,_accept_update=lambda:None,
            _enqueue_text_event=lambda _:self.fail('Busy text entered debounce'))
        scope={'MessageType':SimpleNamespace(TEXT='text')}
        function('plugins/platforms/telegram/adapter.py',['_handle_text_message'],scope)
        with patch.dict(sys.modules,{'brai_files':native}):
            await scope['_handle_text_message'](adapter,object(),None)
        self.assertIn('Уточнение',agent._pending_steer)
        native.clear_steer_turn(turn)

    async def test_media_reserves_current_turn_before_download_and_releases_on_cancel(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        msg=SimpleNamespace(caption=None,sticker=None,photo=None,voice=None,audio=None,video=None,
            document=object(),media_group_id=None)
        event=SimpleNamespace(source=source,message_id='downloading',raw_message=msg,metadata={})
        entered=asyncio.Event()
        async def download(*a):
            entered.set()
            await asyncio.Event().wait()
        adapter=SimpleNamespace(gateway_runner=runner,_is_user_authorized_from_message=lambda _:True,
            _should_process_message=lambda _:True,_media_message_type=lambda _:'document',
            _build_message_event=lambda *a,**kw:event,_apply_telegram_group_observe_attribution=lambda value:value,
            _cache_inbound_document=download)
        scope={};function('plugins/platforms/telegram/adapter.py',['_handle_media_message'],scope)
        with patch.dict(sys.modules,{'brai_files':native}):
            task=asyncio.create_task(scope['_handle_media_message'](adapter,SimpleNamespace(message=msg,update_id=1),None))
            await asyncio.wait_for(entered.wait(),2)
            self.assertFalse(next(iter(turn._brai_preparing_inputs.values())).is_set())
            self.assertFalse(agent._brai_steer_closed)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            self.assertTrue(next(iter(turn._brai_preparing_inputs.values())).is_set())
        native.clear_steer_turn(turn)

    async def test_adapter_guard_accepts_steer_before_gateway_claim(self):
        """Реальный guard занят, но медленный admission ещё не установил started_ts."""
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source,preparing=True)
        turn.started_ts=0;turn.agent=None
        runner._session_key_for_source=lambda _:'session'
        entered,unblock=asyncio.Event(),asyncio.Event()
        async def background(event,session_key):
            entered.set()
            await unblock.wait()
        scope={'asyncio':asyncio}
        function('gateway/platforms/base.py',['_start_session_processing','_track_session_task','_release_session_guard'],scope)
        adapter=SimpleNamespace(gateway_runner=runner,_active_sessions={},_session_tasks={},
            _background_tasks=set(),_expected_cancelled_tasks=set(),_process_message_background=background)
        for name in scope.keys() & {'_start_session_processing','_track_session_task','_release_session_guard'}:
            setattr(adapter,name,MethodType(scope[name],adapter))
        native.install_adapter(adapter)
        initial=SimpleNamespace(source=source,message_id='initial',text='Альбом',internal=False,
            metadata={},get_command=lambda:None)
        guidance=SimpleNamespace(source=source,message_id='later',text='Уточнение',internal=False,
            metadata={},media_urls=[],media_types=[])
        self.assertTrue(adapter._start_session_processing(initial,'session'))
        task=adapter._session_tasks['session']
        try:
            await asyncio.wait_for(entered.wait(),2)
            self.assertEqual(turn.started_ts,0)
            self.assertTrue(await native.steer_active_input(runner,guidance,'session'))
            self.assertTrue(self.edit_allowed(SimpleNamespace(gateway_runner=runner,
                _build_message_event=lambda *a:SimpleNamespace(source=source)),SimpleNamespace(message_id='later')))
            guidance.text='Уточнение после правки'
            guidance.raw_message=SimpleNamespace(edit_date=object())
            self.assertTrue(await native.steer_active_input(runner,guidance,'session'))
            file=SimpleNamespace(source=source,message_id='file',text='Документ',internal=False,
                metadata={},media_urls=[str(self.input_file())],media_types=['text/plain'],
                raw_message=SimpleNamespace(media_group_id=None))
            self.assertTrue(await native.capture(adapter,file))
            self.assertIsNone(agent._pending_steer)
            turn.started_ts=1;turn.event=initial
            with patch.dict(sys.modules,{'brai_files':native}):
                native.bind_steer_turn(agent,runner,ctx)
            self.assertIn('Уточнение после правки',agent._pending_steer)
            self.assertIn('новая редакция заменяет прежнюю',agent._pending_steer)
            self.assertIn('artifactId=',agent._pending_steer)
            self.assertFalse(self.edit_allowed(SimpleNamespace(gateway_runner=runner,
                _build_message_event=lambda *a:SimpleNamespace(source=source)),SimpleNamespace(message_id='old')))
        finally:
            unblock.set();await task
            adapter._release_session_guard('session')
            native.clear_steer_turn(turn)

    async def test_preclaim_guard_release_does_not_leak_inputs_to_next_turn(self):
        """Ошибка admission освобождает вход; старый guard не управляет следующим ходом."""
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source,preparing=True)
        turn.started_ts=0;turn.agent=None
        runner._session_key_for_source=lambda _:'session'
        scope={};function('gateway/platforms/base.py',['_release_session_guard'],scope)
        first,second=asyncio.Event(),asyncio.Event()
        adapter=SimpleNamespace(gateway_runner=runner,_active_sessions={'session':first})
        adapter._start_session_processing=lambda *a,**kw:True
        adapter._release_session_guard=MethodType(scope['_release_session_guard'],adapter)
        native.install_adapter(adapter)
        initial=SimpleNamespace(source=source,message_id='initial',internal=False,get_command=lambda:None)
        adapter._start_session_processing(initial,'session')
        event=SimpleNamespace(source=source,message_id='later',text='Уточнение',internal=False,
            metadata={},media_urls=[],media_types=[])
        self.assertTrue(await native.steer_active_input(runner,event,'session'))
        ready=native.reserve_steer_input(runner,event)
        self.assertFalse(ready.is_set())
        adapter._release_session_guard('session',guard=second)
        self.assertIsNotNone(native.active_steer_turn(runner,'session'))
        adapter._release_session_guard('session',guard=first)
        self.assertIsNone(native.active_steer_turn(runner,'session'))
        self.assertTrue(ready.is_set())
        self.assertTrue(await native.steer_active_input(runner,event,'session'))
        self.assertEqual(turn._brai_pending_steers,[])
        adapter._active_sessions['session']=second
        self.assertIsNone(native.active_steer_turn(runner,'session'))
        adapter._start_session_processing(initial,'session')
        with patch.dict(sys.modules,{'brai_files':native}):native.bind_steer_turn(agent,runner,ctx)
        self.assertIsNone(agent._pending_steer)
        native.clear_steer_turn(turn)

    def test_edit_lookup_uses_actual_telegram_route_in_forums_and_profiles(self):
        """Настоящие auth и input builders дают разные ключи форума; edit должен найти input."""
        platform=SimpleNamespace(TELEGRAM=SimpleNamespace(value='telegram'),WHATSAPP=object(),SLACK=object())
        scope={'Platform':platform,'MessageEvent':SimpleNamespace,'expand_link_entities':lambda m:m.text,
            '_session_key_namespace':lambda profile:'agent:'+(profile or 'main'),
            '_canonical_participant':lambda source:source.user_id}
        function('plugins/platforms/telegram/adapter.py',
            ['_source_from_message_for_auth','_build_message_event','_normalize_chat_type'],scope)
        function('gateway/session.py',['build_session_key'],scope)
        def source(**values):
            defaults={'profile':None,'prospective_thread_id':None,'scope_id':None,'user_id_alt':None}
            return SimpleNamespace(**{**defaults,**values})
        ports={'gateway.session':module(SessionSource=source),
            'gateway.platforms.base':module(resolve_channel_prompt=lambda *a:None),
            'plugins.platforms.telegram.telegram_context':module(group_identity_prompt=lambda *a:None)}
        cases=[('supergroup',True,1312,True,None),('supergroup',True,None,False,None),
            ('supergroup',True,1312,True,'secondary'),('private',False,None,False,None),
            ('private',False,7,True,None),('group',False,None,False,None)]
        for chat_type,is_forum,thread,is_topic,profile in cases:
            with self.subTest(chat_type=chat_type,thread=thread,profile=profile),patch.dict(sys.modules,ports):
                message=SimpleNamespace(chat=SimpleNamespace(id=-10042,type=chat_type,is_forum=is_forum,title='Test'),
                    from_user=SimpleNamespace(id=2,is_bot=False,username='test',full_name='Test'),
                    message_thread_id=thread,is_topic_message=is_topic,message_id=1455,text='Цвет: зелёный',date=None)
                adapter=SimpleNamespace(config=SimpleNamespace(extra={}),_chat_type_str=lambda chat:chat.type,
                    _effective_message_thread_id=lambda m:str(m.message_thread_id or 1) if m.chat.is_forum
                        else str(m.message_thread_id) if m.is_topic_message and m.message_thread_id is not None else None,
                    _resolve_topic_binding=lambda *a:(None,None),_reply_context=lambda m:(None,None),
                    build_source=lambda **kw:source(platform=platform.TELEGRAM,profile=profile,**kw))
                adapter._normalize_chat_type=scope['_normalize_chat_type']
                for name in ['_source_from_message_for_auth','_build_message_event']:
                    setattr(adapter,name,MethodType(scope[name],adapter))
                initial=adapter._build_message_event(message,'text')
                key=lambda value:scope['build_session_key'](value,profile=value.profile)
                route=key(initial.source)
                runner,agent,turn,ctx=self.steering_runner(initial.source)
                state=SimpleNamespace(turn=turn)
                runner._peek_session_state=lambda candidate:state if candidate==route else None
                runner._session_key_for_source=key
                turn._brai_input_ids.add(native._steer_identity(initial.source,message.message_id))
                adapter.gateway_runner=runner
                self.assertTrue(self.edit_allowed(adapter,message))
                message.message_id=999
                self.assertFalse(self.edit_allowed(adapter,message))
                message.message_id=1455;message.from_user.id=3
                self.assertFalse(self.edit_allowed(adapter,message))
                message.from_user.id=2;agent._brai_steer_closed=True
                self.assertFalse(self.edit_allowed(adapter,message))
                native.clear_steer_turn(turn)

    async def test_input_during_agent_preparation_is_steered_before_final(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source,preparing=True)
        event=SimpleNamespace(source=source,message_id='later',text='Новое условие',
            media_urls=[],media_types=[],metadata={},internal=False)
        self.assertTrue(await native.steer_active_input(runner,event,'session'))
        self.assertTrue(event._gateway_accepted)
        self.assertIsNone(agent._pending_steer)
        with patch.dict(sys.modules,{'brai_files':native}):native.bind_steer_turn(agent,runner,ctx)
        self.assertIn('Новое условие',agent._pending_steer)
        scope={};function('agent/turn_iteration_prep.py',['_inject_steer_after_newest_tool_result'],scope)
        messages=[{'role':'user','content':'Исходное поручение'}]
        ports={'agent.prompt_builder':module(steer_user_row=lambda text:{'role':'user','content':text}),
            'agent.message_metadata':module(append_message=lambda rows,row:rows.append(row))}
        with patch.dict(sys.modules,ports):
            scope['_inject_steer_after_newest_tool_result'](agent,messages,agent._pending_steer)
        self.assertIn('Новое условие',messages[-1]['content'])
        native.clear_steer_turn(turn)

    async def test_durable_steer_receipt_prevents_repeated_input(self):
        """Реальный worker и SQLite возвращают квитанцию без повторного steer."""
        from identity.worker import Worker
        from identity.delivery_journal import DeliveryJournal, delivery_id
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        event=SimpleNamespace(source=source,message_id='later',text='Уточнение',
            media_urls=[],media_types=[],metadata={},internal=False,_gateway_accepted=False)
        worker=Worker.__new__(Worker)
        worker.user_id='owner';worker.active={'turn':object()}
        worker.delivery_lock=asyncio.Lock()
        worker.delivery_journal=DeliveryJournal(self.root/'delivery.sqlite3','owner')
        calls=[]
        async def dispatch(event,owner):
            calls.append(event.message_id)
            await native.steer_active_input(runner,event,'session')
            # Такой receipt возвращает _dispatch_native после busy handler.
            return {'accepted':event._gateway_accepted,'turn_id':'turn'}
        worker._dispatch_native=dispatch
        ident,digest=delivery_id('input'),delivery_id('bytes')
        with patch.dict(sys.modules,{'brai_files':native}):
            first=await worker.dispatch(event,'owner',ident,digest)
            self.assertTrue(first['accepted'])
            pending=agent._pending_steer
            second=await worker.dispatch(event,'owner',ident,digest)
        self.assertEqual(second,first)
        self.assertEqual(calls,['later'])
        self.assertIs(agent._pending_steer,pending)
        self.assertEqual(worker.delivery_journal.input_status(ident,digest)['state'],'accepted')
        native.clear_steer_turn(turn)

    async def test_slow_voice_after_completed_turn_is_returned_to_native_queue(self):
        """A completed prior turn must not turn already echoed STT into not_received."""
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        event=SimpleNamespace(source=source,message_id='voice-1',text='',internal=False,
            metadata={},media_urls=['/voice.ogg'],media_types=['audio/ogg'],_gateway_accepted=False)
        started,finish=asyncio.Event(),asyncio.Event()
        calls=[]
        async def transcribe(value):
            calls.append('stt');started.set();await finish.wait()
            value._gateway_pending_stt_text='"голосовой запрос"'
            value._gateway_pending_stt_transcripts=['голосовой запрос']
            value._gateway_pending_stt_echoed=1
            return value._gateway_pending_stt_text
        async def accept(_):return True
        runner._pending_event_audio_paths=lambda _:['/voice.ogg']
        runner._prepare_busy_steer_text=transcribe
        with patch.object(native,'accept_event',accept), patch.object(native,'release_event') as release:
            task=asyncio.create_task(native.steer_active_input(runner,event,'session'))
            await started.wait()
            runner._peek_session_state=lambda _:None
            finish.set()
            self.assertFalse(await task)
            release.assert_not_called()
        self.assertEqual(calls,['stt'])
        self.assertEqual(event._gateway_pending_stt_transcripts,['голосовой запрос'])
        self.assertEqual(event._gateway_pending_stt_echoed,1)
        self.assertFalse(event._gateway_accepted)
        native.clear_steer_turn(turn)

    async def test_rejected_stale_reservation_releases_original_waiter(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        original_turn=SimpleNamespace()
        ready=threading.Event()
        event=SimpleNamespace(source=source,message_id='voice-1',internal=False,
                              _brai_preparation=(original_turn,object(),ready))
        with patch.object(native,'release_event') as release:
            self.assertTrue(await native.steer_active_input(runner,event,'session'))
        self.assertTrue(ready.is_set())
        release.assert_called_once_with(event)
        native.clear_steer_turn(turn)

    async def test_voice_turn_finishes_during_stt_does_not_retranscribe_delivery(self):
        """A transport retry of one delivery must not launch STT and echo twice."""
        from identity.worker import Worker
        from identity.delivery_journal import DeliveryJournal, delivery_id
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        first_runner,first_agent,first_turn,_=self.steering_runner(source)
        next_runner,next_agent,next_turn,_=self.steering_runner(source)
        runners=[first_runner]
        started,finish=asyncio.Event(),asyncio.Event()
        calls=[]
        async def transcribe(value):
            calls.append(value.message_id)
            if len(calls)==1:
                started.set()
                await finish.wait()
            value._gateway_pending_stt_text='voice request'
            value._gateway_pending_stt_transcripts=['voice request']
            value._gateway_pending_stt_echoed=1
            return value._gateway_pending_stt_text
        for runner in (first_runner,next_runner):
            runner._pending_event_audio_paths=lambda _:['/voice.ogg']
            runner._prepare_busy_steer_text=transcribe
        def event():
            return SimpleNamespace(source=source,message_id='same-update',text='',internal=False,
                metadata={},media_urls=['/voice.ogg'],media_types=['audio/ogg'],_gateway_accepted=False)
        async def accepted(_):return True
        async def capture(_adapter, _event):
            return True  # This case covers receipts. The next case uses real file capture.
        worker=Worker.__new__(Worker)
        worker.user_id='owner';worker.active={'turn':object()}
        worker.delivery_lock=asyncio.Lock()
        worker.delivery_journal=DeliveryJournal(self.root/'voice-delivery.sqlite3','owner')
        def start_prepared(value, _):
            self.assertEqual(value._gateway_pending_stt_transcripts,['voice request'])
            self.assertEqual(value._gateway_pending_stt_echoed,1)
            return True
        target=SimpleNamespace(_message_handler=True,_drop_unresolved=lambda _:False,
            _event_session_key=lambda _:'session',_active_sessions={},_start_session_processing=start_prepared)
        handle=function('gateway/platforms/base.py',['handle_message'],{})['handle_message']
        async def dispatch(value,owner):
            if not await native.steer_active_input(runners[0],value,'session'):
                value.allow_gateway_control=False
                await handle(target,value)
            return {'accepted':value._gateway_accepted,'turn_id':'turn' if value._gateway_accepted else None}
        worker._dispatch_native=dispatch
        ident,digest=delivery_id('voice-update'),delivery_id('voice-payload')
        with patch.dict(sys.modules,{'brai_files':native}), patch.object(native,'accept_event',accepted), \
                patch.object(native,'capture_authorized',capture), patch.object(native,'release_event'):
            task=asyncio.create_task(worker.dispatch(event(),'owner',ident,digest))
            await started.wait()
            first_runner._peek_session_state=lambda _:None
            finish.set()
            receipt=await task
            if not receipt['accepted']:
                runners[0]=next_runner
                receipt=await worker.dispatch(event(),'owner',ident,digest)
            self.assertEqual(await worker.dispatch(event(),'owner',ident,digest),receipt)
        self.assertTrue(receipt['accepted'])
        self.assertEqual(calls,['same-update'])
        native.clear_steer_turn(first_turn)
        native.clear_steer_turn(next_turn)

    async def test_voice_capture_retry_preserves_one_stt_and_file_ownership(self):
        """Exercise real file capture and worker receipt at the stale-voice boundary."""
        from identity.worker import Worker
        from identity.delivery_journal import DeliveryJournal, delivery_id
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2',profile=None)
        first,agent,turn,_=self.steering_runner(source)
        next_runner,next_agent,next_turn,_=self.steering_runner(source)
        path=self.input/'voice.ogg'
        path.write_bytes(b'OggS test voice')
        started,finish=asyncio.Event(),asyncio.Event()
        calls=[]
        async def transcribe(value):
            calls.append(value.message_id)
            if len(calls)==1:
                started.set()
                await finish.wait()
            value._gateway_pending_stt_text='voice request'
            value._gateway_pending_stt_transcripts=['voice request']
            value._gateway_pending_stt_echoed=1
            return value._gateway_pending_stt_text
        adapter=SimpleNamespace(gateway_runner=first,_accept_update=lambda:None)
        for runner in (first,next_runner):
            runner._session_key_for_source=lambda _:'session'
            runner._pending_event_audio_paths=lambda _:['/voice.ogg']
            runner._prepare_busy_steer_text=transcribe
            runner._delivery_adapter_for=lambda _:adapter
        def event():
            return SimpleNamespace(source=source,message_id='same-update',text='',internal=False,
                raw_message=SimpleNamespace(media_group_id=None), metadata={}, media_urls=[str(path)],
                media_types=['audio/ogg'],_gateway_accepted=False)
        worker=Worker.__new__(Worker)
        worker.user_id='owner';worker.active={'turn':object()}
        worker.delivery_lock=asyncio.Lock()
        worker.delivery_journal=DeliveryJournal(self.root/'voice-capture.sqlite3','owner')
        def start_prepared(value, _):
            self.assertIsNone(value._brai_preparation)
            self.assertEqual(value._gateway_pending_stt_echoed,1)
            self.assertTrue(value._brai_capture_leases)
            self.assertEqual(len(value.metadata['_brai_artifacts']),1)
            native.release_event(value)
            return True
        adapter._message_handler=True
        adapter._drop_unresolved=lambda _:False
        adapter._event_session_key=lambda _:'session'
        adapter._active_sessions={}
        adapter._start_session_processing=start_prepared
        handle=function('gateway/platforms/base.py',['handle_message'],{})['handle_message']
        async def dispatch(value,owner):
            if await native.capture_authorized(adapter,value):
                value.allow_gateway_control=False
                await handle(adapter,value)
            return {'accepted':value._gateway_accepted,'turn_id':'turn' if value._gateway_accepted else None}
        worker._dispatch_native=dispatch
        ident,digest=delivery_id('voice-capture'),delivery_id('voice-bytes')
        with patch.dict(sys.modules,{'brai_files':native}):
            task=asyncio.create_task(worker.dispatch(event(),'owner',ident,digest))
            await started.wait()
            first._peek_session_state=lambda _:None
            finish.set()
            receipt=await task
            if not receipt['accepted']:
                adapter.gateway_runner=next_runner
                receipt=await worker.dispatch(event(),'owner',ident,digest)
            self.assertEqual(await worker.dispatch(event(),'owner',ident,digest),receipt)
        try:
            self.assertTrue(receipt['accepted'])
            self.assertEqual(calls,['same-update'])
        finally:
            native.clear_steer_turn(turn)
            native.clear_steer_turn(next_turn)

    async def test_slow_voice_does_not_restart_after_stop_or_changed_chat_generation(self):
        for cause in ('stop','chat_generation'):
            with self.subTest(cause=cause):
                source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
                runner,agent,turn,ctx=self.steering_runner(source)
                event=SimpleNamespace(source=source,message_id='voice-1',text='',internal=False,
                    metadata={},media_urls=['/voice.ogg'],media_types=['audio/ogg'],_gateway_accepted=False)
                started,finish=asyncio.Event(),asyncio.Event()
                async def transcribe(value):
                    started.set();await finish.wait()
                    value._gateway_pending_stt_text='"голосовой запрос"'
                    value._gateway_pending_stt_transcripts=['голосовой запрос']
                    value._gateway_pending_stt_echoed=1
                    return value._gateway_pending_stt_text
                async def accept(_):return True
                runner._pending_event_audio_paths=lambda _:['/voice.ogg']
                runner._prepare_busy_steer_text=transcribe
                runner._brai_consent_route_current=lambda _:cause!='chat_generation'
                with patch.object(native,'accept_event',accept), patch.object(native,'release_event') as release:
                    task=asyncio.create_task(native.steer_active_input(runner,event,'session'))
                    await started.wait()
                    runner._peek_session_state=lambda _:None
                    if cause=='stop':agent._interrupt_requested=True
                    finish.set()
                    self.assertTrue(await task)
                    release.assert_called_once_with(event)
                self.assertTrue(event._gateway_accepted)
                native.clear_steer_turn(turn)

    async def test_source_replay_is_accepted_without_repeating_steer_but_edits_survive(self):
        """Новый transport ID не обходит source dedup; новые сообщения и редакции остаются."""
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        accepted=[]
        def event(message_id,text):
            return SimpleNamespace(source=source,message_id=message_id,text=text,media_urls=[],
                media_types=[],metadata={},internal=False,_gateway_accepted=False)
        with patch.dict(sys.modules,{'brai_files':native}):
            for message_id,text in [('later','Да'),('later','Да'),('new','Да'),
                                    ('later','Нет'),('later','Да')]:
                value=event(message_id,text)
                self.assertTrue(await native.steer_active_input(runner,value,'session'))
                self.assertTrue(value._gateway_accepted)
                if agent._pending_steer is not None:
                    accepted.append((message_id,text))
                    agent._pending_steer=None
        self.assertEqual(accepted,[('later','Да'),('new','Да'),('later','Нет'),('later','Да')])
        native.clear_steer_turn(turn)
        self.assertEqual(turn._brai_steer_revisions,{})

    async def test_original_input_replay_and_uncommitted_final_deltas_are_suppressed(self):
        """Исходный input известен до первого API, черновые delta не доходят до транспорта."""
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        initial=SimpleNamespace(source=source,message_id='initial',text='Поручение',
            media_urls=[],metadata={},internal=False,_gateway_accepted=False)
        turn.event=initial
        deltas=[];commentary=[]
        agent.stream_delta_callback=deltas.append
        agent.interim_assistant_callback=commentary.append
        native.bind_steer_turn(agent,runner,ctx)
        for candidate in ['Черновик до уточнения','Другой черновик']:
            if agent.stream_delta_callback is not None:
                agent.stream_delta_callback(candidate)
        self.assertEqual(deltas,[])
        agent.interim_assistant_callback('Проверяю документ')
        self.assertEqual(commentary,['Проверяю документ'])
        with patch.dict(sys.modules,{'brai_files':native}):
            self.assertTrue(await native.steer_active_input(runner,initial,'session'))
        self.assertTrue(initial._gateway_accepted)
        self.assertIsNone(agent._pending_steer)
        native.clear_steer_turn(turn)

    def test_steer_revision_uses_published_media_identity_not_download_path(self):
        """Стабильные вложения сравниваются по artifact ID и сохраняют порядок."""
        def event(paths,ids):
            return SimpleNamespace(text='Подпись',media_urls=paths,
                metadata={'_brai_artifacts':[{'file':{'artifactId':ident}} for ident in ids]})
        original=native._steer_revision(event(['/copy/one','/copy/two'],['one','two']))
        self.assertEqual(original,native._steer_revision(event(['/new/one','/new/two'],['one','two'])))
        self.assertNotEqual(original,native._steer_revision(event(['/copy/two','/copy/one'],['two','one'])))
        self.assertIsNone(native._steer_revision(event(['/unpublished'],[])))

    def test_telegram_does_not_start_provisional_streaming_tts(self):
        """Отдельная commentary не может занять доставку ещё не принятого голосового финала."""
        scope={}
        function('gateway/run_turn.py',['_run_agent_start_streaming_tts'],scope)
        runner=SimpleNamespace(_delivery_adapter_for=lambda _:
            self.fail('Telegram must retain the whole-file final voice path'))
        holder=[None]
        scope['_run_agent_start_streaming_tts'](runner,
            SimpleNamespace(platform=SimpleNamespace(value='telegram')),'voice',{},holder)
        self.assertEqual(holder,[None])

    def test_late_steer_defers_actual_final_response_without_persisting_a_draft(self):
        """Реальный finish_text_response возвращает continue, затем ровно один финал."""
        from dataclasses import make_dataclass
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        fields=['action','active_system_prompt','final_response','_turn_exit_reason','_preflight_compression_blocked',
            'codex_ack_continuations','truncated_response_parts','length_continue_retries',
            '_pending_verification_response','_pending_verification_response_previewed','api_call_count','result']
        scope={'logger':__import__('logging').getLogger('steer-test'), 'FinalResponseVerdict':make_dataclass('Verdict',[(n,object) for n in fields]),
            'answer_in_reasoning_capability':lambda _:False,'STOP_PATH_MIN_CHARS':10000,
            'is_runaway_repetition':lambda _:False,'_EPHEMERAL_SCAFFOLDING_FLAGS':(),
            'append_message':lambda messages,row:messages.append(row),
            'apply_stop_gates':lambda *a,**kw:SimpleNamespace(continue_turn=False,
                pending_verification_response=None,pending_verification_response_previewed=False)}
        function('agent/turn_final_response.py',['finish_text_response'],scope)
        prompt={'format_steer_marker':lambda text:'STEER:'+text,'STEER_DISPLAY_KIND':'steer'}
        function('agent/prompt_builder.py',['steer_user_row'],prompt)
        helpers=module(intent_ack_continuation_mode=lambda _:'off',looks_like_degenerate_final=lambda *a,**kw:False,
            promoted_reasoning_announces_action=lambda _:False,tool_results_this_turn=lambda _:0,
            trailing_continue_intent=lambda _:False)
        ports={'brai_files':native,'agent.prompt_builder':module(steer_user_row=prompt['steer_user_row']),
            'agent.message_metadata':module(append_message=scope['append_message']),
            'agent.conversation_loop':module(_CODEX_ACK_CONTINUATION_NUDGE='',_DEGENERATE_FINAL_NUDGE='',
                _DROPPED_TOOLCALL_NUDGE_CONTENT='',_join_truncated_parts=lambda _:''),
            'agent.agent_runtime_helpers':helpers,
            'agent.turn_finalizer':module(apply_llm_output_transform=lambda a,text,**kw:(text,False,None))}
        agent._has_content_after_think_block=lambda _:True
        agent._emit_pending_fallback_notice=agent._clear_status_buffer=lambda:None
        agent._strip_think_blocks=lambda text:text
        agent._build_assistant_message=lambda message,reason:{'role':'assistant','content':message.content}
        agent._flush_messages_to_session_db=lambda *a:None
        agent.quiet_mode=True;agent.valid_tool_names=set()
        kwargs=dict(assistant_message=SimpleNamespace(content='Общий ответ',tool_calls=[]),response=None,
            finish_reason='stop',messages=[],api_messages=[],conversation_history=[],api_call_count=1,
            user_message='Исходное поручение',active_system_prompt='',final_response=None,_turn_exit_reason='',
            _preflight_compression_blocked=False,codex_ack_continuations=0,truncated_response_parts=[],
            length_continue_retries=0,_pending_verification_response=None,
            _pending_verification_response_previewed=False,effective_task_id='task')
        with patch.dict(sys.modules,ports):
            self.assertTrue(agent.steer('Позднее уточнение'))
            first=scope['finish_text_response'](agent,**kwargs)
            self.assertEqual(first.action,'continue');self.assertIsNone(first.final_response)
            self.assertEqual([row['role'] for row in kwargs['messages']],['user'])
            second=scope['finish_text_response'](agent,**kwargs)
            self.assertEqual(second.action,'break')
            self.assertEqual([row['role'] for row in kwargs['messages']],['user','assistant'])
            self.assertFalse(agent.steer('После фиксации финала'))
        native.clear_steer_turn(turn)

    @patch.dict(sys.modules, {'brai_files':native})
    def test_dialogues_finish_fences_steer_until_the_receipt(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        _runner,agent,turn,_ctx=self.steering_runner(source)
        def complete():
            self.assertFalse(agent.steer('После начала finish'))
            return 'completed'
        self.assertTrue(agent.steer('До начала finish'))
        self.assertIn('STEER_PENDING',native.dialogues_finish(agent,complete,lambda _result:False))
        agent._pending_steer=None
        self.assertEqual(native.dialogues_finish(agent,lambda:'rejected',lambda _result:True),'rejected')
        self.assertTrue(agent.steer('После отказа finish'))
        agent._pending_steer=None
        self.assertEqual(native.dialogues_finish(agent,lambda:'timeout',lambda _result:False),'timeout')
        self.assertFalse(agent.steer('После неясного исхода'))
        self.assertEqual(native.dialogues_finish(agent,complete,lambda _result:False),'completed')
        self.assertFalse(agent.steer('После квитанции'))
        native.clear_steer_turn(turn)

    async def test_two_dialogues_steers_keep_original_text_and_individual_ids(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,_ctx=self.steering_runner(source)
        runner._steer_text_with_origin=lambda text,event: 'Origin\n'+json.dumps({'message_id':event.message_id})+'\n\n'+text
        with patch.dict(sys.modules, {'brai_files':native}), patch.dict(os.environ, BRAI_DIALOGUES_REQUIRED='1'):
            for ident,text in [('one','  Первое\n'),('two','\nВторое  ')]:
                event=SimpleNamespace(source=source,message_id=ident,text=text+' (https://example.org)',
                                      _brai_original_text=text,media_urls=[],media_types=[],metadata={})
                self.assertTrue(await native.steer_active_input(runner,event,'session'))
        payloads=[json.loads(line) for line in agent._pending_steer.splitlines() if line.startswith('{"id":')]
        self.assertEqual(payloads,[{'id':'one','text':'  Первое\n'},{'id':'two','text':'\nВторое  '}])
        native.clear_steer_turn(turn)

    def test_edits_belong_to_exact_active_turn_and_sender(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        turn.event=SimpleNamespace(source=source,message_id='initial')
        adapter=SimpleNamespace(gateway_runner=runner,_build_message_event=lambda *a:SimpleNamespace(source=source))
        self.assertTrue(self.edit_allowed(adapter,SimpleNamespace(message_id='initial')))
        self.assertFalse(self.edit_allowed(adapter,SimpleNamespace(message_id='old')))
        foreign=SimpleNamespace(**{**vars(source),'user_id':'another'})
        adapter._build_message_event=lambda *a:SimpleNamespace(source=foreign)
        self.assertFalse(self.edit_allowed(adapter,SimpleNamespace(message_id='initial')))
        adapter._build_message_event=lambda *a:SimpleNamespace(source=source)
        agent._brai_steer_closed=True
        self.assertFalse(self.edit_allowed(adapter,SimpleNamespace(message_id='initial')))
        native.clear_steer_turn(turn)
        self.assertFalse(turn._brai_input_ids)

    async def test_final_waits_for_an_accepted_album_and_stop_releases_waiter(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        event=SimpleNamespace(source=source,message_id='album-item',raw_message=SimpleNamespace(media_group_id='album'))
        ready=native.reserve_steer_input(runner,event)
        ports={'agent.prompt_builder':module(steer_user_row=lambda text:{'role':'user','content':text}),
            'agent.message_metadata':module(append_message=lambda rows,row:rows.append(row)), 'brai_files':native}
        with patch.dict(sys.modules,ports):
            messages=[]
            result=asyncio.create_task(asyncio.to_thread(native.continue_final_steer,agent,messages))
            await asyncio.sleep(0.03)
            self.assertFalse(result.done());self.assertFalse(agent._brai_steer_closed)
            self.assertTrue(agent.steer('Готовый альбом'))
            ready.set()
            self.assertTrue(await asyncio.wait_for(result,2))
            self.assertEqual(messages[-1]['content'],'Готовый альбом')
            # Новая генерация не принимает отложенный вход прежнего хода.
            old_generation=turn._brai_steer_generation
            native.clear_steer_turn(turn)
            self.assertIsNot(turn._brai_steer_generation,old_generation)
            self.assertFalse(native.continue_final_steer(agent,[]))

    async def test_actual_gateway_rewrite_releases_original_and_replaced_event(self):
        """dataclasses.replace не теряет cleanup при успехе, ошибке и отмене."""
        @dataclasses.dataclass
        class Event:
            source: object
            message_id: str
            text: str
            metadata: dict
            media_urls: list
            media_types: list
            raw_message: object
        scope={'dataclasses':dataclasses}
        function('gateway/run_inbound.py',['_handle_message','_hm_pre_gateway_dispatch_hook'],scope)
        async def hook(*args,**kwargs):return [{'action':'rewrite','text':'rewritten caption'}]
        ports={'brai_files':native,'hermes_cli.lifecycle':module(ainvoke_hook=hook)}
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        for index,phase in enumerate(['success','failure','cancel']):
            with self.subTest(phase=phase),patch.dict(sys.modules,ports):
                original=Event(source,str(30+index),'caption',{},[str(self.input_file())],['text/plain'],
                    SimpleNamespace(media_group_id='rewrite-'+phase))
                adapter=SimpleNamespace(gateway_runner=SimpleNamespace(_is_user_authorized_for_source=lambda s:True))
                await native.capture(adapter,original)
                rewritten=[]
                async def handle(event):
                    changed=await scope['_hm_pre_gateway_dispatch_hook'](runner,event,event.source)
                    self.assertIsNot(changed,event)
                    rewritten.append(changed)
                    native.track_inbound(changed)
                    await native.accept_event(changed)
                    with self.store.db() as db:self.assertGreater(db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)
                    if phase=='failure':raise RuntimeError('synthetic failed turn')
                    if phase=='cancel':raise asyncio.CancelledError()
                    return 'ok'
                runner=SimpleNamespace(_brai_handle_message=handle)
                call=scope['_handle_message'](runner,original)
                if phase=='failure':
                    with self.assertRaisesRegex(RuntimeError,'synthetic failed turn'):await call
                elif phase=='cancel':
                    with self.assertRaises(asyncio.CancelledError):await call
                else:
                    self.assertEqual(await call,'ok')
                self.assertIsNone(rewritten[0]._brai_file_lease)
                self.assertEqual(original._brai_capture_leases,[])
                self.assertIsNone(native._event_cleanup.get())
                with self.store.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)

    async def test_actual_queued_followup_releases_files_without_parent_scope_or_gc(self):
        """Реальный recursive followup восстанавливает ID и закрывает lease, пока event жив."""
        scope={'asyncio':asyncio,'suppress':suppress,
            'logger':SimpleNamespace(debug=lambda *a,**kw:None),
            'display_kind_for_event':lambda e:'file','reply_expected_metadata':lambda e:{},
            'diagnostic_metadata':lambda e:{},'ProcessingOutcome':SimpleNamespace(SUCCESS='ok',FAILURE='failed')}
        function('gateway/run_turn.py',['_run_agent_queued_followup','_brai_run_agent_queued_followup'],scope)
        async def noop(*args,**kwargs):pass
        ports={'brai_files':native,
            'gateway.platforms.base':module(merge_pending_message_event=lambda *a:None),
            'gateway.run':module(_preserve_queued_followup_history_offset=lambda a,b:b),
            'gateway.run_inbound':module(strip_discord_triggering_note=lambda e,t:t),
            'gateway.run_turn_followup_ack':module(_run_followup_processing_hook=noop,_followup_cancel_outcome=lambda a:'cancel')}
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id=None,user_id='2',profile=None)
        for index,phase in enumerate(['success','failure','cancel']):
            with self.subTest(phase=phase),patch.dict(sys.modules,ports):
                event=SimpleNamespace(source=source,message_id=str(70+index),text='queued caption',
                    media_urls=[str(self.input_file())],media_types=['text/plain'],metadata={},
                    raw_message=SimpleNamespace(media_group_id='queued-'+phase),
                    reply_expected=True,channel_prompt=None,internal=False,message_type='document')
                adapter=SimpleNamespace(gateway_runner=SimpleNamespace(_is_user_authorized_for_source=lambda s:True))
                # Первоначальный busy handler уже закончил свой scope, event остаётся в очереди.
                with native.inbound_events(event):await native.capture(adapter,event)
                self.assertIsNone(native._event_cleanup.get())
                async def prepare(**kwargs):
                    self.assertTrue(await native.accept_event(kwargs['event']))
                    return kwargs['event'].text
                async def run(**kwargs):
                    with self.store.db() as db:self.assertGreater(db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)
                    if phase=='failure':raise RuntimeError('synthetic queued failure')
                    if phase=='cancel':raise asyncio.CancelledError()
                    return {'final_response':'done'}
                runner=SimpleNamespace(_MAX_INTERRUPT_DEPTH=5,_is_goal_continuation_event=lambda e:False,
                    _session_key_for_source=lambda s:'session',_prepare_profile_scoped_inbound_message_text=prepare,
                    _reply_anchor_for_event=lambda e:None,_pinned_channel_inputs=lambda k,p,s,**kw:(p,s),
                    _persist_prompt_pins=noop,_delivery_adapter_for=lambda s:None,_intake_adapter_for=lambda s:None,
                    _refresh_agent_cache_message_count=noop,_run_agent_deliver_first_response=noop,_run_agent=run)
                runner._brai_run_agent_queued_followup=MethodType(scope['_brai_run_agent_queued_followup'],runner)
                ctx=SimpleNamespace(source=source,session_id='session',session_key='session',run_generation=1,
                    _interrupt_depth=0,history=[],_status_thread_metadata=None,context_prompt='context')
                call=scope['_run_agent_queued_followup'](runner,ctx,adapter,'queued',event,'first',{'messages':[]},None)
                if phase=='failure':
                    with self.assertRaisesRegex(RuntimeError,'synthetic queued failure'):await call
                elif phase=='cancel':
                    with self.assertRaises(asyncio.CancelledError):await call
                else:
                    self.assertEqual((await call)['final_response'],'done')
                # Ссылка event всё ещё удерживается этим тестом: GC не может скрыть утечку.
                self.assertIsNone(event._brai_file_lease)
                self.assertIsNone(native._event_cleanup.get())
                with self.store.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM leases').fetchone()[0],0)

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

    def test_pinned_telegram_hides_bare_urls_in_rich_and_markdown_output(self):
        scope = {'re': re, '_MDV2_ESCAPE_RE': re.compile(r'([_*\[\]()~`>#\+\-=|{}.!\\])'),
                 '_wrap_markdown_tables': lambda value: value, '_rich_normalize_linebreaks': lambda value: value}
        function('plugins/platforms/telegram/adapter.py',
                 ['_brai_hide_bare_urls', '_escape_mdv2', '_escape_bare_bracket', 'format_message', '_rich_message_payload'], scope)
        scope['TelegramAdapter'] = SimpleNamespace(_escape_bare_bracket=scope['_escape_bare_bracket'])
        source = '# Источники\n[Название](https://example.org/a) и https://example.org/b. `https://example.org/code`'
        rich = scope['_rich_message_payload'](None, source)['markdown']
        formatted = scope['format_message'](None, source)
        self.assertIn('[Название](https://example.org/a)', rich)
        self.assertIn('[Ссылка](https://example.org/b).', rich)
        self.assertIn('[Название](https://example.org/a)', formatted)
        self.assertIn('[Ссылка](https://example.org/b)', formatted)
        self.assertIn('`https://example.org/code`', rich)
        self.assertIn('`https://example.org/code`', formatted)
        self.assertTrue(formatted.startswith('*Источники*'))

    async def test_pinned_telegram_never_retries_raw_text_after_format_rejection(self):
        async def deadline(value, **kwargs):
            return await value
        class Bot:
            def __init__(self):
                self.calls = []
            async def send_message(self, **kwargs):
                self.calls.append(kwargs)
                raise ValueError('cannot parse entities')
        bot = Bot()
        scope = {'_await_with_thread_deadline': deadline, '_TEXT_SEND_DEADLINE': 1,
                 'ParseMode': SimpleNamespace(MARKDOWN_V2='MarkdownV2')}
        function('plugins/platforms/telegram/adapter.py', ['_send_chunk_markdown_or_plain'], scope)
        with self.assertRaisesRegex(ValueError, 'cannot parse'):
            await scope['_send_chunk_markdown_or_plain'](SimpleNamespace(_bot=bot), '*formatted*', {'chat_id': 1})
        self.assertEqual(len(bot.calls), 1)
        self.assertEqual(bot.calls[0]['parse_mode'], 'MarkdownV2')

        edits = []
        async def edit(chat, message, text, mode=None):
            edits.append((text, mode))
            raise ValueError('cannot parse entities')
        scope = {'ParseMode': SimpleNamespace(MARKDOWN_V2='MarkdownV2')}
        function('plugins/platforms/telegram/adapter.py', ['_edit_markdown_or_plain'], scope)
        with self.assertRaisesRegex(ValueError, 'cannot parse'):
            await scope['_edit_markdown_or_plain'](SimpleNamespace(_edit_text=edit), '1', '2', '*formatted*', '**raw**', '')
        self.assertEqual(edits, [('*formatted*', 'MarkdownV2')])

    async def test_pinned_telegram_retries_only_the_same_private_topic(self):
        class BadRequest(OSError):
            pass

        class Forbidden(Exception):
            pass

        class PrivateTopicRetryFailed(Exception):
            pass

        async def deadline(awaitable, **kwargs):
            return await awaitable

        async def record(*args):
            pass

        native_methods = (
            '_metadata_thread_id', '_metadata_reply_to_message_id', '_metadata_direct_messages_topic_id',
            '_dm_topic_fallback', '_is_private_dm_topic_send', '_chunk_reply_routing', '_should_thread_reply',
            '_thread_kwargs_for_send', '_message_thread_id_for_send', '_direct_topic_kwargs',
            '_compute_single_send_routing', '_brai_private_topic_route', '_brai_private_topic_rejected',
            '_brai_send_with_private_topic_retry',
            '_send_chunk_with_retries', '_try_send_rich', '_is_thread_not_found_error',
        )
        scope = function('plugins/platforms/telegram/adapter.py', native_methods, {
            'os': os, 'normalize_telegram_chat_id': int, 'SendResult': SimpleNamespace,
            '_await_with_thread_deadline': deadline, '_TEXT_SEND_DEADLINE': 1,
            '_BraiPrivateTopicRetryFailed': PrivateTopicRetryFailed,
            'logger': SimpleNamespace(warning=lambda *args: None),
        })
        adapter = type('TelegramFixture', (), {
            **{name: scope[name] for name in native_methods}, '_GENERAL_TOPIC_THREAD_ID': '1',
        })()
        types = (OSError, BadRequest, TimeoutError)
        adapter._telegram_error_types = lambda: types
        adapter._link_preview_kwargs = dict
        adapter._notification_kwargs = lambda metadata: {}
        adapter._rich_payload_base = lambda chat, content: {'chat_id': int(chat), 'rich_message': {'markdown': content}}
        adapter._record_rich_sent = record
        adapter._rich_rejected = lambda *_: self.fail('private topic rejection fell back to Markdown')
        anchor = 93
        topic = {'thread_id': '88', 'telegram_dm_topic_reply_fallback': True,
                 'telegram_reply_to_message_id': str(anchor), 'direct_messages_topic_id': '88'}

        denied = BadRequest('Message thread not found')
        delivered = SimpleNamespace(message_id=101)
        for rich in (False, True):
            for results, created, mode, error in (
                    ((denied, delivered), False, 'all', None),
                    ((denied, denied), False, 'all', 'topic_unavailable'),
                    ((denied,), True, 'all', 'topic_unavailable'),
                    ((denied,), False, 'off', 'topic_unavailable'),
                    ((denied, BadRequest('Message to be replied not found')), False, 'all', 'delivery_unknown'),
                    ((denied, OSError('connection state unknown')), False, 'all', 'delivery_unknown'),
                    ((denied, {}), False, 'all', 'delivery_unknown'),
                    (({'result': []},), False, 'all', 'delivery_unknown'),
                    (({'message_id': 0, 'result': {'message_id': 101}},), False, 'all', 'delivery_unknown')):
                with self.subTest(rich=rich, results=results, created=created, reply_mode=mode):
                    attempts = []

                    async def send(method, kwargs):
                        attempts.append((method, dict(kwargs)))
                        result = results[len(attempts) - 1]
                        if isinstance(result, Exception):
                            raise result
                        return result

                    adapter._reply_to_mode = mode
                    adapter._bot = SimpleNamespace(do_api_request=lambda method, api_kwargs: send(method, api_kwargs))
                    adapter._send_chunk_markdown_or_plain = send
                    metadata = {**topic, 'telegram_dm_topic_created_for_send': created}
                    with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
                        if rich:
                            actual = await adapter._try_send_rich('23', 'готовый ответ', None, metadata)
                        else:
                            actual = await adapter._send_chunk_with_retries('23', 'готовый ответ', 0, None,
                                                                           metadata, '88', False, types)
                    expected = {'chat_id': 23, 'message_thread_id': 88}
                    if rich:
                        expected['rich_message'] = {'markdown': 'готовый ответ'}
                        if mode != 'off':
                            expected['reply_parameters'] = {'message_id': anchor}
                    else:
                        expected['reply_to_message_id'] = anchor if mode != 'off' else None
                    method = 'sendRichMessage' if rich else 'готовый ответ'
                    self.assertEqual(attempts, [(method, expected)] * len(results))
                    if error is None:
                        self.assertEqual(actual.message_id if rich else actual[0].message_id, '101' if rich else 101)
                    else:
                        self.assertFalse(actual.retryable)
                        self.assertEqual(actual.error_kind, error)

        from identity.telegram_runtime import Resolver

        resolver = Resolver.__new__(Resolver)
        resolver.adapter = adapter
        adapter.format_message = str
        resolver.journal = None
        recorded = []
        resolver._record_delivery = lambda *args, **kwargs: recorded.append(args)
        current = lambda: None
        current.generation = 1
        receipt = SimpleNamespace(chat_id=23, message_thread_id=88, message_id=101)
        ports = {'plugins.platforms.telegram.adapter': module(_BraiPrivateTopicRetryFailed=PrivateTopicRetryFailed),
                 'telegram.error': module(BadRequest=BadRequest, Forbidden=Forbidden)}
        for outcomes, retry_error, error_kind in (
                ((receipt,), None, None), ((denied, receipt), None, None),
                ((denied, denied), None, 'topic_unavailable'),
                ((denied, BadRequest('Message to be replied not found')), None, 'telegram_rejected'),
                ((denied, Forbidden()), None, 'telegram_rejected'),
                ((denied, TimeoutError()), None, 'delivery_unknown'),
                ((denied,), PermissionError('Conversation generation changed'), 'forbidden')):
            with self.subTest(operator_outcomes=outcomes), patch.dict(sys.modules, ports), \
                    patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
                admitted = AsyncMock()
                retry_admitted = AsyncMock(side_effect=retry_error)
                wire = AsyncMock(side_effect=outcomes)
                adapter._send_chunk_markdown_or_plain = wire
                result = await resolver._deliver_route({'uid': 1}, 'send',
                    {'chat_id': '23', 'reply_to': str(anchor), 'content': 'готовый ответ'}, ('23', '88'),
                    topic, None, current, before_send=admitted, before_retry=retry_admitted)
                admitted.assert_awaited_once()
                self.assertEqual(retry_admitted.await_count, int(outcomes[0] is denied))
                self.assertEqual(wire.await_count, len(outcomes))
                for attempt in wire.await_args_list:
                    self.assertEqual(attempt.args, ('готовый ответ', {
                        'chat_id': 23, 'message_thread_id': 88, 'reply_to_message_id': anchor,
                        'allow_sending_without_reply': False}))
                if error_kind:
                    self.assertEqual(result, {'success': False, 'retryable': False, 'error_kind': error_kind})
                else:
                    self.assertEqual(result, {'success': True, 'message_id': '101'})
        self.assertEqual(len(recorded), 2)

    async def test_pinned_telegram_draft_never_retries_with_raw_markup(self):
        async def deadline(value, **kwargs):
            return await value
        class Bot:
            def __init__(self):
                self.calls = []
            async def send_message_draft(self, **kwargs):
                self.calls.append(kwargs)
                raise ValueError('cannot parse entities')
        bot = Bot()
        adapter = SimpleNamespace(_bot=bot, strip_media_directives_for_display=lambda value: value,
            _should_attempt_rich_draft=lambda value: False, MAX_MESSAGE_LENGTH=4096,
            format_message=lambda value: '*formatted*', _thread_kwargs_for_draft=lambda chat, meta: {}, name='test')
        scope = {'SendResult': lambda **kwargs: SimpleNamespace(**kwargs),
                 '_await_with_thread_deadline': deadline, '_TEXT_SEND_DEADLINE': 1,
                 'ParseMode': SimpleNamespace(MARKDOWN_V2='MarkdownV2'),
                 'normalize_telegram_chat_id': int, '_redact_telegram_error_text': str,
                 'logger': SimpleNamespace(debug=lambda *args: None)}
        function('plugins/platforms/telegram/adapter.py', ['send_draft'], scope)
        result = await scope['send_draft'](adapter, '1', 2, '**raw**')
        self.assertFalse(result.success)
        self.assertEqual(len(bot.calls), 1)
        self.assertEqual(bot.calls[0]['text'], '*formatted*')
        self.assertEqual(bot.calls[0]['parse_mode'], 'MarkdownV2')

    async def test_pinned_standalone_telegram_rejects_direct_file_and_raw_fallback(self):
        scope = {}
        function('tools/send_message_senders.py', ['_send_telegram'], scope)
        result = await scope['_send_telegram']('token', '1', 'text', media_files=[('/raw/file.pdf', False)])
        self.assertIn('Artifacts', result['error'])
        calls = []
        async def send(bot, **kwargs):
            calls.append(kwargs)
            raise ValueError('cannot parse entities')
        scope = {'_send_telegram_message_with_retry': send, '_is_telegram_thread_not_found': lambda error: False}
        function('tools/send_message_senders.py', ['_telegram_send_text_chunk'], scope)
        with self.assertRaisesRegex(ValueError, 'cannot parse'):
            await scope['_telegram_send_text_chunk'](None, '1', '*formatted*', 'MarkdownV2', False, {})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['parse_mode'], 'MarkdownV2')

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
            adapter, receipts = SimpleNamespace(platform='telegram', _bot=bot, format_message=lambda value: value,
                truncate_message=lambda value, maximum, len_fn: list(native.text_chunks(value, maximum))), []
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
