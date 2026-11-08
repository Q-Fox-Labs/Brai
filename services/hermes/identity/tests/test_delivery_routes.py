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
        resolver.ledger.admit(profile(), ('123', '7'), {'thread_id': '7', 'direct_messages_topic_id': 70})
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())) as broker:
                result = await resolver.deliver(profile(), profile()['userId'], 'send',
                    {'chat_id': '123', 'content': 'job done', 'metadata': {'thread_id': '7'}})
            self.assertTrue(result['success'])
            self.assertEqual(broker.await_args.args[0], 'identity.resolve')
            self.assertEqual(adapter.send.await_args.kwargs['metadata']['direct_messages_topic_id'], 70)
            self.assertTrue(resolver.ledger.owns(profile(), ('123', '7'), '200', outgoing=True))
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
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), None).configure_delivery(require_scope=True)
        bridge.routes.add(('123', ''))
        with self.assertRaisesRegex(RpcError, 'scope'):
            await bridge.send('send', {'chat_id': '123', 'content': 'no'})

    async def test_callback_author_is_bot_but_clicker_must_own_message(self):
        resolver = runtime.Resolver(NS(_effective_message_thread_id=lambda message: '7'))
        resolver.ledger.admit(profile(), ('123', '7'), {'thread_id': '7'})
        resolver.ledger.record(profile(), ('123', '7'), '200')
        update = NS(effective_user=NS(id=123, is_bot=False),
            callback_query=NS(id='query', message=NS(chat=NS(id=123, type='private'), message_id=200,
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


class AccountCompatibilityTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.primary = {**profile(), 'authorTelegramId': '123'}
        self.alias = {**self.primary, 'telegramId': '456'}
        self.accounts = {'456'}
        self.native = NS(send=AsyncMock(return_value={'success': True, 'message_id': '201'}),
                         send_draft=AsyncMock(return_value={'success': True}),
                         supports_draft_streaming=lambda *args: True,
                         _bot=NS(answer_callback_query=AsyncMock(return_value=True)))
        self.resolver = runtime.Resolver(self.native)
        self.addAsyncCleanup(self.resolver.close)
        self.resolver.ledger.admit(self.primary, ('456', ''), {}, '55')
        self.resolver.ledger.record(self.primary, ('456', ''), '200')

    async def broker(self, method, params, **kwargs):
        if method == 'identity.resolve':
            if params['telegramId'] not in self.accounts:
                raise PermissionError('Account unlinked')
            return {**self.primary, 'telegramId': params['telegramId']}
        if method == 'ingress.status':
            return {'suppressFinal': False}
        if method == 'ingress.profiles':
            return {'profiles': [self.primary]}
        return {}

    def update(self, actor='456', *, chat=None, kind='private'):
        chat = actor if chat is None else chat
        raw = {'update_id': 9, 'callback_query': {'id': 'query', 'chat_instance': 'private', 'data': 'cp:0',
            'from': {'id': int(actor), 'is_bot': False, 'first_name': 'Owner'},
            'message': {'message_id': 200, 'date': 1, 'text': 'Choose',
                'from': {'id': 999, 'is_bot': True, 'first_name': 'Bot'},
                'chat': {'id': int(chat), 'type': kind}}}}
        return NS(effective_user=NS(id=int(actor), is_bot=False), inline_query=None,
            callback_query=NS(id='query', from_user=NS(id=int(actor), is_bot=False),
                message=NS(chat=NS(id=int(chat), type=kind), message_id=200,
                           from_user=NS(id=999, is_bot=True))), to_dict=lambda: raw)

    async def test_connected_bridge_keeps_one_stable_owner_configuration_on_alias_lookup(self):
        with patch.object(runtime, 'broker_call', self.broker):
            bridge = await self.resolver(NS(user_id='456'))
        ports = bridge.authorize_delivery, bridge.telegram_api
        bridge.peer = NS(closed=False)
        self.assertIs(self.resolver._bridge(self.primary), bridge)
        self.assertEqual((bridge.authorize_delivery, bridge.telegram_api), ports)
        self.assertTrue(bridge.require_scope)

    async def test_alias_callback_crosses_worker_with_actual_actor_and_stable_author(self):
        from identity.worker import Worker
        worker = Worker(os.getuid() + 1, self.primary['userId'], '123', None)
        worker.ensure_tools = AsyncMock()
        worker.adapter = NS(handle_interactive=AsyncMock())
        async def call(method, params, **kwargs):
            self.assertEqual(method, 'interactive')
            return await worker.interactive(**params)
        with patch.object(runtime, 'broker_call', self.broker), patch.object(Bridge, 'connect',
                AsyncMock(return_value=NS(call=call))):
            receipt = await self.resolver.interactive(self.update())
        self.assertTrue(receipt['accepted'])
        self.assertEqual(worker.telegram_id, '123')
        update = worker.adapter.handle_interactive.await_args.args[0]
        self.assertEqual(update['callback_query']['from']['id'], 456)
        self.assertEqual(update['callback_query']['message']['chat']['id'], 456)
        self.assertEqual(worker.adapter.handle_interactive.await_args.kwargs['telegram_id'], '456')

    async def test_supervisor_restart_uses_stable_profile_after_original_account_unlinked(self):
        import asyncio
        health = AsyncMock(return_value={'ready': True})
        calls = []
        async def broker(method, params, **kwargs):
            calls.append((method, params))
            return await self.broker(method, params, **kwargs)
        with patch.object(runtime, 'broker_call', broker), patch.object(Bridge, 'connect',
                AsyncMock(return_value=NS(call=health))), patch.object(runtime.asyncio, 'sleep',
                AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await self.resolver._supervise()
        self.assertEqual(calls, [('ingress.profiles', {})])
        health.assert_awaited_once_with('health', {'require_tools': True}, timeout=240)
        with patch.object(runtime, 'broker_call', self.broker):
            bridge = await self.resolver(NS(user_id='456'))
        self.assertEqual(bridge.worker_telegram_id, '123')
        self.assertEqual(len(self.resolver.bridges), 1)

    async def test_alias_proactive_delivery_and_draft_do_not_revalidate_revoked_author(self):
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', self.broker):
                self.assertTrue((await self.resolver.deliver(self.primary, self.primary['userId'],
                    'send', {'chat_id': '456', 'content': 'Finished'}))['success'])
                self.assertTrue((await self.resolver.deliver(self.primary, self.primary['userId'],
                    'send_draft', {'chat_id': '456', 'draft_id': 17, 'content': 'Preview'}))['success'])
                with self.assertRaises(PermissionError):
                    await self.resolver.deliver(self.primary, self.primary['userId'],
                        'send', {'chat_id': '123', 'content': 'Revoked'})
            self.native.send.assert_awaited_once_with(chat_id='456', content='Finished', metadata={})
            self.native.send_draft.assert_awaited_once_with(chat_id='456', draft_id=17, content='Preview', metadata={})
            self.assertTrue(self.resolver.ledger.owns(self.alias, ('456', ''), '201', outgoing=True))
        finally:
            request_scope.reset(token)

    async def test_unlinked_actor_loses_existing_callback_and_query_grant(self):
        self.resolver.interactive_scopes['scope'] = {'owner': self.resolver.ledger.owner(self.primary),
            'route': ('456', ''), 'actorTelegramId': '456', 'queryId': 'query', 'kind': 'callback',
            'expires': runtime.time.monotonic() + 60}
        self.accounts.clear()
        with patch.object(runtime, 'broker_call', self.broker):
            with self.assertRaises(PermissionError):
                await self.resolver.interactive_admit(self.update())
            with self.assertRaises(PermissionError):
                await self.resolver.telegram_api(self.primary, self.primary['userId'],
                    'answer_callback_query', {'callback_query_id': 'query'}, 'scope')
        self.native._bot.answer_callback_query.assert_not_awaited()

    async def test_callbacks_reject_groups_and_another_account_chat_before_auth(self):
        for update in (self.update(chat='-900', kind='supergroup'), self.update(chat='123')):
            with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                with self.assertRaises(PermissionError):
                    await self.resolver.interactive_admit(update)
                broker.assert_not_awaited()

    async def test_stable_ledger_survives_restart_and_keeps_account_message_routes_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'routes.sqlite'
            first = RouteLedger(path)
            first.admit(self.primary, ('456', ''), {}, '55')
            first.record(self.primary, ('456', ''), '200')
            first.close()
            second = RouteLedger(path)
            try:
                self.assertEqual(second.owner(self.primary), second.owner(self.alias))
                self.assertTrue(second.owns(self.alias, ('456', ''), '200', outgoing=True))
                self.assertFalse(second.owns(self.alias, ('123', ''), '200', outgoing=True))
                self.assertFalse(second.owns({**self.alias, 'profileId': 'replacement'}, ('456', ''), '200'))
            finally:
                second.close()


if __name__ == '__main__':
    unittest.main()
