# ABOUTME: Проверяет устойчивую административную паузу доверенного ingress.
# ABOUTME: Не запускает рабочие профили и реальные отправки.
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.chat_journal import IdentityJournal
from identity.worker import Worker
from identity.ipc import RpcError

PROFILE = {'profileId': '11111111-1111-4111-8111-111111111111', 'userId': 'owner'}

class DurablePauseTest(unittest.TestCase):
    def test_old_return_notice_cannot_adopt_generation_after_pause_resume(self):
        from identity.telegram_runtime import Resolver
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root)/'journal')
            journal.set_chat_pause(PROFILE, ('123','77'), True)
            resumed = journal.set_chat_pause(PROFILE, ('123','77'), False)
            resolver = Resolver(SimpleNamespace(), journal=journal)
            try:
                with self.assertRaisesRegex(PermissionError, 'stale'):
                    resolver.authorize_delivery(PROFILE,'send',{'chat_id':'123',
                        'metadata':{'thread_id':'77','_brai_return_notice_generation':0}})
                self.assertGreater(resumed['generation'],0)
            finally:
                resolver.ledger.close()

    def test_restart_idempotency_and_isolation(self):
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root) / 'journal')
            first = journal.set_chat_pause(PROFILE, ('123', ''), True)
            self.assertTrue(first['paused'])
            self.assertEqual(journal.set_chat_pause(PROFILE, ('123', ''), True), first)
            restarted = IdentityJournal(Path(root) / 'journal')
            self.assertEqual(restarted.chat_state(PROFILE, ('123', '')), first)
            self.assertFalse(restarted.chat_state(PROFILE, ('123', '7'))['paused'])
            other = dict(PROFILE, profileId='22222222-2222-4222-8222-222222222222')
            self.assertFalse(restarted.chat_state(other, ('123', ''))['paused'])
            resumed = restarted.set_chat_pause(PROFILE, ('123', ''), False)
            self.assertFalse(resumed['paused'])
            self.assertTrue(resumed['recoveryBlocked'])
            self.assertGreater(resumed['generation'], first['generation'])


    def test_paused_and_old_inputs_never_replay_after_restart_resume(self):
        from datetime import datetime, timezone, timedelta
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root) / 'journal')
            chat, user = SimpleNamespace(id=123), SimpleNamespace(full_name='Тест', username='')
            def incoming(mid):
                journal.incoming(PROFILE, SimpleNamespace(chat=chat, message_id=mid, text='Точный текст ' + str(mid),
                    date=datetime.now(timezone.utc) + timedelta(seconds=2)), chat, user)
            incoming(1)
            journal.set_chat_pause(PROFILE, ('123', ''), True)
            incoming(2)
            state = journal.set_chat_pause(PROFILE, ('123', ''), False)
            journal = IdentityJournal(Path(root) / 'journal')
            self.assertFalse(journal.chat_admission(PROFILE, ('123', ''), '1'))
            self.assertFalse(journal.chat_admission(PROFILE, ('123', ''), '2'))
            incoming(3)
            self.assertTrue(journal.chat_admission(PROFILE, ('123', ''), '3'))
            self.assertTrue(journal.chat_state(PROFILE, ('123', ''))['recoveryBlocked'])
            journal.chat_started(PROFILE, ('123', ''), state['generation'] - 1)
            self.assertTrue(journal.chat_state(PROFILE, ('123', ''))['recoveryBlocked'])
            journal.chat_started(PROFILE, ('123', ''), state['generation'])
            self.assertFalse(journal.chat_state(PROFILE, ('123', ''))['recoveryBlocked'])
            db = journal.database(PROFILE)
            try:
                self.assertEqual([row[0] for row in db.execute('SELECT text FROM messages ORDER BY id')],
                                 ['Точный текст 1', 'Точный текст 2', 'Точный текст 3'])
            finally:
                db.close()


    def test_telegram_backlog_first_observed_after_resume_is_not_a_new_input(self):
        from datetime import datetime, timezone, timedelta
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root) / 'journal')
            journal.set_chat_pause(PROFILE, ('123', ''), True)
            journal.set_chat_pause(PROFILE, ('123', ''), False)
            journal = IdentityJournal(Path(root) / 'journal')
            chat, user = SimpleNamespace(id=123), SimpleNamespace(full_name='Тест', username='')
            journal.incoming(PROFILE, SimpleNamespace(chat=chat, message_id=999, text='Старый backlog',
                date=datetime.now(timezone.utc) - timedelta(minutes=1)), chat, user)
            self.assertFalse(journal.chat_admission(PROFILE, ('123', ''), '999'))
            journal.incoming(PROFILE, SimpleNamespace(chat=chat, message_id=1000, text='Новый вход',
                date=datetime.now(timezone.utc) + timedelta(seconds=2)), chat, user)
            self.assertTrue(journal.chat_admission(PROFILE, ('123', ''), '1000'))

class WorkerPauseTest(unittest.IsolatedAsyncioTestCase):
    async def test_foreign_pause_and_unknown_snapshot_fail_closed(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        with self.assertRaises(RpcError):
            await worker.chat_pause(owner='other', chat='123', thread='', paused=True, generation=1)
        self.assertFalse(worker.route_allowed(SimpleNamespace(chat_id='123', thread_id=None), recovery=True))


    async def test_new_input_repairs_lost_resume_receipt_but_stale_generation_cannot_run(self):
        from unittest.mock import patch, AsyncMock
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        worker.chat_snapshot_ready = True
        worker.chat_states[('123', '')] = dict(paused=True, generation=1, recoveryBlocked=True)
        source_data = {'platform': 'telegram', 'user_id': '123', 'chat_id': '123', 'chat_type': 'dm'}
        def source(value):
            return SimpleNamespace(**dict(value, platform=SimpleNamespace(value='telegram'),
                thread_id=None, is_bot=False, to_dict=lambda: value))
        received = []
        async def handle(message):
            received.append(message.text)
            message._gateway_accepted = True
        worker.adapter = SimpleNamespace(bind_source=lambda value: None, _event_session_key=lambda value: 'key',
            _session_tasks={}, start_turn_typing=lambda value: None, handle_message=handle)
        cleared = AsyncMock()
        worker.runner = SimpleNamespace(async_session_store=SimpleNamespace(clear_resume_pending=cleared))
        worker.ensure_tools = AsyncMock()
        event = dict(source=source_data, text='Новый вход', message_id='3', chat_generation=2, delivery_scope='scope')
        modules = {
            'tools.approval_conversation': SimpleNamespace(gateway_input_prepared=AsyncMock(return_value=None)),
            'gateway.session': SimpleNamespace(SessionSource=SimpleNamespace(from_dict=source)),
            'gateway.platforms.event': SimpleNamespace(MessageType=lambda value: value,
                MessageEvent=lambda **value: SimpleNamespace(**value, _gateway_accepted=False)),
        }
        with patch.dict(sys.modules, modules), patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'):
            self.assertTrue((await worker.dispatch(event, 'owner'))['accepted'])
            self.assertFalse((await worker.dispatch(dict(event, text='Старый вход', chat_generation=1), 'owner'))['accepted'])
        self.assertEqual(received, ['Новый вход'])
        self.assertFalse(worker.chat_states[('123', '')]['recoveryBlocked'])
        cleared.assert_awaited_once_with('key')

class IngressPauseTest(unittest.IsolatedAsyncioTestCase):
    async def test_commit_precedes_primary_cancel_and_offline_resume_never_dispatches(self):
        from identity.telegram_runtime import Resolver
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root) / 'journal')
            resolver = Resolver(SimpleNamespace(), journal=journal)
            calls = []
            class PeerStub:
                closed = False
                async def call(self, method, value, **kwargs):
                    calls.append(method)
                    self_state = journal.chat_state(PROFILE, ('123', ''))
                    assert self_state['paused'] is value['paused']
                    return {'state': 'stopped' if value['paused'] else 'resumed'}
            bridge = SimpleNamespace(profile_id=PROFILE['profileId'], owner='owner',
                                     peer=PeerStub(), dispatch_inflight=0)
            resolver.bridges[99] = bridge
            request = dict(userId='owner', profileId=PROFILE['profileId'], chat='123', thread='')
            self.assertEqual(await resolver.chat_control(**request, paused=True), {'paused': True, 'state': 'stopped'})
            self.assertEqual(calls, ['chat_pause'])
            bridge.peer = None
            self.assertEqual(await resolver.chat_control(**request), {'paused': True, 'state': 'stopping'})
            self.assertEqual(await resolver.chat_control(**request, paused=False), {'paused': False, 'state': 'resumed'})
            self.assertTrue(journal.chat_state(PROFILE, ('123', ''))['recoveryBlocked'])
            self.assertEqual(calls, ['chat_pause'])
            resolver.ledger.close()

    async def test_prepare_race_and_new_input_after_resume(self):
        from identity.ingress import Bridge
        import asyncio
        entered, release = asyncio.Event(), asyncio.Event()
        state = {'paused': False, 'generation': 0}
        async def prepare(event):
            entered.set()
            await release.wait()
            return {'message_id': event.message_id}
        calls = []
        class PeerStub:
            async def call(self, method, value):
                calls.append(value['event'])
                return {'accepted': True, 'turn_id': None}
        bridge = Bridge('owner', '123', 99, '/unused', None, prepare)
        bridge.chat_state = lambda route: dict(state)
        async def connect():
            return PeerStub()
        bridge.connect = connect
        source = SimpleNamespace(platform=SimpleNamespace(value='telegram'), user_id='123',
            is_bot=False, chat_id='123', thread_id=None,
            to_dict=lambda: {'platform': 'telegram', 'user_id': '123', 'chat_id': '123'})
        pending = asyncio.create_task(bridge.dispatch(SimpleNamespace(source=source, message_id='1')))
        await entered.wait()
        state.update(paused=True, generation=1)
        state.update(paused=False, generation=2)
        release.set()
        self.assertFalse((await pending)['accepted'])
        self.assertEqual(calls, [])
        self.assertTrue((await bridge.dispatch(SimpleNamespace(source=source, message_id='2')))['accepted'])
        self.assertEqual(calls[0]['chat_generation'], 2)

    async def test_store_failure_never_cancels_or_reports_paused(self):
        from identity.telegram_runtime import Resolver
        from unittest.mock import Mock
        journal = SimpleNamespace(set_chat_pause=Mock(side_effect=OSError('disk failure')))
        resolver = Resolver(SimpleNamespace(), journal=journal)
        with self.assertRaises(OSError):
            await resolver.chat_control(userId='owner', profileId=PROFILE['profileId'], chat='123', thread='', paused=True)
        self.assertEqual(resolver.bridges, {})
        resolver.ledger.close()


class NativePauseTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_preserves_history_session_and_discards_all_pending(self):
        import asyncio
        from unittest.mock import patch, AsyncMock
        history, identity = ['user', 'assistant'], object()
        source = SimpleNamespace(chat_id='123', thread_id=None)
        task = asyncio.create_task(asyncio.Event().wait())
        await asyncio.sleep(0)
        queue = [SimpleNamespace(internal=True)]
        adapter = SimpleNamespace(_session_tasks={'key': task}, _pending_messages={'key': 'old input'},
                                  _event_session_key=lambda event: 'key', _discard_text_debounce=lambda key: None)
        runner = SimpleNamespace(_pending_messages={'key': 'old input'}, _overflow_queue=lambda key: queue,
            _interrupt_and_clear_session=AsyncMock(), session_id=identity, history=history)
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        worker.runner, worker.adapter, worker.chat_snapshot_ready = runner, adapter, True
        with patch.dict(sys.modules, {
                'gateway.session': SimpleNamespace(SessionSource=SimpleNamespace(from_dict=lambda value: source)),
                'gateway.run': SimpleNamespace(_INTERRUPT_REASON_STOP='stop')}):
            result = await worker.chat_pause(owner='owner', chat='123', thread='', paused=True, generation=1)
        self.assertEqual(result, {'state': 'stopped'})
        self.assertTrue(task.cancelled())
        self.assertIs(runner.session_id, identity)
        self.assertEqual(runner.history, ['user', 'assistant'])
        self.assertEqual(queue, [])
        self.assertEqual(adapter._pending_messages, {})
        self.assertEqual(runner._pending_messages, {})
        self.assertFalse(hasattr(runner, 'suspended'))
        self.assertFalse(worker.route_allowed(source, recovery=True))
        await worker.chat_pause(owner='owner', chat='123', thread='', paused=False, generation=2)
        self.assertTrue(worker.route_allowed(source))
        self.assertFalse(worker.route_allowed(source, recovery=True))
        self.assertEqual(runner._interrupt_and_clear_session.await_count, 1)

    async def test_snapshot_merges_newer_pause_and_fails_closed_on_foreign_owner(self):
        import asyncio
        from unittest.mock import patch
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        worker.activation.set()
        class PeerStub:
            async def call(self, method, value, **kwargs):
                return {'owner': 'owner', 'routes': [dict(chat='123', thread='', paused=True,
                    generation=3, recoveryBlocked=True, discardThrough=0)]}
        worker.peer = PeerStub()
        with patch('identity.tool_client.broker_call', return_value={}), patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'):
            await worker._startup_gate(None)
        source = SimpleNamespace(chat_id='123', thread_id=None)
        self.assertTrue(worker.chat_snapshot_ready)
        self.assertFalse(worker.route_allowed(source, recovery=True))
        await worker.chat_pause(owner='owner', chat='123', thread='', paused=False, generation=2)
        self.assertFalse(worker.route_allowed(source))

class DuplexPauseTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_unix_duplex_snapshot_precedes_startup_and_secondary_cannot_mutate(self):
        import asyncio
        from unittest.mock import patch
        from identity.ingress import Bridge
        from identity.ipc import Peer
        with tempfile.TemporaryDirectory() as root:
            journal = IdentityJournal(Path(root) / 'journal')
            journal.set_chat_pause(PROFILE, ('123', ''), True)
            socket_path = str(Path(root) / 'worker.sock')
            worker = Worker(os.getuid() + 1, 'owner', '123', None)
            stopping, events = asyncio.Event(), []
            async def stop():
                stopping.set()
            async def bootstrap(peer):
                worker.runner = SimpleNamespace(stop=stop)
                worker.adapter = SimpleNamespace(_session_tasks={}, _event_session_key=lambda event: 'key')
                async def lifecycle():
                    await worker.activation.wait()
                    await worker._startup_gate(None)
                    events.append(('native_start', worker.route_allowed(SimpleNamespace(chat_id='123', thread_id=None), recovery=True)))
                    worker.operational.set()
                    await stopping.wait()
                worker.lifecycle_task = asyncio.create_task(lifecycle())
            worker.start = bootstrap
            bridge = Bridge('owner', '123', os.getuid(), socket_path, None, None)
            bridge.chat_states = lambda: journal.chat_states(PROFILE)
            source_type = SimpleNamespace(from_dict=lambda value: SimpleNamespace(chat_id=value['chat_id'], thread_id=value['thread_id']))
            with patch('identity.worker.peer_uid', return_value=worker.ingress_uid), patch(
                    'identity.tool_client.broker_call', return_value={}), patch.dict(
                    os.environ, BRAI_IDENTITY_MODE='worker'), patch.dict(
                    sys.modules, {'gateway.session': SimpleNamespace(SessionSource=source_type)}):
                server = await asyncio.start_unix_server(worker.serve_connection, path=socket_path)
                try:
                    peer = await bridge.connect()
                    self.assertTrue((await peer.call('health', {'require_tools': True}, timeout=3))['operational'])
                    self.assertEqual(events, [('native_start', False)])
                    receipt = await peer.call('chat_pause', {'owner': 'owner', 'chat': '123', 'thread': '',
                                                          'paused': True, 'generation': 1})
                    self.assertEqual(receipt, {'state': 'stopped'})
                    reader, writer = await asyncio.open_unix_connection(socket_path)
                    probe = Peer(reader, writer, {})
                    probing = asyncio.create_task(probe.run())
                    with self.assertRaisesRegex(RpcError, 'Method not found'):
                        await probe.call('chat_pause', {'owner': 'owner', 'chat': '123', 'thread': '',
                                                      'paused': False, 'generation': 2}, timeout=3)
                    self.assertTrue((await probe.call('health', {}))['ready'])
                    writer.close()
                    await probing
                    self.assertIsNotNone(worker.peer)
                    self.assertFalse(worker.route_allowed(SimpleNamespace(chat_id='123', thread_id=None)))
                finally:
                    if bridge.task is not None:
                        bridge.task.cancel()
                        await asyncio.gather(bridge.task, return_exceptions=True)
                    await asyncio.wait_for(worker.peer_released.wait(), 3)
                    server.close()
                    await server.wait_closed()


class InteractivePauseTest(unittest.IsolatedAsyncioTestCase):
    def worker(self, *, chat='456', paused=True, generation=1):
        from unittest.mock import AsyncMock
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        worker.chat_snapshot_ready = True
        worker.chat_states[(chat, '')] = dict(paused=paused, generation=generation, recoveryBlocked=True)
        worker.ensure_tools = AsyncMock()
        worker.adapter = SimpleNamespace(handle_interactive=AsyncMock())
        return worker

    def update(self, chat=456):
        return {'callback_query': {'id': 'query', 'from': {'id': chat, 'is_bot': False},
            'message': {'chat': {'id': chat, 'type': 'private'}, 'message_id': 200, 'date': 1},
            'data': 'gt:archive:example'}}

    async def test_paused_callback_never_activates_tools_or_invokes_native_side_effect(self):
        worker = self.worker()
        with self.assertRaises(RpcError):
            await worker.interactive(self.update(), 'owner', 'scope', '456')
        worker.ensure_tools.assert_not_awaited()
        worker.adapter.handle_interactive.assert_not_awaited()

    async def test_stale_generation_after_resume_and_foreign_actor_cannot_invoke(self):
        worker = self.worker(paused=False, generation=2)
        for args in ({'owner': 'owner', 'actor_telegram_id': '456', 'chat_generation': 0},
                     {'owner': 'other', 'actor_telegram_id': '456', 'chat_generation': 2},
                     {'owner': 'owner', 'actor_telegram_id': '123', 'chat_generation': 2}):
            with self.assertRaises(RpcError):
                await worker.interactive(self.update(), scope_id='scope', **args)
        worker.adapter.handle_interactive.assert_not_awaited()

    async def test_pause_during_activation_blocks_handler_and_new_current_action_keeps_recovery_blocked(self):
        worker = self.worker(paused=False, generation=2)
        async def pause():
            worker.chat_states[('456', '')].update(paused=True, generation=3)
        worker.ensure_tools.side_effect = pause
        with self.assertRaises(RpcError):
            await worker.interactive(self.update(), 'owner', 'scope', '456', chat_generation=2)
        worker.adapter.handle_interactive.assert_not_awaited()
        worker.ensure_tools.side_effect = None
        worker.chat_states[('456', '')].update(paused=False, generation=4)
        self.assertTrue((await worker.interactive(self.update(), 'owner', 'new-scope', '456', chat_generation=4))['accepted'])
        self.assertTrue(worker.chat_states[('456', '')]['recoveryBlocked'])

    async def test_inflight_callback_is_cancelled_and_reply_anchor_is_not_a_topic(self):
        import asyncio
        worker = self.worker(paused=False, generation=0)
        started = asyncio.Event()
        async def handle(update, **kwargs):
            started.set()
            await asyncio.Event().wait()
        worker.adapter.handle_interactive.side_effect = handle
        task = asyncio.create_task(worker.interactive(self.update(), 'owner', 'scope', '456', chat_generation=0))
        await started.wait()
        self.assertEqual((await worker.chat_pause('owner', '456', '', True, 1))['state'], 'stopping')
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertEqual((await worker.chat_pause('owner', '456', '', True, 1))['state'], 'stopped')
        anchored = self.update()
        anchored['callback_query']['message'].update(message_thread_id=77, is_topic_message=False)
        with self.assertRaises(RpcError):
            await worker.interactive(anchored, 'owner', 'other-scope', '456', chat_generation=0)


class InteractiveProvenanceTest(unittest.IsolatedAsyncioTestCase):
    def setup_resolver(self):
        from identity.telegram_runtime import Resolver
        from unittest.mock import AsyncMock
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        journal = IdentityJournal(Path(temp.name) / 'journal')
        profile = dict(PROFILE, uid=1001, telegramId='456', authorTelegramId='123', workerSocket='/unused')
        bot = SimpleNamespace(send_message=AsyncMock(return_value={'message_id': 201, 'chat': {'id': 456}}),
                              edit_message_reply_markup=AsyncMock(return_value={'message_id': 200, 'chat': {'id': 456}}),
                              answer_callback_query=AsyncMock(return_value=True))
        resolver = Resolver(SimpleNamespace(_bot=bot), journal=journal)
        self.addCleanup(resolver.ledger.close)
        resolver.ledger.admit(profile, ('456', ''), {})
        resolver.ledger.record(profile, ('456', ''), 200)
        return resolver, journal, profile, bot

    def update(self, mid=200, actor=456):
        message = SimpleNamespace(chat=SimpleNamespace(id=actor, type='private'), message_id=mid,
                                  message_thread_id=None, date=1)
        raw = {'callback_query': {'id': 'query', 'from': {'id': actor, 'is_bot': False},
            'message': {'chat': {'id': actor, 'type': 'private'}, 'message_id': mid, 'date': 1}, 'data': 'gt:archive:x'}}
        return SimpleNamespace(effective_user=SimpleNamespace(id=actor, is_bot=False), inline_query=None,
            callback_query=SimpleNamespace(id='query', message=message), to_dict=lambda: raw)

    async def test_legacy_and_old_birth_rejected_after_resume_new_message_allowed_and_edits_cannot_bless(self):
        from identity import telegram_runtime as runtime
        from unittest.mock import patch
        resolver, journal, profile, bot = self.setup_resolver()
        async def broker(method, params, **kwargs):
            return profile
        with patch.object(runtime, 'broker_call', broker):
            self.assertEqual((await resolver.interactive_binding(self.update()))[-1], 0)
            journal.record_presentation(profile, ('456', ''), 200, 0)
            journal.set_chat_pause(profile, ('456', ''), True)
            with self.assertRaises(PermissionError):
                await resolver.interactive_binding(self.update())
            generation = journal.set_chat_pause(profile, ('456', ''), False)['generation']
            with self.assertRaises(PermissionError):
                await resolver.interactive_binding(self.update())
            await resolver.telegram_api(profile, 'owner', 'edit_message_reply_markup',
                {'chat_id': 456, 'message_id': 200, 'reply_markup': {'inline_keyboard': []}}, None)
            self.assertEqual(journal.presentation_generation(profile, ('456', ''), 200), 0)
            journal.record_presentation(profile, ('456', ''), 200, generation)
            self.assertEqual(journal.presentation_generation(profile, ('456', ''), 200), 0)
            resolver._record_delivery(profile, ('456', ''), 202, generation, created=False)
            self.assertIsNone(journal.presentation_generation(profile, ('456', ''), 202))
            await resolver.telegram_api(profile, 'owner', 'send_message',
                {'chat_id': 456, 'text': 'Fresh prompt', 'reply_markup': {'inline_keyboard': []}}, None)
            self.assertEqual((await resolver.interactive_binding(self.update(201)))[-1], generation)
            for mid in (200, 202):
                with self.assertRaises(PermissionError):
                    await resolver.interactive_binding(self.update(mid))
            with self.assertRaises(PermissionError):
                await resolver.interactive_binding(self.update(201, actor=123))
        bot.send_message.assert_awaited_once()

    async def test_pause_resume_while_connecting_never_allocates_or_dispatches_scope(self):
        from identity import telegram_runtime as runtime
        from identity.ingress import Bridge
        from unittest.mock import patch, AsyncMock
        resolver, journal, profile, _ = self.setup_resolver()
        journal.record_presentation(profile, ('456', ''), 200, 0)
        rpc = AsyncMock()
        async def connect(bridge):
            journal.set_chat_pause(profile, ('456', ''), True)
            journal.set_chat_pause(profile, ('456', ''), False)
            return SimpleNamespace(call=rpc)
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile)), patch.object(Bridge, 'connect', connect):
            with self.assertRaises(PermissionError):
                await resolver.interactive(self.update())
        self.assertEqual(resolver.interactive_scopes, {})
        rpc.assert_not_awaited()

    async def test_stale_recipient_scope_cannot_answer_or_deliver_after_resume(self):
        from identity import telegram_runtime as runtime
        from identity.scope import request_scope
        from unittest.mock import patch, AsyncMock
        import time
        resolver, journal, profile, bot = self.setup_resolver()
        resolver.interactive_scopes['old'] = {'owner': resolver.ledger.owner(profile), 'route': ('456', ''),
            'actorTelegramId': '456', 'queryId': 'query', 'kind': 'callback', 'expires': time.monotonic() + 300, 'generation': 0}
        journal.set_chat_pause(profile, ('456', ''), True)
        journal.set_chat_pause(profile, ('456', ''), False)
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile)):
            with self.assertRaises(PermissionError):
                await resolver.telegram_api(profile, 'owner', 'answer_callback_query', {'callback_query_id': 'query'}, 'old')
            token = request_scope.set('old')
            try:
                with self.assertRaises(PermissionError):
                    await resolver.delivery_context(profile, 'owner', {'chat_id': '456'})
            finally:
                request_scope.reset(token)
        bot.answer_callback_query.assert_not_awaited()

    async def test_automatic_notification_checks_actual_recipient_topic(self):
        from identity import telegram_runtime as runtime
        from identity.scope import request_scope
        from unittest.mock import patch, AsyncMock
        resolver, journal, profile, _ = self.setup_resolver()
        journal.set_chat_pause(profile, ('456', '77'), True)
        send = AsyncMock()
        resolver._deliver_route = send
        async def notification(profile, chat, deliver, **kwargs):
            return await deliver(('456', '77'), {'thread_id': '77'})
        resolver.notifications = SimpleNamespace(deliver=notification)
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile)):
                with self.assertRaises(PermissionError):
                    await resolver.deliver(profile, 'owner', 'send',
                        {'chat_id': '456', 'content': 'Notice', 'metadata': {'_brai_notifications': True}})
        finally:
            request_scope.reset(token)
        send.assert_not_awaited()

    async def test_notification_auth_await_cannot_adopt_post_pause_generation(self):
        from identity.scope import request_scope
        from unittest.mock import patch, AsyncMock
        resolver, journal, profile, _ = self.setup_resolver()
        send, checks = AsyncMock(), []
        resolver._deliver_route = send
        async def account(profile, chat):
            checks.append(chat)
            if len(checks) == 2:
                journal.set_chat_pause(profile, ('456', '77'), True)
                journal.set_chat_pause(profile, ('456', '77'), False)
            return profile
        async def notification(profile, chat, deliver, **kwargs):
            return await deliver(('456', '77'), {'thread_id': '77'})
        resolver.notifications = SimpleNamespace(deliver=notification)
        token = request_scope.set(None)
        try:
            with patch.object(resolver, '_account', account):
                with self.assertRaises(PermissionError):
                    await resolver.deliver(profile, 'owner', 'send',
                        {'chat_id': '456', 'content': 'Notice', 'metadata': {'_brai_notifications': True}})
        finally:
            request_scope.reset(token)
        send.assert_not_awaited()

if __name__ == '__main__':
    unittest.main()
