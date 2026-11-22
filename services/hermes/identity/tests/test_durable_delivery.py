# ABOUTME: Проверяет сохранение доставки, потерянные квитанции и автоматический возврат очереди.
# ABOUTME: Использует настоящие SQLite/PTB Update и перезапуск объектов без пользовательских данных.
import asyncio
import ast
from contextlib import asynccontextmanager, closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
from types import ModuleType, SimpleNamespace as NS
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

    def test_final_output_and_completion_are_one_durable_commit(self):
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        output = delivery_id('final')
        wire = {'payload': {'chat_id': '42', 'content': 'done'}, 'input_delivery_id': IDENT, 'scope_id': None}
        self.store.queue_output(output, 'send', wire, completed_session='session')
        restarted = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restarted.continuation('session')['ready_output'], output)
        self.assertEqual(restarted.pending_outputs()[0]['payload'], wire)
        with self.assertRaisesRegex(ValueError, 'BINDING_CONFLICT'):
            restarted.queue_output(delivery_id('foreign'), 'send', {**wire, 'input_delivery_id': DIGEST},
                                   completed_session='session')
        self.assertEqual(len(restarted.pending_outputs()), 1)

    def test_backup_restores_original_input_and_ready_answer(self):
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        output = delivery_id('backup-answer')
        self.store.queue_output(output, 'send', {'payload': {'content': 'done'},
            'input_delivery_id': IDENT, 'scope_id': None}, completed_session='session')
        backup = self.path.parent / 'restored.sqlite3'
        with sqlite3.connect(self.path) as source, sqlite3.connect(backup) as target:
            source.backup(target)
        backup.chmod(0o600)
        restored = DeliveryJournal(backup, 'owner')
        self.assertEqual(restored.continuation('session'),
                         {'input_id': IDENT, 'chat_generation': 3, 'ready_output': output})
        self.assertEqual(restored.pending_outputs()[0]['id'], output)

    def test_backup_restores_unsent_composed_response_and_anchor(self):
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        preview = {'text_content': 'answer', 'media_files': [['/tmp/file.pdf', False]],
                   'images': [], 'local_files': [], 'force_document_attachments': False, 'pre_extract': 'answer MEDIA:file'}
        self.store.save_response('session', IDENT, 'answer MEDIA:file', {'message_id': '71'}, preview=preview)
        self.store.save_response_plan('session', IDENT, {'batches': [{'kind': 'single', 'items': [
            {'artifact': {'artifact_id': 'file'}, 'caption': '', 'presentation': 'document'}]}]})
        backup = self.path.parent / 'composed.sqlite3'
        with sqlite3.connect(self.path) as source, sqlite3.connect(backup) as target:
            source.backup(target)
        backup.chmod(0o600)
        journal = DeliveryJournal(backup, 'owner')
        restored = journal.continuation('session')
        self.assertEqual((restored['ready_response'], restored['response_event']['message_id']),
                         ('answer MEDIA:file', '71'))
        self.assertEqual(journal.prepared_response('session', IDENT)['plan']['batches'][0]['items'][0]['artifact']['artifact_id'], 'file')
        self.assertEqual(journal.prepared_response('session', IDENT)['preview'], preview)

    def test_new_input_keeps_previous_prepared_response_and_outbox(self):
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        self.store.save_response('session', IDENT, 'answer MEDIA:file', {'message_id': '71'}, {'chat_id': '42'})
        newer, newer_digest = delivery_id('newer'), delivery_id('newer-digest')
        self.store.begin_input(newer, newer_digest)
        self.store.save_continuation('session', newer, 3)
        restored = DeliveryJournal(self.path, 'owner')
        self.assertEqual(restored.continuation('session')['input_id'], newer)
        self.assertEqual(restored.prepared_response('session', IDENT)['response'], 'answer MEDIA:file')
        output = delivery_id('saved-file')
        restored.enqueue_response('session', IDENT, [(output, 'send_file_set',
            {'payload': {'chat_id': '42'}, 'scope_id': None, 'input_delivery_id': IDENT})])
        restored.clear_response('session', IDENT, 'answer MEDIA:file')
        self.assertEqual(restored.continuation('session')['input_id'], newer)
        self.assertEqual(restored.pending_outputs()[0]['id'], output)

    def test_prepared_batch_conflict_rolls_back_all_outputs(self):
        self.store.begin_input(IDENT, DIGEST)
        self.store.save_continuation('session', IDENT, 3)
        self.store.save_response('session', IDENT, 'answer')
        first, conflict = delivery_id('first-file'), delivery_id('conflict-file')
        self.store.queue_output(conflict, 'send', {'payload': {'content': 'different'}})
        with self.assertRaisesRegex(ValueError, 'OUTPUT_CONFLICT'):
            self.store.enqueue_response('session', IDENT, [
                (first, 'send_file_set', {'payload': {'chat_id': '42'}}),
                (conflict, 'send_file_set', {'payload': {'chat_id': '42'}})])
        self.assertIsNone(self.store.output(first))
        self.assertEqual(self.store.prepared_response('session', IDENT)['phase'], 'prepared')

    def test_streamed_media_preserves_native_audio_and_document_routing(self):
        from identity.adapter import _streamed_batches
        def item(name, mime, presentation):
            return {'file': {'artifactId': name, 'filename': name, 'mimeType': mime},
                    'caption': '', 'presentation': presentation}
        source = NS(platform='telegram')
        samples = [item('sample.ogg', 'audio/ogg', 'voice'), item('song.mp3', 'audio/mpeg', 'audio'),
                   item('voice.wav', 'audio/wav', 'document'), item('image.png', 'image/png', 'photo'),
                   item('movie.mp4', 'video/mp4', 'video')]
        media = [('sample.ogg', False), ('song.mp3', False), ('voice.wav', True),
                 ('image.png', False), ('movie.mp4', False)]
        batches, _ = _streamed_batches(samples, media, source, True)
        self.assertEqual([batch.get('action', 'send_file_set') for batch in batches],
                         ['send_file_set', 'send_file_set', 'send_voice', 'send_file_set', 'send_file_set'])
        self.assertEqual([batch['items'][0]['presentation'] for batch in batches if 'items' in batch],
                         ['document', 'audio', 'document', 'video'])
        self.assertTrue(batches[2]['is_voice'])


class FailedTurnRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.worker = Worker(os.getuid() + 1, 'owner', '42', None)
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        self.worker.delivery_journal.begin_input(IDENT, DIGEST)
        self.worker.peer = NS(closed=False, call=AsyncMock(return_value={'allowed': True}))
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
        self.assertEqual(self.worker.delivery_journal.continuation('session')['input_id'], IDENT)

    async def test_recovered_turn_has_ephemeral_shutdown_route_only_while_running(self):
        from identity.scope import ephemeral_input, delivery_scope
        started, release = asyncio.Event(), asyncio.Event()
        async def resume(adapter, event, key):
            started.set()
            await release.wait()
        self.runner._run_startup_resume_event.side_effect = resume
        task = asyncio.create_task(self.worker._resume_failed_turn(
            self.runner, self.adapter, NS(source=self.source), 'session', IDENT))
        await started.wait()
        with self.worker.shutdown_notice_scope('session') as allowed:
            self.assertTrue(allowed)
            self.assertEqual(ephemeral_input.get(), IDENT)
            self.assertIsNone(delivery_scope.get())
        self.assertIsNone(ephemeral_input.get())
        self.worker.chat_states[('42', '7')]['paused'] = True
        with self.worker.shutdown_notice_scope('session') as allowed:
            self.assertFalse(allowed)
        release.set()
        await task
        with self.worker.shutdown_notice_scope('session') as allowed:
            self.assertFalse(allowed)

    async def test_ephemeral_shutdown_never_enters_worker_outbox(self):
        from identity.scope import ephemeral_input
        from identity.adapter import make_adapter
        class Base:
            def __init__(self, config):
                pass
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': '81'}))
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', peer, None)
        adapter._brai_delivery_journal = self.worker.delivery_journal
        token = ephemeral_input.set(IDENT)
        try:
            result = await adapter._action('send', {'chat_id': '42', 'content': 'warning', 'metadata': {'thread_id': '7'}})
        finally:
            ephemeral_input.reset(token)
        self.assertTrue(result.success)
        wire = peer.call.await_args.args[1]
        self.assertEqual(wire['input_delivery_id'], IDENT)
        self.assertNotIn('delivery_id', wire)
        self.assertEqual(self.worker.delivery_journal.pending_outputs(), [])

    async def test_final_text_is_recorded_before_network_and_tied_to_input(self):
        from identity.scope import input_delivery
        from identity.adapter import make_adapter
        class Base:
            def __init__(self, config):
                pass
            async def _send_final_text(self, event, key, *args, **kwargs):
                return await self._action('send', {'chat_id': '42', 'content': 'done', 'metadata': {'thread_id': '7'}})
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        async def send(method, wire):
            self.assertEqual(self.worker.delivery_journal.continuation('session')['ready_output'], wire['delivery_id'])
            return {'success': True, 'message_id': '81'}
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', NS(call=send), None)
        adapter._brai_delivery_journal = self.worker.delivery_journal
        token = input_delivery.set(IDENT)
        try:
            result = await adapter._send_final_text(NS(_brai_single_text=True, _brai_successful_turn=True),
                'session', 'done', {'thread_id': '7'}, False, 0, lambda result: None)
        finally:
            input_delivery.reset(token)
        self.assertTrue(result.success)

    async def test_voice_after_staging_reuses_original_outbox_id(self):
        from gateway.config import Platform
        from gateway.platforms.event import MessageType
        from gateway.session import SessionSource
        from identity.scope import input_delivery, prepared_response, prepared_voice
        from identity.adapter import make_adapter
        class Base:
            def __init__(self, config):
                pass
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': '81'}))
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', peer, None)
        adapter._brai_delivery_journal = self.worker.delivery_journal
        adapter._streaming_tts_turn_completed = lambda *args: False
        adapter._preview_prepared_response = AsyncMock(return_value={'text_content': 'answer', 'images': [],
            'media_files': [], 'local_files': [], 'force_document_attachments': False, 'pre_extract': 'answer'})
        self.runner._delivery_adapter_for = lambda source: adapter
        self.runner._should_send_voice_reply = lambda *args, **kwargs: True
        source = SessionSource(platform=Platform.TELEGRAM, chat_id='42', user_id='42', thread_id='7')
        event = NS(source=source, message_id='71', message_type=MessageType.VOICE)
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        async def deliver(*args, **kwargs):
            self.assertEqual(self.worker.delivery_journal.prepared_response('session', IDENT)['response'], 'answer')
            return await adapter._action('send_voice', {'chat_id': '42', 'artifact': {'artifact_id': 'first'},
                'caption': None, 'metadata': {'thread_id': '7'}})
        self.runner._hmwa_deliver_turn_response = deliver
        self.worker._install_failure_recovery(self.runner)
        t1, t2, t3 = input_delivery.set(IDENT), prepared_response.set(None), prepared_voice.set([0])
        try:
            result = await self.runner._hmwa_deliver_turn_response(event, source, self.entry, 'session', 0,
                {'completed': True}, [], 'answer', '', False)
            self.assertTrue(result.success)
            prepared_voice.set([0])
            replay = await adapter._action('send_voice', {'chat_id': '42', 'artifact': {'artifact_id': 'regenerated'},
                'caption': None, 'metadata': {'thread_id': '7'}})
            self.assertTrue(replay.success)
        finally:
            prepared_voice.reset(t3)
            prepared_response.reset(t2)
            input_delivery.reset(t1)
        peer.call.assert_awaited_once()

    async def test_followup_uses_its_own_input_instead_of_old_task_context(self):
        from identity.scope import input_delivery, delivery_scope
        from identity.adapter import make_adapter
        next_input = delivery_id('followup')
        class Base:
            def __init__(self, config):
                pass
            async def _process_message_background(self, event, key):
                return input_delivery.get(), delivery_scope.get()
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', NS(), None)
        old_input, old_scope = input_delivery.set(IDENT), delivery_scope.set('old')
        try:
            event = NS(internal=False, _brai_identity_input_id=next_input, _brai_delivery_scope='new')
            self.assertEqual(await adapter._process_message_background(event, 'session'), (next_input, 'new'))
            self.assertEqual((input_delivery.get(), delivery_scope.get()), (IDENT, 'old'))
        finally:
            input_delivery.reset(old_input)
            delivery_scope.reset(old_scope)

    async def test_composed_response_resumes_delivery_without_repeating_text_or_model(self):
        from identity.scope import input_delivery
        from identity.adapter import make_adapter
        class Base:
            def __init__(self, config):
                self.crash = True
            async def _extract_response_content(self, response, event, key, **kwargs):
                if not self.crash:
                    raise AssertionError('Replay must use saved media plan after temporary file disappears')
                return NS(text_content='answer', images=[], media_files=[('file', False)], local_files=[])
            async def _send_final_text(self, event, key, text, metadata, ephemeral, ttl, record):
                record(await self._action('send', {'chat_id': '42', 'content': text,
                                                   'reply_to': event.message_id, 'metadata': metadata}))
            async def _deliver_attachments(self, event, extracted, metadata, *, anything_sent, record_delivery):
                record_delivery(await self._action('send_file_set', {'chat_id': '42', 'metadata': metadata,
                    'items': [{'artifact': {'artifact_id': 'file'}, 'caption': '', 'presentation': 'document'}],
                    'kind': 'single', 'fallback': False}))
            async def _release_turn_marker(self, event):
                return None
            async def _process_message_background(self, event, key):
                if getattr(event, '_brai_ready_response', None):
                    from identity.scope import prepared_response
                    prepared_response.set((key, IDENT, event._brai_ready_response))
                extracted = await self._extract_response_content('answer MEDIA:file', event, key)
                await self._send_final_text(event, key, extracted.text_content, {'thread_id': '7'}, False, 0, lambda _: None)
                if self.crash:
                    raise RuntimeError('synthetic crash')
                await self._deliver_attachments(event, extracted, {'thread_id': '7'}, anything_sent=True, record_delivery=lambda _: None)
                await self._release_turn_marker(event)
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        files = ModuleType('brai_files')
        files.output_items = lambda paths: ([{'file': {'artifactId': 'file', 'mimeType': 'application/pdf'},
                                             'caption': '', 'presentation': 'document'}], 'files')
        files.validate_telegram = lambda items: None
        files.key = lambda value: delivery_id(value)
        files.source_of = lambda event: {'chat': '42'}
        files.store = lambda: NS(cleanup=lambda ident: None)
        patched_files = patch.dict(sys.modules, {'brai_files': files})
        patched_files.start()
        self.addCleanup(patched_files.stop)
        peer = NS(call=AsyncMock(side_effect=[{'success': True, 'message_id': '1'},
                                              {'success': True, 'message_id': '2'}]))
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', peer, None)
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        adapter._brai_delivery_journal = self.worker.delivery_journal
        adapter.gateway_runner = self.runner
        self.runner.async_session_store.clear_resume_pending = AsyncMock()
        event = NS(internal=True, _brai_successful_turn=True, message_id='71', source=NS(chat_id='42'))
        token = input_delivery.set(IDENT)
        try:
            with self.assertRaisesRegex(RuntimeError, 'synthetic crash'):
                await adapter._process_message_background(event, 'session')
            self.assertEqual(self.worker.delivery_journal.continuation('session')['ready_response'], 'answer MEDIA:file')
            self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
            adapter._brai_delivery_journal = self.worker.delivery_journal
            adapter.crash = False
            await adapter._process_message_background(NS(internal=True, _brai_successful_turn=True, message_id='71',
                _brai_ready_response='answer MEDIA:file', source=NS(chat_id='42')), 'session')
        finally:
            input_delivery.reset(token)
        self.assertEqual([call.args[1]['action'] for call in peer.call.await_args_list], ['send'])
        self.assertEqual(self.worker.delivery_journal.pending_outputs()[0]['action'], 'send_file_set')
        self.assertNotIn('ready_response', self.worker.delivery_journal.continuation('session'))
        self.runner.async_session_store.clear_resume_pending.assert_awaited_once_with('session')

    async def test_restart_rebinds_running_turn_and_rejects_stale_route(self):
        from identity.scope import input_delivery, continuation_turn, ephemeral_input
        self.runner._mark_durable_active_turn = AsyncMock(return_value=True)
        self.runner._peek_session_state = lambda key: self.slot
        self.runner._release_running_agent_state = Mock()
        original = self.runner._run_startup_resume_event
        async def resume(adapter, event, key):
            self.assertEqual(input_delivery.get(), IDENT)
            self.assertTrue(continuation_turn.get())
            with self.worker.shutdown_notice_scope(key) as allowed:
                self.assertTrue(allowed)
                self.assertEqual(ephemeral_input.get(), IDENT)
        original.side_effect = resume
        self.worker._install_restart_recovery(self.runner)
        event = NS(source=self.source, _brai_chat_generation=3)
        token = input_delivery.set(IDENT)
        try:
            await self.runner._mark_durable_active_turn(event, 'session')
        finally:
            input_delivery.reset(token)
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        original.assert_awaited_once()
        self.worker.chat_states[('42', '7')]['generation'] = 4
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        original.assert_awaited_once()
        self.worker.chat_states[('42', '7')]['generation'] = 3
        self.worker.peer.call.side_effect = PermissionError('revoked')
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        original.assert_awaited_once()
        self.assertIsNone(input_delivery.get())

    async def test_restart_delivers_saved_final_without_reexecuting_model(self):
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        output = delivery_id('answer')
        self.worker.delivery_journal.queue_output(output, 'send',
            {'payload': {'chat_id': '42', 'content': 'done'}, 'scope_id': None, 'input_delivery_id': IDENT},
            completed_session='session')
        self.worker.delivery_journal = DeliveryJournal(Path(self.tmp.name) / 'delivery.sqlite3', 'owner')
        self.runner._peek_session_state = lambda key: self.slot
        self.runner._release_running_agent_state = Mock()
        self.runner.async_session_store.clear_resume_pending = AsyncMock()
        original = self.runner._run_startup_resume_event
        self.worker._install_restart_recovery(self.runner)
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        original.assert_not_awaited()
        self.runner.async_session_store.clear_resume_pending.assert_awaited_once_with('session')
        self.assertEqual(self.worker.delivery_journal.pending_outputs()[0]['id'], output)

    async def test_restart_retries_after_transient_authorization_failure(self):
        from gateway.run import _AGENT_PENDING_SENTINEL
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.entry.resume_pending, self.entry.resume_reason = True, 'restart_timeout'
        self.slot.turn.agent = _AGENT_PENDING_SENTINEL
        self.runner._peek_session_state = lambda key: self.slot
        self.runner._release_running_agent_state = lambda key: setattr(self.slot.turn, 'agent', None)
        self.worker.peer.call.side_effect = [ConnectionError('temporary'), {'allowed': True}]
        original = self.runner._run_startup_resume_event
        self.worker._install_restart_recovery(self.runner)
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        self.assertTrue(self.entry.resume_pending)
        original.assert_not_awaited()
        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
            await self.worker._retry_failed_sessions()
        await asyncio.gather(*self.tasks)
        original.assert_awaited_once()

    async def test_saved_composed_response_bypasses_model_on_restart(self):
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.worker.delivery_journal.save_response('session', IDENT, 'answer MEDIA:file',
            {'message_id': '71', 'reply_to_message_id': None})
        self.runner._peek_session_state = lambda key: self.slot
        self.runner._release_running_agent_state = Mock()
        model = self.runner._handle_message_with_agent = AsyncMock()
        async def resume(adapter, event, key):
            self.assertEqual(event.message_id, '71')
            self.assertEqual(await self.runner._handle_message_with_agent(event, event.source, key), 'answer MEDIA:file')
        self.runner._run_startup_resume_event.side_effect = resume
        self.worker._install_restart_recovery(self.runner)
        await self.runner._run_startup_resume_event(self.adapter, NS(source=self.source), 'session')
        model.assert_not_awaited()

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

    async def test_ordinary_restart_also_has_no_new_expiry(self):
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.entry.resume_pending, self.entry.resume_reason = True, 'restart_timeout'
        self.entry.last_resume_marked_at = '2000-01-01T00:00:00'
        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
            await self.worker._retry_failed_sessions()
            await asyncio.gather(*self.tasks)
        self.runner._run_startup_resume_event.assert_awaited_once()

    async def test_prepared_old_response_restarts_after_new_turn(self):
        from gateway.config import Platform
        from gateway.session import SessionSource
        source = SessionSource(platform=Platform.TELEGRAM, chat_id='42', user_id='42', thread_id='7')
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        self.worker.delivery_journal.save_response('session', IDENT, 'old response', {'message_id': '71'}, source.to_dict())
        newer = delivery_id('newer-input')
        self.worker.delivery_journal.begin_input(newer, delivery_id('newer-digest'))
        self.worker.delivery_journal.save_continuation('session', newer, 3)
        self.entry.resume_pending = False
        self.runner._peek_session_state = lambda key: self.slot
        self.runner._release_running_agent_state = Mock()
        self.adapter._session_tasks = {'session': NS(done=lambda: False)}
        original = self.runner._run_startup_resume_event
        async def resume(adapter, event, key):
            self.assertEqual(event._brai_ready_response, 'old response')
            self.assertEqual(event.message_id, '71')
        original.side_effect = resume
        self.worker._install_restart_recovery(self.runner)
        with patch('identity.native_policy.principal', return_value={'role': 'user'}):
            await self.worker._retry_failed_sessions()
            self.assertEqual(self.tasks, [])
            self.adapter._session_tasks.clear()
            await self.worker._retry_failed_sessions()
        await asyncio.gather(*self.tasks)
        original.assert_awaited_once()
        self.assertEqual(self.worker.delivery_journal.continuation('session')['input_id'], newer)

    @unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Pinned native engine required')
    async def test_native_media_plan_survives_removed_temporary_file(self):
        from gateway.config import Platform, PlatformConfig
        from gateway.platforms.base import BasePlatformAdapter
        from gateway.platforms.event import MessageEvent, MessageType
        from gateway.session import SessionSource
        from files import native
        from files.tests.test_files import Backend
        from identity.scope import input_delivery, prepared_response
        from identity.adapter import make_adapter
        class NativeBase(BasePlatformAdapter):
            def __init__(self, config):
                super().__init__(config, Platform.TELEGRAM)
            async def connect(self, **kwargs):
                return True
            async def disconnect(self):
                return None
            async def send(self, *args, **kwargs):
                return NS(success=True, message_id='1')
            async def get_chat_info(self, chat_id):
                return {}
        root = Path(self.tmp.name)
        workspace, cache = root / 'workspace', root / 'cache'
        workspace.mkdir()
        local = workspace / 'result.pdf'
        local.write_bytes(b'%PDF-1.4 synthetic')
        config = {'ownerId': 'owner', 'stateRoot': str(root / 'file-state'), 'resultRoot': str(cache),
                  'readRoots': [str(workspace)], 'account': 'test'}
        module = ModuleType('plugins.platforms.telegram.adapter')
        module.TelegramAdapter = NativeBase
        source = SessionSource(platform=Platform.TELEGRAM, chat_id='42', user_id='42', thread_id='7')
        event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='71')
        event._brai_successful_turn = True
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        response = 'answer\nMEDIA:' + str(local)
        self.worker.delivery_journal.save_response('session', IDENT, response, {'message_id': '71'}, source.to_dict())
        with patch.dict(os.environ, {'HERMES_HOME': str(root),
                'HERMESCUSTOM_ROOT': str(Path(__file__).resolve().parents[2] / 'extensions')}), patch.object(native, '_store', None), \
                patch.object(native, 'schedule_recovery'), patch.dict(sys.modules, {
                    'brai_files': native, 'plugins.platforms.telegram.adapter': module}):
            native.configure(config, Backend(cache))
            peer = NS(call=AsyncMock(side_effect=ConnectionError('synthetic IPC outage')))
            adapter = make_adapter(PlatformConfig(), Platform.TELEGRAM, peer, None)
            adapter._brai_delivery_journal = self.worker.delivery_journal
            adapter.gateway_runner = self.runner
            a, b = input_delivery.set(IDENT), prepared_response.set(('session', IDENT, response))
            try:
                first = await adapter._extract_response_content(response, event, 'session', is_ephemeral_response=False)
                self.assertEqual(len(first.media_files), 1)
                await adapter._send_final_text(event, 'session', first.text_content, {'thread_id': '7'}, False, 0, lambda _: None)
                await adapter._deliver_attachments(event, first, {'thread_id': '7'}, anything_sent=True, record_delivery=lambda _: None)
                self.assertEqual(self.worker.delivery_journal.prepared_response('session', IDENT)['phase'], 'prepared_enqueued')
                local.unlink()
                second = await adapter._extract_response_content(response, event, 'session', is_ephemeral_response=False)
                self.assertEqual(len(second.media_files), 1)
                self.assertEqual(second.text_content, first.text_content)
                self.assertEqual(len(self.worker.delivery_journal.prepared_response('session', IDENT)['plan']['batches']), 1)
                await adapter._send_final_text(event, 'session', second.text_content, {'thread_id': '7'}, False, 0, lambda _: None)
                peer.call.assert_awaited_once()
                self.assertEqual([row['action'] for row in self.worker.delivery_journal.pending_outputs()],
                                 ['send', 'send_file_set'])
                self.worker.peer = NS(call=AsyncMock(side_effect=[{'success': True, 'message_id': '81'},
                    {'success': True, 'message_id': '82', 'raw_response': {'message_ids': ['82']}}]))
                self.assertEqual(await self.worker.flush_outputs('owner'), {'sent': 2})
                self.assertEqual(self.worker.delivery_journal.pending_outputs(), [])
                with native.store().db() as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM deliveries WHERE state='unknown'").fetchone()[0], 0)
                from types import MethodType
                from gateway.run_turn import GatewayTurnMixin
                stream_input = delivery_id('stream-input')
                self.worker.delivery_journal.begin_input(stream_input, delivery_id('stream-digest'))
                self.worker.delivery_journal.save_continuation('stream-session', stream_input, 3)
                streamed_file = workspace / 'stream.pdf'
                streamed_file.write_bytes(b'%PDF-1.4 streamed')
                streamed = 'already streamed\nMEDIA:' + str(streamed_file)
                stream_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='72')
                self.runner._delivery_adapter_for = lambda _source: adapter
                self.runner._event_thread_metadata = lambda _event, _source: {'thread_id': '7'}
                self.runner._should_send_voice_reply = lambda *args, **kwargs: False
                self.runner._hmwa_deliver_turn_response = MethodType(GatewayTurnMixin._hmwa_deliver_turn_response, self.runner)
                self.worker._install_failure_recovery(self.runner)
                nested_input, nested_response = input_delivery.set(stream_input), prepared_response.set(None)
                try:
                    with patch.object(adapter, '_deliver_attachments', AsyncMock(side_effect=RuntimeError('crash before file queue'))):
                        with self.assertRaisesRegex(RuntimeError, 'crash before file queue'):
                            await self.runner._hmwa_deliver_turn_response(stream_event, source, NS(session_id='id'),
                                'stream-session', 0, {'already_sent': True}, [], streamed, 'footer', False)
                    saved = self.worker.delivery_journal.prepared_response('stream-session', stream_input)
                    self.assertEqual(saved['event']['already_streamed'], 'yes')
                    self.assertEqual(saved['phase'], 'prepared')
                    streamed_file.unlink()
                    extracted = await adapter._extract_response_content(streamed, stream_event, 'stream-session', is_ephemeral_response=False)
                    self.assertEqual(extracted.text_content, '')
                    await adapter._deliver_attachments(stream_event, extracted, {'thread_id': '7'},
                        anything_sent=True, record_delivery=lambda _: None)
                    self.assertEqual([row['action'] for row in self.worker.delivery_journal.pending_outputs()],
                                     ['send_file_set', 'send'])
                    for row in self.worker.delivery_journal.pending_outputs():
                        self.worker.delivery_journal.output_state(row['id'], 'sent', {'success': True, 'message_id': '90'})
                    self.worker.delivery_journal.clear_response('stream-session', stream_input, streamed)
                    next_input = delivery_id('stream-input-2')
                    self.worker.delivery_journal.begin_input(next_input, delivery_id('stream-digest-2'))
                    self.worker.delivery_journal.save_continuation('stream-session-2', next_input, 3)
                    next_file = workspace / 'stream2.pdf'
                    next_file.write_bytes(b'%PDF-1.4 stream2')
                    next_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='74')
                    next_token = input_delivery.set(next_input)
                    try:
                        value = await self.runner._hmwa_deliver_turn_response(next_event, source, NS(session_id='id'),
                            'stream-session-2', 0, {'already_sent': True}, [], 'streamed\nMEDIA:' + str(next_file), 'footer 2', False)
                        self.assertIsNone(value)
                        self.assertEqual([row['action'] for row in self.worker.delivery_journal.pending_outputs()],
                                         ['send_file_set', 'send'])
                    finally:
                        input_delivery.reset(next_token)
                    for row in self.worker.delivery_journal.pending_outputs():
                        self.worker.delivery_journal.output_state(row['id'], 'sent', {'success': True, 'message_id': '91'})
                    footer_input = delivery_id('footer-input')
                    self.worker.delivery_journal.begin_input(footer_input, delivery_id('footer-digest'))
                    self.worker.delivery_journal.save_continuation('footer-session', footer_input, 3)
                    footer_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='75')
                    footer_token = input_delivery.set(footer_input)
                    try:
                        with patch.object(self.worker.delivery_journal, 'enqueue_response', side_effect=sqlite3.OperationalError('temporary')):
                            with self.assertRaises(sqlite3.OperationalError):
                                await self.runner._hmwa_deliver_turn_response(footer_event, source, NS(session_id='id'),
                                    'footer-session', 0, {'already_sent': True}, [], 'streamed body', 'footer only', False)
                        saved_footer = self.worker.delivery_journal.prepared_response('footer-session', footer_input)
                        self.assertEqual(saved_footer['phase'], 'prepared')
                        footer_result = await adapter._extract_response_content('streamed body', footer_event, 'footer-session', is_ephemeral_response=False)
                        await adapter._deliver_attachments(footer_event, footer_result, {'thread_id': '7'},
                            anything_sent=True, record_delivery=lambda _: None)
                        self.assertEqual([row['payload']['payload']['content'] for row in self.worker.delivery_journal.pending_outputs()], ['footer only'])
                    finally:
                        input_delivery.reset(footer_token)
                    for row in self.worker.delivery_journal.pending_outputs():
                        self.worker.delivery_journal.output_state(row['id'], 'sent', {'success': True, 'message_id': '92'})
                    empty_input = delivery_id('empty-stream-input')
                    self.worker.delivery_journal.begin_input(empty_input, delivery_id('empty-stream-digest'))
                    self.worker.delivery_journal.save_continuation('empty-session', empty_input, 3)
                    empty_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='77')
                    empty_token = input_delivery.set(empty_input)
                    try:
                        await self.runner._hmwa_deliver_turn_response(empty_event, source, NS(session_id='id'),
                            'empty-session', 0, {'already_sent': True}, [], '', 'footer without body', False)
                        self.assertEqual([row['payload']['payload']['content'] for row in self.worker.delivery_journal.pending_outputs()],
                                         ['footer without body'])
                    finally:
                        input_delivery.reset(empty_token)
                finally:
                    prepared_response.reset(nested_response)
                    input_delivery.reset(nested_input)
                pre_input = delivery_id('preview-input')
                self.worker.delivery_journal.begin_input(pre_input, delivery_id('preview-digest'))
                self.worker.delivery_journal.save_continuation('preview-session', pre_input, 3)
                original_file = workspace / 'preview.pdf'
                original_file.write_bytes(b'%PDF-1.4 preview')
                rendered = native.final_text('answer\nMEDIA:' + str(original_file), 'preview-operation')
                preview_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='76')
                pi, pp = input_delivery.set(pre_input), prepared_response.set(None)
                try:
                    value = await self.runner._hmwa_deliver_turn_response(preview_event, source, NS(session_id='id'),
                        'preview-session', 0, {'completed': True}, [], rendered, '', False)
                    self.assertEqual(value, rendered)
                    preview = self.worker.delivery_journal.prepared_response('preview-session', pre_input)['preview']
                finally:
                    prepared_response.reset(pp)
                    input_delivery.reset(pi)
                self.assertEqual(len(preview['media_files']), 1)
                temp_path = preview['media_files'][0][0]
                items, _ = native.output_items([temp_path])
                native.release_set(items[0]['_setId'])
                self.assertFalse(Path(temp_path).exists())
                pi, pp = input_delivery.set(pre_input), prepared_response.set(('preview-session', pre_input, rendered))
                try:
                    restored_media = await adapter._extract_response_content(rendered, preview_event, 'preview-session', is_ephemeral_response=False)
                    self.assertEqual(len(restored_media.media_files), 1)
                    self.assertEqual(len(self.worker.delivery_journal.prepared_response('preview-session', pre_input)['plan']['batches']), 1)
                finally:
                    prepared_response.reset(pp)
                    input_delivery.reset(pi)
                for filename, directive, expected_action, expected_presentation in (
                    ('sound.ogg', '', 'send_file_set', 'document'),
                    ('sound.mp3', '', 'send_file_set', 'audio'),
                    ('voice.wav', '[[audio_as_voice]]', 'send_voice', None),
                    ('image.png', '[[as_document]]', 'send_file_set', 'document'),
                ):
                    media_path = workspace / filename
                    media_path.write_bytes(b'synthetic media')
                    media_input = delivery_id(['media-input', filename])
                    key = 'media-' + filename
                    self.worker.delivery_journal.begin_input(media_input, delivery_id(['media-digest', filename]))
                    self.worker.delivery_journal.save_continuation(key, media_input, 3)
                    media_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='78')
                    mi, mr = input_delivery.set(media_input), prepared_response.set(None)
                    try:
                        await self.runner._hmwa_deliver_turn_response(media_event, source, NS(session_id='id'), key, 0,
                            {'already_sent': True}, [], 'streamed\nMEDIA:' + str(media_path) + '\n' + directive, '', False)
                        queued = [row for row in self.worker.delivery_journal.pending_outputs()
                                  if row['payload']['input_delivery_id'] == media_input]
                        self.assertEqual([row['action'] for row in queued], [expected_action])
                        if expected_presentation is not None:
                            self.assertEqual(queued[0]['payload']['payload']['items'][0]['presentation'], expected_presentation)
                        else:
                            self.assertTrue(queued[0]['payload']['payload']['is_voice'])
                    finally:
                        prepared_response.reset(mr)
                        input_delivery.reset(mi)
                url_input = delivery_id('url-input')
                self.worker.delivery_journal.begin_input(url_input, delivery_id('url-digest'))
                self.worker.delivery_journal.save_continuation('url-session', url_input, 3)
                url_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='79')
                ui, ur = input_delivery.set(url_input), prepared_response.set(None)
                try:
                    url_response = 'answer ![pic](https://example.com/pic.png)'
                    await self.runner._hmwa_deliver_turn_response(url_event, source, NS(session_id='id'),
                        'url-session', 0, {'completed': True}, [], url_response, '', False)
                    extracted = await adapter._extract_response_content(url_response, url_event, 'url-session', is_ephemeral_response=False)
                    self.assertEqual(extracted.images, [])
                    self.assertIn('answer', extracted.text_content)
                    self.assertIn('https://example.com/pic.png', extracted.text_content)
                    await adapter._send_final_text(url_event, 'url-session', extracted.text_content,
                        {'thread_id': '7'}, False, 0, lambda _: None)
                    queued = [row for row in self.worker.delivery_journal.pending_outputs()
                              if row['payload']['input_delivery_id'] == url_input]
                    self.assertEqual([row['action'] for row in queued], ['send'])
                finally:
                    prepared_response.reset(ur)
                    input_delivery.reset(ui)
                pdf = workspace / 'set.pdf'
                png = workspace / 'set.png'
                pdf.write_bytes(b'%PDF synthetic')
                png.write_bytes(b'synthetic png')
                pdf_artifact = native.store().resolve(str(pdf), ['fixture', 'pdf'])['artifactId']
                png_artifact = native.store().resolve(str(png), ['fixture', 'png'])['artifactId']
                explicit = native.final_text('BRAI_FILES:' + json.dumps({'mode': 'files', 'items': [
                    {'artifactId': pdf_artifact, 'caption': 'one', 'presentation': 'document'},
                    {'artifactId': png_artifact, 'caption': 'two', 'presentation': 'document'}]}), 'explicit-set')
                set_input = delivery_id('explicit-input')
                self.worker.delivery_journal.begin_input(set_input, delivery_id('explicit-digest'))
                self.worker.delivery_journal.save_continuation('explicit-session', set_input, 3)
                set_event = MessageEvent(text='original', message_type=MessageType.TEXT, source=source, message_id='80')
                si, sr = input_delivery.set(set_input), prepared_response.set(None)
                try:
                    await self.runner._hmwa_deliver_turn_response(set_event, source, NS(session_id='id'),
                        'explicit-session', 0, {'already_sent': True}, [], explicit, '', False)
                    queued = [row for row in self.worker.delivery_journal.pending_outputs()
                              if row['payload']['input_delivery_id'] == set_input]
                    self.assertEqual([row['payload']['payload']['items'][0]['artifact']['artifact_id'] for row in queued],
                                     [pdf_artifact, png_artifact])
                    self.assertEqual([row['payload']['payload']['items'][0]['presentation'] for row in queued],
                                     ['document', 'document'])
                    self.assertEqual([row['payload']['payload']['items'][0]['caption'] for row in queued], ['one', 'two'])
                finally:
                    prepared_response.reset(sr)
                    input_delivery.reset(si)
                from identity.scope import prepared_voice
                voice_input = delivery_id('native-voice-input')
                self.worker.delivery_journal.begin_input(voice_input, delivery_id('native-voice-digest'))
                self.worker.delivery_journal.save_continuation('voice-session', voice_input, 3)
                self.worker.delivery_journal.save_response('voice-session', voice_input, 'voice text', {'message_id': '73'}, source.to_dict())
                publisher = AsyncMock(side_effect=[{'artifact_id': 'voice-artifact'}, ConnectionError('publisher unavailable')])
                voice_peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': '83'}))
                voice_adapter = make_adapter(PlatformConfig(), Platform.TELEGRAM, voice_peer, publisher)
                voice_adapter._brai_delivery_journal = self.worker.delivery_journal
                voice_event = MessageEvent(text='original', message_type=MessageType.VOICE, source=source, message_id='73')
                i, p, v = input_delivery.set(voice_input), prepared_response.set(('voice-session', voice_input, 'voice text')), prepared_voice.set([0])
                try:
                    first = await voice_adapter._play_tts_file(voice_event, 'voice text', str(workspace / 'first.ogg'),
                        True, {'thread_id': '7'}, lambda _: None)
                    self.assertTrue(first)
                    prepared_voice.set([0])
                    second = await voice_adapter._play_tts_file(voice_event, 'voice text', str(workspace / 'second.ogg'),
                        True, {'thread_id': '7'}, lambda _: None)
                    self.assertTrue(second)
                    publisher.assert_awaited_once()
                    voice_peer.call.assert_awaited_once()
                finally:
                    prepared_voice.reset(v)
                    prepared_response.reset(p)
                    input_delivery.reset(i)
            finally:
                prepared_response.reset(b)
                input_delivery.reset(a)

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
        scope = {'logger': Mock()}
        async def tick(_):
            fake._running = False
        scope['asyncio'] = NS(sleep=tick)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(target), 'exec'), scope)
        @asynccontextmanager
        async def release_source():
            yield
        fake = NS(_running=True, _brai_release_source=release_source,
                  _replay_pending_planned_restart_notification=AsyncMock(side_effect=ValueError('broken notice')),
                  _brai_retry_failed_sessions=self.worker._retry_failed_sessions)
        self.entry.resume_pending, self.entry.resume_reason = True, 'brai_technical_failure'
        self.worker.delivery_journal.save_continuation('session', IDENT, 3)
        from gateway import run
        with patch.object(run, '_planned_restart_notification_path', return_value=Mock(exists=Mock(return_value=True))), \
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

    async def test_group_recovery_checks_original_author_and_sends_no_queued_warning(self):
        from identity import telegram_runtime as runtime
        from identity.ingress import Bridge
        item = update(1, message={'message_id': 1, 'date': 1,
            'chat': {'id': -55, 'type': 'supergroup', 'is_forum': True},
            'from': {'id': 42, 'is_bot': False, 'first_name': 'synthetic'},
            'message_thread_id': 7, 'is_topic_message': True, 'text': 'work'})
        self.inbox.capture(PROFILE, item, 123)
        source = self.inbox.bind_delivery(PROFILE, 123, [1])['delivery_id']
        self.inbox.claim_for_delivery(PROFILE, 123, 1)
        self.inbox.markaccepted(PROFILE, 123, 1, RECEIPT)
        resolver = runtime.Resolver(NS(), journal=self.inbox.journal)
        self.addCleanup(resolver.ledger.close)
        route = ('-55', '7')
        resolver.ledger.admit(PROFILE, route, {'thread_id': '7'}, '1')
        resolver._account = AsyncMock(return_value=PROFILE)
        resolver._deliver_route = AsyncMock(return_value={'success': True, 'message_id': '51'})
        bridge = Bridge(PROFILE['userId'], '42', PROFILE['uid'], '/unused', AsyncMock(), None)
        bridge.configure_delivery(require_scope=True, authorize_delivery=
            lambda action, payload: resolver.authorize_delivery(PROFILE, action, payload))
        bridge.durable_delivery = lambda owner, action, payload, ident, input_id: resolver.durable_reply(
            PROFILE, owner, action, payload, ident, input_id)
        bridge.recovery_authorize = lambda owner, input_id, chat, thread: resolver.authorize_recovery(
            PROFILE, owner, input_id, chat, thread)
        self.assertEqual(await bridge.check_recovery(source, '-55', '7'), {'allowed': True})
        result = await bridge.send('send', {'chat_id': '-55', 'content': 'warning',
            'metadata': {'thread_id': '7'}}, scope_id=None, input_delivery_id=source)
        self.assertTrue(result['success'])
        self.assertEqual(resolver._deliver_route.await_args.args[3], route)
        self.assertEqual(resolver.ledger.db.execute('SELECT count(*) FROM reply_outbox').fetchone()[0], 0)
        resolver.ledger.record(PROFILE, route, '51', outgoing=True)
        edited = await bridge.send('edit_message', {'chat_id': '-55', 'message_id': '51',
            'content': 'final', 'finalize': True, 'metadata': {'thread_id': '7'}},
            scope_id=None, input_delivery_id=source)
        self.assertTrue(edited['success'])
        from identity.adapter import make_adapter
        from identity.scope import input_delivery, delivery_scope
        class Base:
            def __init__(self, config):
                pass
        class Peer:
            async def call(self, method, params):
                return await bridge.send(**params)
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', Peer(), None)
        source_token, scope_token = input_delivery.set(source), delivery_scope.set(None)
        try:
            result = await adapter._action('edit_message', {'chat_id': '-55', 'message_id': '51',
                'content': 'streamed final', 'finalize': True, 'metadata': {'thread_id': '7'}})
        finally:
            delivery_scope.reset(scope_token)
            input_delivery.reset(source_token)
        self.assertTrue(result.success)
        with self.assertRaises(PermissionError):
            await bridge.send('edit_message', {'chat_id': '-55', 'message_id': '999',
                'content': 'foreign', 'finalize': True, 'metadata': {'thread_id': '7'}},
                scope_id=None, input_delivery_id=source)
        resolver._account.return_value = {**PROFILE, 'generation': 2}
        with self.assertRaises(PermissionError):
            await bridge.check_recovery(source, '-55', '7')
        with self.assertRaises(PermissionError):
            await bridge.send('send', {'chat_id': '-55', 'content': 'warning',
                'metadata': {'thread_id': '7'}}, scope_id=None, input_delivery_id=source)

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

    async def test_snapshot_restores_exact_envelope_and_receipt(self):
        body = {'action': 'send', 'payload': {'text': 'Ответ'}}
        digest = delivery_id('request')
        self.outbox.enqueue(IDENT, 'owner', body, request_digest=digest)
        await self.outbox.flush()

        with closing(sqlite3.connect(':memory:', isolation_level=None)) as restored:
            self.db.backup(restored)
            stored = restored.execute('SELECT body FROM reply_outbox WHERE id=?', (IDENT,)).fetchone()
            self.assertEqual(json.loads(stored[0]), body)
            old_receipt = restored.execute('SELECT receipt FROM reply_outbox WHERE id=?', (IDENT,)).fetchone()
            self.assertEqual(json.loads(old_receipt[0]), {'success': True, 'message_id': '1'})
            outbox = ReplyOutbox(restored, self.deliver)
            outbox.enqueue(IDENT, 'owner', body, request_digest=digest)
            with self.assertRaisesRegex(ValueError, 'CONFLICT'):
                outbox.enqueue(IDENT, 'owner', {**body, 'payload': {'text': 'Другой ответ'}},
                               request_digest=digest)
            await outbox.flush()
        self.deliver.assert_awaited_once()

    async def test_released_envelope_preserves_its_embedded_request_fingerprint(self):
        digest = delivery_id('previous request')
        body = {'text': 'Ответ'}
        self.db.execute("INSERT INTO reply_outbox(id,owner,body,state) VALUES (?,?,?,'pending')",
                        (IDENT, 'owner', json.dumps({**body, 'requestDigest': digest})))
        self.outbox.enqueue(IDENT, 'owner', body, request_digest=digest)
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.outbox.enqueue(IDENT, 'owner', body, request_digest=delivery_id('different'))

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
