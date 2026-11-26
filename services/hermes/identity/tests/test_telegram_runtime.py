# ABOUTME: Проверяет связку Telegram ingress с брокером личного процесса.
# ABOUTME: Все сетевые вызовы заменены локальными подставными ответами.
import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import telegram_runtime as runtime
from identity.ingress import Bridge
from identity.ipc import RpcError
from identity.reply_outbox import ReplyOutbox
from identity.routes import RouteLedger
from identity.delivery_journal import delivery_id
from identity.broker import Broker


def profile():
    return {'uid': 101, 'userId':'owner', 'telegramId':'123', 'workerSocket':'/tmp/worker'}


def event():
    return NS(source=NS(chat_id='123', thread_id=None, chat_type='dm'), text='hello', user_name='test',
              message_id='55', message_type=NS(value='photo'), timestamp=None, reply_expected=True,
              media_urls=['/ingress/a'], media_types=['image/png'], media_text_inlined=[], reply_to_message_id=None,
              _brai_identity_inputs=[{'path':'/ingress/a','itemId':'55:0','caption':'hello','groupId':'album'}])


class TelegramRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_restored_profile_reply_uses_canonical_owner_and_reaches_transport(self):
        resolver = runtime.Resolver(NS())
        self.addCleanup(resolver.ledger.close)
        registered = {**profile(), 'profileId': 'profile', 'status': 'active'}
        async def auth(method, params, timeout=35):
            if method == 'authorize':
                return {'userId': 'owner', 'profileId': 'profile', 'role': 'user', 'generation': 0}
            self.assertEqual(method, 'identity.resolve')
            return {'user': {'id': 'owner', 'profileId': 'profile', 'telegramId': '123', 'status': 'active'}}
        broker = Broker({'ingressUid': 995}, NS(call=auth))
        async def broker_rpc(method, params):
            return await broker.call(995, method, params)
        with patch.object(broker, 'profiles', return_value={101: registered}):
            restored = (await broker.call(995, 'ingress.profiles', {}))['profiles'][0]
            self.assertNotIn('authorTelegramId', restored)
            active = await broker.call(995, 'identity.resolve', {'telegramId': '123'})
        self.assertEqual(active['authorTelegramId'], '123')
        route = ('123', '77')
        resolver.ledger.admit(restored, route, {'thread_id': '77'}, '55')
        resolver._deliver_route = AsyncMock(return_value={'success': True, 'message_id': '56'})
        outbox = ReplyOutbox(resolver.ledger.db, resolver._deliver_saved_reply)
        ident = delivery_id('restored-reply')
        body = {'profile': restored, 'action': 'send', 'generation': 0,
                'payload': {'chat_id': '123', 'content': 'Ответ', 'metadata': {'thread_id': '77'}}}
        outbox.enqueue(ident, RouteLedger.owner(restored), body)
        with patch.object(broker, 'profiles', return_value={101: registered}), \
                patch.object(runtime, 'broker_call', broker_rpc):
            await outbox.flush()
        self.assertEqual(outbox.result(ident), {'success': True, 'message_id': '56'})
        resolver._deliver_route.assert_awaited_once()

    async def test_startup_hold_defers_durable_recovery(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        resolver.release_gate = NS(operation='release-123')
        resolver.mirror = NS(restartable=True, pump=AsyncMock())
        resolver.reply_outbox = NS(flush=AsyncMock())
        peer = NS(call=AsyncMock())
        async def tick(delay):
            if resolver.release_gate.operation is None:
                raise asyncio.CancelledError
            resolver.mirror.pump.assert_not_awaited()
            resolver.reply_outbox.flush.assert_not_awaited()
            self.assertEqual([c.args[0] for c in peer.call.await_args_list], ['health'])
            resolver.release_gate.operation = None
        with patch.dict(runtime.os.environ, {'BRAI_IDENTITY_RELEASE_HOLD_OPERATION': 'release-123'}), \
                patch.object(runtime, 'broker_call', AsyncMock(return_value={'profiles': [profile()]})), \
                patch.object(resolver, '_bridge', return_value=NS(connect=AsyncMock(return_value=peer))), \
                patch.object(runtime.asyncio, 'sleep', tick):
            with self.assertRaises(asyncio.CancelledError):
                await resolver._supervise()
        resolver.mirror.pump.assert_awaited_once()
        resolver.reply_outbox.flush.assert_awaited_once()
        self.assertEqual([c.args[0] for c in peer.call.await_args_list], ['health', 'health', 'outbox.flush'])

    async def test_supervisor_accepts_and_sends_reply_in_second_accounts_topic(self):
        resolver = runtime.Resolver(NS(send=AsyncMock(return_value={'success': True, 'message_id': '56'})))
        self.addAsyncCleanup(resolver.close)
        registered = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 0}
        active = {**registered, 'authorTelegramId': '123', 'telegramId': '456'}
        bridge = resolver._bridge(registered)
        incoming = event()
        incoming.source = NS(chat_id='456', user_id='456', thread_id='77', chat_type='dm')
        incoming.media_urls = []
        incoming._brai_identity_inputs = []
        payload = {'chat_id': '456', 'content': 'Ответ', 'reply_to': '55',
                   'metadata': {'thread_id': '77'}}
        async def broker(method, params):
            if method == 'identity.resolve':
                self.assertEqual(params['telegramId'], '456')
                return active
            if method == 'ingress.admit':
                self.assertEqual(params['telegramId'], '456')
            return {}
        with patch.object(runtime, 'broker_call', broker):
            self.assertIs(await resolver(incoming.source), bridge)
            prepared = await bridge.prepare_event(incoming)
            response = await bridge.send('send', payload, scope_id=prepared['delivery_scope'])
        self.assertEqual(bridge.worker_telegram_id, '123')
        self.assertEqual(response, {'success': True, 'message_id': '56'})
        self.assertTrue(resolver.ledger.owns(registered, ('456', '77'), '55', outgoing=False))
        self.assertTrue(resolver.ledger.owns(registered, ('456', '77'), '56', outgoing=True))
        self.assertFalse(resolver.ledger.owns(registered, ('123', '77'), '56'))
        self.assertEqual(resolver.adapter.send.await_args.kwargs['chat_id'], '456')

    async def test_saved_second_account_reply_recovers_legacy_admission(self):
        for denied in (None, 'unlinked', 'other_message', 'other_generation'):
            with self.subTest(denied=denied):
                resolver = runtime.Resolver(NS(send=AsyncMock(return_value={'success': True, 'message_id': '56'})))
                self.addAsyncCleanup(resolver.close)
                registered = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 0}
                active = {**registered, 'authorTelegramId': '123', 'telegramId': '456'}
                legacy = {**registered, 'telegramId': '456'}
                route = ('456', '77')
                source = {'chat': '456', 'actor_id': '456', 'chat_generation': 0, 'state': 'accepted',
                          'auth_author': '123', 'auth_role': 'user', 'auth_generation': 0,
                          'payload': json.dumps({'message': {'message_thread_id': 77, 'is_topic_message': True, 'message_id': 55}})}
                resolver.ledger.admit(legacy, route, {'thread_id': '77'}, '55')
                resolver.ledger.record(legacy, route, '57', outgoing=False)
                resolver.ledger.record(legacy, route, '58', outgoing=True)
                resolver.mirror = NS(restartable=True, accepted=AsyncMock(),
                                     inbox=NS(delivery_source=lambda *args: source))
                resolver.reply_outbox = ReplyOutbox(resolver.ledger.db, resolver._deliver_saved_reply)
                bridge = resolver._bridge(registered)
                target = '57' if denied == 'other_message' else '55'
                payload = {'chat_id': '456', 'content': 'Ответ', 'reply_to': target, 'metadata': {'thread_id': '77'}}
                ident = delivery_id('stored-reply')
                kwargs = {'scope_id': 'finished-turn', 'delivery_id': ident,
                          'input_delivery_id': delivery_id('stored-input')}
                async def broker(method, params):
                    self.assertEqual((method, params), ('identity.resolve', {'telegramId': '456'}))
                    if denied == 'unlinked':
                        raise PermissionError('Account unlinked')
                    return {**active, 'generation': 1} if denied == 'other_generation' else active
                with patch.object(runtime, 'broker_call', broker):
                    if denied is None:
                        sent = await bridge.send('send', payload, **kwargs)
                        resolver._bridge(active)
                        resolver.ledger.admit(registered, route, {'thread_id': '77', 'new_anchor': '57'}, '59')
                        repeated = await bridge.send('send', payload, **kwargs)
                        with self.assertRaisesRegex(ValueError, 'OUTBOX_ID_CONFLICT'):
                            await bridge.send('send', {**payload, 'content': 'Другой ответ'}, **kwargs)
                        self.assertEqual(sent, {'success': True, 'message_id': '56'})
                        self.assertEqual(repeated, sent)
                        resolver.adapter.send.assert_awaited_once()
                        self.assertTrue(resolver.ledger.owns(registered, route, '55', outgoing=False))
                    else:
                        with self.assertRaises(PermissionError):
                            await bridge.send('send', payload, **kwargs)
                        resolver.adapter.send.assert_not_awaited()
                        self.assertIsNone(resolver.reply_outbox.result(ident))
                        self.assertIsNone(resolver.ledger.metadata(registered, route))
                self.assertFalse(resolver.ledger.owns(registered, route, '57'))
                self.assertFalse(resolver.ledger.owns(registered, route, '58'))

    async def test_durable_reply_checks_input_even_with_existing_canonical_route(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        primary = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 2}
        route = ('456', '77')
        source_id = delivery_id('active-input')
        source = {'chat': '456', 'actor_id': '456', 'chat_generation': 0,
                  'state': 'handing_off', 'auth_author': '123', 'auth_role': 'user', 'auth_generation': 2,
                  'payload': json.dumps({'message': {'message_thread_id': 77, 'is_topic_message': True, 'message_id': 55}})}
        resolver.ledger.admit(primary, route, {'thread_id': '77'}, '55')
        resolver.mirror = NS(restartable=True, accepted=AsyncMock(),
                             inbox=NS(delivery_source=lambda *args: source))
        deliver = AsyncMock(return_value={'success': True, 'message_id': '56'})
        resolver.reply_outbox = ReplyOutbox(resolver.ledger.db, deliver)
        bridge = resolver._bridge(primary)
        resolver.turns[primary['uid']] = {'id': 'active-turn', 'route': route,
                                         'delivery': {'delivery_id': source_id}}
        payload = {'chat_id': '456', 'content': 'Ответ', 'metadata': {'thread_id': '77'}}
        options = {'delivery_id': delivery_id('outbound'), 'input_delivery_id': source_id}
        pending = await bridge.send('send', payload, scope_id='stale-turn', **options)
        self.assertEqual(pending, {'success': False, 'retryable': True, 'error': 'Waiting for input acceptance'})
        deliver.assert_not_awaited()
        self.assertIsNone(resolver.reply_outbox.result(options['delivery_id']))
        result = await bridge.send('send', payload, scope_id='active-turn', **options)
        self.assertEqual(result, {'success': True, 'message_id': '56'})
        for state, generation in (('handled', 2), ('accepted', 1)):
            with self.subTest(state=state, generation=generation):
                source.update(state=state, auth_generation=generation)
                options['delivery_id'] = delivery_id([state, generation])
                with self.assertRaises(PermissionError):
                    await bridge.send('send', payload, scope_id='active-turn', **options)
                self.assertIsNone(resolver.reply_outbox.result(options['delivery_id']))
        deliver.assert_awaited_once()

    async def test_saved_reply_rejects_changed_owner_role_and_generation(self):
        restored = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 0}
        for change in ({'uid': 202}, {'userId': 'foreign'}, {'profileId': 'foreign'},
                       {'authorTelegramId': '456'}, {'role': 'guest'}, {'generation': 1}):
            with self.subTest(change=change):
                resolver = runtime.Resolver(NS())
                self.addCleanup(resolver.ledger.close)
                resolver._deliver_route = AsyncMock()
                body = {'profile': restored, 'action': 'send', 'generation': 0,
                        'payload': {'chat_id': '123', 'metadata': {}}}
                active = {**restored, 'authorTelegramId': '123', **change}
                with patch.object(runtime, 'broker_call', AsyncMock(return_value=active)):
                    with self.assertRaises(PermissionError):
                        await resolver._deliver_saved_reply(body)
                resolver._deliver_route.assert_not_awaited()

    async def test_supervisor_bridge_saves_explicit_author_before_first_send(self):
        resolver = runtime.Resolver(NS())
        self.addCleanup(resolver.ledger.close)
        restored = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 0}
        active = {**restored, 'authorTelegramId': '123'}
        resolver.mirror = NS(restartable=True, accepted=AsyncMock(), inbox=NS(
            delivery_source=lambda *args: {'chat': '123', 'actor_id': '123', 'chat_generation': 0,
                'state': 'accepted', 'auth_author': '123', 'auth_role': 'user', 'auth_generation': 0,
                'payload': json.dumps({'message': {'message_thread_id': 77, 'is_topic_message': True}})}))
        resolver.ledger.admit(restored, ('123', '77'), {'thread_id': '77'}, '55')
        resolver._deliver_route = AsyncMock(return_value={'success': True, 'message_id': '56'})
        resolver.reply_outbox = ReplyOutbox(resolver.ledger.db, resolver._deliver_saved_reply)
        bridge = resolver._bridge(restored)
        ident = delivery_id('supervisor-reply')
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=active)):
            result = await bridge.durable_delivery('owner', 'send', {
                'chat_id': '123', 'content': 'Ответ', 'metadata': {'thread_id': '77'}}, ident, delivery_id('input'))
        self.assertEqual(result, {'success': True, 'message_id': '56'})
        body = json.loads(resolver.ledger.db.execute('SELECT body FROM reply_outbox WHERE id=?', (ident,)).fetchone()[0])
        self.assertEqual(body['profile']['authorTelegramId'], '123')
        self.assertNotIn('authorTelegramId', restored)

        progress_id = delivery_id('supervisor-progress')
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=active)):
            await bridge.durable_delivery('owner', 'send', {
                'chat_id': '123', 'content': 'Проверяю документы',
                'metadata': {'thread_id': '77', '_interim_send': True, '_brai_progress': True}},
                progress_id, delivery_id('input'))
        body = json.loads(resolver.ledger.db.execute(
            'SELECT body FROM reply_outbox WHERE id=?', (progress_id,)).fetchone()[0])
        self.assertEqual(body['payload']['metadata'],
                         {'thread_id': '77', '_interim_send': True, '_brai_progress': True})




    async def test_saved_reply_pause_blocks_transport(self):
        resolver = runtime.Resolver(NS())
        self.addCleanup(resolver.ledger.close)
        restored = {**profile(), 'profileId': 'profile', 'role': 'user', 'generation': 0}
        resolver.journal = NS(chat_state=lambda *args: {'paused': True, 'generation': 0})
        resolver._deliver_route = AsyncMock()
        body = {'profile': restored, 'action': 'send', 'generation': 0,
                'payload': {'chat_id': '123', 'metadata': {}}}
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={**restored, 'authorTelegramId': '123'})):
            with self.assertRaises(PermissionError):
                await resolver._deliver_saved_reply(body)
        resolver._deliver_route.assert_not_awaited()

    async def test_operator_retry_preserves_bytes_checks_receipt_and_never_reopens_sent(self):
        resolver = runtime.Resolver(NS())
        self.addCleanup(resolver.ledger.close)
        deliver = AsyncMock(return_value={'success': True, 'message_id': '56'})
        outbox = ReplyOutbox(resolver.ledger.db, deliver)
        ident, owner = delivery_id('operator-retry'), RouteLedger.owner(profile())
        body = {'action': 'send', 'payload': {'content': 'Сохранённый ответ'}}
        outbox.enqueue(ident, owner, body)
        receipt = {'success': False, 'retryable': False, 'error': 'Delivery forbidden'}
        resolver.ledger.db.execute("UPDATE reply_outbox SET state='blocked',receipt=?", (json.dumps(receipt),))
        for wrong_owner, wrong_body, wrong_receipt in [
                ('foreign', body, receipt), (owner, {'changed': True}, receipt), (owner, body, {})]:
            with self.assertRaises(ValueError):
                outbox.retry_blocked(ident, wrong_owner, wrong_body, wrong_receipt)
        self.assertTrue(outbox.retry_blocked(ident, owner, body, receipt))
        self.assertFalse(outbox.retry_blocked(ident, owner, body, receipt))
        await outbox.flush()
        self.assertFalse(outbox.retry_blocked(ident, owner, body, receipt))
        self.assertEqual(outbox.result(ident), {'success': True, 'message_id': '56'})
        deliver.assert_awaited_once_with(body)

    async def test_delayed_batch_cannot_cross_auth_generation_change(self):
        resolver=runtime.Resolver.__new__(runtime.Resolver)
        resolver.mirror=NS(block_event=AsyncMock())
        binding=(101,'profile','owner','123','123','user',1)
        incoming=NS(_brai_release_binding=binding)
        changed={'uid':101,'profileId':'profile','userId':'owner','telegramId':'123',
                 'authorTelegramId':'123','role':'user','generation':2}
        with patch.object(runtime,'broker_call',AsyncMock(return_value={'state':'known','profile':changed})):
            with self.assertRaises(PermissionError):
                await resolver.validate_event_binding(incoming)
        resolver.mirror.block_event.assert_awaited_once_with(incoming)

    async def test_registered_private_user_is_admitted(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())) as broker:
            self.assertTrue(await runtime.admit_update(update, NS()))
        broker.assert_awaited_once_with('identity.resolve', {'telegramId': '123'})

    async def test_preack_binding_change_is_blocked_before_any_command(self):
        from unittest.mock import Mock
        before={'uid':101,'userId':'owner','profileId':'p1','telegramId':'123','authorTelegramId':'123'}
        after={**before,'uid':202,'profileId':'p2'}
        snapshot={'state':'known','profile':before}
        blocked=Mock()
        mirror=NS(snapshot=lambda key:snapshot,inbox=NS(markblocked=blocked))
        adapter=NS(_bot=NS(id=123))
        resolver=NS(mirror=mirror)
        update=NS(update_id=7,effective_message=NS(sender_chat=None,business_connection_id=None,text='/start link_' + 'a' * 43),
                  effective_user=NS(id=123,is_bot=False),effective_chat=NS(id=123,type='private'))
        with patch.dict(runtime._resolvers,{id(adapter):resolver}), \
                patch.object(runtime,'broker_call',AsyncMock(return_value={'state':'known','profile':after})) as broker, \
                patch.object(runtime,'_notice',AsyncMock()):
            self.assertFalse(await runtime.admit_update(update,adapter))
        broker.assert_awaited_once_with('ingress.resolve-known',{'telegramId':'123'},timeout=None)
        blocked.assert_called_once_with(before,123,7)
        self.assertEqual(snapshot['state'],'binding_changed')

    async def test_unregistered_snapshot_cannot_turn_into_registered_dispatch(self):
        snapshot={'state':'unregistered'}
        mirror=NS(snapshot=lambda key:snapshot)
        adapter=NS(_bot=NS(id=123));resolver=NS(mirror=mirror)
        update=NS(update_id=8,effective_message=NS(sender_chat=None,business_connection_id=None,text='hello'),
                  effective_user=NS(id=123,is_bot=False),effective_chat=NS(id=123,type='private'))
        with patch.dict(runtime._resolvers,{id(adapter):resolver}), \
                patch.object(runtime,'broker_call',AsyncMock(return_value={'state':'known','profile':profile()})) as broker, \
                patch.object(runtime,'_notice',AsyncMock()):
            self.assertFalse(await runtime.admit_update(update,adapter))
        broker.assert_awaited_once_with('ingress.resolve-known',{'telegramId':'123'},timeout=None)
        self.assertEqual(snapshot['state'],'binding_changed')

    async def test_non_private_updates_are_ignored_before_broker_or_notice(self):
        for chat_type, chat_id in [('group', -10), ('supergroup', -100), ('channel', -100),
                                   ('private', 456), (None, 123)]:
            for text in ['hello', '/start invite_abcdefghijklmnop', '/link', '/unlink', '/start link_' + 'a' * 43]:
                with self.subTest(chat_type=chat_type, text=text):
                    update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                                effective_user=NS(id=123, is_bot=False),
                                effective_chat=NS(id=chat_id, type=chat_type))
                    adapter = NS(send=AsyncMock(return_value={'success': True}))
                    with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                        self.assertFalse(await runtime.admit_update(update, adapter))
                    broker.assert_not_awaited()
                    adapter.send.assert_not_awaited()

    async def test_only_standalone_waits_make_the_reply_optional(self):
        resolver = runtime.Resolver(NS())
        self.addAsyncCleanup(resolver.close)
        sequence = (
            ('Внеси два протокола в таблицу', None, True),
            ('Таблица', 'xlsx', True),
            ('Это таблица жди', None, False),
            ('Сейчас будет два протокола', None, False),
            ('Сейчас будут ещё два протокола.', None, False),
            ('Я пришлю ещё файл', None, False),
            ('Подожди, пожалуйста.\nСейчас отправлю еще один файл.', None, False),
            ('Жди, но сначала проверь сумму', None, True),
            ('Сейчас будет два протокола?', None, True),
            ('Жди\nПроверь итог', None, True),
            ('Жди', 'docx', True),
            ('Второй протокол', 'docx', True),
        )

        async def broker(method, payload, **_):
            return {'paths': ['/isolated/' + Path(path).name for path in payload['paths']]} if method == 'ingress.prepare' else {}

        with patch.object(runtime, 'broker_call', side_effect=broker):
            for index, (body, filetype, expected) in enumerate(sequence, 100):
                with self.subTest(body=body, filetype=filetype):
                    path = f'/ingress/{index}.{filetype}' if filetype else None
                    incoming = NS(source=NS(chat_id='123', thread_id='77', chat_type='dm'),
                                  text=body, message_id=str(index), message_type='document' if filetype else 'text',
                                  reply_expected=True, media_urls=[path] if path else [],
                                  _brai_identity_inputs=[{'path': path, 'itemId': str(index)}] if path else [])
                    data = await resolver.prepare(profile(), incoming)
                    self.assertEqual(data['reply_expected'], expected)
                    self.assertEqual(data['text'], body)
                    if filetype:
                        self.assertEqual(data['media_urls'], [f'/isolated/{index}.{filetype}'])
                    self.assertTrue(resolver.ledger.owns(profile(), ('123', '77'), str(index), outgoing=False))

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
                adapter = NS(send=AsyncMock(return_value={'success': True}))
                with patch.object(runtime, 'broker_call', AsyncMock(return_value=result)) as broker:
                    self.assertFalse(await runtime.admit_update(update, adapter))
                self.assertEqual(broker.await_count, 1)
                self.assertEqual(broker.await_args.args[0], method)
                self.assertEqual(broker.await_args.args[1]['telegramId'], '456')
                adapter.send.assert_awaited_once()

    async def test_control_replies_keep_the_source_private_topic(self):
        cases = [('/start link_' + 'a' * 43, {'user': {'id': 'owner'}}),
                 ('/start link_' + 'a' * 43, {}),
                 ('/start link_short', {})]
        for text, response in cases:
            with self.subTest(command=text[:12], accepted=bool(response)):
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                            text=text, message_thread_id=73), effective_user=NS(id=456, is_bot=False),
                            effective_chat=NS(id=456, type='private'))
                adapter = NS(send=AsyncMock(return_value={'success': True}))
                with patch.object(runtime, 'broker_call', AsyncMock(return_value=response)):
                    self.assertFalse(await runtime.admit_update(update, adapter))
                self.assertEqual(adapter.send.await_args.args[0], '456')
                self.assertEqual(adapter.send.await_args.kwargs, {'metadata': {'message_thread_id': 73}})

    async def test_link_reply_without_topic_does_not_invent_one(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text='/start link_' + 'a' * 43), effective_user=NS(id=456, is_bot=False),
                    effective_chat=NS(id=456, type='private'))
        adapter = NS(send=AsyncMock(return_value={'success': True}))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'user': {'id': 'owner'}})):
            self.assertFalse(await runtime.admit_update(update, adapter))
        self.assertEqual(adapter.send.await_args.kwargs, {})

    async def test_failed_link_reply_is_observed_without_redeeming_or_sending_again(self):
        secret = 'a' * 43
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text='/start link_' + secret, message_thread_id=73),
                    effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type='private'))
        adapter = NS(send=AsyncMock(return_value={'success': False, 'error': secret, 'retryable': True}))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'user': {'id': 'owner'}})) as broker:
            with self.assertLogs(runtime.__name__, level='WARNING') as logs:
                self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_awaited_once()
        adapter.send.assert_awaited_once()
        self.assertIn('status=unconfirmed', logs.output[0])
        self.assertNotIn(secret, ''.join(logs.output))

    async def test_exception_in_link_reply_logs_only_type_and_never_retries(self):
        secret = 'b' * 43
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text='/start link_' + secret, message_thread_id=73),
                    effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type='private'))
        adapter = NS(send=AsyncMock(side_effect=RuntimeError('secret ' + secret)))
        with patch.object(runtime, 'broker_call', AsyncMock(return_value={'user': {'id': 'owner'}})) as broker:
            with self.assertLogs(runtime.__name__, level='WARNING') as logs:
                self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_awaited_once()
        adapter.send.assert_awaited_once()
        self.assertIn('error=RuntimeError', logs.output[0])
        self.assertNotIn(secret, ''.join(logs.output))

    async def test_notices_are_scoped_to_topic_and_failed_delivery_does_not_throttle(self):
        runtime._notices.clear()
        adapter = NS(send=AsyncMock(side_effect=[{'success': False}, {'success': True}, {'success': True}]))
        first, second = NS(message_thread_id=73), NS(message_thread_id=74)
        with self.assertLogs(runtime.__name__, level='WARNING'):
            await runtime._notice(adapter, '456', first, 'notice')
        await runtime._notice(adapter, '456', first, 'notice')
        await runtime._notice(adapter, '456', first, 'notice')
        await runtime._notice(adapter, '456', second, 'notice')
        self.assertEqual(adapter.send.await_count, 3)
        self.assertEqual([call.kwargs['metadata']['message_thread_id'] for call in adapter.send.await_args_list], [73, 73, 74])
        runtime._notices.clear()

    async def test_raw_unlink_is_ignored_without_revoking(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text='/unlink'),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
        adapter = NS(send=AsyncMock(return_value={'success': True}))
        with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
            self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_not_awaited()
        adapter.send.assert_not_awaited()

    async def test_full_human_answer_is_forwarded_without_parsing_or_normalization(self):
        for text in ["Подтверждаю отвязку Telegram-аккаунта 123",
                     " Да, это мой второй личный аккаунт. Все риски понимаю.\n",
                     "Да", "Отвяжи аккаунт 123", "В архиве: подтверждаю", "Подтверждаю, если…",
                     "Не подтверждаю", ""]:
            with self.subTest(text=text):
                incoming = event()
                incoming.text = text
                broker = AsyncMock(side_effect=[{}, {"paths": ["/user/a"]}])
                with patch.object(runtime, "broker_call", broker):
                    await runtime.Resolver(NS()).prepare(profile(), incoming)
                admission = broker.await_args_list[0].args[1]
                self.assertEqual(admission["accountAnswer"], text)
                self.assertNotIn("linkConsent", admission)
                self.assertNotIn("unlinkConsent", admission)

    async def test_malformed_link_secrets_never_reach_broker_or_agent(self):
        for secret in ['short', 'a' * 44, 'a' * 43 + '\nextra']:
            update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text='/start link_' + secret),
                        effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type='private'))
            adapter = NS(send=AsyncMock(return_value={'success': True}))
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

    async def test_answer_limit_keeps_full_text_or_empty_and_never_truncates(self):
        for text, expected in [("x" * 8192, "x" * 8192), ("x" * 8193, ""), (None, "")]:
            with self.subTest(size=len(text) if isinstance(text, str) else None):
                incoming = event()
                incoming.text = text
                broker = AsyncMock(side_effect=[{}, {"paths": ["/user/a"]}])
                with patch.object(runtime, "broker_call", broker):
                    await runtime.Resolver(NS()).prepare(profile(), incoming)
                admission = broker.await_args_list[0].args[1]
                self.assertEqual(admission["accountAnswer"], expected)
                self.assertNotIn("linkConsent", admission)
                self.assertNotIn("unlinkConsent", admission)

    async def test_explicit_account_refusal_is_taken_from_current_text_only(self):
        for text in ["Нет", "Нет!", "Не подтверждаю", "Отмена"]:
            with self.subTest(text=text):
                incoming = event()
                incoming.text = text
                broker = AsyncMock(side_effect=[{}, {"paths": ["/user/a"]}])
                with patch.object(runtime, "broker_call", broker):
                    await runtime.Resolver(NS()).prepare(profile(), incoming)
                self.assertIs(broker.await_args_list[0].args[1]["accountRefused"], True)

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
        adapter = NS(send=AsyncMock(return_value={'success': True}))
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
        adapter = NS(send=AsyncMock(return_value={'success': True}))
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
        adapter = NS(send=AsyncMock(return_value={'success': True}))
        update = NS(effective_message=NS(sender_chat=None,business_connection_id=None,text='/start bad'),
                    effective_user=NS(id=123,is_bot=False,full_name='User'), effective_chat=NS(id=123,type='private'))
        broker = AsyncMock(side_effect=PermissionError('denied'))
        with patch.object(runtime, 'broker_call', broker), patch.object(runtime, '_notice', AsyncMock()):
            self.assertFalse(await runtime.admit_update(update, adapter))
        self.assertEqual([call.args[0] for call in broker.await_args_list], ['identity.resolve'])

    async def test_new_user_start_and_invite_do_not_require_worker(self):
        for text, expected_calls in [('/start', ['identity.resolve']),
                ('/start invite_abcdefghijklmnop', ['identity.resolve', 'identity.invite-redeem'])]:
            with self.subTest(text=text):
                adapter = NS()
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                    effective_user=NS(id=123, is_bot=False, full_name='Fixture'),
                    effective_chat=NS(id=123, type='private'))
                async def broker(method, params, **kwargs):
                    if method == 'identity.resolve':
                        raise PermissionError('Unregistered fixture')
                    self.assertEqual(method, 'identity.invite-redeem')
                    return {}
                with patch.object(runtime, 'broker_call', AsyncMock(side_effect=broker)) as call, \
                        patch.object(runtime, '_control_reply', AsyncMock()) as notice:
                    self.assertFalse(await runtime.admit_update(update, adapter))
                    self.assertEqual([c.args[0] for c in call.await_args_list], expected_calls)
                    notice.assert_awaited_once()

    async def test_disabled_commands_do_not_resolve_profile_or_dispatch(self):
        for text in ['/help', '/commands', '/cancel', '/unlink', '/startnot', '/start_any', '/HELP args', '/help@brai_bot',
                     '/new@bot/anything', '/new@', '/start@bot/anything', '@file:/tmp/x\n/new']:
            with self.subTest(text=text):
                adapter = NS(send=AsyncMock())
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
                with patch.object(runtime, 'broker_call', AsyncMock()) as broker:
                    self.assertFalse(await runtime.admit_update(update, adapter))
                    broker.assert_not_awaited()
                    adapter.send.assert_not_awaited()

    async def test_two_new_start_messages_each_reply_in_original_topic_without_worker(self):
        adapter = NS(send=AsyncMock(return_value={'success': True, 'message_id': '700'}))
        with patch.dict(runtime._resolvers, {}, clear=True), \
                patch.dict(runtime._notices, {('123', '9'): time.monotonic()}), \
                patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())) as broker:
            for ident in [10, 11]:
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text='/start', message_id=ident, message_thread_id=9),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
                self.assertFalse(await runtime.admit_update(update, adapter))
        self.assertEqual(adapter.send.await_count, 2)
        for call in adapter.send.await_args_list:
            self.assertEqual(call.kwargs['metadata']['message_thread_id'], 9)
            self.assertTrue(call.args[1])
        self.assertTrue(all(c.args[0] == 'identity.resolve' for c in broker.await_args_list))

    async def test_normal_text_and_absolute_paths_remain_admitted(self):
        with patch.dict(runtime._resolvers, {}, clear=True), \
                patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())):
            for text in ['Помоги с файлом', '/home/user/document.txt', '/tmp/a.pdf']:
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text=text),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
                self.assertTrue(await runtime.admit_update(update, NS()))

    async def test_command_menus_are_deleted_in_all_native_scopes_and_not_recreated(self):
        scopes = NS(BotCommandScopeDefault=lambda: NS(type='default'),
            BotCommandScopeAllPrivateChats=lambda: NS(type='all_private_chats'),
            BotCommandScopeAllGroupChats=lambda: NS(type='all_group_chats'),
            BotCommandScopeChat=lambda chat: NS(type='chat', chat_id=chat))
        bot = NS(delete_my_commands=AsyncMock(return_value=True),
                 get_my_commands=AsyncMock(return_value=()), set_my_commands=AsyncMock())
        resolver = runtime.Resolver(NS(_bot=bot))
        self.addCleanup(resolver.ledger.close)
        resolver._known_forum_chats = lambda: {123, -100456}
        with patch.dict(sys.modules, {'telegram': scopes}):
            await resolver.hide_command_menu()
            self.assertEqual(bot.delete_my_commands.await_count, 5)
            self.assertEqual(bot.get_my_commands.await_count, 5)
            await resolver.hide_forum_command_menu(NS(chat=NS(id=123, is_forum=True)))
            self.assertEqual(bot.delete_my_commands.await_count, 5)
            await resolver.hide_forum_command_menu(NS(chat=NS(id=789, is_forum=False)))
            self.assertEqual(bot.delete_my_commands.await_count, 5)
            await resolver.hide_forum_command_menu(NS(chat=NS(id=-100789, is_forum=True)))
            self.assertEqual(bot.delete_my_commands.await_count, 6)
            await resolver.hide_command_menu()
            self.assertEqual(bot.delete_my_commands.await_count, 6)
        bot.set_my_commands.assert_not_awaited()
        self.assertTrue(all(c.kwargs['language_code'] == '' for c in bot.delete_my_commands.await_args_list))

    async def test_forum_menu_failure_does_not_drop_regular_message(self):
        scopes = NS(BotCommandScopeChat=lambda chat: NS(type='chat', chat_id=chat))
        bot = NS(delete_my_commands=AsyncMock(side_effect=TimeoutError), get_my_commands=AsyncMock())
        resolver = runtime.Resolver(NS(_bot=bot))
        self.addCleanup(resolver.ledger.close)
        with patch.dict(sys.modules, {'telegram': scopes}), self.assertLogs(runtime.__name__, level='WARNING'):
            await resolver.hide_forum_command_menu(NS(chat=NS(id=-100789, is_forum=True)))
        self.assertFalse(resolver.cleared_command_menus)
        bot.get_my_commands.assert_not_awaited()

    async def test_uid_rebinding_to_other_owner_fails_closed(self):
        resolver = runtime.Resolver(NS())
        first = profile()
        changed = {**first, 'userId':'other'}
        source = NS(user_id='123')
        with patch.object(runtime, 'broker_call', AsyncMock(side_effect=[first, changed])):
            await resolver(source)
            with self.assertRaises(PermissionError):
                await resolver(source)

    async def test_machine_link_ack_uses_real_labels_and_unlink_hint_without_profile_ids_or_agent_dispatch(self):
        labels = [{"name": "Анна Тест", "username": "anna"}, {"name": "Борис", "username": "boris"}]
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text="/start link_" + "a" * 43, message_thread_id=73),
                    effective_user=NS(id=456, is_bot=False), effective_chat=NS(id=456, type="private"))
        adapter = NS(send=AsyncMock(return_value={"success": True, "message_id": "700"}))
        result = {"user": {"id": "private-owner", "profileId": "private-profile"}, "accounts": labels}
        with patch.object(runtime, "broker_call", AsyncMock(return_value=result)) as broker:
            self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_awaited_once()
        adapter.send.assert_awaited_once()
        text = adapter.send.await_args.args[1]
        for label in ["Анна Тест", "@anna", "Борис", "@boris"]:
            self.assertIn(label, text)
        self.assertIn("отвяз", text.casefold())
        for hidden in ["private-owner", "private-profile", "бесед", "a" * 43]:
            self.assertNotIn(hidden, text.casefold())
        self.assertEqual(adapter.send.await_args.kwargs, {"metadata": {"message_thread_id": 73}})

    async def test_missing_telegram_labels_do_not_undo_or_repeat_successful_redemption(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                    text="/start link_" + "b" * 43), effective_user=NS(id=456, is_bot=False),
                    effective_chat=NS(id=456, type="private"))
        adapter = NS(send=AsyncMock(return_value={"success": True}))
        with patch.object(runtime, "broker_call", AsyncMock(return_value={
                "user": {"id": "private-owner", "profileId": "private-profile"},
                "accounts": [{"name": None, "username": None}, {"name": None, "username": None}]})) as broker:
            self.assertFalse(await runtime.admit_update(update, adapter))
        broker.assert_awaited_once()
        adapter.send.assert_awaited_once()
        text = adapter.send.await_args.args[1]
        self.assertIn("подключ", text.casefold())
        for hidden in ["private-owner", "private-profile", "None", "бесед", "b" * 43]:
            self.assertNotIn(hidden, text)

    async def test_only_confirmed_final_question_delivery_is_reported_to_broker_on_end(self):
        cases = [
            ("send", {}, {}, NS(success=True, message_id="200"), True, "200"),
            ("send", {}, {}, {"success": True, "message_id": "200", "continuation_message_ids": ["201", "202"]}, True, "202"),
            ("send", {}, {}, NS(success=True, message_id="200", raw_response={"message_ids": ["200", "201", "202"]}), True, "202"),
            ("edit_message", {"message_id": "190", "finalize": True}, {}, {"success": True, "message_id": "190"}, True, "190"),
            ("send", {}, {"_interim_send": True}, {"success": True, "message_id": "200"}, True, None),
            ("edit_message", {"message_id": "190", "finalize": False}, {}, {"success": True, "message_id": "190"}, True, None),
            ("send", {}, {}, {"success": False, "message_id": "200"}, True, None),
            ("send", {}, {}, {"success": True}, True, None),
            ("send", {}, {}, {"success": True, "message_id": "200"}, False, None),
            ("send_typing", {}, {}, None, True, None),
            ("send", {}, {}, {"success": True, "message_id": "200"}, "legacy-status-without-offer", None),
        ]
        for action, extra, metadata, receipt, needed, expected in cases:
            with self.subTest(action=action, extra=extra, metadata=metadata, needed=needed, expected=expected):
                adapter = NS(**{action: AsyncMock(return_value=receipt)})
                resolver = runtime.Resolver(adapter)
                resolver.turns[101] = {"id": "offer", "route": ("123", ""), "workerTurnId": "worker", "inputId": "a" * 64}
                async def broker(method, params, **kwargs):
                    if method == "ingress.status":
                        return {"suppressFinal": False, "needsAccountConsent": bool(needed),
                                **({"accountOfferId": "b" * 32} if needed is True else {})}
                    self.assertEqual(method, "ingress.close")
                    return {"closed": True}
                with patch.object(runtime, "broker_call", AsyncMock(side_effect=broker)) as calls:
                    await resolver.deliver(profile(), "owner", action,
                        {"chat_id": "123", "content": "Предупреждение и вопрос", "metadata": metadata, **extra})
                    await resolver.end(profile(), "worker")
                close = [call.args[1] for call in calls.await_args_list if call.args[0] == "ingress.close"]
                self.assertEqual(len(close), 1)
                if expected is None:
                    self.assertNotIn("questionMessageId", close[0])
                else:
                    self.assertEqual(close[0]["questionMessageId"], expected)
                    self.assertEqual(close[0]["inputId"], "a" * 64)
                    self.assertEqual(close[0]["accountOfferId"], "b" * 32)

    async def test_failed_final_question_send_cannot_leave_a_delivery_confirmation(self):
        adapter = NS(send=AsyncMock(side_effect=RuntimeError("synthetic send refusal")))
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {"id": "offer", "route": ("123", ""), "workerTurnId": "worker", "inputId": "a" * 64}
        calls = []
        async def broker(method, params, **kwargs):
            calls.append((method, params))
            return {"suppressFinal": False, "needsAccountConsent": True, "accountOfferId": "b" * 32} if method == "ingress.status" else {"closed": True}
        with patch.object(runtime, "broker_call", broker):
            with self.assertRaises(RuntimeError):
                await resolver.deliver(profile(), "owner", "send", {"chat_id": "123", "content": "Вопрос"})
            await resolver.end(profile(), "worker")
        self.assertNotIn("questionMessageId", calls[-1][1])

    async def test_old_question_success_then_new_input_failed_final_cannot_confirm_new_offer(self):
        adapter = NS(send=AsyncMock(side_effect=[{"success": True, "message_id": "200"},
                                                 {"success": False, "message_id": "201"}]))
        resolver = runtime.Resolver(adapter)
        offer_id, calls = "a" * 32, []
        async def broker(method, params, **kwargs):
            calls.append((method, params))
            if method == "ingress.status":
                return {"suppressFinal": False, "needsAccountConsent": True, "accountOfferId": offer_id}
            return {"closed": True}
        incoming = event()
        incoming.media_urls, incoming._brai_identity_inputs = [], []
        with patch.object(runtime, "broker_call", broker):
            await resolver.prepare(profile(), incoming)
            await resolver.deliver(profile(), "owner", "send", {"chat_id": "123", "text": "Вопрос A"})
            self.assertIn("questionReceipt", resolver.turns[101])
            incoming.text, incoming.message_id = "Другой запрос B", "56"
            offer_id = "b" * 32
            await resolver.prepare(profile(), incoming)
            self.assertNotIn("questionReceipt", resolver.turns[101])
            await resolver.deliver(profile(), "owner", "send", {"chat_id": "123", "text": "Вопрос B"})
            await resolver.end(profile(), None)
        close = [params for method, params in calls if method == "ingress.close"][-1]
        self.assertIn("inputId", close)
        self.assertNotIn("questionMessageId", close)
        self.assertNotIn("accountOfferId", close)

    async def test_delayed_old_send_cannot_confirm_replaced_offer_even_with_same_input(self):
        for change_input in [False, True]:
            with self.subTest(change_input=change_input):
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed_send(**kwargs):
                    entered.set()
                    await release.wait()
                    return {"success": True, "message_id": "200"}
                adapter = NS(send=delayed_send)
                resolver = runtime.Resolver(adapter)
                offer_id, calls = "a" * 32, []
                async def broker(method, params, **kwargs):
                    calls.append((method, params))
                    if method == "ingress.status":
                        return {"suppressFinal": False, "needsAccountConsent": True, "accountOfferId": offer_id}
                    return {"closed": True}
                incoming = event()
                incoming.media_urls, incoming._brai_identity_inputs = [], []
                with patch.object(runtime, "broker_call", broker):
                    await resolver.prepare(profile(), incoming)
                    task = asyncio.create_task(resolver.deliver(profile(), "owner", "send",
                        {"chat_id": "123", "text": "Вопрос A"}))
                    await asyncio.wait_for(entered.wait(), 1)
                    offer_id = "b" * 32
                    if change_input:
                        incoming.text, incoming.message_id = "Новый запрос B", "56"
                        await resolver.prepare(profile(), incoming)
                    release.set()
                    await task
                    await resolver.end(profile(), None)
                close = [params for method, params in calls if method == "ingress.close"][-1]
                self.assertNotIn("questionMessageId", close)
                self.assertNotIn("accountOfferId", close)

    async def test_native_multipart_receipt_exposes_only_valid_ids_not_raw_response_content(self):
        normalized = runtime._receipt(NS(success=True, message_id="200",
            raw_response={"message_ids": ["200", "201", True, "0", "not-an-id"],
                          "text": "synthetic-private-raw-content", "other": {"secret": "never-forward"}}))
        self.assertNotIn("raw_response", normalized)
        self.assertNotIn("synthetic-private-raw-content", repr(normalized))
        self.assertNotIn("never-forward", repr(normalized))
        ids = normalized.get("continuation_message_ids", [])
        self.assertIn("201", ids)
        self.assertTrue(all(isinstance(value, str) and value.isascii() and value.isdigit()
                            and 0 < int(value) and len(value) <= 20 for value in ids))

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


    async def test_one_or_unknown_account_result_never_claims_two_accounts_or_repeats_redemption(self):
        for accounts in [[{"name": "Анна Тест", "username": "anna"}], []]:
            with self.subTest(account_count=len(accounts)):
                update = NS(effective_message=NS(sender_chat=None, business_connection_id=None,
                            text="/start link_" + "c" * 43, message_thread_id=73),
                            effective_user=NS(id=456, is_bot=False),
                            effective_chat=NS(id=456, type="private"))
                adapter = NS(send=AsyncMock(return_value={"success": True, "message_id": "700"}))
                with patch.object(runtime, "broker_call", AsyncMock(return_value={
                        "user": {"id": "private-owner", "profileId": "private-profile"},
                        "accounts": accounts})) as broker:
                    self.assertFalse(await runtime.admit_update(update, adapter))
                broker.assert_awaited_once()
                adapter.send.assert_awaited_once()
                self.assertEqual(adapter.send.await_args.args[0], "456")
                self.assertEqual(adapter.send.await_args.kwargs,
                                 {"metadata": {"message_thread_id": 73}})
                text = adapter.send.await_args.args[1]
                for hidden in ["Оба аккаунта", "Аккаунт привязан", "private-owner",
                               "private-profile", "бесед", "c" * 43]:
                    self.assertNotIn(hidden, text)
                if accounts:
                    self.assertIn("Второй аккаунт не добавлен", text)
                    self.assertIn("Анна Тест", text)
                    self.assertIn("@anna", text)
                    self.assertIn("новую команду", text)
                    self.assertIn("со второго личного аккаунта", text)
                else:
                    self.assertIn("проверить список", text)
                    self.assertIn("Повторять команду не нужно", text)


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
