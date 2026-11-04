# ABOUTME: Исполняет обязательные границы на функциях из проверочной копии pinned Hermes.
# ABOUTME: Не вызывает модель или сеть; использует настоящий файловый адаптер и SQLite.
import ast
import base64
import dataclasses
import importlib.util
import asyncio
from contextlib import nullcontext, suppress
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import struct
import threading
import zlib
from types import SimpleNamespace, ModuleType, MethodType
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
            self.assertTrue(native.active_telegram_edit(SimpleNamespace(gateway_runner=runner,
                _source_from_message_for_auth=lambda _:event.source),SimpleNamespace(message_id='later')))
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

    async def test_input_during_agent_preparation_is_steered_before_final(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source,preparing=True)
        event=SimpleNamespace(source=source,message_id='later',text='Новое условие',
            media_urls=[],media_types=[],metadata={},internal=False)
        self.assertTrue(await native.steer_active_input(runner,event,'session'))
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

    def test_edits_belong_to_exact_active_turn_and_sender(self):
        source=SimpleNamespace(platform='telegram',chat_id='1',thread_id='topic',user_id='2')
        runner,agent,turn,ctx=self.steering_runner(source)
        runner._session_key_for_source=lambda _:'session'
        turn.event=SimpleNamespace(source=source,message_id='initial')
        adapter=SimpleNamespace(gateway_runner=runner,_source_from_message_for_auth=lambda _:source)
        self.assertTrue(native.active_telegram_edit(adapter,SimpleNamespace(message_id='initial')))
        self.assertFalse(native.active_telegram_edit(adapter,SimpleNamespace(message_id='old')))
        foreign=SimpleNamespace(**{**vars(source),'user_id':'another'})
        adapter._source_from_message_for_auth=lambda _:foreign
        self.assertFalse(native.active_telegram_edit(adapter,SimpleNamespace(message_id='initial')))
        adapter._source_from_message_for_auth=lambda _:source
        agent._brai_steer_closed=True
        self.assertFalse(native.active_telegram_edit(adapter,SimpleNamespace(message_id='initial')))
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
