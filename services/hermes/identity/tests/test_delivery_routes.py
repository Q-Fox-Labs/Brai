# ABOUTME: Проверяет фоновые доставки, callback ownership и поздние ответы.
# ABOUTME: Реальный журнал прав используется без Telegram и Auth сети.
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.routes import RouteLedger
from identity.scope import request_scope
from identity import telegram_runtime as runtime
from identity.ingress import Bridge
from identity.ipc import RpcError


def profile(uid=101):
    return {'uid': uid, 'userId': 'owner' + str(uid), 'profileId': 'profile' + str(uid),
            'telegramId': str(uid + 22), 'workerSocket': '/unused'}


class LedgerTest(unittest.TestCase):
    def test_restart_keeps_owned_ids_but_not_reassigned_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'routes.sqlite'
            ledger = RouteLedger(path)
            ledger.admit(profile(), ('-900', '7'), {'thread_id': '7'}, '42')
            ledger.record(profile(), ('-900', '7'), '43')
            ledger.close()
            ledger = RouteLedger(path)
            self.assertEqual(ledger.metadata(profile(), ('-900', '7')), {'thread_id': '7'})
            self.assertTrue(ledger.owns(profile(), ('-900', '7'), '43', outgoing=True))
            self.assertFalse(ledger.owns(profile(), ('-900', '7'), '42', outgoing=True))
            replacement = {**profile(), 'userId': 'replacement'}
            self.assertFalse(ledger.owns(replacement, ('-900', '7'), '43'))
            ledger.close()

    def test_linked_ledger_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            canary = Path(directory) / 'canary'
            canary.write_bytes(b'canary')
            (Path(directory) / 'state').symlink_to(canary)
            with self.assertRaises(OSError):
                RouteLedger(Path(directory) / 'state')
            self.assertEqual(canary.read_bytes(), b'canary')


class DeliveryRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def test_owner_proactive_send_uses_persistent_route_without_input_turn(self):
        adapter = NS(send=AsyncMock(return_value={'success': True, 'message_id': '200'}))
        resolver = runtime.Resolver(adapter)
        resolver.ledger.admit(profile(), ('-900', '7'), {'thread_id': '7', 'direct_messages_topic_id': 70})
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())) as broker:
                result = await resolver.deliver(profile(), profile()['userId'], 'send',
                    {'chat_id': '-900', 'content': 'job done', 'metadata': {'thread_id': '7'}})
            self.assertTrue(result['success'])
            self.assertEqual(broker.await_args.args[0], 'identity.resolve')
            self.assertEqual(adapter.send.await_args.kwargs['metadata']['direct_messages_topic_id'], 70)
            self.assertTrue(resolver.ledger.owns(profile(), ('-900', '7'), '200', outgoing=True))
        finally:
            request_scope.reset(token)

    async def test_expired_turn_nonce_cannot_become_proactive_delivery(self):
        adapter = NS(send=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.ledger.admit(profile(), ('123', ''), {})
        resolver.turns[101] = {'id': 'new', 'route': ('123', '')}
        token = request_scope.set('old')
        try:
            with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                with self.assertRaisesRegex(PermissionError, 'scope'):
                    await resolver.deliver(profile(), profile()['userId'], 'send',
                                           {'chat_id': '123', 'content': 'stale'})
            broker.assert_not_awaited()
            adapter.send.assert_not_awaited()
        finally:
            request_scope.reset(token)

    async def test_proactive_foreign_route_and_changed_auth_denied(self):
        resolver = runtime.Resolver(NS(send=AsyncMock()))
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile(102))):
                with self.assertRaises(PermissionError):
                    await resolver.deliver(profile(), profile()['userId'], 'send',
                                           {'chat_id': '-foreign', 'content': 'no'})
                with self.assertRaisesRegex(PermissionError, 'binding'):
                    await resolver.deliver(profile(), profile()['userId'], 'send',
                                           {'chat_id': '123', 'content': 'no'})
            resolver.adapter.send.assert_not_awaited()
        finally:
            request_scope.reset(token)

    async def test_production_bridge_requires_explicit_scope(self):
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), None, require_scope=True)
        bridge.routes.add(('123', ''))
        with self.assertRaisesRegex(RpcError, 'scope'):
            await bridge.send('send', {'chat_id': '123', 'content': 'no'})

    async def test_callback_author_is_bot_but_clicker_must_own_message(self):
        resolver = runtime.Resolver(NS(_effective_message_thread_id=lambda message: '7'))
        resolver.ledger.admit(profile(), ('-900', '7'), {'thread_id': '7'})
        resolver.ledger.record(profile(), ('-900', '7'), '200')
        update = NS(effective_user=NS(id=123, is_bot=False),
            callback_query=NS(id='query', message=NS(chat=NS(id=-900), message_id=200,
                from_user=NS(id=999, is_bot=True))), inline_query=None)
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())):
            self.assertTrue(await resolver.interactive_admit(update))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile(102))):
            with self.assertRaisesRegex(PermissionError, 'another owner'):
                await resolver.interactive_admit(update)

    async def test_callback_answer_cannot_use_another_query(self):
        adapter = NS(_bot=NS(answer_callback_query=AsyncMock(return_value=True)))
        resolver = runtime.Resolver(adapter)
        resolver.interactive_scopes['scope'] = {'owner': resolver.ledger.owner(profile()),
            'route': ('123', ''), 'queryId': 'valid-query', 'kind': 'callback',
            'expires': runtime.time.monotonic() + 60}
        with self.assertRaisesRegex(PermissionError, 'Foreign interactive'):
            await resolver.telegram_api(profile(), profile()['userId'], 'answer_callback_query',
                                       {'callback_query_id': 'foreign-query'}, 'scope')
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())):
            self.assertTrue(await resolver.telegram_api(profile(), profile()['userId'],
                'answer_callback_query', {'callback_query_id': 'valid-query'}, 'scope'))
        self.assertEqual(adapter._bot.answer_callback_query.await_count, 1)

    async def test_ui_edit_and_reply_cannot_target_foreign_message(self):
        adapter = NS(_bot=NS(edit_message_text=AsyncMock(), send_message=AsyncMock()))
        resolver = runtime.Resolver(adapter)
        resolver.ledger.admit(profile(), ('123', ''), {})
        for method, payload in [('edit_message_text', {'chat_id': 123, 'message_id': 999, 'text': 'no'}),
                                ('send_message', {'chat_id': 123, 'text': 'no', 'reply_to_message_id': 999})]:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())):
                with self.assertRaisesRegex(PermissionError, 'Foreign UI'):
                    await resolver.telegram_api(profile(), profile()['userId'], method, payload, None)
        adapter._bot.edit_message_text.assert_not_awaited()
        adapter._bot.send_message.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
