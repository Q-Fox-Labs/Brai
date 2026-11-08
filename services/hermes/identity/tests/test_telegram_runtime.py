# ABOUTME: Проверяет связку Telegram ingress с брокером личного процесса.
# ABOUTME: Все сетевые вызовы заменены локальными подставными ответами.
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import telegram_runtime as runtime


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
                    adapter = NS(send=AsyncMock(return_value={'success': True}))
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
                 ('/start link_short', {}), ('/unlink', {})]
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

    async def test_raw_unlink_only_explains_agent_workflow_without_revoking(self):
        update = NS(effective_message=NS(sender_chat=None, business_connection_id=None, text='/unlink'),
                    effective_user=NS(id=123, is_bot=False), effective_chat=NS(id=123, type='private'))
        adapter = NS(send=AsyncMock(return_value={'success': True}))
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

    async def test_confirmation_uses_natural_current_human_text_without_quotes_conditions_or_negation(self):
        positive = ["Подтверждаю", "Да, подтверждаю!", "Согласен.", "Согласна",
                    "Подтверждаю привязку моего второго аккаунта"]
        negative = ["Не подтверждаю", "Не согласен", "Нет", "Отмена",
                    "«Подтверждаю»", '"подтверждаю"', "Он сказал: подтверждаю",
                    "Подтверждаю, если это бесплатно", "Согласен при условии, что данные не общие",
                    "В архиве было: да"]
        for text, expected in [(text, True) for text in positive] + [(text, False) for text in negative]:
            with self.subTest(text=text):
                incoming = event()
                incoming.text = text
                broker = AsyncMock(side_effect=[{}, {"paths": ["/user/a"]}])
                with patch.object(runtime, "broker_call", broker):
                    await runtime.Resolver(NS()).prepare(profile(), incoming)
                self.assertIs(broker.await_args_list[0].args[1]["linkConsent"], expected)

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
        ]
        for action, extra, metadata, receipt, needed, expected in cases:
            with self.subTest(action=action, extra=extra, metadata=metadata, needed=needed, expected=expected):
                adapter = NS(**{action: AsyncMock(return_value=receipt)})
                resolver = runtime.Resolver(adapter)
                resolver.turns[101] = {"id": "offer", "route": ("123", ""), "workerTurnId": "worker"}
                async def broker(method, params, **kwargs):
                    if method == "ingress.status":
                        return {"suppressFinal": False, "needsAccountConsent": needed}
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

    async def test_failed_final_question_send_cannot_leave_a_delivery_confirmation(self):
        adapter = NS(send=AsyncMock(side_effect=RuntimeError("synthetic send refusal")))
        resolver = runtime.Resolver(adapter)
        resolver.turns[101] = {"id": "offer", "route": ("123", ""), "workerTurnId": "worker"}
        calls = []
        async def broker(method, params, **kwargs):
            calls.append((method, params))
            return {"suppressFinal": False, "needsAccountConsent": True} if method == "ingress.status" else {"closed": True}
        with patch.object(runtime, "broker_call", broker):
            with self.assertRaises(RuntimeError):
                await resolver.deliver(profile(), "owner", "send", {"chat_id": "123", "content": "Вопрос"})
            await resolver.end(profile(), "worker")
        self.assertNotIn("questionMessageId", calls[-1][1])

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
