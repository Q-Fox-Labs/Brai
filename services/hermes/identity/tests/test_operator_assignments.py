# ABOUTME: Проверяет скрытый запуск и единственную доставку принятого результата на синтетическом owner.
# ABOUTME: Использует реальную SQLite, штатную исходящую очередь и подставной Telegram transport.
import asyncio
from io import BytesIO
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from types import ModuleType
import unittest
from unittest.mock import AsyncMock, patch
import uuid
from zipfile import ZipFile

from identity.delivery_journal import DeliveryJournal, delivery_id
from identity.operator_assignment_control import OFFICE_DOCUMENTS, OperatorAssignmentControl
from identity.operator_assignments import OperatorAssignments
from identity.reply_outbox import ReplyOutbox
from identity.routes import RouteLedger
from identity.scope import operator_assignment
from identity.telegram_proxy import BotProxy
from identity.telegram_runtime import Resolver
from identity.worker import Worker


class OperatorAssignmentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ledger = RouteLedger()
        self.user, self.profile = 'owner', str(uuid.uuid4())
        self.binding = {'userId': self.user, 'profileId': self.profile, 'uid': 2000,
                        'telegramId': '123', 'authorTelegramId': '123', 'role': 'owner', 'generation': 1}
        self.route = ('123', '88')
        self.ledger.admit(self.binding, self.route, {'thread_id': '88'}, '93')
        self.addCleanup(self.ledger.close)
        self.owner = self.ledger.owner(self.binding)
        self.sent = []
        self.outbox = ReplyOutbox(self.ledger.db, self.deliver, retry_unknown=False)
        self.original = delivery_id(['old rejected reply'])
        self.outbox.enqueue(self.original, self.owner, {'old': True})
        self.ledger.db.execute("UPDATE reply_outbox SET state='blocked',receipt='{}' WHERE id=?", (self.original,))
        self.worker = AsyncMock(side_effect=self.worker_method)
        peer = SimpleNamespace(call=self.worker)
        bridge = SimpleNamespace(connect=AsyncMock(return_value=peer))
        self.resolver = SimpleNamespace(ledger=self.ledger, reply_outbox=self.outbox, release_gate=None,
            _startup_held=lambda: False, _chat_generation=lambda *_: 5,
            _account=AsyncMock(return_value=self.binding), _bridge=lambda profile: bridge)
        self.control = OperatorAssignmentControl(self.resolver, AsyncMock(return_value={
            'state': 'known', 'profile': self.binding,
        }))
        self.output = {'text': 'Проверенный ответ.', 'artifactIds': []}
        self.selector = {'operationId': str(uuid.uuid4()), 'userId': self.user, 'profileId': self.profile,
                         'chat': '123', 'thread': '88', 'anchor': '93'}
        self.instructions = {'sessionKey': 'agent:main:telegram:dm:123:88', 'sessionId': 'owner-session',
                             'instructions': 'Выполни поручение и подготовь ответ.', 'requiredMimeTypes': []}

    async def asyncTearDown(self):
        await self.control.close()

    async def worker_method(self, name, value, *, timeout):
        self.assertEqual(name, 'operator.assignment')
        if value.get('checkOnly'):
            return {'state': 'validated'}
        return {'state': 'ready', 'result': self.output}

    async def deliver(self, envelope, *, begin_attempt):
        await self.control.check_delivery(envelope, self.route)
        self.control.begin_delivery(envelope, begin_attempt)
        self.sent.append(envelope)
        return {'success': True, 'message_id': '101'}

    async def start(self, **overrides):
        state = await self.control('start', **self.selector, **{**self.instructions, **overrides})
        self.assertEqual(state['state'], 'running')
        await self.control.tasks[self.selector['operationId']]
        return await self.control('status', **self.selector)

    async def test_office_documents_are_verified_when_publisher_uses_octet_stream(self):
        artifact = str(uuid.uuid4())
        for suffix, (mime, main_part, main_mime) in OFFICE_DOCUMENTS.items():
            request = {'requiredMimeTypes': [mime]}
            result = {'text': 'Проверенный ответ.', 'artifactIds': [artifact]}
            for expected, declared in ((True, main_mime), (False, 'application/xml')):
                stream = BytesIO()
                with ZipFile(stream, 'w') as file:
                    xml = ('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                           f'<Override PartName="/{main_part}" ContentType="{declared}" /></Types>')
                    file.writestr('[Content_Types].xml', xml)
                    file.writestr(main_part, '<test/>')
                meta = {'artifactId': artifact, 'sizeBytes': stream.tell(), 'filename': 'result' + suffix,
                        'mimeType': 'application/octet-stream'}
                with patch('identity.operator_assignment_control.receive_artifact', return_value=(meta, stream)):
                    if expected:
                        items = await self.control.checked_artifacts(self.binding, request, result)
                        self.assertEqual(items[0]['artifact']['artifact_id'], artifact)
                    else:
                        with self.assertRaisesRegex(ValueError, 'Invalid Office document'):
                            await self.control.checked_artifacts(self.binding, request, result)
                self.assertTrue(stream.closed)

    async def test_approved_new_answer_does_not_reopen_old_output(self):
        ready = await self.start()
        self.assertEqual(ready['state'], 'ready')
        self.assertEqual(self.sent, [])

        await self.control('start', **self.selector, **self.instructions)
        self.worker.assert_awaited_once()
        with self.assertRaises(Exception):
            await self.control('approve', **self.selector, resultDigest='0' * 64)
        self.assertEqual(self.sent, [])
        result = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual((result['state'], result['receipt']['message_id']), ('delivered', '101'))
        self.assertEqual(len(self.sent), 1)
        body = self.sent[0]
        self.assertEqual((body['payload']['chat_id'], body['payload']['reply_to']), ('123', '93'))
        self.assertEqual(body['payload']['content'], self.output['text'])
        self.assertEqual(self.ledger.db.execute('SELECT state FROM reply_outbox WHERE id=?',
                                               (self.original,)).fetchone()[0], 'blocked')
        self.assertEqual((await self.control('status', **self.selector))['state'], 'delivered')
        self.assertEqual(len(self.sent), 1)

    async def test_incomplete_or_foreign_result_cannot_send_a_caption(self):
        self.output['artifactIds'] = [str(uuid.uuid4())]
        ready = await self.start(requiredMimeTypes=['text/plain', 'application/pdf'])
        with self.assertRaisesRegex(ValueError, 'Incomplete operator assignment result'):
            await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        with self.assertRaises(PermissionError):
            await self.control('status', **{**self.selector, 'userId': 'foreign'})
        self.assertEqual(self.sent, [])

    async def test_complete_artifacts_send_together_with_the_prepared_caption(self):
        expected = ['text/plain', 'application/pdf']
        self.output['artifactIds'] = [str(uuid.uuid4()), str(uuid.uuid4())]
        ready = await self.start(requiredMimeTypes=expected)
        receive = AsyncMock(side_effect=[
            ({'artifactId': ident, 'sizeBytes': 4, 'mimeType': mime}, SimpleNamespace(close=lambda: None))
            for ident, mime in zip(self.output['artifactIds'], expected)
        ])
        with patch('identity.operator_assignment_control.receive_artifact', receive):
            result = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(result['state'], 'delivered')
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]['action'], 'send_file_set')
        items = self.sent[0]['payload']['items']
        self.assertEqual([item['artifact']['artifact_id'] for item in items], self.output['artifactIds'])
        self.assertEqual(items[0]['caption'], self.output['text'])

    async def test_cancelled_running_assignment_can_never_publish(self):
        entered = asyncio.Event()

        async def busy(method, *args, **kwargs):
            if method == 'operator.assignment.cancel':
                return {'state': 'stopped'}
            entered.set()
            await asyncio.Future()

        self.worker.side_effect = busy
        await self.control('start', **self.selector, **self.instructions)
        await entered.wait()
        result = await self.control('cancel', **self.selector)
        self.assertEqual(result['state'], 'cancelled')
        self.assertFalse(self.control.store.ready(self.selector['operationId'], self.owner, self.output))
        self.assertEqual(self.sent, [])

    async def test_idless_receipt_is_not_retried_even_on_dev(self):
        self.outbox.retry_unknown = True
        self.outbox.deliver = AsyncMock(return_value={'success': True})
        ready = await self.start()
        status = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(status['state'], 'delivery_blocked')
        await self.outbox.flush()
        self.outbox.deliver.assert_awaited_once()

    async def test_generation_change_before_transport_prevents_network_send(self):
        ready = await self.start()
        self.resolver._chat_generation = lambda *_: 5
        active = self.resolver._account
        active.side_effect = [self.binding, {**self.binding, 'generation': 2}]
        result = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(result['state'], 'delivery_blocked')
        self.assertEqual(self.sent, [])

    async def test_proven_busy_before_transport_preserves_the_approved_result(self):
        ready = await self.start()
        self.worker.side_effect = [{'state': 'validated'}, {'state': 'busy'}, {'state': 'validated'}]
        status = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(status['state'], 'approved')
        self.assertEqual(self.sent, [])
        await self.outbox.flush()
        self.assertEqual(len(self.sent), 1)
        status = await self.control('status', **self.selector)
        self.assertEqual(status['state'], 'delivered')

    async def test_cancel_while_approved_delivery_is_waiting(self):
        ready = await self.start()
        self.worker.side_effect = [{'state': 'validated'}, {'state': 'busy'}]
        approved = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(approved['state'], 'approved')
        status = await self.control('cancel', **self.selector)
        self.assertEqual(status['state'], 'cancelled')
        await self.outbox.flush()
        self.assertEqual(self.sent, [])

    async def test_preparation_connection_failure_leaves_approval_pending(self):
        ready = await self.start()
        self.outbox.deliver = AsyncMock(side_effect=ConnectionError('Preparation unavailable'))
        result = await self.control('approve', **self.selector, resultDigest=ready['resultDigest'])
        self.assertEqual(result['state'], 'approved')
        self.outbox.deliver = self.deliver
        await self.outbox.flush()
        self.assertEqual(len(self.sent), 1)

    async def test_approved_attempt_interrupted_before_network_can_resume(self):
        ready = await self.start()
        self.worker.side_effect = self.worker_method
        entered = asyncio.Event()

        async def blocked(envelope, *, begin_attempt):
            entered.set()
            await asyncio.Future()

        self.outbox.deliver = blocked
        attempt = asyncio.create_task(self.control('approve', **self.selector, resultDigest=ready['resultDigest']))
        await entered.wait()
        attempt.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await attempt
        self.resolver.reply_outbox = ReplyOutbox(self.ledger.db, self.deliver, retry_unknown=False)
        await self.resolver.reply_outbox.flush()
        self.assertEqual(len(self.sent), 1)
        status = await self.control('status', **self.selector)
        self.assertEqual(status['state'], 'delivered')

    async def test_interrupted_network_attempt_is_never_reissued(self):
        ready = await self.start()
        attempted = asyncio.Event()

        async def blocked(envelope, *, begin_attempt):
            await self.control.check_delivery(envelope, self.route)
            self.control.begin_delivery(envelope, begin_attempt)
            attempted.set()
            await asyncio.Future()

        self.outbox.deliver = blocked
        attempt = asyncio.create_task(self.control('approve', **self.selector, resultDigest=ready['resultDigest']))
        await attempted.wait()
        attempt.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await attempt
        self.resolver.reply_outbox = ReplyOutbox(self.ledger.db, self.deliver, retry_unknown=True)
        await self.resolver.reply_outbox.flush()
        self.assertEqual(self.sent, [])
        status = await self.control('status', **self.selector)
        self.assertEqual((status['state'], status['receipt']['error_kind']), ('delivery_blocked', 'delivery_unknown'))

    async def test_reopened_store_does_not_restart_unconfirmed_running_assignment(self):
        entered = asyncio.Event()

        async def busy(*args, **kwargs):
            entered.set()
            await asyncio.Future()

        self.worker.side_effect = busy
        await self.control('start', **self.selector, **self.instructions)
        await entered.wait()
        restarted = OperatorAssignments(self.ledger.db)
        ident = self.selector['operationId']
        self.assertEqual(restarted.read(ident, self.owner)['state'], 'interrupted')
        self.assertFalse(restarted.begin(ident, self.owner))
        self.assertFalse(restarted.ready(ident, self.owner, self.output))


class WorkerOperatorAssignmentTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_reserves_operation_before_lookup(self):
        worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
        worker.operational.set()
        lookup_started = asyncio.Event()

        async def lookup(_session):
            lookup_started.set()
            await asyncio.Future()

        worker.adapter = SimpleNamespace(_session_tasks={})
        injection = AsyncMock()
        worker.runner = SimpleNamespace(async_session_store=SimpleNamespace(lookup_by_session_key=lookup),
                                        _dispatch_plugin_message_injection=injection)
        ident = str(uuid.uuid4())
        turn = asyncio.create_task(worker.run_operator_assignment('owner', ident, 'session', 'existing',
                                                                  '123', '88', 0, 'Выполни поручение.'))
        await lookup_started.wait()
        self.assertEqual(await worker.cancel_operator_assignment('owner', ident), {'state': 'stopped'})
        self.assertTrue(turn.cancelled())
        injection.assert_not_awaited()

    async def test_personal_runner_completes_without_sending_and_is_held_on_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            journal_path = Path(directory) / 'delivery.sqlite3'
            worker = Worker(os.getuid() + 1, 'owner', '123', AsyncMock())
            worker.delivery_journal = DeliveryJournal(journal_path, 'owner')
            worker.operational.set()
            worker.chat_dispatches[('123', '88')] = 0  # The first regular turn has already finished.
            worker.route_allowed = lambda *args, **kwargs: True
            worker.adapter = SimpleNamespace(_session_tasks={}, bind_source=lambda source: None)
            entry = SimpleNamespace(session_id='existing', origin={}, resume_pending=False)
            auth = SimpleNamespace(lookup_by_session_key=AsyncMock(return_value=entry),
                                   clear_resume_pending=AsyncMock())
            entry.origin = {'platform': 'telegram'}
            source = SimpleNamespace(chat_id='123', user_id='123', thread_id='88')
            network = AsyncMock()
            proxy = BotProxy(SimpleNamespace(call=network))
            original_resume = AsyncMock()
            runner = SimpleNamespace(async_session_store=auth, _restored_source=lambda value: source,
                _peek_session_state=lambda key: None, _run_startup_resume_event=original_resume,
                _hmwa_shape_agent_response=AsyncMock(return_value=('Готовый ответ.', False, [])),
                _hmwa_deliver_turn_response=AsyncMock(), _hmwa_agent_error_reply=AsyncMock(),
                _mark_durable_active_turn=AsyncMock(return_value=True))

            async def inject(session_key, content, plugin_id):
                self.assertEqual(plugin_id, 'brai-telegram')

                async def turn():
                    self.assertIsNotNone(operator_assignment.get())
                    self.assertFalse(await runner._mark_durable_active_turn(None, session_key))
                    with self.assertRaises(PermissionError):
                        await proxy.send_message(chat_id=123, text='private progress')
                    result = {'completed': True}
                    await runner._hmwa_shape_agent_response(result, source, [], entry, session_key)
                    await runner._hmwa_deliver_turn_response(None, source, entry, session_key, 1, result)

                worker.adapter._session_tasks[session_key] = asyncio.create_task(turn())
                return True

            runner._dispatch_plugin_message_injection = inject
            worker.runner = runner
            worker._install_failure_recovery(runner)
            ident = str(uuid.uuid4())
            value = await worker.run_operator_assignment('owner', ident, 'session', 'existing',
                                                         '123', '88', 0, 'Выполни поручение.')
            self.assertEqual(value, {'state': 'ready', 'result': {'text': 'Готовый ответ.', 'artifactIds': []}})
            network.assert_not_awaited()
            self.assertIsNone(operator_assignment.get())
            worker.delivery_journal = DeliveryJournal(journal_path, 'owner')
            fake_gateway = ModuleType('gateway.run')
            fake_gateway._AGENT_PENDING_SENTINEL = object()
            with patch.dict(sys.modules, {'gateway.run': fake_gateway}):
                await runner._run_startup_resume_event(worker.adapter, None, 'session')
                auth.clear_resume_pending.assert_awaited_once_with('session')
                original_resume.assert_not_awaited()
                await runner._run_startup_resume_event(worker.adapter, None, 'other-session')
                original_resume.assert_awaited_once()


class OperatorTransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_text_uses_one_exact_bot_call_and_confirmed_route(self):
        async def send(**kwargs):
            self.assertEqual(checked.await_count, 1)
            self.assertEqual({key: kwargs[key] for key in ('chat_id', 'message_thread_id', 'reply_to_message_id',
                'allow_sending_without_reply')}, {'chat_id': 123, 'message_thread_id': 88, 'reply_to_message_id': 93,
                                                  'allow_sending_without_reply': False})
            return SimpleNamespace(chat_id=123, message_thread_id=88, message_id=101)

        resolver = Resolver.__new__(Resolver)
        normal_send = AsyncMock()
        bot = SimpleNamespace(send_message=AsyncMock(side_effect=send))
        resolver.adapter = SimpleNamespace(_bot=bot, format_message=str, send=normal_send)
        resolver.journal = None
        recorded = []
        resolver._record_delivery = lambda *args, **kwargs: recorded.append(args)
        checked = AsyncMock()
        current = lambda: None
        current.generation = 5
        result = await resolver._deliver_route({'uid': 1}, 'send',
            {'chat_id': '123', 'reply_to': '93', 'content': 'Prepared response'}, ('123', '88'),
            {'thread_id': '88'}, None, current, before_send=checked)
        self.assertEqual(result, {'success': True, 'message_id': '101'})
        self.assertEqual(recorded[0][1:], (('123', '88'), 101, 5))
        bot.send_message.assert_awaited_once()
        normal_send.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
