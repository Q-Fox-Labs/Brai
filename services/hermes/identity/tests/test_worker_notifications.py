# ABOUTME: Проверяет автоматические темы, повторы и изоляцию личных Telegram-профилей.
# ABOUTME: Использует настоящие SQLite, Bridge и Resolver с управляемым Telegram-портом.
import ast
import asyncio
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.notifications import NotificationTopics
from identity.routes import RouteLedger
from identity.scope import request_scope, delivery_scope
from identity import telegram_runtime as runtime
from identity.ingress import Bridge
from identity.adapter import make_adapter


class BadRequest(Exception):
    pass


class Forbidden(Exception):
    pass


class RetryAfter(Exception):
    pass


def profile(chat='123', owner='owner'):
    return {'uid': 101 if owner == 'owner' else 102, 'userId': owner, 'profileId': owner,
            'telegramId': chat, 'authorTelegramId': '123', 'workerSocket': '/unused'}


class NotificationsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        errors = ModuleType('telegram.error')
        errors.BadRequest, errors.Forbidden, errors.RetryAfter = BadRequest, Forbidden, RetryAfter
        self.errors = patch.dict(sys.modules, {'telegram.error': errors})
        self.errors.start()
        self.addCleanup(self.errors.stop)
        self.ledger = RouteLedger()
        self.addCleanup(self.ledger.close)
        self.bot = NS(create_forum_topic=AsyncMock(side_effect=[NS(message_thread_id=n) for n in range(7, 40)]),
                      edit_forum_topic=AsyncMock(return_value=True))
        self.topics = NotificationTopics(self.ledger, lambda: self.bot)

    async def test_parallel_first_deliveries_create_one_topic_and_send_once_each(self):
        sent = []
        async def send(route, metadata):
            sent.append(route)
            return {'success': True, 'message_id': str(100 + len(sent))}
        results = await asyncio.gather(*(self.topics.deliver(profile(), '123', send, text=True)
                                        for _ in range(20)))
        self.assertTrue(all(r['success'] for r in results))
        self.assertEqual(sent, [('123', '7')] * 20)
        self.bot.create_forum_topic.assert_awaited_once()
        self.assertEqual(self.ledger.metadata(profile(), ('123', '7')), self.topics.metadata('7'))

    async def test_parallel_deleted_topic_recovery_uses_one_replacement(self):
        await self.topics.ensure(profile(), '123')
        arrived, release = 0, asyncio.Event()
        async def send(route, metadata):
            nonlocal arrived
            if route[1] == '7':
                arrived += 1
                if arrived == 2:
                    release.set()
                await release.wait()
                return {'success': False, 'error': 'Message thread not found'}
            return {'success': True, 'message_id': '200'}
        results = await asyncio.gather(*(self.topics.deliver(profile(), '123', send, text=True)
                                        for _ in range(2)))
        self.assertTrue(all(r['success'] for r in results))
        self.assertEqual(self.bot.create_forum_topic.await_count, 2)

    async def test_restart_reuses_topic_and_keeps_accounts_and_profiles_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'routes.sqlite'
            first = RouteLedger(path)
            topics = NotificationTopics(first, lambda: self.bot)
            self.assertEqual(await topics.ensure(profile(), '123'), '7')
            first.close()
            second = RouteLedger(path)
            self.addCleanup(second.close)
            topics = NotificationTopics(second, lambda: self.bot)
            self.assertEqual(await topics.ensure(profile(), '123'), '7')
            self.assertEqual(await topics.ensure(profile('456'), '456'), '8')
            self.assertEqual(await topics.ensure(profile(owner='another'), '123'), '9')
            self.assertEqual(self.bot.create_forum_topic.await_count, 3)
            self.assertIsNone(second.metadata(profile('456'), ('456', '7')))

    async def test_unknown_create_survives_restart_without_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            path = Path(directory) / 'routes.sqlite'
            first = RouteLedger(path)
            self.bot.create_forum_topic.side_effect = TimeoutError
            with self.assertRaises(TimeoutError):
                await NotificationTopics(first, lambda: self.bot).ensure(profile(), '123')
            first.close()
            second = RouteLedger(path)
            self.addCleanup(second.close)
            with self.assertRaisesRegex(RuntimeError, 'unknown'):
                await NotificationTopics(second, lambda: self.bot).ensure(profile(), '123')
            self.bot.create_forum_topic.assert_awaited_once()

    async def test_cancel_and_invalid_receipt_never_allow_second_creation(self):
        for error in (asyncio.CancelledError(), None):
            ledger = RouteLedger()
            self.addCleanup(ledger.close)
            bot = NS(create_forum_topic=AsyncMock(side_effect=error) if error else
                     AsyncMock(return_value=NS(message_thread_id=None)))
            topics = NotificationTopics(ledger, lambda: bot)
            with self.assertRaises(asyncio.CancelledError if error else ValueError):
                await topics.ensure(profile(), '123')
            with self.assertRaisesRegex(RuntimeError, 'unknown'):
                await topics.ensure(profile(), '123')
            bot.create_forum_topic.assert_awaited_once()

    async def test_disconnected_bot_and_revocation_while_waiting_do_not_reserve_creation(self):
        topics = NotificationTopics(self.ledger, lambda: None)
        with self.assertRaisesRegex(RuntimeError, 'unavailable'):
            await topics.ensure(profile(), '123')
        authorize = AsyncMock(side_effect=PermissionError('revoked'))
        topics = NotificationTopics(self.ledger, lambda: self.bot, authorize)
        with self.assertRaises(PermissionError):
            await topics.ensure(profile(), '123')
        self.bot.create_forum_topic.assert_not_awaited()
        self.assertEqual(await self.topics.ensure(profile(), '123'), '7')

    async def test_two_ingresses_share_atomic_reservation(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def create(**kwargs):
            entered.set()
            await release.wait()
            return NS(message_thread_id=7)
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            first, second = RouteLedger(Path(directory) / 'state'), RouteLedger(Path(directory) / 'state')
            self.addCleanup(first.close)
            self.addCleanup(second.close)
            self.bot.create_forum_topic.side_effect = create
            one = asyncio.create_task(NotificationTopics(first, lambda: self.bot).ensure(profile(), '123'))
            await entered.wait()
            with self.assertRaisesRegex(RuntimeError, 'unknown'):
                await NotificationTopics(second, lambda: self.bot).ensure(profile(), '123')
            release.set()
            self.assertEqual(await one, '7')
            self.assertEqual(await NotificationTopics(second, lambda: self.bot).ensure(profile(), '123'), '7')
            self.bot.create_forum_topic.assert_awaited_once()

    async def test_explicit_creation_refusal_can_be_retried_after_fix(self):
        self.bot.create_forum_topic.side_effect = [BadRequest('topics disabled'), NS(message_thread_id=7)]
        with self.assertRaises(BadRequest):
            await self.topics.ensure(profile(), '123')
        self.assertEqual(await self.topics.ensure(profile(), '123'), '7')

    async def test_delivery_timeout_partial_result_and_other_errors_do_not_resend(self):
        cases = [
            TimeoutError(),
            {'success': False, 'error': 'Forbidden'},
            {'success': False, 'error': 'Message thread not found', 'message_id': '101'},
            {'success': False, 'error': 'Message thread not found', 'continuation_message_ids': ['101']},
            {'success': False, 'error': 'Message thread not found',
             'raw_response': {'partial_overflow': True, 'delivered_chunks': 1}},
        ]
        for value in cases:
            send = AsyncMock(side_effect=value) if isinstance(value, Exception) else AsyncMock(return_value=value)
            if isinstance(value, Exception):
                with self.assertRaises(TimeoutError):
                    await self.topics.deliver(profile(), '123', send, text=True)
            else:
                self.assertEqual(await self.topics.deliver(profile(), '123', send, text=True), value)
            send.assert_awaited_once()
        self.bot.create_forum_topic.assert_awaited_once()

    async def test_file_checks_deleted_topic_before_any_message_and_sends_set_once(self):
        await self.topics.ensure(profile(), '123')
        self.bot.edit_forum_topic.side_effect = BadRequest('TOPIC_ID_INVALID')
        send = AsyncMock(return_value={'success': True, 'message_id': '200'})
        result = await self.topics.deliver(profile(), '123', send, text=False)
        self.assertTrue(result['success'])
        send.assert_awaited_once_with(('123', '8'), self.topics.metadata('8'))
        self.assertEqual(self.bot.create_forum_topic.await_count, 2)

    async def test_file_preflight_timeout_does_not_send_or_create_extra_topic(self):
        await self.topics.ensure(profile(), '123')
        self.bot.edit_forum_topic.side_effect = TimeoutError
        send = AsyncMock()
        with self.assertRaises(TimeoutError):
            await self.topics.deliver(profile(), '123', send, text=False)
        send.assert_not_awaited()
        self.bot.create_forum_topic.assert_awaited_once()

    async def test_unconfirmed_topic_probe_does_not_send_files(self):
        await self.topics.ensure(profile(), '123')
        self.bot.edit_forum_topic.return_value = False
        send = AsyncMock()
        with self.assertRaises(ValueError):
            await self.topics.deliver(profile(), '123', send, text=False)
        send.assert_not_awaited()
        self.bot.create_forum_topic.assert_awaited_once()

    async def test_file_partial_failure_does_not_repeat_captions_or_batch(self):
        send = AsyncMock(side_effect=BadRequest('Message thread not found'))
        with self.assertRaises(BadRequest):
            await self.topics.deliver(profile(), '123', send, text=False)
        send.assert_awaited_once()
        self.bot.create_forum_topic.assert_awaited_once()

    async def test_topic_not_modified_is_valid_file_preflight(self):
        await self.topics.ensure(profile(), '123')
        self.bot.edit_forum_topic.side_effect = BadRequest('TOPIC_NOT_MODIFIED')
        send = AsyncMock(return_value={'success': True})
        self.assertTrue((await self.topics.deliver(profile(), '123', send, text=False))['success'])

    async def test_root_revalidates_alias_and_routes_receipt_to_new_topic(self):
        adapter = NS(_bot=self.bot, send=AsyncMock(return_value={'success': True, 'message_id': '42'}))
        resolver = runtime.Resolver(adapter, ledger=self.ledger)
        account = profile('456')
        async def broker(method, params, **kwargs):
            self.assertEqual((method, params), ('identity.resolve', {'telegramId': '456'}))
            return account
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', broker):
                result = await resolver.deliver(profile(), 'owner', 'send',
                    {'chat_id': '456', 'content': 'done', 'metadata': {'_brai_notifications': True}})
            self.assertTrue(result['success'])
            self.bot.create_forum_topic.assert_awaited_once()
            self.assertEqual(self.bot.create_forum_topic.await_args.kwargs['chat_id'], 456)
            adapter.send.assert_awaited_once_with(chat_id='456', content='done',
                                                  metadata=self.topics.metadata('7'))
            self.assertTrue(self.ledger.owns(account, ('456', '7'), '42', outgoing=True))
            self.assertFalse(self.ledger.owns(account, ('123', '7'), '42', outgoing=True))
        finally:
            request_scope.reset(token)

    async def test_revocation_during_creation_prevents_sending(self):
        adapter = NS(_bot=self.bot, send=AsyncMock())
        resolver = runtime.Resolver(adapter, ledger=self.ledger)
        token = request_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(side_effect=[profile(), profile(), PermissionError('revoked')])):
                with self.assertRaises(PermissionError):
                    await resolver.deliver(profile(), 'owner', 'send',
                        {'chat_id': '123', 'content': 'done', 'metadata': {'_brai_notifications': True}})
            adapter.send.assert_not_awaited()
        finally:
            request_scope.reset(token)

    async def test_foreign_owner_and_revoked_account_cannot_create_topic(self):
        resolver = runtime.Resolver(NS(_bot=self.bot), ledger=self.ledger)
        token = request_scope.set(None)
        try:
            for returned in (profile(owner='foreign'), PermissionError('revoked')):
                broker = AsyncMock(side_effect=returned) if isinstance(returned, Exception) else AsyncMock(return_value=returned)
                with patch.object(runtime, 'broker_call', broker), self.assertRaises(PermissionError):
                    await resolver.deliver(profile(), 'owner', 'send',
                        {'chat_id': '123', 'content': 'no', 'metadata': {'_brai_notifications': True}})
            self.bot.create_forum_topic.assert_not_awaited()
        finally:
            request_scope.reset(token)

    async def test_native_turn_cannot_use_internal_notification_marker(self):
        adapter = NS(_bot=self.bot, send=AsyncMock())
        resolver = runtime.Resolver(adapter, ledger=self.ledger)
        resolver.turns[101] = {'id': 'turn', 'route': ('123', '')}
        token = request_scope.set('turn')
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value={})), self.assertRaises(PermissionError):
                await resolver.deliver(profile(), 'owner', 'send',
                    {'chat_id': '123', 'content': 'no', 'metadata': {'_brai_notifications': True}})
            self.bot.create_forum_topic.assert_not_awaited()
            adapter.send.assert_not_awaited()
        finally:
            request_scope.reset(token)

    async def test_worker_marks_only_background_root_deliveries_through_bridge(self):
        # Исполняется настоящий IpcAdapter/Bridge/Resolver, без отдельного Bot у worker.
        class Base:
            def __init__(self, config):
                self.config = config
        module, platform = ModuleType('plugins.platforms.telegram.adapter'), ModuleType('gateway.platforms.base')
        module.TelegramAdapter, platform.SendResult = Base, NS
        native = NS(_bot=self.bot, send=AsyncMock(return_value={'success': True, 'message_id': '42'}))
        resolver = runtime.Resolver(native, ledger=self.ledger)
        bridge = Bridge('owner', '123', 101, '/unused',
            lambda owner, action, payload: resolver.deliver(profile(), owner, action, payload), None)
        bridge.configure_delivery(require_scope=True, authorize_delivery=
            lambda action, payload: resolver.authorize_delivery(profile(), action, payload))
        class Peer:
            async def call(self, method, params):
                return await bridge.send(**params)
        with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': module, 'gateway.platforms.base': platform}):
            adapter = make_adapter(NS(), 'telegram', Peer(), None)
        self.assertIsNone(await adapter.create_handoff_thread('123', 'cron job'))
        self.bot.create_forum_topic.assert_not_awaited()
        token = delivery_scope.set(None)
        try:
            with patch.object(runtime, 'broker_call', AsyncMock(return_value=profile())):
                self.assertTrue((await adapter.send('123', 'cron done')).success)
            self.assertTrue(self.ledger.owns(profile(), ('123', '7'), '42', outgoing=True))
        finally:
            delivery_scope.reset(token)


@unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Pinned public engine required')
class NativeNotificationTest(unittest.IsolatedAsyncioTestCase):
    def source(self, name):
        from test_worker_lifecycle import patch_hunks
        source = (Path(os.environ['HERMES_TEST_ENGINE']) / name).read_text()
        # Методы отправки не меняются identity overlay; читаем закреплённую реализацию.
        if name == 'plugins/platforms/telegram/adapter.py':
            return ast.parse(source)
        patch_text = (Path(__file__).resolve().parents[1] / 'native.patch').read_text()
        for _, old, new in patch_hunks(patch_text, {name}):
            old, new = old.rstrip('\n') + '\n', new.rstrip('\n') + '\n'
            self.assertEqual(source.count(old), 1, name)
            source = source.replace(old, new, 1)
        return ast.parse(source)

    def function(self, filename, name, scope):
        tree = self.source(filename)
        functions = [node for node in ast.walk(tree)
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        self.assertEqual(len(functions), 1)
        code = ast.Module(body=[ast.ImportFrom(module='__future__',
            names=[ast.alias(name='annotations')], level=0), functions[0]], type_ignores=[])
        exec(compile(ast.fix_missing_locations(code), filename, 'exec'), scope)
        return scope[name]

    async def test_first_contact_never_sends_sethome_but_other_platforms_still_can(self):
        import contextlib
        platforms = NS(LOCAL='local', WEBHOOK='webhook', TELEGRAM='telegram', SLACK='slack')
        module = ModuleType('gateway.run')
        module._gateway_config_home, module._home_target_env_var = lambda: Path('/unused'), lambda name: None
        module._load_gateway_config = lambda: None
        note = self.function('gateway/run_turn.py', '_hmwa_first_contact_notes',
                             {'os': os, 'Platform': platforms, 'suppress': contextlib.suppress,
                              't': lambda *args, **kwargs: 'sethome notice'})
        runner = NS(_deliver_platform_notice=AsyncMock(), config=NS(get_home_channel=lambda p: None),
                    async_session_store=NS(has_any_sessions=AsyncMock(return_value=True)))
        with patch.dict(sys.modules, {'gateway.run': module}):
            for platform in ('telegram', NS(value='discord')):
                source = NS(platform=platform, chat_type='dm')
                await note(runner, source, [], [], 'hello')
        runner._deliver_platform_notice.assert_awaited_once()

    async def test_native_chunk_rejection_preserves_topic_and_never_duplicates_head(self):
        import logging
        from types import MethodType
        ledger = RouteLedger()
        self.addCleanup(ledger.close)
        bot = NS(create_forum_topic=AsyncMock(side_effect=[NS(message_thread_id=7), NS(message_thread_id=8)]))
        topics = NotificationTopics(ledger, lambda: bot)
        class Result(NS):
            def __init__(self, **values):
                super().__init__(**{'raw_response': None, **values})
        scope = {'os': os, 'SendResult': Result, 'logger': logging.getLogger(__name__)}
        chunk = self.function('plugins/platforms/telegram/adapter.py', '_send_chunk_with_retries', scope)
        chunks = self.function('plugins/platforms/telegram/adapter.py', '_send_chunks', scope)
        partial = self.function('plugins/platforms/telegram/adapter.py', '_with_partial_send', scope)
        calls = []
        partial_mode = False
        async def send(text, kwargs):
            calls.append((text, kwargs.get('message_thread_id')))
            if kwargs.get('message_thread_id') == 7 and (not partial_mode or text == 'tail'):
                raise BadRequest('Message thread not found')
            return NS(message_id=100 + len(calls))
        adapter = NS(name='test', _reply_to_mode='off',
            _chunk_reply_routing=lambda *a: (False, False, None),
            _thread_kwargs_for_send=lambda chat, thread, metadata, **kw: {'message_thread_id': int(thread)},
            _link_preview_kwargs=lambda: {}, _notification_kwargs=lambda m: {},
            _is_thread_not_found_error=lambda error: 'thread not found' in str(error).lower(),
            _metadata_thread_id=lambda m: m['thread_id'], _message_thread_id_for_send=lambda t: int(t),
            _retrigger_typing=AsyncMock(), _with_partial_send=partial,
            _send_chunk_markdown_or_plain=send)
        adapter._send_chunk_with_retries = MethodType(chunk, adapter)
        scope['normalize_telegram_chat_id'] = int
        async def operation(route, metadata):
            value = await chunks(adapter, route[0], ['head', 'tail'] if partial_mode else ['body'],
                                 [], None, metadata, (Exception, BadRequest, TimeoutError))
            return vars(value)
        result = await topics.deliver(profile(), '123', operation, text=True)
        self.assertTrue(result['success'])
        self.assertEqual(calls, [('body', 7), ('body', 8)])
        self.assertEqual(bot.create_forum_topic.await_count, 2)
        # Новый профиль: первая часть дошла, вторая получила отказ. Весь текст не повторяется.
        calls.clear()
        partial_mode = True
        other = profile(owner='another')
        bot.create_forum_topic.side_effect = None
        bot.create_forum_topic.return_value = NS(message_thread_id=7)
        result = await topics.deliver(other, '123', operation, text=True)
        self.assertFalse(result['success'])
        self.assertTrue(result['raw_response']['partial_overflow'])
        self.assertEqual(calls, [('head', 7), ('tail', 7)])
        self.assertEqual(bot.create_forum_topic.await_count, 3)

    def test_native_home_and_cron_ignore_stale_thread_without_network(self):
        from enum import Enum
        class Platform(Enum):
            TELEGRAM = 'telegram'
            DISCORD = 'discord'
        home = self.function('gateway/config.py', 'get_home_channel',
                             {'os': os, 'Platform': Platform, 'HomeChannel': NS})
        config = NS(platforms={})
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker', 'BRAI_IDENTITY_TELEGRAM_ID': '123'}):
            self.assertEqual(home(config, Platform.TELEGRAM).chat_id, '123')
            config.platforms[Platform.TELEGRAM] = NS(home_channel=NS(chat_id='456', thread_id='deleted'))
            self.assertEqual(home(config, Platform.TELEGRAM).chat_id, '456')
            self.assertFalse(hasattr(home(config, Platform.TELEGRAM), 'thread_id'))
            scope = {'os': os, '_get_config_home_channel': lambda p: home(config, Platform.TELEGRAM),
                     '_env_home_target_chat_id': lambda p: 'foreign',
                     '_home_env_lookup': lambda *args, **kwargs: 'stale'}
            chat = self.function('cron/scheduler_delivery.py', '_get_home_target_chat_id', scope)
            thread = self.function('cron/scheduler_delivery.py', '_get_home_target_thread_id', scope)
            self.assertEqual(chat('telegram'), '456')
            self.assertIsNone(thread('telegram'))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'ordinary'}):
            self.assertEqual(home(config, Platform.TELEGRAM).thread_id, 'deleted')


if __name__ == '__main__':
    unittest.main()
