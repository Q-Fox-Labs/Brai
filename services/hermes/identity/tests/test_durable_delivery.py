# ABOUTME: Проверяет сохранение доставки, потерянные квитанции и автоматический возврат очереди.
# ABOUTME: Использует настоящие SQLite/PTB Update и перезапуск объектов без пользовательских данных.
import asyncio
import ast
from contextlib import asynccontextmanager
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

from telegram import Bot, Update, User
from identity.chat_journal import IdentityJournal
from identity.delivery_journal import DeliveryJournal, delivery_id
from identity.ordinary_admission import Mirror
from identity.reply_outbox import ReplyOutbox
from identity.transport_inbox import TransportInbox
from identity.update_inbox import UpdateInbox
from identity.worker import Worker
from identity.tests.test_update_inbox import PROFILE, update

IDENT, DIGEST = delivery_id('input'), delivery_id('bytes')
RECEIPT = {'accepted': True, 'turn_id': 'native-turn'}


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'delivery.sqlite3'
        self.store = DeliveryJournal(self.path, 'owner')

    def test_lost_ack_and_restart_preserve_exact_receipt(self):
        self.assertEqual(self.store.input_status(IDENT, DIGEST), {'state': 'not_received'})
        self.assertTrue(self.store.begin_input(IDENT, DIGEST))
        self.assertFalse(self.store.begin_input(IDENT, DIGEST))
        self.store.accept_input(IDENT, DIGEST, RECEIPT)
        restarted = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restarted.input_status(IDENT, DIGEST), {'state': 'accepted', 'receipt': RECEIPT})
        restarted.complete_turn('native-turn')
        self.assertEqual(self.store.input_status(IDENT, DIGEST)['state'], 'completed')

    def test_continuation_binding_survives_restart_and_requires_existing_input(self):
        with self.assertRaisesRegex(ValueError, 'INPUT_UNKNOWN'):
            self.store.save_continuation('session', IDENT, 3)
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        self.assertEqual(self.store.pending_outputs(), [])
        restarted = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restarted.continuation('session'), {'input_id': IDENT, 'chat_generation': 3})
        restarted.clear_continuation('session')
        self.assertIsNone(self.store.continuation('session'))


    def test_dispatch_crash_does_not_claim_success_or_reexecute_unknown_effects(self):
        self.store.begin_input(IDENT, DIGEST)
        restarted = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restarted.input_status(IDENT, DIGEST), {'state': 'dispatching', 'receipt': None})
        self.assertFalse(restarted.begin_input(IDENT, DIGEST))

    def test_conflicting_content_owner_and_unprotected_path_fail(self):
        self.store.begin_input(IDENT, DIGEST)
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.store.input_status(IDENT, delivery_id('changed'))
        with self.assertRaisesRegex(PermissionError, 'OWNER_CHANGED'):
            DeliveryJournal(self.path, 'other')
        self.path.chmod(0o644)
        with self.assertRaisesRegex(PermissionError, 'UNPROTECTED'):
            DeliveryJournal(self.path, 'owner')

    def test_output_bytes_survive_restart_and_conflict_is_rejected(self):
        payload = {'payload': {'text': 'Готовый ответ'}, 'scope_id': 'old', 'input_delivery_id': IDENT}
        self.store.queue_output(IDENT, 'send', payload)
        self.store.output_state(IDENT, 'sending')
        restarted = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restarted.pending_outputs()[0]['payload'], payload)
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            restarted.queue_output(IDENT, 'send', {'payload': {}})
        with self.assertRaisesRegex(ValueError, 'RECEIPT_REQUIRED'):
            restarted.output_state(IDENT, 'sent', {'success': True})
        restarted.output_state(IDENT, 'sent', {'success': True, 'message_id': '1'})
        restarted.output_state(IDENT, 'pending')
        self.assertEqual(self.store.pending_outputs(), [])


class FailedTurnRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.worker = Worker(os.getuid() + 1, 'owner', '42', None)
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        self.worker.delivery_journal.begin_input(IDENT, DIGEST)
        self.worker.peer = NS(closed=False)
        self.worker.chat_snapshot_ready = True
        self.worker.chat_states[('42', '7')] = {'paused': False, 'generation': 3, 'recoveryBlocked': False}
        self.worker.operational.set()
        self.source = NS(chat_id='42', thread_id='7', user_id='42', is_bot=False)
        self.entry = NS(session_key='session', resume_pending=False, resume_reason=None,
                        suspended=False, origin=self.source)
        self.slot = NS(turn=NS(agent=None, started_ts=None))
        self.tasks = []
        self.adapter = NS(bind_source=lambda source: None)
        async def mark(key, reason):
            self.assertEqual(key, 'session')
            self.entry.resume_pending, self.entry.resume_reason = True, reason
        async def shape(result, *args, **kwargs):
            if not result.get('failed') and not result.get('partial') and not result.get('error'):
                self.entry.resume_pending = False
            return 'native'
        self.runner = NS(
            _hmwa_shape_agent_response=shape,
            async_session_store=NS(mark_resume_pending=mark),
            session_store=NS(_lock=threading.RLock(), _ensure_loaded_locked=lambda: None,
                             _entries={'session': self.entry}),
            _is_session_running=lambda key: self.slot.turn.agent is not None,
            _restored_source=lambda entry: entry.origin,
            _resume_owner_authorized=lambda key, source: True,
            _delivery_adapter_for=lambda source: self.adapter,
            _session_state=lambda key: self.slot,
            _persist_active_agents=lambda: None,
            _retain_background_task=self.tasks.append,
            _run_startup_resume_event=AsyncMock(),
        )
        self.worker.runner, self.worker.adapter = self.runner, self.adapter
        self.worker._install_failure_recovery(self.runner)

    async def test_failure_recovers_without_new_input_and_uses_original_outbox(self):
        from identity.scope import input_delivery, continuation_turn
        async def resume(adapter, event, key):
            self.assertEqual(input_delivery.get(), IDENT)
            self.assertTrue(continuation_turn.get())
            self.assertTrue(event.internal)
            self.assertEqual(event.text, '')
            self.assertEqual(key, 'session')
        self.runner._run_startup_resume_event.side_effect = resume
        token = input_delivery.set(IDENT)
        try:
            await self.runner._hmwa_shape_agent_response({'failed': True}, self.source, [], self.entry, 'session')
        finally:
            input_delivery.reset(token)
        self.assertEqual(self.entry.resume_reason, 'brai_technical_failure')
        self.assertEqual(self.worker.delivery_journal.continuation('session')['input_id'], IDENT)
        with patch('identity.native_policy.principal', side_effect=[ConnectionError(), {'role': 'user'}, {'role': 'user'}]):
            await self.worker._retry_failed_sessions()
            self.assertEqual(self.tasks, [])
            await self.worker._retry_failed_sessions()
            await self.worker._retry_failed_sessions()
        self.assertEqual(len(self.tasks), 1)
        await asyncio.gather(*self.tasks)
        self.runner._run_startup_resume_event.assert_awaited_once()
        await self.runner._hmwa_shape_agent_response({'failed': False, 'completed': True}, self.source, [], self.entry, 'session')
        self.assertIsNone(self.worker.delivery_journal.continuation('session'))

    async def test_interrupted_stream_and_exhausted_retries_resume_without_followup(self):
        from identity.scope import input_delivery
        for code in ('stream_drop', 'retry_limit'):
            with self.subTest(code=code):
                self.slot.turn.agent = None
                self.tasks.clear()
                self.entry.resume_pending = False
                self.worker.delivery_journal.clear_continuation('session')
                self.runner._run_startup_resume_event.reset_mock()
                token = input_delivery.set(IDENT)
                try:
                    with self.assertLogs('identity.worker', 'INFO') as records:
                        await self.runner._hmwa_shape_agent_response(
                            {'failed': True, 'partial': True, 'error': 'interrupted',
                             'brai_failure_kind': code}, self.source, [], self.entry, 'session')
                        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
                            await self.worker._retry_failed_sessions()
                            await self.worker._retry_failed_sessions()
                    await asyncio.gather(*self.tasks)
                finally:
                    input_delivery.reset(token)
                self.runner._run_startup_resume_event.assert_awaited_once()
                self.assertEqual(len(self.tasks), 1)
                self.assertIn('HERMES_FAILED_TURN_RECOVERY_MARKED session=session binding=True', '\n'.join(records.output))
                self.assertIn('HERMES_FAILED_TURN_RECOVERY_STARTED session=session', '\n'.join(records.output))

    async def test_pause_or_changed_chat_generation_prevents_automatic_resume(self):
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.entry.resume_pending, self.entry.resume_reason = True, 'brai_technical_failure'
        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
            self.worker.chat_states[('42', '7')]['paused'] = True
            await self.worker._retry_failed_sessions()
            self.worker.chat_states[('42', '7')].update(paused=False, generation=4)
            await self.worker._retry_failed_sessions()
        self.assertEqual(self.tasks, [])
        self.assertTrue(self.entry.resume_pending)

    async def test_restarted_worker_keeps_old_pending_turn_without_time_expiry(self):
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        self.entry.resume_pending, self.entry.resume_reason = True, 'brai_technical_failure'
        self.entry.last_resume_marked_at = '2000-01-01T00:00:00'
        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
            await self.worker._retry_failed_sessions()
            await asyncio.gather(*self.tasks)
        self.runner._run_startup_resume_event.assert_awaited_once()

    async def test_user_interrupt_does_not_create_recovery(self):
        await self.runner._hmwa_shape_agent_response({'failed': True, 'interrupted': True}, self.source, [], self.entry, 'session')
        self.assertFalse(self.entry.resume_pending)
        self.assertIsNone(self.worker.delivery_journal.continuation('session'))

    async def test_review_outage_resumes_but_consent_halt_does_not(self):
        from identity.scope import input_delivery
        token = input_delivery.set(IDENT)
        try:
            await self.runner._hmwa_shape_agent_response(
                {'completed': True, 'guardrail': {'code': 'brai_review_unavailable'}},
                self.source, [], self.entry, 'session')
            self.assertTrue(self.entry.resume_pending)
            self.assertEqual(self.worker.delivery_journal.continuation('session')['input_id'], IDENT)
            with patch('identity.native_policy.principal', return_value={'role': 'user'}):
                await self.worker._retry_failed_sessions()
                await asyncio.gather(*self.tasks)
            self.runner._run_startup_resume_event.assert_awaited_once()
            self.entry.resume_pending = False
            self.worker.delivery_journal.clear_continuation('session')
            await self.runner._hmwa_shape_agent_response(
                {'completed': True, 'guardrail': {'code': 'brai_conversation'}},
                self.source, [], self.entry, 'session')
            self.assertFalse(self.entry.resume_pending)
            self.assertIsNone(self.worker.delivery_journal.continuation('session'))
        finally:
            input_delivery.reset(token)

    async def test_partial_response_with_error_remains_resumable(self):
        from identity.scope import input_delivery
        token = input_delivery.set(IDENT)
        try:
            await self.runner._hmwa_shape_agent_response(
                {'partial': True, 'error': 'synthetic'}, self.source, [], self.entry, 'session')
            self.assertTrue(self.entry.resume_pending)
            self.assertEqual(self.worker.delivery_journal.continuation('session')['input_id'], IDENT)
        finally:
            input_delivery.reset(token)

    async def test_native_watcher_recovers_even_when_return_notice_is_broken(self):
        """Проверить связку поставляемого native watcher, журнала и worker scheduler."""
        root = Path(self.tmp.name) / 'native'
        target = root / 'gateway/return_notices.py'
        target.parent.mkdir(parents=True)
        extensions = Path(__file__).resolve().parents[2] / 'extensions'
        core = (extensions / 'patches/hermes-core.patch').read_text()
        section = core.split('diff --git a/gateway/return_notices.py b/gateway/return_notices.py', 1)[1]
        section = section.split('diff --git ', 1)[0]
        target.write_text('\n'.join(line[1:] for line in section.splitlines()
                                    if line.startswith('+') and not line.startswith('+++')) + '\n')
        identity = Path(__file__).resolve().parents[1] / 'native.patch'
        subprocess.run(['git', 'apply', '--include=gateway/return_notices.py', str(identity)],
                       cwd=root, check=True, capture_output=True)
        node = next(node for node in ast.walk(ast.parse(target.read_text()))
                    if isinstance(node, ast.AsyncFunctionDef) and node.name == '_return_notice_watcher')
        scope = {'read_return_notices': Mock(side_effect=ValueError('broken notice')), 'logger': Mock()}
        async def tick(_):
            fake._running = False
        scope['asyncio'] = NS(sleep=tick)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(target), 'exec'), scope)
        @asynccontextmanager
        async def release_source():
            yield
        fake = NS(_running=True, _brai_release_source=release_source,
                  _brai_retry_failed_sessions=self.worker._retry_failed_sessions)
        self.entry.resume_pending, self.entry.resume_reason = True, 'brai_technical_failure'
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        from gateway import run
        with patch.object(run, '_planned_restart_notification_path', return_value=Path('/unused')), \
                patch('identity.native_policy.principal', return_value={'role': 'user'}):
            await scope['_return_notice_watcher'](fake)
            await asyncio.gather(*self.tasks)
        self.runner._run_startup_resume_event.assert_awaited_once()
        scope['logger'].warning.assert_called_once_with('Return notice remains pending error=%s', 'ValueError')



class WorkerReceiptsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.worker = Worker(os.getuid() + 1, 'owner', '42', None)
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        self.worker.active['native-turn'] = ('session', None, {})
        self.worker._dispatch_native = AsyncMock(return_value=RECEIPT)

    async def test_duplicate_rpc_never_repeats_native_work(self):
        first = await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        second = await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        self.assertEqual(first, second)
        self.worker._dispatch_native.assert_awaited_once()
        self.worker.delivery_journal.complete_turn('native-turn')
        self.assertEqual((await self.worker.dispatch({}, 'owner', IDENT, DIGEST))['delivery_state'], 'completed')

    async def test_status_cannot_overtake_dispatch_in_progress(self):
        admitted, release = asyncio.Event(), asyncio.Event()
        async def native(*args):
            admitted.set()
            await release.wait()
            return RECEIPT
        self.worker._dispatch_native = native
        dispatch = asyncio.create_task(self.worker.dispatch({}, 'owner', IDENT, DIGEST))
        await admitted.wait()
        status = asyncio.create_task(self.worker.dispatch_status('owner', IDENT, DIGEST))
        await asyncio.sleep(0)
        self.assertFalse(status.done())
        release.set()
        await dispatch
        self.assertEqual((await status)['state'], 'accepted')

    async def test_old_process_turn_does_not_hold_future_inputs_forever(self):
        await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        self.worker.active.clear()
        self.worker.adapter = NS(_session_tasks={})
        self.worker.operational.set()
        status = await self.worker.dispatch_status('owner', IDENT, DIGEST)
        self.assertEqual(status['state'], 'interrupted')
        self.assertEqual(status['receipt'], RECEIPT)
        again = await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        self.assertEqual(again['delivery_state'], 'interrupted')
        self.worker._dispatch_native.assert_awaited_once()

    async def test_native_refusal_keeps_input_retryable_instead_of_fake_handled(self):
        self.worker._dispatch_native.side_effect = [
            {'accepted': False, 'turn_id': None}, RECEIPT]
        first = await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        self.assertEqual(first['delivery_state'], 'not_received')
        self.assertEqual(await self.worker.dispatch_status('owner', IDENT, DIGEST), {'state': 'not_received'})
        second = await self.worker.dispatch({}, 'owner', IDENT, DIGEST)
        self.assertTrue(second['accepted'])
        self.assertEqual(self.worker._dispatch_native.await_count, 2)

    async def test_trusted_rpc_enables_delivery_for_existing_worker_unit_without_instance_env(self):
        self.worker.delivery_journal = None
        self.worker.adapter = NS()
        self.worker.peer = NS(call=AsyncMock())
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker', 'HERMES_HOME': self.tmp.name}):
            os.environ.pop('BRAI_IDENTITY_INSTANCE', None)
            self.assertEqual(await self.worker.flush_outputs('owner'), {'sent': 0})
        self.assertIsNotNone(self.worker.delivery_journal)
        self.assertIs(self.worker.adapter._brai_delivery_journal, self.worker.delivery_journal)


class ReleaseDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_release_uses_owned_outbox_and_skips_the_dev_release_gate(self):
        from identity import telegram_runtime
        with tempfile.TemporaryDirectory() as folder, patch.dict(
                os.environ, {'BRAI_IDENTITY_INSTANCE': 'release'}):
            journal = IdentityJournal(Path(folder) / 'chats')
            resolver = telegram_runtime.Resolver(NS(_bot=None), journal=journal)
            self.assertTrue(resolver.mirror.restartable)
            self.assertIsNotNone(resolver.reply_outbox)
            with patch.object(telegram_runtime, 'broker_call', new_callable=AsyncMock) as broker:
                self.assertFalse(await resolver.input_ready(PROFILE, ('42', '')))
                resolver.ready_profiles.add(PROFILE['uid'])
                self.assertTrue(await resolver.input_ready(PROFILE, ('42', '')))
                resolver.turns[PROFILE['uid']] = {'route': ('42', '123')}
                self.assertFalse(await resolver.input_ready(PROFILE, ('42', '')))
                broker.assert_not_called()


class PumpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {'BRAI_IDENTITY_INSTANCE': 'dev'})
        env.start(); self.addCleanup(env.stop)
        self.inbox = UpdateInbox(IdentityJournal(Path(self.tmp.name) / 'chats'))
        self.transport = TransportInbox(self.inbox.journal)
        self.bot = Bot('123:abc'); self.bot._bot_user = User(123, 'fixture', True)
        self.resolve = AsyncMock(return_value={'state': 'known', 'profile': PROFILE})
        self.mirror = self.new_mirror()

    def new_mirror(self):
        mirror = Mirror(self.inbox, self.resolve, transport=self.transport)
        mirror.app = NS(bot=self.bot, update_queue=asyncio.Queue())
        mirror.bot_id = 123
        mirror.hydrated = True
        mirror.input_ready = AsyncMock(return_value=True)
        return mirror

    def capture(self, ident=1):
        item = update(ident)
        self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
        self.inbox.capture(PROFILE, item, 123)
        return item

    def handing_off(self, ident=1):
        self.capture(ident)
        binding = self.inbox.bind_delivery(PROFILE, 123, [ident])
        self.inbox.claim_for_delivery(PROFILE, 123, ident)
        self.transport.transition(123, ident, 'captured', 'handing_off')
        return binding

    async def test_release_admission_keeps_original_input_captured_until_owner_accepts(self):
        """Непринятый пакет не получает input; после допуска возвращается исходный Update."""
        from identity import telegram_runtime as runtime
        from identity.broker import Broker
        from unittest.mock import Mock
        resolver = runtime.Resolver(NS())
        self.addCleanup(resolver.ledger.close)
        resolver.mirror = self.mirror
        resolver.ready_profiles.add(PROFILE['uid'])
        self.mirror.input_ready = resolver.input_ready
        gateway = NS(input_ready=Mock(return_value=False))
        broker = Broker({'ingressUid': 995}, NS())
        async def rpc(method, params):
            return await broker.call(995, method, params)
        self.capture()
        with patch.object(broker, 'dev_gateway', return_value=gateway), patch.object(runtime, 'broker_call', rpc):
            await self.mirror.pump()
            self.assertTrue(self.mirror.app.update_queue.empty())
            self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')
            gateway.input_ready.return_value = True
            await self.mirror.pump()
            await self.mirror.pump()
            self.assertEqual(self.mirror.app.update_queue.qsize(), 1)
            self.assertEqual(self.mirror.app.update_queue.get_nowait().update_id, 1)

    async def test_release_start_during_native_batch_keeps_original_inbox_unclaimed(self):
        """Закрытие допуска после classify не создаёт bind/claim перед RPC."""
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        self.mirror.input_ready.return_value = False
        result = await self.mirror.before_delivery(NS(_brai_release_updates=[1]))
        self.assertEqual(result, {'deferred': True})
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')
        self.assertIsNone(self.inbox.delivery_for(PROFILE, 123, 1))
        self.assertEqual(self.transport.observe(123, 1)['state'], 'captured')

    async def test_deferred_batch_does_not_call_worker_or_publish_receipt(self):
        """Отложенный batch не создаёт worker receipt и не вызывает worker."""
        from identity.ingress import Bridge
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        self.mirror.input_ready.return_value = False
        bridge = Bridge('owner', '42', 101, '/unused', AsyncMock(), AsyncMock(return_value={}))
        bridge.before_delivery = self.mirror.before_delivery
        bridge.input_receipt = AsyncMock()
        source = NS(chat_id='42', thread_id=None, to_dict=lambda: {'user_id': '42'})
        event = NS(message_id='1', _brai_release_updates=[1])
        peer = NS(call=AsyncMock())
        result = await bridge._dispatch(event, source, peer, {'handing_off': False, 'turn_id': None})
        self.assertEqual(result, {'accepted': False, 'turn_id': None})
        peer.call.assert_not_awaited()
        bridge.input_receipt.assert_not_awaited()
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')

    async def test_worker_absence_then_ready_requeues_without_new_input(self):
        self.capture()
        self.mirror.input_ready.return_value = False
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')
        self.mirror.input_ready.return_value = True
        await self.mirror.pump()
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)
        self.assertEqual(self.mirror.app.update_queue.get_nowait().update_id, 1)

    async def test_disabled_command_is_ignored_before_identity_resolution(self):
        item = update(40, '/help')
        await self.mirror.capture([item], 123)
        self.resolve.assert_not_awaited()
        self.assertEqual(self.transport.observe(123, 40)['state'], 'ignored')
        self.assertEqual(self.mirror.snapshot('123:40')['state'], 'outside')
        ticket = self.mirror.enter('123:40', item)
        self.assertFalse(await self.mirror.classify(ticket, item))
        self.mirror.finish(ticket, {'completed': True})
        self.assertFalse(self.mirror.tracker.tickets)

    async def test_start_remains_admitted_for_ingress_reply(self):
        item = update(41, '/start')
        await self.mirror.capture([item], 123)
        self.assertEqual(self.inbox.observe(PROFILE, 123, 41)['state'], 'captured')
        ticket = self.mirror.enter('123:41', item)
        self.assertFalse(await self.mirror.classify(ticket, item))
        await self.mirror.handled(item)
        self.mirror.finish(ticket, {'completed': True})
        self.assertEqual(self.transport.observe(123, 41)['state'], 'handled')

    async def test_saved_disabled_command_is_blocked_without_replay_and_text_still_runs(self):
        item = update(42, '/help')
        self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
        self.inbox.capture(PROFILE, item, 123)
        self.mirror.reconcile_delivery = AsyncMock()
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.assertEqual(self.inbox.observe(PROFILE, 123, 42)['state'], 'blocked')
        self.assertEqual(self.transport.observe(123, 42)['state'], 'blocked')
        self.mirror.reconcile_delivery.assert_not_awaited()
        self.resolve.assert_not_awaited()
        self.capture(43)
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.get_nowait().update_id, 43)

    async def test_disabled_command_keeps_unknown_profile_history_but_stops_global_replay(self):
        item = update(44, '/new')
        self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
        self.inbox.capture(PROFILE, item, 123)
        self.inbox.claim_for_delivery(PROFILE, 123, 44)
        self.inbox.markunknown(PROFILE, 123, 44)
        await self.mirror.pump()
        self.assertEqual(self.inbox.observe(PROFILE, 123, 44)['state'], 'unknown')
        self.assertEqual(self.transport.observe(123, 44)['state'], 'blocked')
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.resolve.assert_not_awaited()


    async def test_held_hydration_defers_registered_and_unregistered_updates(self):
        self.capture(1)
        outsider = update(2)
        self.transport.capture_batch([(outsider, {'state': 'unregistered'})], 123)
        self.mirror.hydrated = False
        self.mirror.inventory = AsyncMock(return_value={'profiles': [PROFILE]})
        self.mirror.gate_store = object()
        await self.mirror.hydrate_held()
        self.assertTrue(self.mirror.hydrated)
        self.assertTrue(self.mirror.app.update_queue.empty())
        await self.mirror.hydrate()
        self.assertCountEqual([self.mirror.app.update_queue.get_nowait().update_id for _ in range(2)], [1, 2])

    async def test_ingress_restart_preserves_fifo_raw_messages(self):
        for ident in (3, 1, 2): self.capture(ident)
        self.mirror = self.new_mirror()
        await self.mirror.pump()
        self.assertEqual([self.mirror.app.update_queue.get_nowait().update_id for _ in range(3)], [3, 1, 2])




    async def test_voice_and_media_keep_original_file_ids_while_agent_is_offline(self):
        media = [('voice', {'file_id': 'voice-file', 'file_unique_id': 'voice-unique', 'duration': 1}),
                 ('document', {'file_id': 'document-file', 'file_unique_id': 'document-unique', 'file_name': 'fixture.txt'})]
        for ident, (kind, value) in enumerate(media, 10):
            raw = update(ident).to_dict()
            raw['message'].pop('text')
            raw['message'][kind] = value
            item = Update.de_json(raw, self.bot)
            self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
            self.inbox.capture(PROFILE, item, 123)
        self.mirror.input_ready.return_value = False
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.mirror.input_ready.return_value = True
        await self.mirror.pump()
        for kind, value in media:
            queued = self.mirror.app.update_queue.get_nowait()
            self.assertEqual(getattr(queued.message, kind).file_id, value['file_id'])
            self.assertEqual(getattr(queued.message, kind).file_unique_id, value['file_unique_id'])

    async def test_service_topic_creation_is_handled_without_worker_dispatch(self):
        for ident, restartable in ((7, True), (8, False)):
            with self.subTest(restartable=restartable):
                self.inbox.restartable = self.mirror.restartable = restartable
                raw = update(ident).to_dict()
                raw['message'].pop('text')
                raw['message']['forum_topic_created'] = {'name': 'Fixture', 'icon_color': 7322096}
                item = Update.de_json(raw, self.bot)
                self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
                self.inbox.capture(PROFILE, item, 123)
                key = f'123:{ident}'
                self.mirror.register_snapshot(key, {'state': 'known', 'profile': PROFILE})
                self.mirror.enter(key, item)
                self.assertFalse(await self.mirror.classify(key, item))
                self.assertFalse(self.mirror.finish(key, {'completed': True}))
                await self.mirror.recovery_tasks[key]
                self.assertEqual(self.inbox.observe(PROFILE, 123, ident)['state'], 'handled')
                self.assertEqual(self.transport.observe(123, ident)['state'], 'handled')
                self.assertEqual(self.mirror.snapshots, {})

    async def test_frontend_completion_before_rpc_does_not_ack_input(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        self.assertFalse(await self.mirror.classify('123:1', item))
        self.assertFalse(self.mirror.finish('123:1', {'completed': True}))
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')
        self.assertEqual(self.mirror.input_routes, {})
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)

    def batch(self):
        from identity.ordinary_admission import BatchOwnership
        adapter = NS(_bot=self.bot, _pending_text_batches={}, _pending_photo_batches={},
                     _media_group_events={}, _held_inbound_events=[])
        return BatchOwnership(adapter, self.mirror)

    async def test_delayed_batch_keeps_snapshot_after_native_postflight(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        batch = self.batch()
        event = NS(_brai_release_updates=[1])
        batch.tag(event, 1)
        proceed = asyncio.Event()
        async def delayed():
            await proceed.wait()
            await self.mirror.before_delivery(event)
            await self.mirror.accepted(event, RECEIPT)
        task = asyncio.create_task(delayed())
        batch.track(task, event)
        self.assertFalse(self.mirror.finish('123:1', {'completed': True}))
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        proceed.set()
        await task
        await asyncio.sleep(0)
        self.assertEqual(self.transport.observe(123, 1)['state'], 'accepted')
        self.assertEqual(self.mirror.snapshots, {})
        self.assertEqual(self.mirror.pending_snapshots, set())

    async def test_rearmed_text_batch_retains_every_merged_update_after_pop(self):
        batch = self.batch()
        batch.adapter._text_batch_key = lambda event: 'route'
        tasks = batch.adapter._pending_text_batch_tasks = {}
        pending = batch.adapter._pending_text_batches
        events = []
        for ident in (1, 2):
            item = self.capture(ident)
            self.mirror.register_snapshot(f'123:{ident}', {'state': 'known', 'profile': PROFILE})
            self.mirror.enter(f'123:{ident}', item)
            await self.mirror.classify(f'123:{ident}', item)
            event = NS(_brai_release_updates=[ident])
            batch.tag(event, ident)
            events.append(event)
        first = asyncio.create_task(asyncio.Event().wait())
        pending['route'] = events[0]
        tasks['route'] = first
        batch.track(first, events[0])
        self.mirror.finish('123:1', {'completed': True})
        popped, proceed = asyncio.Event(), asyncio.Event()
        async def flush():
            combined = pending.pop('route')
            popped.set()
            await proceed.wait()
            await self.mirror.before_delivery(combined)
            await self.mirror.accepted(combined, RECEIPT)
        second = asyncio.create_task(flush())
        tasks['route'] = second
        batch.text(events[1], {'route': first}, 'after')
        self.mirror.finish('123:2', {'completed': True})
        await popped.wait()
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        self.assertIn('123:1', self.mirror.snapshots)
        self.assertIn('123:2', self.mirror.snapshots)
        proceed.set()
        await second
        await asyncio.sleep(0)
        self.assertEqual(self.mirror.snapshots, {})
        for ident in (1, 2):
            self.assertEqual(self.transport.observe(123, ident)['state'], 'accepted')

    async def test_cancelled_batch_without_receipt_requeues_automatically(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        batch = self.batch()
        event = NS(_brai_release_updates=[1])
        batch.tag(event, 1)
        task = asyncio.create_task(asyncio.Event().wait())
        batch.track(task, event)
        self.mirror.finish('123:1', {'completed': True})
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')

    async def test_held_redispatch_retains_snapshot_until_callback_finishes(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        batch = self.batch()
        event = NS(_brai_release_updates=[1])
        batch.tag(event, 1)
        batch.adapter._held_inbound_events.append(event)
        self.mirror.finish('123:1', {'completed': True})
        batch.take_held([event])
        batch.adapter._held_inbound_events.clear()
        await self.mirror.before_delivery(event)
        await self.mirror.accepted(event, RECEIPT)
        batch.finish_held(event)
        self.assertEqual(self.transport.observe(123, 1)['state'], 'accepted')
        self.assertEqual(self.mirror.snapshots, {})

    async def test_accepted_route_is_released_for_next_topic(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        event = NS(_brai_release_updates=[1])
        await self.mirror.before_delivery(event)
        await self.mirror.accepted(event, RECEIPT)
        self.assertTrue(self.mirror.finish('123:1', {'completed': True}))
        self.assertEqual(self.mirror.input_routes, {})

    async def test_native_refusal_leaves_claim_deferred_and_automatically_requeued(self):
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        await self.mirror.classify('123:1', item)
        event = NS(_brai_release_updates=[1])
        await self.mirror.before_delivery(event)
        await self.mirror.accepted(event, {'accepted': False, 'turn_id': None, 'delivery_state': 'not_received'})
        self.assertFalse(self.mirror.finish('123:1', {'completed': True}))
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'not_received'})
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')

    async def test_pause_preflight_defers_before_media_or_dispatch(self):
        self.inbox.journal.set_chat_pause(PROFILE, ('42', ''), True)
        item = self.capture()
        self.mirror.register_snapshot('123:1', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:1', item)
        self.assertTrue(await self.mirror.classify('123:1', item))
        self.assertFalse(self.mirror.finish('123:1', {'completed': True, 'deferred': True}))
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'captured')

    async def test_lost_rpc_ack_reconciles_instead_of_reexecuting(self):
        binding = self.handing_off()
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'accepted', 'receipt': RECEIPT})
        await self.mirror.pump()
        self.mirror.reconcile_delivery.assert_awaited_once_with(PROFILE, binding)
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.assertEqual(self.inbox.observe(PROFILE, 123, 1)['state'], 'accepted')
        self.assertEqual(self.transport.observe(123, 1)['state'], 'accepted')

    async def test_proven_not_received_requeues_with_no_manual_reset(self):
        self.handing_off()
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'not_received'})
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)
        self.assertEqual(self.transport.observe(123, 1)['state'], 'captured')
        self.assertIsNone(self.inbox.delivery_for(PROFILE, 123, 1))

    async def test_crash_between_profile_and_transport_claim_is_recoverable(self):
        self.capture()
        self.inbox.bind_delivery(PROFILE, 123, [1])
        self.inbox.claim_for_delivery(PROFILE, 123, 1)
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'not_received'})
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 1)

    async def test_crash_after_binding_before_claim_allows_rebatch_with_later_message(self):
        self.capture(1)
        self.inbox.bind_delivery(PROFILE, 123, [1])
        self.capture(2)
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'not_received'})
        await self.mirror.pump()
        self.assertEqual(self.mirror.app.update_queue.qsize(), 2)
        rebound = self.inbox.bind_delivery(PROFILE, 123, [1, 2])
        self.assertEqual(self.inbox.delivery_for(PROFILE, 123, 1), rebound)

    async def test_crash_after_profile_receipt_before_transport_receipt(self):
        self.handing_off()
        self.inbox.markaccepted(PROFILE, 123, 1, RECEIPT)
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'accepted', 'receipt': RECEIPT})
        await self.mirror.pump()
        self.assertEqual(self.transport.observe(123, 1)['state'], 'accepted')

    async def test_ambiguous_dispatch_stays_visible_without_fake_ack(self):
        self.handing_off()
        self.mirror.reconcile_delivery = AsyncMock(return_value={'state': 'dispatching', 'receipt': None})
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.assertEqual(self.transport.observe(123, 1)['state'], 'handing_off')

    async def test_pause_and_changed_identity_never_replay(self):
        self.capture()
        self.inbox.journal.set_chat_pause(PROFILE, ('42', ''), True)
        await self.mirror.pump()
        self.assertTrue(self.mirror.app.update_queue.empty())
        self.resolve.return_value = {'state': 'known', 'profile': {**PROFILE, 'userId': 'different'}}
        await self.mirror.pump()
        self.assertEqual(self.transport.observe(123, 1)['state'], 'blocked')


class OutboxTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'outbox.sqlite3'
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.addCleanup(self.db.close)
        self.deliver = AsyncMock(return_value={'success': True, 'message_id': '1'})
        self.outbox = ReplyOutbox(self.db, self.deliver)

    async def test_failed_send_restarts_from_saved_bytes_and_caches_actual_ack(self):
        body = {'action': 'send', 'payload': {'text': 'Ответ'}}
        self.outbox.enqueue(IDENT, 'owner', body)
        self.deliver.side_effect = ConnectionError('offline')
        await self.outbox.flush()
        self.assertFalse(self.outbox.result(IDENT)['success'])
        self.deliver.side_effect = None
        restarted = ReplyOutbox(self.db, self.deliver)
        await restarted.flush()
        await restarted.flush()
        self.assertEqual(self.deliver.await_count, 2)
        self.deliver.assert_awaited_with(body)
        self.assertEqual(restarted.result(IDENT), {'success': True, 'message_id': '1'})

    async def test_same_id_cannot_change_owner_or_reply(self):
        self.outbox.enqueue(IDENT, 'owner', {'text': 'first'})
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.outbox.enqueue(IDENT, 'other', {'text': 'first'})
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.outbox.enqueue(IDENT, 'owner', {'text': 'second'})

    async def test_owner_fifo_and_independent_other_owner(self):
        second, other = delivery_id('second'), delivery_id('other')
        for ident, owner in ((IDENT, 'owner'), (second, 'owner'), (other, 'other')):
            self.outbox.enqueue(ident, owner, {'id': ident})
        async def deliver(body):
            return {'success': body['id'] == other, 'message_id': '2' if body['id'] == other else None}
        self.deliver.side_effect = deliver
        await self.outbox.flush()
        self.assertEqual(self.deliver.await_count, 2)
        self.assertIsNone(self.outbox.result(second))
        self.assertTrue(self.outbox.result(other)['success'])

    async def test_release_retries_confirmed_refusal_after_reconnect(self):
        outbox = ReplyOutbox(self.db, self.deliver, retry_unknown=False)
        outbox.enqueue(IDENT, 'owner', {'text': 'Готовый ответ'})
        self.deliver.side_effect = [
            {'success': False, 'retryable': True, 'error': 'send_path_degraded'},
            {'success': True, 'message_id': '101'},
        ]
        await outbox.flush()
        self.assertFalse(outbox.result(IDENT)['success'])
        restarted = ReplyOutbox(self.db, self.deliver, retry_unknown=False)
        await restarted.flush()
        await restarted.flush()
        self.assertEqual(restarted.result(IDENT)['message_id'], '101')
        self.assertEqual(self.deliver.await_count, 2)

    async def test_release_preserves_unknown_external_attempt_without_duplicate(self):
        outbox = ReplyOutbox(self.db, self.deliver, retry_unknown=False)
        outbox.enqueue(IDENT, 'owner', {'text': 'Готовый ответ'})
        self.db.execute("UPDATE reply_outbox SET state='sending'")
        await outbox.flush()
        await outbox.flush()
        self.deliver.assert_not_awaited()
        self.assertEqual(outbox.result(IDENT)['error_kind'], 'delivery_unknown')

    async def test_lost_ack_after_sending_is_retried_but_explicit_forbidden_is_not(self):
        self.outbox.enqueue(IDENT, 'owner', {'text': 'saved'})
        self.db.execute("UPDATE reply_outbox SET state='sending'")
        self.deliver.side_effect = PermissionError('access changed')
        await self.outbox.flush()
        await self.outbox.flush()
        self.deliver.assert_awaited_once()
        self.assertFalse(self.outbox.result(IDENT)['retryable'])
