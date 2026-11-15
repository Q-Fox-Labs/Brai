# ABOUTME: Проверяет сохранение доставки, потерянные квитанции и автоматический возврат очереди.
# ABOUTME: Использует настоящие SQLite/PTB Update и перезапуск объектов без пользовательских данных.
import asyncio
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

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
        raw = update(7).to_dict()
        raw['message'].pop('text')
        raw['message']['forum_topic_created'] = {'name': 'Fixture', 'icon_color': 7322096}
        item = Update.de_json(raw, self.bot)
        self.transport.capture_batch([(item, {'state': 'known', 'profile': PROFILE})], 123)
        self.inbox.capture(PROFILE, item, 123)
        self.mirror.register_snapshot('123:7', {'state': 'known', 'profile': PROFILE})
        self.mirror.enter('123:7', item)
        self.assertFalse(await self.mirror.classify('123:7', item))
        self.assertFalse(self.mirror.finish('123:7', {'completed': True}))
        await self.mirror.recovery_tasks['123:7']
        self.assertEqual(self.inbox.observe(PROFILE, 123, 7)['state'], 'handled')
        self.assertEqual(self.transport.observe(123, 7)['state'], 'handled')
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

    async def test_lost_ack_after_sending_is_retried_but_explicit_forbidden_is_not(self):
        self.outbox.enqueue(IDENT, 'owner', {'text': 'saved'})
        self.db.execute("UPDATE reply_outbox SET state='sending'")
        self.deliver.side_effect = PermissionError('access changed')
        await self.outbox.flush()
        await self.outbox.flush()
        self.deliver.assert_awaited_once()
        self.assertFalse(self.outbox.result(IDENT)['retryable'])
