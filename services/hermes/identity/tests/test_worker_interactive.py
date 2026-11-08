# ABOUTME: Проверяет native Telegram кнопки личного worker через tokenless IPC.
# ABOUTME: Исполняет закреплённые native методы с локальными портами без Telegram сети.
import ast
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
import html
import logging
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

try:
    import telegram as real_telegram
except ImportError:
    real_telegram = None

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.adapter import make_adapter
from identity.scope import delivery_scope
from identity.telegram_proxy import BotProxy, TELEGRAM_API_METHODS, telegram_payload
from identity import native_ingress


class TelegramObject:
    """Минимальный JSON порт PTB объектов без token и HTTP."""
    def __init__(self, **fields):
        self.fields = fields
    def to_dict(self):
        return self.fields


class Button(TelegramObject):
    def __init__(self, text, **fields):
        super().__init__(text=text, **fields)


class Markup(TelegramObject):
    def __init__(self, rows):
        super().__init__(inline_keyboard=rows)


class DefaultValue:
    def __init__(self, value):
        self.value = value


class Message:
    @classmethod
    def de_json(cls, value, bot):
        return NS(**value, chat_id=value['chat']['id'])


class Query:
    def __init__(self, value, bot):
        self.id, self.data, self.bot = value['id'], value['data'], bot
        self.from_user = NS(**value['from'])
        self.message = Message.de_json(value['message'], bot)
        self.message.chat = NS(**value['message']['chat'])
        self.message.message_thread_id = value['message'].get('message_thread_id')
    async def answer(self, **payload):
        return await self.bot.answer_callback_query(callback_query_id=self.id, **payload)
    async def edit_message_text(self, **payload):
        return await self.bot.edit_message_text(chat_id=self.message.chat_id,
            message_id=self.message.message_id, **payload)


class Update:
    @classmethod
    def de_json(cls, value, bot):
        if value.get('callback_query'):
            return NS(callback_query=Query(value['callback_query'], bot))
        return NS(inline_query=NS(**value['inline_query']))


def telegram_modules():
    """Подменить только внешние DTO и shortcuts PTB."""
    module = ModuleType('telegram')
    for name, value in {'TelegramObject': TelegramObject, 'Message': Message, 'Update': Update}.items():
        setattr(module, name, value)
    default = ModuleType('telegram._utils.defaultvalue')
    default.DefaultValue = DefaultValue
    return {'telegram': module, 'telegram._utils.defaultvalue': default}


class ProxyTest(unittest.IsolatedAsyncioTestCase):
    async def test_draft_uses_high_level_ipc_and_preserves_native_async_delivery(self):
        class Native:
            supports_async_delivery = True
            def __init__(self, config):
                self.config = config
            def _mark_disconnected(self):
                pass
        native_module = ModuleType('plugins.platforms.telegram.adapter')
        native_module.TelegramAdapter = Native
        base = ModuleType('gateway.platforms.base')
        base.SendResult = NS
        peer = NS(call=AsyncMock(return_value={'success': True, 'message_id': None}))
        token = delivery_scope.set('draft-turn')
        try:
            with patch.dict(sys.modules, {'plugins.platforms.telegram.adapter': native_module,
                                         'gateway.platforms.base': base}):
                adapter = make_adapter(NS(), 'telegram', peer, AsyncMock())
                self.assertTrue(adapter.supports_async_delivery)
                for chat_type in ('dm', 'private'):
                    self.assertTrue(adapter.supports_draft_streaming(chat_type))
                for chat_type in ('group', 'supergroup', '', None):
                    self.assertFalse(adapter.supports_draft_streaming(chat_type))
                receipt = await adapter.send_draft('123', 17, 'Partial', {'thread_id': '73'})
                self.assertTrue(receipt.success)
                self.assertIsNone(receipt.message_id)
                peer.call.assert_awaited_once_with('send', {'action': 'send_draft',
                    'payload': {'chat_id': '123', 'draft_id': 17, 'content': 'Partial',
                                'metadata': {'thread_id': '73'}}, 'scope_id': 'draft-turn'})
                self.assertFalse(hasattr(adapter._bot, 'send_message_draft'))
                await adapter.disconnect()
                self.assertFalse(adapter.supports_draft_streaming('private'))
        finally:
            delivery_scope.reset(token)

    async def test_scope_receipt_markup_and_no_token_or_generic_api(self):
        peer = NS(call=AsyncMock(return_value={'message_id': 41, 'date': 1,
            'chat': {'id': -55, 'type': 'supergroup'}, 'text': 'Question'}))
        bot = BotProxy(peer)
        token = delivery_scope.set('scope-one')
        try:
            with patch.dict(sys.modules, telegram_modules()):
                receipt = await bot.send_message(chat_id=-55, text='Question',
                    reply_markup=Markup([[Button('Yes', callback_data='cl:one:0')]]))
                self.assertEqual(receipt.message_id, 41)
                method, params = peer.call.call_args.args
                self.assertEqual(method, 'telegram_api')
                self.assertEqual(params['scope_id'], 'scope-one')
                self.assertEqual(params['payload']['reply_markup']['inline_keyboard'][0][0]['callback_data'], 'cl:one:0')
                with self.assertRaises(PermissionError):
                    await bot._call('get_file', {})
                with self.assertRaises(ValueError):
                    telegram_payload({'file': object()})
                self.assertEqual(telegram_payload(DefaultValue(None)), None)
                self.assertEqual(telegram_payload(timedelta(seconds=2)), 2)
                self.assertEqual(telegram_payload(datetime(1970, 1, 1, tzinfo=timezone.utc)), 0)
        finally:
            delivery_scope.reset(token)
        self.assertEqual(TELEGRAM_API_METHODS, {'send_message', 'edit_message_text',
            'edit_message_reply_markup', 'delete_message', 'answer_callback_query', 'answer_inline_query'})
        self.assertFalse(hasattr(bot, 'token'))
        self.assertFalse(hasattr(bot, 'get_updates'))
        self.assertFalse(hasattr(bot, 'do_api_request'))

    async def test_unknown_outcome_does_not_become_success(self):
        peer = NS(call=AsyncMock(side_effect=ConnectionError('closed')))
        with patch.dict(sys.modules, telegram_modules()):
            with self.assertRaises(ConnectionError):
                await BotProxy(peer).answer_callback_query(callback_query_id='one')
            peer.call = AsyncMock(return_value=False)
            with self.assertRaises(ValueError):
                await BotProxy(peer).answer_callback_query(callback_query_id='one')


@unittest.skipUnless(getattr(real_telegram, '__version__', None), 'Installed PTB runtime not configured')
class PtbCompatibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_ptb_shortcuts_use_proxy_without_token_or_http(self):
        calls = []
        async def call(method, params):
            calls.append((method, params))
            if params['method'] in {'send_message', 'edit_message_text', 'edit_message_reply_markup'}:
                return {'message_id': 41, 'date': 1, 'chat': {'id': -55, 'type': 'supergroup'}, 'text': 'Saved'}
            return True
        bot = BotProxy(NS(call=call))
        update = real_telegram.Update.de_json({'update_id': 9, 'callback_query': {
            'id': 'one', 'chat_instance': 'group', 'data': 'cp:0',
            'from': {'id': 123, 'is_bot': False, 'first_name': 'Owner'},
            'message': {'message_id': 41, 'date': 1, 'text': 'Choose',
                'from': {'id': 900, 'is_bot': True, 'first_name': 'Bot'},
                'chat': {'id': -55, 'type': 'supergroup'}}}}, bot)
        await update.callback_query.answer('Saved')
        await update.callback_query.edit_message_text('Saved')
        await bot.send_message(chat_id=-55, text='Choose', reply_markup=real_telegram.InlineKeyboardMarkup([
            [real_telegram.InlineKeyboardButton('One', callback_data='cp:0')]]))
        inline = real_telegram.Update.de_json({'update_id': 10, 'inline_query': {
            'id': 'two', 'query': 'search', 'offset': '',
            'from': {'id': 123, 'is_bot': False, 'first_name': 'Owner'}}}, bot)
        await inline.inline_query.answer([real_telegram.InlineQueryResultArticle(id='a', title='Command',
            input_message_content=real_telegram.InputTextMessageContent('/help'))],
            cache_time=0, is_personal=True, next_offset='')
        self.assertEqual([params['method'] for _, params in calls],
            ['answer_callback_query', 'edit_message_text', 'send_message', 'answer_inline_query'])
        self.assertEqual(calls[0][1]['payload']['callback_query_id'], 'one')
        self.assertEqual(calls[-1][1]['payload']['inline_query_id'], 'two')
        self.assertEqual(calls[2][1]['payload']['reply_markup']['inline_keyboard'][0][0]['callback_data'], 'cp:0')
        self.assertFalse(hasattr(bot, 'token'))


class GuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_unload_closes_resolver_and_does_not_leave_interactive_hooks(self):
        class Stop(Exception):
            pass
        removed = []
        app = NS(add_handler=lambda *a, **kw: None, remove_handler=lambda *a, **kw: removed.append(a))
        ctx = NS(register_telegram_handler=lambda factory: setattr(ctx, 'factory', factory),
                 on_unload=lambda close: setattr(ctx, 'close', close))
        adapter = NS(gateway_runner=NS(_hm_admit_event=lambda event: None))
        ext = ModuleType('telegram.ext')
        ext.ApplicationHandlerStop = Stop
        ext.TypeHandler = lambda cls, callback: NS(callback=callback)
        resolver_close = AsyncMock()
        retired = Mock()
        forward = NS(_brai_restore_authorize=lambda: None, _brai_close_resolver=resolver_close,
                     _brai_retire_resolver=retired)
        def install(*args):
            adapter._brai_identity_dispatch = forward
            adapter._brai_identity_interactive = AsyncMock()
            adapter._brai_identity_interactive_admit = AsyncMock()
            return forward
        with patch.dict(sys.modules, telegram_modules() | {'telegram.ext': ext}), patch.object(native_ingress, 'install', install):
            native_ingress.register(ctx, build_resolver=lambda *args: (lambda source: None))
            ctx.factory(app, adapter)
            ctx.close()
            retired.assert_called_once()
            resolver_close.assert_not_awaited()
            ctx.close()
            retired.assert_called_once()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        resolver_close.assert_awaited_once()
        self.assertEqual(len(removed), 1)
        self.assertIsNone(adapter._brai_identity_dispatch)
        self.assertIsNone(adapter._brai_identity_interactive)
        self.assertIsNone(adapter._brai_identity_interactive_admit)


    async def test_callbacks_and_inline_require_trusted_root_then_stop_root_handlers(self):
        class Stop(Exception):
            pass
        app = NS(add_handler=lambda handler, **kw: setattr(app, 'guard', handler.callback), remove_handler=lambda *a, **kw: None)
        ctx = NS(register_telegram_handler=lambda factory: setattr(ctx, 'factory', factory), on_unload=lambda close: None)
        adapter = NS(gateway_runner=NS(_hm_admit_event=lambda event: None))
        ext = ModuleType('telegram.ext')
        ext.ApplicationHandlerStop = Stop
        ext.TypeHandler = lambda cls, callback: NS(callback=callback)
        forward = NS(_brai_restore_authorize=lambda: None)
        ordinary_admit = AsyncMock(return_value=True)
        modules = telegram_modules() | {'telegram.ext': ext}
        with patch.dict(sys.modules, modules), patch.object(native_ingress, 'install', return_value=forward):
            native_ingress.register(ctx, build_resolver=lambda *args: (lambda source: None), admit_update=ordinary_admit)
            ctx.factory(app, adapter)
            message = NS(from_user=NS(id=900, is_bot=True), chat=NS(id=-55), message_id=41)
            callback = NS(id='query', from_user=NS(id=123, is_bot=False), message=message)
            for update in (NS(callback_query=callback, effective_message=message), NS(inline_query=NS(id='inline'))):
                with self.assertRaises(Stop):
                    await app.guard(update, None)
                adapter._brai_identity_interactive_admit = AsyncMock(return_value=False)
                adapter._brai_identity_interactive = AsyncMock(return_value={'accepted': True})
                with self.assertRaises(Stop):
                    await app.guard(update, None)
                adapter._brai_identity_interactive.assert_not_awaited()
                adapter._brai_identity_interactive_admit.return_value = True
                with self.assertRaises(Stop):
                    await app.guard(update, None)
                adapter._brai_identity_interactive.assert_awaited_once_with(update)
                del adapter._brai_identity_interactive_admit
                del adapter._brai_identity_interactive
            ordinary_admit.assert_not_awaited()
            self.assertFalse(native_ingress.message_admitted(message))


@unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Native public source fixture not configured')
class NativeInteractiveTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        methods = {'_send_prompt', '_rows_of_two', '_send_exec_approval_prompt', 'send_clarify',
            'send_choice_picker', 'send_model_picker', '_provider_get_label', '_callback_ctx',
            '_callback_authorized', '_handle_callback_query', '_claim_callback_state',
            '_handle_exec_approval_callback', '_handle_clarify_callback', '_handle_choice_picker_callback',
            '_handle_model_picker_callback', '_picker_selection', '_picker_switch', '_edit_result_text',
            '_edit_md_quiet', '_edit_html_quiet', '_notify_clarify_expired'}
        source = Path(os.environ['HERMES_TEST_ENGINE']) / 'plugins/platforms/telegram/adapter.py'
        tree = ast.parse(source.read_text())
        native_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'TelegramAdapter')
        definitions = [node for node in native_class.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in methods]
        self.assertEqual({node.name for node in definitions}, methods)
        selected = ast.ClassDef(name='TelegramAdapter', bases=[], keywords=[], body=definitions, decorator_list=[])
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), selected], type_ignores=[])
        scope = {'SendResult': NS, 'InlineKeyboardButton': Button, 'InlineKeyboardMarkup': Markup,
            'ParseMode': NS(HTML='HTML', MARKDOWN_V2='MarkdownV2'), '_html': html,
            't': lambda key, **kw: key, '_toast': lambda key, **kw: key, '_unauthorized': lambda: 'denied',
            '_TOAST_LIMIT': 200, 'logger': logging.getLogger(__name__), 'contextlib': contextlib}
        exec(compile(ast.fix_missing_locations(module), str(source), 'exec'), scope)
        native = scope['TelegramAdapter']
        def initialize(adapter, config):
            adapter.config, adapter.name = config, 'telegram'
            adapter._clarify_state, adapter._approval_state = {}, {}
            adapter._choice_picker_state, adapter._model_picker_state = {}, {}
            adapter._reply_to_mode = 'first'
            adapter._running = False
        native.__init__ = initialize
        native.format_message = staticmethod(lambda text: text)
        native.strip_media_directives_for_display = staticmethod(lambda text: text)
        native._metadata_thread_id = staticmethod(lambda metadata: (metadata or {}).get('thread_id'))
        native._is_callback_user_authorized = lambda *args, **kw: True
        native._accept_update = lambda self: None
        native._mark_connected = lambda self: setattr(self, '_running', True)
        native._mark_disconnected = lambda self: setattr(self, '_running', False)
        native.resume_typing_for_chat = lambda *args: None
        native._handle_gmail_triage_callback = AsyncMock()
        native._handle_slash_confirm_callback = AsyncMock()
        native._handle_update_prompt_callback = AsyncMock()
        native._provider_list_text = lambda *args: 'Models'
        native._build_provider_keyboard = lambda *args: (Markup([[Button('Provider', callback_data='mp:local')]]), {})
        async def send_control(adapter, chat_id, text, *, parse_mode, thread_id, metadata, reply_markup=None, **kwargs):
            return await adapter._bot.send_message(chat_id=chat_id, text=text,
                parse_mode=parse_mode, reply_markup=reply_markup, message_thread_id=thread_id)
        native._send_control_message = send_control
        fake_native = ModuleType('plugins.platforms.telegram.adapter')
        fake_native.TelegramAdapter = native
        base = ModuleType('gateway.platforms.base')
        base.SendResult = NS
        self.modules = telegram_modules() | {'plugins.platforms.telegram.adapter': fake_native, 'gateway.platforms.base': base}
        self.patch = patch.dict(sys.modules, self.modules)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.calls, self.prompts = [], {}
        async def call(method, params):
            self.calls.append((method, params))
            payload = params['payload']
            if params.get('method') == 'send_message':
                message_id = 41 + len(self.prompts)
                self.prompts[message_id] = payload['text']
                return {'message_id': message_id, 'date': 1, 'chat': {'id': int(payload['chat_id']), 'type': 'private'}, 'text': payload['text']}
            if params.get('method') in {'edit_message_text', 'edit_message_reply_markup'}:
                return {'message_id': payload['message_id'], 'date': 1, 'chat': {'id': payload['chat_id'], 'type': 'private'}, 'text': payload.get('text', '')}
            return True
        self.adapter = make_adapter(NS(typing_indicator=False), 'telegram', NS(call=call), AsyncMock())

    def update(self, data, *, user=123, message_id=41, chat=123):
        return {'update_id': 9, 'callback_query': {'id': 'callback-one', 'chat_instance': 'group', 'data': data,
            'from': {'id': user, 'is_bot': False, 'first_name': 'Owner'},
            'message': {'message_id': message_id, 'date': 1, 'text': self.prompts.get(message_id, 'Question'),
                'from': {'id': 900, 'is_bot': True}, 'chat': {'id': chat, 'type': 'private'}, 'message_thread_id': 77}}}

    async def test_clarification_choice_and_wrong_private_clicker(self):
        result = await self.adapter.send_clarify('123', 'Choose', ['A', 'B'], 'clarify', 'session', {'thread_id': '77'})
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, '41')
        self.assertEqual(self.adapter._clarify_state, {'clarify': 'session'})
        with self.assertRaises(PermissionError):
            await self.adapter.handle_interactive(self.update('cl:clarify:1', user=456), telegram_id='123')
        self.assertEqual(len(self.calls), 1)
        clarify = ModuleType('tools.clarify_gateway')
        clarify._entries = {'clarify': NS(choices=['A', 'B'])}
        selected = []
        clarify.resolve_gateway_clarify = lambda identifier, text: selected.append((identifier, text)) or True
        with patch.dict(sys.modules, {'tools.clarify_gateway': clarify}):
            await self.adapter.handle_interactive(self.update('cl:clarify:1'), telegram_id='123')
        self.assertEqual(selected, [('clarify', 'B')])
        self.assertEqual(self.adapter._clarify_state, {})
        self.assertEqual([params['method'] for _, params in self.calls], ['send_message', 'answer_callback_query', 'edit_message_text'])

    async def test_clarification_other_keeps_pending_entry_until_typed_answer(self):
        await self.adapter.send_clarify('123', 'Choose', ['A'], 'clarify', 'session')
        clarify = ModuleType('tools.clarify_gateway')
        awaiting = []
        clarify.mark_awaiting_text = lambda identifier: awaiting.append(identifier) or True
        with patch.dict(sys.modules, {'tools.clarify_gateway': clarify}):
            await self.adapter.handle_interactive(self.update('cl:clarify:other'), telegram_id='123')
        self.assertEqual(awaiting, ['clarify'])
        self.assertEqual(self.adapter._clarify_state, {'clarify': 'session'})

    async def test_human_callback_uses_separate_owner_checked_plugin(self):
        update = self.update('brai:opaque-token')
        with self.assertRaises(PermissionError):
            await self.adapter.handle_interactive(update, telegram_id='123')
        handler = AsyncMock()
        self.adapter._brai_human_callback = handler
        with self.assertRaises(PermissionError):
            await self.adapter.handle_interactive(self.update('brai:opaque-token', user=456), telegram_id='123')
        handler.assert_not_awaited()
        receipt = await self.adapter.handle_interactive(update, telegram_id='123')
        self.assertEqual(receipt, {'accepted': True})
        native, context = handler.call_args.args
        self.assertEqual(native.callback_query.data, 'brai:opaque-token')
        self.assertEqual(native.callback_query.from_user.id, 123)
        self.assertIsNone(context)
        self.assertEqual(self.calls, [])

    async def test_second_account_keeps_actual_callback_actor_and_scoped_native_auth(self):
        selected = AsyncMock(return_value='Selected')
        await self.adapter.send_choice_picker('456', 'Reasoning', [{'label': 'High', 'value': 'high'}], 'alias-session', selected)
        self.adapter._is_callback_user_authorized = lambda user_id, **kwargs: self.adapter.is_interactive_actor(user_id)
        await self.adapter.handle_interactive(self.update('cp:0', user=456, chat=456), telegram_id='456')
        selected.assert_awaited_once_with('456', 'high')
        self.assertFalse(self.adapter.is_interactive_actor('456'))
        rejected = self.update('cp:0', user=456, chat=-55)
        rejected['callback_query']['message']['chat']['type'] = 'supergroup'
        with self.assertRaises(PermissionError):
            await self.adapter.handle_interactive(rejected, telegram_id='456')
        self.assertFalse(self.adapter.is_interactive_actor('456'))

    async def test_exec_approval_uses_native_resolution_once(self):
        prompt = NS(chat_id='123', text='Approve command', metadata={'thread_id': '77'},
            session_key='session', actions=[('Once', 'once', ''), ('Deny', 'deny', '')])
        self.assertTrue((await self.adapter._send_exec_approval_prompt(prompt)).success)
        approval = ModuleType('tools.approval')
        resolved = []
        approval.resolve_gateway_approval = lambda session, choice: resolved.append((session, choice)) or 1
        with patch.dict(sys.modules, {'tools.approval': approval}):
            await self.adapter.handle_interactive(self.update('ea:once:1'), telegram_id='123')
            await self.adapter.handle_interactive(self.update('ea:once:1'), telegram_id='123')
        self.assertEqual(resolved, [('session', 'once')])
        self.assertEqual(self.adapter._approval_state, {})

    async def test_choice_and_model_menus_keep_private_callbacks(self):
        selected = AsyncMock(return_value='Selected')
        self.assertTrue((await self.adapter.send_choice_picker('123', 'Reasoning',
            [{'label': 'High', 'value': 'high'}], 'session', selected)).success)
        await self.adapter.handle_interactive(self.update('cp:0'), telegram_id='123')
        selected.assert_awaited_once_with('123', 'high')
        switched = AsyncMock(return_value='Switched')
        self.assertTrue((await self.adapter.send_model_picker('123', [{'slug': 'local'}],
            'old', 'local', 'session', switched)).success)
        self.adapter._model_picker_state['123'].update(model_list=['new'], selected_provider='local')
        await self.adapter.handle_interactive(self.update('mc:0', message_id=42), telegram_id='123')
        switched.assert_awaited_once_with('123', 'new', 'local')
        self.assertEqual(self.adapter._model_picker_state, {})
        await self.adapter.connect()
        self.assertTrue(self.adapter._running)
        await self.adapter.disconnect()
        self.assertFalse(self.adapter._running)
        self.assertIsNone(self.adapter._bot)


@unittest.skipUnless(os.environ.get('HERMES_TEST_ENGINE'), 'Native public source fixture not configured')
class NativeDraftRenderingTest(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_root_renderer_formats_preview_and_never_retries_unknown_outcome(self):
        path = Path(os.environ['HERMES_TEST_ENGINE']) / 'plugins/platforms/telegram/adapter.py'
        tree = ast.parse(path.read_text())
        adapter = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'TelegramAdapter')
        method = next(node for node in adapter.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'send_draft')
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), method], type_ignores=[])
        async def bounded(operation, **kwargs):
            return await operation
        scope = {'SendResult': NS, 'ParseMode': NS(MARKDOWN_V2='MarkdownV2'),
                 'normalize_telegram_chat_id': int, '_await_with_thread_deadline': bounded,
                 '_TEXT_SEND_DEADLINE': 15, 'logger': logging.getLogger(__name__),
                 '_redact_telegram_error_text': str}
        exec(compile(ast.fix_missing_locations(module), str(path), 'exec'), scope)
        send = AsyncMock(return_value=True)
        native = NS(_bot=NS(send_message_draft=send), name='telegram', MAX_MESSAGE_LENGTH=4096,
                    strip_media_directives_for_display=lambda text: text,
                    _should_attempt_rich_draft=lambda text: False,
                    format_message=lambda text: 'formatted:' + text,
                    _thread_kwargs_for_draft=lambda chat, metadata: {'message_thread_id': int(metadata['thread_id'])})
        result = await scope['send_draft'](native, '123', 17, '*Preview*', {'thread_id': '73'})
        self.assertTrue(result.success)
        self.assertIsNone(result.message_id)
        send.assert_awaited_once_with(chat_id=123, draft_id=17, text='formatted:*Preview*',
                                      parse_mode='MarkdownV2', message_thread_id=73)
        send.reset_mock(side_effect=True)
        send.side_effect = TimeoutError('Unknown draft outcome')
        result = await scope['send_draft'](native, '123', 17, '*Preview*', {'thread_id': '73'})
        self.assertFalse(result.success)
        self.assertEqual(send.await_count, 1)
