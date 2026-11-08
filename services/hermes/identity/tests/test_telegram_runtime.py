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


def profile():
    return {'uid': 101, 'userId':'owner', 'telegramId':'123', 'workerSocket':'/tmp/worker'}


def event():
    return NS(source=NS(chat_id='123', thread_id=None, chat_type='dm'), text='hello', user_name='test',
              message_id='55', message_type=NS(value='photo'), timestamp=None, reply_expected=True,
              media_urls=['/ingress/a'], media_types=['image/png'], media_text_inlined=[], reply_to_message_id=None,
              _brai_identity_inputs=[{'path':'/ingress/a','itemId':'55:0','caption':'hello','groupId':'album'}])


class TelegramRuntimeTest(unittest.IsolatedAsyncioTestCase):
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

    async def test_historical_route_cannot_deliver_during_another_turn(self):
        adapter = NS(send=AsyncMock())
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {'id': 'current', 'route': ('123', 'new')}
        async def deliver(owner, action, payload):
            return await resolver.deliver(profile(), owner, action, payload)
        bridge = Bridge('owner', '123', 101, '/unused', deliver, None)
        bridge.routes.update({('123', 'old'), ('123', 'new')})
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            with self.assertRaisesRegex(PermissionError, 'active conversation'):
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
                        effective_user=user, effective_chat=NS(id=123))
            with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                self.assertFalse(await runtime.admit_update(update, adapter))
                broker.assert_not_awaited()

    async def test_invalid_invite_cannot_be_redeemed(self):
        adapter = NS(send=AsyncMock())
        update = NS(effective_message=NS(sender_chat=None,business_connection_id=None,text='/start bad'),
                    effective_user=NS(id=123,is_bot=False,full_name='User'), effective_chat=NS(id=123))
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
