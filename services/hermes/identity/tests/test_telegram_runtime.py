# ABOUTME: Проверяет связку Telegram ingress с брокером личного процесса.
# ABOUTME: Все сетевые вызовы заменены локальными подставными ответами.
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import telegram_runtime as runtime
from identity.ingress import Bridge
from identity.ipc import RpcError


def profile():
    return {'uid': 101, 'userId':'owner', 'telegramId':'123', 'workerSocket':'/tmp/worker'}


def event():
    return NS(source=NS(chat_id='123', thread_id=None, chat_type='dm'), text='hello', user_name='test',
              message_id='55', message_type=NS(value='photo'), timestamp=None, reply_expected=True,
              media_urls=['/ingress/a'], media_types=['image/png'], media_text_inlined=[], reply_to_message_id=None,
              _brai_identity_inputs=[{'path':'/ingress/a','itemId':'55:0','caption':'hello','groupId':'album'}])


class TelegramRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_registered_private_user_is_admitted(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())) as broker:
            self.assertTrue(await runtime.admit_update(update, NS()))
        broker.assert_awaited_once_with('identity.resolve', {'telegramId': '123'})

    async def test_non_private_updates_are_ignored_before_broker_or_notice(self):
        for chat_type, chat_id in [('group', -10), ('supergroup', -100), ('channel', -100),
                                   ('private', 456), (None, 123)]:
            for text in ['hello', '/start invite_abcdefghijklmnop', '/link', '/unlink', '/start link_' + 'a' * 43]:
                with self.subTest(chat_type=chat_type, text=text):
                    update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                                effective_user=NS(id=123, is_bot=False),
                                effective_chat=NS(id=chat_id, type=chat_type))
                    adapter = NS(send=AsyncMock())
                    with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                        self.assertFalse(await runtime.admit_update(update, adapter))
                    broker.assert_not_awaited()
                    adapter.send.assert_not_awaited()

    async def test_non_private_event_cannot_register_turn_or_prepare_media(self):
        for chat_type, chat_id in [('group', '-10'), ('supergroup', '-100'), ('channel', '-100'),
                                   ('dm', '456'), ('', '123')]:
            with self.subTest(chat_type=chat_type, chat_id=chat_id):
                incoming = event()
                incoming.source.chat_type, incoming.source.chat_id = chat_type, chat_id
                resolver = runtime.Resolver(NS())
                with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                    with self.assertRaisesRegex(PermissionError, 'Only private Telegram'):
                        await resolver.prepare(profile(), incoming)
                broker.assert_not_awaited()
                self.assertEqual(resolver.turns, {})

    async def test_link_commands_are_private_transport_operations_without_agent_dispatch(self):
        for text, method, result in [('/start link_' + 'a' * 43, 'identity.link-redeem', {'user': {'id': 'owner'}})]:
            with self.subTest(command=method):
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                            effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type='private'))
                adapter = NS(send=AsyncMock())
                with patch.object(runtime, 'broker_call', AsyncMock(return_value=result)) as broker:
                    self.assertFalse(await runtime.admit_update(update, adapter))
                self.assertEqual(broker.await_count, 1)
                self.assertEqual(broker.await_args.args[0], method)
                self.assertEqual(broker.await_args.args[1]['telegramId'], '456')
                adapter.send.assert_awaited_once()

    async def test_raw_unlink_only_explains_agent_workflow_without_revoking(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text='/unlink'),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
        adapter = NS(send=AsyncMock())
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_not_awaited()
        self.assertIn('подтверждение', adapter.send.await_args.args[1])

    async def test_unlink_consent_contains_only_exact_human_confirmed_account_id(self):
        for text, expected in [('Подтверждаю отвязку Telegram-аккаунта 123', '123'),
                               ('Подтверждаю отвязку Telegram-аккаунта 456!', '456'),
                               ('Да', ''), ('Отвяжи аккаунт 123', ''),
                               ('В архиве: Подтверждаю отвязку Telegram-аккаунта 123', '')]:
            incoming = event()
            incoming.text = text
            broker = AsyncMock(side_effect=[{}, {'paths': ['/user/a']}])
            with patch.object(runtime, 'broker_call', broker):
                await runtime.Resolver(NS()).prepare(profile(), incoming)
            self.assertEqual(broker.await_args_list[0].args[1]['unlinkConsent'], expected)

    async def test_malformed_link_secrets_never_reach_broker_or_agent(self):
        for secret in ['short', 'a' * 44, 'a' * 43 + '\nextra']:
            update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text='/start link_' + secret),
                        effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type='private'))
            adapter = NS(send=AsyncMock())
            with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                self.assertFalse(await runtime.admit_update(update, adapter))
            broker.assert_not_awaited()
            self.assertNotIn(secret, adapter.send.await_args.args[1])

    async def test_linked_accounts_share_one_bridge_and_worker(self):
        resolver = runtime.Resolver(NS())
        primary = {**profile(), 'authorTelegramId': '123'}
        alias = {**primary, 'telegramId': '456'}
        with patch.object(runtime, 'broker_call', AsyncMock(side_effect=[primary, alias])):
            first = await resolver(NS(user_id='123'))
            second = await resolver(NS(user_id='456'))
        self.assertEqual(first.worker_uid, second.worker_uid)
        self.assertEqual(first.owner, second.owner)
        self.assertEqual(second.worker_telegram_id, '123')
        self.assertIs(first, second)
        self.assertEqual(first.telegram_ids, {'123', '456'})
        self.assertEqual(len(resolver.bridges), 1)

    async def test_dm_admission_registers_private_context(self):
        resolver = runtime.Resolver(NS())
        calls = []
        async def broker(method, params, **kwargs):
            calls.append((method, params))
            if method == 'ingress.prepare':
                return {'paths':['/user/a']}
            return {}
        with patch.object(runtime, 'broker_call', broker):
            await resolver.prepare(profile(), event())
        admission = next(params for method, params in calls if method == 'ingress.admit')
        self.assertIs(admission['privateChat'], True)
        self.assertEqual(admission['telegramId'], '123')

    async def test_confirmation_flag_comes_from_trusted_current_user_text(self):
        for text, expected in [('Подтверждаю привязку моего второго аккаунта', True), ('Да, подтверждаю', False), ('да', False), ('нет', False), ('В архиве было: да', False)]:
            with self.subTest(text=text):
                incoming = event()
                incoming.text = text
                broker = AsyncMock(side_effect=[{}, {'paths': ['/user/a']}])
                with patch.object(runtime, 'broker_call', broker):
                    await runtime.Resolver(NS()).prepare(profile(), incoming)
                self.assertIs(broker.await_args_list[0].args[1]['linkConsent'], expected)

    async def test_dm_topic_is_passed_only_from_trusted_source(self):
        incoming = event()
        incoming.source.thread_id = '73'
        resolver = runtime.Resolver(NS())
        broker = AsyncMock(side_effect=[{}, {'paths': ['/user/a']}])
        with patch.object(runtime, 'broker_call', broker):
            await resolver.prepare(profile(), incoming)
        self.assertEqual(broker.await_args_list[0].args[1]['threadId'], 73)

    async def test_media_paths_rewritten_and_original_ids_preserved(self):
        resolver = runtime.Resolver(NS())
        async def broker(method, params, **kwargs):
            if method == 'ingress.prepare':
                self.assertEqual(params['paths'], ['/ingress/a'])
                return {'paths':['/user/a']}
            return {}
        with patch.object(runtime, 'broker_call', broker):
            result = await resolver.prepare(profile(), event())
        self.assertEqual(result['media_urls'], ['/user/a'])
        self.assertEqual(result['identity_inputs'], [{'path':'/user/a','itemId':'55:0','caption':'hello','groupId':'album'}])

    async def test_response_cannot_cross_to_another_account_of_same_owner(self):
        adapter = NS(send=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id': 'current', 'route': ('456', '')}
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(PermissionError, 'outside current conversation'):
                await resolver.deliver(profile(), 'owner', 'send', {'chat_id': '123', 'content': 'wrong chat'})
        broker.assert_not_awaited()
        adapter.send.assert_not_awaited()

    async def test_wrong_owner_is_rejected(self):
        resolver = runtime.Resolver(NS())
        resolver.turns[101] = {'id':'t', 'route':('123','')}
        with self.assertRaises(PermissionError):
            await resolver.deliver(profile(), 'someone-else', 'send', {'chat_id':'123'})

    async def test_login_suppression_sends_nothing(self):
        adapter = NS(send=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id':'t', 'route':('123','')}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'suppressFinal':True})):
            result = await resolver.deliver(profile(), 'owner', 'send', {'chat_id':'123', 'content':'answer'})
        self.assertTrue(result['success'])
        adapter.send.assert_not_awaited()

    async def test_untrusted_url_never_reaches_native_adapter(self):
        adapter = NS(send_image=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id':'t', 'route':('123','')}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'suppressFinal':False})):
            with self.assertRaises(PermissionError):
                await resolver.deliver(profile(), 'owner', 'send_image', {'chat_id':'123', 'image_url':'http://127.0.0.1:8000/'})
        adapter.send_image.assert_not_awaited()

    async def test_bot_or_anonymous_sender_never_reaches_broker(self):
        adapter = NS()
        for user, sender in [(NS(id=123,is_bot=True), None), (NS(id=123,is_bot=False), NS(id=9))]:
            update = NS(effective_message=NS(sender_chat=sender, business_connection_id=None),
                        effective_user=user, effective_chat=NS(id=123, type='private'))
            with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                self.assertFalse(await runtime.admit_update(update, adapter))
                broker.assert_not_awaited()

    async def test_invalid_invite_cannot_be_redeemed(self):
        adapter = NS(send=AsyncMock())
        update = NS(effective_message=NS(sender_chat=None,business_connection_id=None,text='/start bad'),
                    effective_user=NS(id=123,is_bot=False,full_name='User'), effective_chat=NS(id=123,type='private'))
        broker = AsyncMock(side_effect=PermissionError('denied'))
        with patch.object(runtime, 'broker_call', broker), patch.object(runtime, '_notice', AsyncMock()):
            self.assertFalse(await runtime.admit_update(update, adapter))
        self.assertEqual([call.args[0] for call in broker.await_args_list], ['identity.resolve'])

    async def test_uid_rebinding_to_other_owner_fails_closed(self):
        resolver = runtime.Resolver(NS())
        first = profile()
        changed = {**first, 'userId':'other'}
        source = NS(user_id='123')
        with patch.object(runtime, 'broker_call', AsyncMock(side_effect=[first, changed])):
            await resolver(source)
            with self.assertRaises(PermissionError):
                await resolver(source)

    async def test_historical_route_cannot_deliver_during_another_turn(self):
        adapter = NS(send=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id': 'current', 'route': ('123', 'new')}
        async def deliver(owner, action, payload):
            return await resolver.deliver(profile(), owner, action, payload)
        bridge = Bridge('owner', '123', 101, '/unused', deliver, None)
        bridge.routes.update({('123', 'old'), ('123', 'new')})
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(PermissionError, 'conversation'):
                await bridge.send('send', {'chat_id': '123', 'content': 'stale',
                                         'metadata': {'thread_id': 'old'}})
        broker.assert_not_awaited()
        adapter.send.assert_not_awaited()

    async def test_worker_cannot_override_trusted_topic_metadata(self):
        adapter = NS(send=AsyncMock(return_value={'success': True, 'message_id': '1'}))
        runner = NS(_thread_metadata_for_source=lambda *args: {
            'thread_id': '77', 'direct_messages_topic_id': 42})
        resolver = runtime.Resolver(adapter, runner)
        incoming = event()
        incoming.source.thread_id = '77'
        incoming.media_urls, incoming._brai_identity_inputs = [], []
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={})):
            await resolver.prepare(profile(), incoming)
            await resolver.deliver(profile(), 'owner', 'send', {'chat_id': '123', 'content': 'answer',
                'metadata': {'thread_id': '77', 'direct_messages_topic_id': 999}})
        self.assertEqual(adapter.send.await_args.kwargs['metadata'],
                         {'thread_id': '77', 'direct_messages_topic_id': 42})

    async def test_old_completion_during_new_dispatch_cannot_close_new_turn(self):
        resolver = runtime.Resolver(NS())
        async def broker(method, params, **kwargs):
            return profile() if method == 'identity.resolve' else {}
        incoming = event()
        incoming.media_urls, incoming._brai_identity_inputs = [], []
        incoming.source.user_id, incoming.source.is_bot = '123', False
        incoming.source.platform = NS(value='telegram')
        incoming.source.to_dict = lambda: {'platform': 'telegram', 'user_id': '123', 'chat_id': '123'}
        with patch.object(runtime, 'broker_call', AsyncMock(side_effect=broker)) as calls:
            bridge = await resolver(incoming.source)
            count = 0
            async def dispatch(method, params):
                nonlocal count
                count += 1
                if count == 2:
                    await bridge.turn_ended('owner', 'first')
                return {'accepted': True, 'turn_id': 'first' if count == 1 else 'second'}
            bridge.connect = AsyncMock(return_value=NS(call=dispatch))
            await bridge.dispatch(incoming)
            incoming.message_id = '56'
            await bridge.dispatch(incoming)
            self.assertEqual(resolver.turns[101]['workerTurnId'], 'second')
            self.assertEqual(bridge.known_turns, {'second'})
            self.assertFalse(any(call.args[0] == 'ingress.close' for call in calls.await_args_list))
            await bridge.turn_ended('owner', 'second')
            self.assertEqual(resolver.turns, {})
            self.assertEqual(sum(call.args[0] == 'ingress.close' for call in calls.await_args_list), 1)

    async def test_old_completion_during_prepare_keeps_new_admission(self):
        resolver = runtime.Resolver(NS())
        bridge = None
        preparing_second = False
        async def broker(method, params, **kwargs):
            if method == 'identity.resolve':
                return profile()
            if method == 'ingress.admit' and preparing_second:
                await bridge.turn_ended('owner', 'first')
            return {}
        incoming = event()
        incoming.media_urls, incoming._brai_identity_inputs = [], []
        incoming.source.user_id, incoming.source.is_bot = '123', False
        incoming.source.platform = NS(value='telegram')
        incoming.source.to_dict = lambda: {'platform': 'telegram', 'user_id': '123', 'chat_id': '123'}
        with patch.object(runtime, 'broker_call', AsyncMock(side_effect=broker)) as calls:
            bridge = await resolver(incoming.source)
            count = 0
            async def dispatch(method, params):
                nonlocal count
                count += 1
                return {'accepted': True, 'turn_id': 'first' if count == 1 else 'second'}
            bridge.connect = AsyncMock(return_value=NS(call=dispatch))
            await bridge.dispatch(incoming)
            preparing_second = True
            incoming.message_id = '56'
            await bridge.dispatch(incoming)
            self.assertEqual(resolver.turns[101]['workerTurnId'], 'second')
            self.assertEqual(bridge.known_turns, {'second'})
            self.assertFalse(any(call.args[0] == 'ingress.close' for call in calls.await_args_list))
            await bridge.turn_ended('owner', 'second')
            self.assertEqual(resolver.turns, {})

    async def test_rejected_sender_cannot_close_current_owner_admission(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        current = {'id': 'current', 'route': ('123', '')}
        resolver.turns[101] = current
        prepare = AsyncMock()
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), prepare,
                        on_turn_end=lambda turn: resolver.end(profile(), turn))
        bridge.connect = AsyncMock()
        incoming = event()
        incoming.source.platform = NS(value='telegram')
        incoming.source.user_id, incoming.source.is_bot = '456', False
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(PermissionError, 'owner mismatch'):
                await bridge.dispatch(incoming)
        self.assertIs(resolver.turns[101], current)
        bridge.connect.assert_not_awaited()
        prepare.assert_not_awaited()
        broker.assert_not_awaited()

    async def test_connect_failure_cannot_close_existing_owner_admission(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        current = {'id': 'current', 'route': ('123', '')}
        resolver.turns[101] = current
        prepare = AsyncMock()
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), prepare,
                        on_turn_end=lambda turn: resolver.end(profile(), turn))
        bridge.connect = AsyncMock(side_effect=ConnectionError('Worker unavailable'))
        incoming = event()
        incoming.source.platform = NS(value='telegram')
        incoming.source.user_id, incoming.source.is_bot = '123', False
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(ConnectionError, 'Worker unavailable'):
                await bridge.dispatch(incoming)
        self.assertIs(resolver.turns[101], current)
        prepare.assert_not_awaited()
        broker.assert_not_awaited()

    async def test_prepare_failure_closes_new_admission_after_dispatch_started(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        async def prepare(incoming):
            resolver.turns[101] = {'id': 'prepared', 'route': ('123', '')}
            raise ValueError('Media rejected')
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), prepare,
                        on_turn_end=lambda turn: resolver.end(profile(), turn))
        bridge.connect = AsyncMock(return_value=NS(call=AsyncMock()))
        incoming = event()
        incoming.source.platform = NS(value='telegram')
        incoming.source.user_id, incoming.source.is_bot = '123', False
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(ValueError, 'Media rejected'):
                await bridge.dispatch(incoming)
        self.assertEqual(resolver.turns, {})
        broker.assert_awaited_once_with('ingress.close', {'uid': 101, 'turnId': 'prepared'})

    async def test_delivery_ports_cannot_change_after_connection(self):
        original = AsyncMock()
        bridge = Bridge('owner', '123', 101, '/unused', AsyncMock(), None).configure_delivery(
            authorize_delivery=original, require_scope=True)
        bridge.peer = NS(closed=False)
        with self.assertRaisesRegex(RuntimeError, 'already connected'):
            bridge.configure_delivery(authorize_delivery=AsyncMock(), require_scope=False)
        self.assertIs(bridge.authorize_delivery, original)
        self.assertTrue(bridge.require_scope)


class DraftDeliveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.native = NS(send_draft=AsyncMock(return_value={'success': True, 'message_id': None}),
                         supports_draft_streaming=lambda *args: True)
        self.resolver = runtime.Resolver(self.native)
        self.owner = {**profile(), 'profileId': 'profile'}
        self.route = ('123', '73')
        self.metadata = {'thread_id': '73', 'telegram_reply_to_message_id': 55,
                         'telegram_dm_topic_reply_fallback': True}
        self.resolver.ledger.admit(self.owner, self.route, self.metadata, '55')
        self.resolver.turns[101] = {'id': 'turn', 'route': self.route, 'metadata': self.metadata}
        self.bridge = Bridge('owner', '123', 101, '/unused',
            lambda owner, action, payload: self.resolver.deliver(self.owner, owner, action, payload), None).configure_delivery(
            authorize_delivery=lambda action, payload: self.resolver.authorize_delivery(self.owner, action, payload),
            require_scope=True)
        self.addAsyncCleanup(self.resolver.close)

    def draft(self, **fields):
        return {'chat_id': '123', 'draft_id': 17, 'content': 'Partial answer',
                'metadata': {'thread_id': '73', 'direct_messages_topic_id': 999}, **fields}

    async def test_native_draft_keeps_trusted_topic_and_has_no_delivered_message_id(self):
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'suppressFinal': False})):
            receipt = await self.bridge.send('send_draft', self.draft(), scope_id='turn')
        self.assertTrue(receipt['success'])
        self.assertIsNone(receipt['message_id'])
        self.native.send_draft.assert_awaited_once_with(chat_id='123', draft_id=17,
            content='Partial answer', metadata=self.metadata)
        self.assertEqual(self.bridge.sent, set())
        self.assertEqual(self.resolver.ledger.db.execute('SELECT COUNT(*) FROM messages WHERE outgoing=1').fetchone()[0], 0)

    async def test_late_draft_cannot_become_proactive_or_switch_conversation(self):
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaises(PermissionError):
                await self.bridge.send('send_draft', self.draft(), scope_id='expired')
            with self.assertRaises(PermissionError):
                await self.bridge.send('send_draft', self.draft(chat_id='999'), scope_id='turn')
        self.native.send_draft.assert_not_awaited()
        broker.assert_not_awaited()

    async def test_group_drafts_stay_disabled_even_for_known_owner_route(self):
        route = ('-55', '73')
        self.resolver.ledger.admit(self.owner, route, {'thread_id': '73'}, '56')
        self.resolver.turns[101] = {'id': 'turn', 'route': route}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={})):
            with self.assertRaisesRegex(PermissionError, 'owner private chat'):
                await self.bridge.send('send_draft', self.draft(chat_id='-55'), scope_id='turn')
        self.native.send_draft.assert_not_awaited()

    async def test_invalid_draft_or_raw_api_fields_never_reach_native(self):
        for fields in ({'draft_id': 0}, {'draft_id': True}, {'draft_id': '17'},
                       {'content': None}, {'content': 'x' * 65537}, {'api_kwargs': {}}, {'reply_markup': {}}):
            with self.subTest(fields=tuple(fields)):
                with self.assertRaises(RpcError):
                    await self.bridge.send('send_draft', self.draft(**fields), scope_id='turn')
        self.native.send_draft.assert_not_awaited()

    async def test_unavailable_native_api_returns_failure_for_stream_consumer_fallback(self):
        self.native.supports_draft_streaming = lambda *args: False
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={})):
            receipt = await self.bridge.send('send_draft', self.draft(), scope_id='turn')
        self.assertFalse(receipt['success'])
        self.native.send_draft.assert_not_awaited()

    async def test_proactive_draft_rechecks_auth_and_preserves_unknown_outcome(self):
        self.resolver.turns.clear()
        self.native.send_draft.return_value = {'success': False, 'error': 'Outcome unknown'}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=self.owner)) as broker:
            receipt = await self.bridge.send('send_draft', self.draft(), scope_id=None)
        self.assertFalse(receipt['success'])
        broker.assert_awaited_once_with('identity.resolve', {'telegramId': '123'})
        self.assertEqual(self.bridge.sent, set())
        self.native.send_draft.reset_mock()
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={**self.owner, 'userId': 'other'})):
            with self.assertRaises(PermissionError):
                await self.bridge.send('send_draft', self.draft(), scope_id=None)
        self.native.send_draft.assert_not_awaited()
