# ABOUTME: Проверяет границы native Telegram плагина без сети и сторонних пакетов.
# ABOUTME: Подменяет private Brai порт и PTB, сохраняя реальные SQLite и loop transitions.
import ast
import asyncio
from dataclasses import replace
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch


PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parents[2]
spec = importlib.util.spec_from_file_location("brai_telegram_tested", PLUGIN / "__init__.py")
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

MOVE, REVISION, ATTEMPT, TARGET, ARTIFACT = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1, 6)]
ROOT = "/publisher/results"
GROUP = "-1009876543210"
MARKDOWN = rf"[Отчёт \[план\].pdf](<{ROOT}/{ARTIFACT}/Отчёт [план].pdf>)"


class FakeBridge:
    """Сохраняет вызовы и моделирует private порт, не исполняя реальные side effects."""

    def __init__(self):
        """Задать текущую человеческую попытку."""
        self.calls = []
        self.fail = None
        self.action = {"moveId": MOVE, "revisionId": REVISION, "attemptId": ATTEMPT,
                       "targetId": TARGET, "title": "Принять план", "targetTitle": "Результат",
                       "targetDescription": "Проверить описанный план", "status": "claimed",
                       "attemptStatus": "running", "attemptExecutorKind": "human"}
        self.file = {"artifactId": ARTIFACT, "markdown": MARKDOWN, "filename": "Отчёт [план].pdf",
                     "mimeType": "application/pdf", "sizeBytes": 3, "sha256": "a" * 64}

    def call(self, method, params, timeout=15):
        """Вернуть результат либо контролируемую ошибку."""
        self.calls.append((method, params))
        if self.fail == method:
            raise mod.BridgeError("TIMEOUT")
        if method == "actions.prepare":
            return {**self.action, "status": "running"}
        if method == "actions.read":
            return dict(self.action)
        if method == "actions.complete":
            self.action.update(status="succeeded", attemptStatus="succeeded")
            return {"attempt": {"id": self.action["attemptId"], "status": "succeeded"}}
        if method == "actions.feedback":
            if params["decision"] == "cancelled":
                self.action.update(status="cancelled", attemptStatus="failed")
                return {"id": TARGET, "status": "cancelled", "element_ids": [TARGET]}
            self.action.update(status="succeeded", attemptStatus="succeeded")
            return {"attempt": {"id": ATTEMPT, "status": "succeeded"}}
        if method == "actions.result":
            if "decisionText" not in params:
                raise mod.BridgeError("HUMAN_FINAL_DECISION_REQUIRED")
            self.action.update(status="succeeded", attemptStatus="succeeded")
            return {"attempt": {"id": ATTEMPT, "status": "succeeded"}}
        if method == "actions.cancel":
            self.action["attemptStatus"] = "failed"
            return {"ok": True}
        if method == "actions.fail_agent":
            return {"attempt": {"id": params["attemptId"], "status": "failed"}}
        return dict(self.file)


class FakeBot:
    """Проверяет, что native отправки идут только в loop приложения."""

    def __init__(self):
        """Запомнить текущий loop и отправленные сообщения."""
        self.loop = asyncio.get_running_loop()
        self.sent, self.edited = [], []
        self.fail = False

    async def send_message(self, **kwargs):
        """Проверить loop; не выполнять Telegram запрос."""
        if asyncio.get_running_loop() is not self.loop:
            raise AssertionError("wrong native loop")
        if self.fail:
            raise RuntimeError("Telegram failed")
        self.sent.append(kwargs)
        return NS(message_id=len(self.sent))


    async def edit_message_text(self, **kwargs):
        self.edited.append(kwargs)
        return NS(message_id=kwargs["message_id"])


class FakeQuery:
    """Моделирует callback от одного Telegram сообщения."""

    def __init__(self, data, owner=123, chat=123, chat_type="private", message_id=1):
        """Задать отправителя, чат и исходный message ID."""
        self.data = data
        self.from_user = NS(id=owner)
        self.message = NS(chat=NS(id=chat, type=chat_type), message_id=message_id)
        self.answers, self.edits = [], []

    async def answer(self, text, **kwargs):
        """Запомнить UI уведомление."""
        self.answers.append(text)

    async def edit_message_reply_markup(self, **kwargs):
        """Запомнить снятие кнопок."""
        self.edits.append(kwargs)


def ptb_stubs():
    """Создать минимальные public PTB объекты для регистрации и кнопок."""
    class ApplicationHandlerStop(Exception):
        """Остановить дальнейшие группы fake PTB dispatch."""

    telegram = NS(Update=object, InlineKeyboardButton=lambda label, callback_data: NS(text=label, callback_data=callback_data),
                  InlineKeyboardMarkup=lambda rows: NS(inline_keyboard=rows))
    ext = NS(CallbackQueryHandler=lambda callback, pattern: NS(callback=callback, pattern=pattern),
             TypeHandler=lambda kind, callback: NS(callback=callback, update_type=kind),
             ApplicationHandlerStop=ApplicationHandlerStop)
    return {"telegram": telegram, "telegram.ext": ext, "telegram.error": NS(BadRequest=type("BadRequest", (Exception,), {}))}


class PluginTests(unittest.IsolatedAsyncioTestCase):
    """Проверяет авторизацию, publication и весь callback lifecycle."""

    async def asyncSetUp(self):
        """Поднять изолированные SQLite и native loop для каждого сценария."""
        self.tmp = tempfile.TemporaryDirectory(prefix="telegram-test-")
        self.config = mod.Config("123", Path(self.tmp.name) / "brai-telegram", "/test/trusted.mjs",
                                 "/usr/local/bin/node", str(Path(self.tmp.name) / "results"))
        self.bridge = FakeBridge()
        self.injections = []
        self.native_context = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_USER_ID": "123",
            "HERMES_SESSION_CHAT_ID": "123", "HERMES_SESSION_CHAT_TYPE": "dm",
            "HERMES_SESSION_KEY": "agent:main:telegram:test", "HERMES_SESSION_ID": "native-session-1",
            "HERMES_SESSION_THREAD_ID": ""}
        self.entry = NS(session_id="native-session-1", origin=NS(platform="telegram", user_id="123",
            chat_id="123", chat_type="dm", thread_id=""))
        self.store = NS(lookup_by_session_key=lambda key: self.entry
                        if key == self.native_context["HERMES_SESSION_KEY"] else None,
                        lookup_by_session_id=lambda sid: self.entry if sid == self.entry.session_id else None)
        self.markdown = MARKDOWN.replace(ROOT, self.config.result_root)
        self.bridge.file["markdown"] = self.markdown
        self.plugin = mod.TelegramPlugin(self.config, self.bridge, self.inject)
        self.format_inputs = []
        def format_message(value):
            self.format_inputs.append(value)
            return value
        def truncate_message(value, maximum, len_fn):
            return [value[i:i + 1800] for i in range(0, len(value), 1800)]
        self.adapter = NS(format_message=format_message, truncate_message=truncate_message)
        self.bot = FakeBot()
        self.app = NS(bot=self.bot, handlers=[])
        def add_handler(handler, group=0):
            handler.group = group
            self.app.handlers.append(handler)
        self.app.add_handler = add_handler
        self.app.remove_handler = lambda h, group=0: self.app.handlers.remove(h)
        self.stubs = patch.dict(sys.modules, {**ptb_stubs(), "gateway.session_context":
            NS(get_session_env=lambda key: self.native_context.get(key, ""))})
        self.stubs.start()
        self.plugin.factory(self.app, self.adapter)
        self.plugin.session_store = self.store

    def inject(self, content, role="user", *, session_key=None, origin=None):
        """Сохранить штатный inject без модели; потребовать reserve до вызова."""
        with self.plugin.tokens._connect() as db:
            row = db.execute("SELECT * FROM tokens WHERE resume_outcome='attempted'").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(role, "user")
        self.assertIsNone(origin)
        self.injections.append((content, session_key))
        return True

    async def asyncTearDown(self):
        """Остановить только свои native таймеры и убрать временные файлы."""
        self.plugin.close()
        await asyncio.sleep(0)
        await asyncio.gather(*tuple(self.plugin.tasks), return_exceptions=True)
        self.stubs.stop()
        self.tmp.cleanup()

    def event(self, **kwargs):
        """Создать normalized owner MessageEvent."""
        values = dict(text="Текст", message_id="42", media_urls=[], raw_message=None,
                      source=NS(platform="telegram", chat_type="dm", user_id="123", chat_id="123"))
        values.update(kwargs)
        return NS(**values)

    async def request(self, stage="planning"):
        """Запросить native кнопки и вернуть токен первого решения."""
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION, "stage": stage}))
        self.assertTrue(result["ok"])
        return self.bot.sent[-1]["reply_markup"].inline_keyboard[0][0].callback_data

    async def test_factory_scopes_handler_and_unload_removes_it(self):
        self.assertEqual(self.app.handlers[0].group, -100)
        self.assertEqual(self.app.handlers[1].pattern, "^brai:")
        self.assertIs(self.plugin.loop, asyncio.get_running_loop())
        self.plugin.close()
        await asyncio.sleep(0)
        self.assertEqual(self.app.handlers, [])

    async def test_observer_records_only_authorized_original_updates(self):
        """Фиксация при guard охватывает сообщения независимо от последующего режима очереди."""
        config = replace(self.config, entry=str(REPO / "services/hermes/trusted.mjs"))
        with patch.dict(os.environ, {"BRAI_TELEGRAM_OBSERVER_ENABLED": "1"}):
            observer = mod.TelegramPlugin(config, self.bridge, self.inject)
        message = NS(message_id=91, text="Вход", date=None, edit_date=None)
        update = NS(message=message, effective_message=message,
                    effective_chat=NS(id=123, type="private"), effective_user=NS(id=123, full_name="Анна"))
        await observer.guard(update, None)
        await observer.guard(update, None)
        with observer.journal.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM messages").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT text FROM messages").fetchone()[0], "Вход")
        update.effective_user = NS(id=999, full_name="Чужой")
        with self.assertRaises(sys.modules["telegram.ext"].ApplicationHandlerStop):
            await observer.guard(update, None)
        with observer.journal.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM messages").fetchone()[0], 1)

    async def set_group_route(self, chat=GROUP):
        """Перезапустить только плагин с прежним SQLite и новым защищённым route."""
        self.plugin.close()
        await asyncio.sleep(0)
        await asyncio.gather(*tuple(self.plugin.tasks), return_exceptions=True)
        self.config = replace(self.config, chat_id=chat)
        self.native_context.update(HERMES_SESSION_CHAT_ID=chat, HERMES_SESSION_CHAT_TYPE="supergroup")
        self.entry.origin.chat_id, self.entry.origin.chat_type = chat, "supergroup"
        self.plugin = mod.TelegramPlugin(self.config, self.bridge, self.inject)
        self.plugin.factory(self.app, self.adapter)
        self.plugin.session_store = self.store

    def update(self, chat=GROUP, owner=123, chat_type="supergroup", **message):
        """Создать native update с отдельными sender, chat и effective message."""
        return NS(effective_chat=NS(id=int(chat), type=chat_type), effective_user=NS(id=owner),
                  effective_message=NS(**message))

    async def set_private_participant(self, user="456"):
        """Открыть native DM назначенного участника при настроенной общей группе."""
        self.config = replace(self.config, allowed_users=("456", "789"))
        await self.set_group_route()
        self.native_context.update(HERMES_SESSION_CHAT_ID=user, HERMES_SESSION_CHAT_TYPE="dm",
                                   HERMES_SESSION_USER_ID=user, HERMES_SESSION_MESSAGE_ID="42")
        self.entry.origin.chat_id = self.entry.origin.user_id = user
        self.entry.origin.chat_type = "dm"

    async def test_group_profile_accepts_authorized_private_senders_only(self):
        """Личка доступна назначенным пользователям с точной привязкой chat ID к sender ID."""
        await self.set_private_participant()
        stop = sys.modules["telegram.ext"].ApplicationHandlerStop
        for user in (123, 456, 789):
            for kind in ("private", "dm"):
                await self.plugin.guard(self.update(chat=str(user), owner=user, chat_type=kind), None)
                self.assertIsNone(await self.plugin.incoming(self.event(source=NS(
                    platform="telegram", chat_id=str(user), user_id=str(user), chat_type=kind))))
        for chat, user in (("999", 999), ("456", 123), ("789", 456)):
            with self.assertRaises(stop):
                await self.plugin.guard(self.update(chat=chat, owner=user, chat_type="private"), None)
            self.assertEqual((await self.plugin.incoming(self.event(source=NS(
                platform="telegram", chat_id=chat, user_id=str(user), chat_type="dm"))))["action"], "skip")

    async def test_private_files_have_separate_idempotency_namespace(self):
        """Одинаковые message ID из группы и разных личек не сталкиваются в publisher."""
        await self.set_private_participant()
        for chat, user, kind in ((GROUP, "456", "group"), ("456", "456", "dm"), ("789", "789", "dm")):
            await self.plugin.incoming(self.event(media_urls=["/download/file.pdf"], source=NS(
                platform="telegram", chat_id=chat, user_id=user, chat_type=kind)))
        keys = [args["requestId"] for method, args in self.bridge.calls if method == "files.publish"]
        self.assertEqual(keys, [f"tg:{chat}:42:0" for chat in (GROUP, "456", "789")])

    async def test_private_confirmation_delivery_callback_and_restart_stay_in_dm(self):
        """Кнопка и продолжение остаются в личке; перезапуск не отменяет валидный DM token."""
        await self.set_private_participant()
        data = await self.request()
        self.assertEqual(self.bot.sent[-1]["chat_id"], 456)
        self.assertNotIn("message_thread_id", self.bot.sent[-1])
        row = self.plugin.tokens.pending()[0]
        self.assertEqual((row["owner"], row["chat_id"]), ("123", "456"))
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0)
        for user, chat, kind in ((123, 123, "private"), (789, 789, "private"), (456, int(GROUP), "supergroup"),
                                  (123, 456, "private")):
            await self.plugin.callback(NS(callback_query=FakeQuery(data, owner=user, chat=chat, chat_type=kind)), None)
        self.assertFalse(any(method in {"actions.complete", "actions.cancel"} for method, _ in self.bridge.calls))
        query = FakeQuery(data, owner=456, chat=456)
        await self.plugin.callback(NS(callback_query=query), None)
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertEqual(len(self.injections), 1)
        self.assertEqual(self.bot.sent[-1]["chat_id"], 456)

    async def test_private_feedback_uses_actual_message_and_chat(self):
        """Замечания из лички не подменяются сообщением группы с тем же ID."""
        await self.set_private_participant()
        for chat, text, kind in ((GROUP, "групповое сообщение", "group"), ("456", "исправь мой план", "dm")):
            await self.plugin.incoming(self.event(text=text, source=NS(
                platform="telegram", chat_id=chat, user_id="456", chat_type=kind)))
        result = json.loads(await self.plugin.submit_feedback({"elementId": TARGET, "revisionId": REVISION,
            "moveId": MOVE, "decision": "changes"}))
        self.assertTrue(result["ok"])
        call = next(args for method, args in self.bridge.calls if method == "actions.feedback")
        self.assertEqual(call["feedback"]["content"], "исправь мой план")
        self.assertEqual(call["feedback"]["source"]["chat_id"], "456")
        self.plugin.config = replace(self.config, allowed_users=())
        self.assertFalse(self.plugin._session_matches({
            "session_key": self.native_context["HERMES_SESSION_KEY"], "session_id": self.entry.session_id,
            "chat_id": "456", "thread_id": "", "owner": "123"}))
        with self.assertRaises(mod.BridgeError):
            self.plugin._tool_context({})

    async def test_confirmation_cannot_be_reused_or_cancelled_from_another_chat(self):
        """Запрос того же Action из другой беседы не переносит и не отменяет чужую кнопку."""
        await self.set_group_route()
        await self.request()
        self.native_context.update(HERMES_SESSION_CHAT_ID="123", HERMES_SESSION_CHAT_TYPE="dm")
        self.entry.origin.chat_id, self.entry.origin.chat_type = "123", "dm"
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.bot.sent), 1)
        self.assertFalse(any(method == "actions.cancel" for method, _ in self.bridge.calls))

    async def test_shared_group_participant_ingress_tools_and_cross_user_confirmation(self):
        """Участник работает с общими данными; любой назначенный пользователь принимает кнопку один раз."""
        self.config = replace(self.config, allowed_users=("456",))
        await self.set_group_route()
        self.native_context["HERMES_SESSION_USER_ID"] = "456"
        self.entry.origin.user_id = "456"
        await self.plugin.guard(self.update(owner=456), None)
        event = self.event(media_urls=["/native-download/file.pdf"],
            source=NS(platform="telegram", chat_type="supergroup", user_id="456", chat_id=GROUP))
        self.assertEqual((await self.plugin.incoming(event))["action"], "rewrite")
        self.assertEqual(self.plugin._owner_session(self.entry.session_id), self.entry)
        data = await self.request()
        self.assertEqual(self.plugin.tokens.pending()[0]["owner"], "123")
        denied = FakeQuery(data, owner=789, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=denied), None)
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        query = FakeQuery(data, owner=123, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertEqual(len(self.injections), 1)

    async def test_shared_participant_can_confirm_owner_button_and_revocation_blocks_context(self):
        """Участник принимает кнопку владельца, а отозванный origin не продолжает работу."""
        self.config = replace(self.config, allowed_users=("456",))
        await self.set_group_route()
        data = await self.request()
        query = FakeQuery(data, owner=456, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertTrue(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.native_context["HERMES_SESSION_USER_ID"] = "456"
        self.entry.origin.user_id = "456"
        self.plugin.config = replace(self.config, allowed_users=())
        with self.assertRaises(mod.BridgeError):
            self.plugin._tool_context({})
        self.assertIsNone(self.plugin._owner_session(self.entry.session_id))
        with self.assertRaises(sys.modules["telegram.ext"].ApplicationHandlerStop):
            await self.plugin.guard(self.update(owner=456), None)

    async def test_shared_users_config_rejects_wildcards_groups_duplicates_and_private_route(self):
        """Дополнительный доступ задаётся только точными user ID для группового route."""
        env = {"BRAI_TELEGRAM_OWNER_ID": "123", "BRAI_TELEGRAM_CHAT_ID": GROUP,
            "BRAI_TELEGRAM_STATE_DIR": str(self.config.state_dir), "BRAI_HERMES_TRUSTED_ENTRY": self.config.entry,
            "BRAI_HERMES_NODE_EXECUTABLE": self.config.node, "BRAI_TELEGRAM_RESULT_ROOT": self.config.result_root}
        with patch.dict(os.environ, env, clear=True):
            os.environ["TELEGRAM_ALLOWED_USERS"] = "456,789"
            config = mod.Config.from_env()
            self.assertTrue(all(config.allows(user) for user in ("123", "456", "789")))
            self.assertFalse(config.allows("999"))
            for invalid in ("*", GROUP, "456,456", "456, 789", "456,", "0", "0456",
                            ",".join(str(i) for i in range(1, 22))):
                os.environ["TELEGRAM_ALLOWED_USERS"] = invalid
                with self.assertRaises(ValueError):
                    mod.Config.from_env()
            os.environ["TELEGRAM_ALLOWED_USERS"] = "456"
            os.environ["BRAI_TELEGRAM_CHAT_ID"] = "123"
            with self.assertRaises(ValueError):
                mod.Config.from_env()

    async def test_group_owner_guard_precedes_native_command_media_callback_and_inline(self):
        await self.set_group_route()
        reached = []
        self.assertEqual(self.app.handlers[0].group, -100)
        stop = sys.modules["telegram.ext"].ApplicationHandlerStop
        async def dispatch(update, handler):
            # PTB обходит группы по возрастанию и прекращает все при ApplicationHandlerStop.
            try:
                await self.app.handlers[0].callback(update, None)
                reached.append(handler)
            except stop:
                pass
        denied = [self.update(owner=456), self.update(chat="-1009876543211"),
                  self.update(chat="456", chat_type="private"), self.update(sender_chat=NS(id=int(GROUP))),
                  self.update(business_connection_id="business"), self.update(owner=None),
                  NS(effective_chat=None, effective_user=NS(id=123), effective_message=None)]
        denied.append(self.update())
        denied[-1].effective_user.is_bot = True
        for handler in ("command", "media_download", "native_callback", "inline_query"):
            for update in denied:
                await dispatch(update, handler)
        self.assertEqual(reached, [])
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.bot.sent, [])
        await dispatch(self.update(), "owner")
        self.assertEqual(reached, ["owner"])

    async def test_business_updates_reach_their_handler_without_brai_access(self):
        """Business lifecycle проходит к своему плагину без publisher и общего owner turn."""
        await self.set_group_route()
        reached = []
        for field in ("business_connection", "business_message", "edited_business_message",
                      "deleted_business_messages"):
            with self.subTest(field=field):
                payload = (NS(user=NS(id=123, is_bot=False)) if field == "business_connection"
                           else NS(business_connection_id="business", chat=NS(id=999, type="private")))
                update = NS(effective_chat=getattr(payload, "chat", None),
                            effective_user=None if field == "business_connection" else NS(id=999),
                            effective_message=payload if field.endswith("message") else None,
                            **{field: payload})
                # Следующий native Business handler должен получить исходный update.
                await self.app.handlers[0].callback(update, None)
                reached.append(update)
                self.assertIs(getattr(reached[-1], field), payload)
        self.assertEqual(len(reached), 4)
        for sender in (123, 456, 999):
            source = NS(platform="telegram", chat_id=str(sender), user_id=str(sender), chat_type="dm")
            event = self.event(source=source, media_urls=["/download/file.pdf"],
                               raw_message=NS(business_connection_id="business"))
            self.assertEqual((await self.plugin.incoming(event))["action"], "skip")
        self.assertEqual(self.plugin.inbound_events, {})
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.bot.sent, [])

    async def test_business_connection_requires_primary_owner_and_closed_guard_stops_updates(self):
        """Участник Brai не может подключить свой Business-аккаунт; unload закрывает весь ingress."""
        self.config = replace(self.config, allowed_users=("456",))
        await self.set_group_route()
        stop = sys.modules["telegram.ext"].ApplicationHandlerStop
        for user in (NS(id=456), NS(id=999), NS(id=123, is_bot=True), None):
            update = NS(business_connection=NS(user=user))
            with self.subTest(user=user), self.assertRaises(stop):
                await self.plugin.guard(update, None)
        self.plugin.closed = True
        for field in ("business_connection", "business_message", "edited_business_message",
                      "deleted_business_messages"):
            payload = NS(user=NS(id=123, is_bot=False))
            with self.subTest(field=field), self.assertRaises(stop):
                await self.plugin.guard(NS(**{field: payload}), None)

    async def test_group_ingress_route_owner_and_idempotent_attachment_namespace(self):
        await self.set_group_route()
        event = self.event(media_urls=["/native-download/file.pdf"],
            source=NS(platform="telegram", chat_type="group", user_id="123", chat_id=GROUP))
        first = await self.plugin.incoming(event)
        second = await self.plugin.incoming(event)
        self.assertEqual(first["action"], "rewrite")
        self.assertEqual(first, second)
        self.assertEqual(self.bridge.calls[0][1]["requestId"], f"tg:{GROUP}:42:0")
        self.assertEqual(self.bridge.calls[0], self.bridge.calls[1])
        self.bridge.calls.clear()
        for changes in ({"user_id": "456"}, {"chat_id": "-1009876543211"}, {"is_bot": True}):
            source = NS(**{**vars(event.source), **changes})
            self.assertEqual((await self.plugin.incoming(self.event(source=source, media_urls=["/file"])))["action"], "skip")
        for raw in (NS(sender_chat=NS(id=int(GROUP))), NS(business_connection_id="business")):
            self.assertEqual((await self.plugin.incoming(self.event(source=event.source, raw_message=raw, media_urls=["/file"])))["action"], "skip")
        self.assertEqual(self.bridge.calls, [])

    async def test_group_callback_binds_route_owner_message_and_rejects_replay(self):
        await self.set_group_route()
        data = await self.request()
        self.assertEqual(self.bot.sent[-1]["chat_id"], int(GROUP))
        self.assertEqual(self.plugin.tokens.pending()[0]["chat_id"], GROUP)
        self.bridge.calls.clear()
        for query in (FakeQuery(data), FakeQuery(data, owner=456, chat=int(GROUP), chat_type="supergroup"),
                      FakeQuery(data, chat=int(GROUP) - 1, chat_type="supergroup"),
                      FakeQuery(data, chat=int(GROUP), chat_type="supergroup", message_id=9)):
            await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(self.bridge.calls, [])
        query = FakeQuery(data, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertEqual(self.bot.sent[-1]["chat_id"], int(GROUP))

    async def test_route_change_rejects_same_message_id_and_cancels_old_pending_on_restart(self):
        await self.set_group_route()
        data = await self.request()
        await self.set_group_route("-1009876543211")
        query = FakeQuery(data, chat=-1009876543211, chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        for _ in range(100):
            if not self.plugin.tokens.pending():
                break
            await asyncio.sleep(0.005)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.assertTrue(any(method == "actions.cancel" for method, _ in self.bridge.calls))
        self.assertEqual(self.bot.sent[-1]["chat_id"], int(GROUP))

    async def test_group_restart_keeps_old_button_without_deadline(self):
        await self.set_group_route()
        data = await self.request()
        await self.set_group_route()
        with patch.object(mod.time, "time", return_value=time.time() + 365 * 86400):
            query = FakeQuery(data, chat=int(GROUP), chat_type="supergroup")
            await self.plugin.callback(NS(callback_query=query), None)
        self.assertTrue(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.assertFalse(any(method == "actions.cancel" for method, _ in self.bridge.calls))
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_legacy_sqlite_migration_binds_old_tokens_to_owner_dm(self):
        directory = Path(self.tmp.name) / "legacy"
        directory.mkdir()
        with sqlite3.connect(directory / "confirmations.sqlite3") as db:
            db.execute("""CREATE TABLE tokens (token TEXT PRIMARY KEY, owner TEXT NOT NULL,
                move_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision_id TEXT NOT NULL,
                stage TEXT NOT NULL, expires REAL NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
                message_id TEXT, resolved INTEGER NOT NULL DEFAULT 0)""")
            db.execute("INSERT INTO tokens VALUES ('old','123',?,?,?,'planning',?,0,'1',0)",
                       (MOVE, ATTEMPT, REVISION, time.time() + 900))
        tokens = mod.Tokens(directory)
        self.assertEqual(tokens.pending()[0]["chat_id"], "123")
        self.assertNotIn("expires", tokens.pending()[0])
        self.assertIsNone(tokens.consume("old", "123", 1, GROUP))
        self.assertIsNotNone(tokens.consume("old", "123", 1, "123"))

    async def test_protected_chat_config_is_optional_and_never_substitutes_owner(self):
        env = {"BRAI_TELEGRAM_OWNER_ID": "123", "BRAI_TELEGRAM_STATE_DIR": str(self.config.state_dir),
               "BRAI_HERMES_TRUSTED_ENTRY": self.config.entry, "BRAI_HERMES_NODE_EXECUTABLE": self.config.node,
               "BRAI_TELEGRAM_RESULT_ROOT": self.config.result_root}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(mod.Config.from_env().chat, "123")
            os.environ["BRAI_TELEGRAM_CHAT_ID"] = GROUP
            self.assertEqual(mod.Config.from_env().chat, GROUP)
            for invalid in ("0", "-0", "00123", "+123", "456", "group", " 123"):
                os.environ["BRAI_TELEGRAM_CHAT_ID"] = invalid
                with self.assertRaises(ValueError):
                    mod.Config.from_env()
            os.environ["BRAI_TELEGRAM_CHAT_ID"] = GROUP
            os.environ["BRAI_TELEGRAM_OWNER_ID"] = GROUP
            with self.assertRaises(ValueError):
                mod.Config.from_env()

    async def test_foreign_owner_group_and_business_never_publish(self):
        for changes in ({"user_id": "456"}, {"chat_id": "456"}, {"chat_type": "group"}):
            event = self.event(media_urls=["/file.pdf"])
            for key, value in changes.items():
                setattr(event.source, key, value)
            self.assertEqual((await self.plugin.incoming(event))["action"], "skip")
        self.assertEqual((await self.plugin.incoming(self.event(media_urls=["/file.pdf"],
            raw_message=NS(business_connection_id="business"))))["action"], "skip")
        self.assertEqual(self.bridge.calls, [])

    async def test_other_platform_hooks_unchanged(self):
        event = self.event(source=NS(platform="slack"), media_urls=["/file.pdf"])
        self.assertIsNone(await self.plugin.incoming(event))
        self.assertIsNone(self.plugin.outgoing(self.markdown, platform="slack"))
        self.assertEqual(self.bridge.calls, [])

    async def test_incoming_preserves_exact_markdown_and_stable_id(self):
        event = self.event(media_urls=["/file.pdf"])
        for _ in range(2):
            result = await self.plugin.incoming(event)
            self.assertEqual(result, {"action": "rewrite", "text": "Текст\n\n" + self.markdown})
        self.assertEqual([args["requestId"] for method, args in self.bridge.calls], ["tg:123:42:0"] * 2)

    async def test_publication_failure_preserves_native_album_and_caption(self):
        self.bridge.fail = "files.publish"
        paths = ["/native-download/one.jpg", "/native-download/two.jpg"]
        event = self.event(text="Прочитай оба изображения", media_urls=paths.copy(),
                           media_types=["image/jpeg", "image/jpeg"])
        with self.assertLogs(mod.__name__, level="WARNING") as logs:
            result = await self.plugin.incoming(event)
        self.assertEqual(result["action"], "rewrite")
        self.assertIn(event.text, result["text"])
        self.assertIn("сохранение всех файлов в Brai не подтверждено", result["text"])
        self.assertEqual(event.media_urls, paths)
        self.assertEqual(event.media_types, ["image/jpeg", "image/jpeg"])
        self.assertEqual(self.bot.sent, [])
        self.assertEqual(len(self.bridge.calls), 1)
        self.assertIn("code=TIMEOUT count=2", logs.output[0])
        self.assertNotIn("/native-download", logs.output[0])

    async def test_partial_publication_preserves_descriptor_and_all_native_files(self):
        original_call = self.bridge.call
        def call(method, params, timeout=15):
            if method == "files.publish" and params["path"].endswith("two.jpg"):
                self.bridge.calls.append((method, params))
                raise mod.BridgeError("RPC_REJECTED")
            return original_call(method, params, timeout)
        self.bridge.call = call
        event = self.event(media_urls=["/native-download/one.jpg", "/native-download/two.jpg"])
        with self.assertLogs(mod.__name__, level="WARNING"):
            result = await self.plugin.incoming(event)
        self.assertEqual(result["action"], "rewrite")
        self.assertIn(self.markdown, result["text"])
        self.assertIn("не подтверждено", result["text"])
        self.assertEqual(len(event.media_urls), 2)
        self.assertEqual([args["requestId"] for method, args in self.bridge.calls],
                         ["tg:123:42:0", "tg:123:42:1"])
        self.assertEqual(self.bot.sent, [])

    async def test_malformed_publisher_result_does_not_discard_native_file(self):
        self.bridge.file["markdown"] = "[untrusted](https://example.test)"
        event = self.event(media_urls=["/native-download/one.jpg"])
        with self.assertLogs(mod.__name__, level="WARNING"):
            result = await self.plugin.incoming(event)
        self.assertEqual(result["action"], "rewrite")
        self.assertNotIn("https://example.test", result["text"])
        self.assertEqual(event.media_urls, ["/native-download/one.jpg"])

    async def test_attachment_limit_still_rejects_before_publication(self):
        with self.assertLogs(mod.__name__, level="WARNING"):
            result = await self.plugin.incoming(self.event(media_urls=["/file.pdf"] * 11))
        self.assertEqual(result["action"], "skip")
        self.assertEqual(result["reason"], "brai-file-input-invalid")
        self.assertEqual(self.bridge.calls, [])
        self.assertIn("десяти", self.bot.sent[-1]["text"])

    async def test_wrong_message_foreign_sender_group_forgery_do_not_complete(self):
        data = await self.request()
        for kwargs in ({"message_id": 9}, {"owner": 456}, {"chat": -9, "chat_type": "group"}):
            await self.plugin.callback(NS(callback_query=FakeQuery(data, **kwargs)), None)
        await self.plugin.callback(NS(callback_query=FakeQuery("brai:" + "x" * 32 + ":approved")), None)
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)

    async def test_replay_rejected_even_after_sqlite_reopen(self):
        data = await self.request()
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.plugin.tokens = mod.Tokens(self.config.state_dir)
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_changed_attempt_revision_and_executor_cannot_complete(self):
        for field, value in (("attemptId", TARGET), ("revisionId", TARGET),
                             ("attemptStatus", "completed"), ("attemptExecutorKind", "agent")):
            original = dict(self.bridge.action)
            data = await self.request()
            self.bridge.action[field] = value
            message_id = len(self.bot.sent)
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=message_id)), None)
            self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
            self.bridge.action = original

    async def test_prepare_precedes_native_send_and_context_has_binding(self):
        await self.request()
        self.assertEqual(self.bridge.calls[0][0], "actions.prepare")
        text = self.bot.sent[-1]["text"]
        for value in ("Принять план", "Результат", "План работы", "Проверить описанный план"):
            self.assertIn(value, text)
        for value in (MOVE, TARGET, REVISION, "planning"):
            self.assertNotIn(value, text)
        for row in self.bot.sent[-1]["reply_markup"].inline_keyboard:
            self.assertLessEqual(len(row[0].callback_data.encode()), 64)

    async def test_full_saved_text_precedes_buttons_and_is_not_truncated(self):
        preview = 'Чек-лист подготовлен\nРезультат: три пункта.\n' + '👤 Ход\n' * 900
        self.bridge.action.update(confirmationStage='planning', confirmationText=preview)
        await self.request()
        self.assertGreater(len(self.bot.sent), 1)
        text = ''.join(item['text'] for item in self.bot.sent)
        plain = html.unescape(re.sub(r'</?b>', '', text))
        self.assertIn(preview, plain)
        self.assertNotIn(MOVE, plain)
        for message in self.bot.sent:
            self.assertLessEqual(len(message['text'].encode('utf-16-le')) // 2, 4096)
            self.assertEqual(message['parse_mode'], 'MarkdownV2')
        self.assertTrue(all('reply_markup' not in item for item in self.bot.sent[:-1]))
        keyboard = self.bot.sent[-1]['reply_markup'].inline_keyboard
        self.assertEqual([row[0].text for row in keyboard], ['Принять'])
        self.assertEqual(self.plugin.tokens.pending()[0]['message_id'], str(len(self.bot.sent)))

    async def test_confirmation_uses_native_formatter_for_new_and_edited_message(self):
        preview = 'Заголовок\n\n## Вывод\n\n**Важно**: [источник](https://example.org)'
        self.bridge.action.update(confirmationStage='planning', confirmationText=preview)
        await self.request()
        self.assertIn(preview, self.format_inputs[-1])
        self.assertEqual(self.bot.sent[0]['parse_mode'], 'MarkdownV2')
        result = json.loads(await self.plugin.request_confirmation({'moveId': MOVE, 'revisionId': REVISION}))
        self.assertTrue(result['ok'])
        self.assertEqual(len(self.bot.sent), 1)
        self.assertEqual(self.bot.edited[0]['parse_mode'], 'MarkdownV2')
        self.assertIn(preview, self.format_inputs[-1])
        self.assertEqual([button.text for row in self.bot.edited[0]['reply_markup'].inline_keyboard for button in row], ['Принять'])

    async def test_real_file_adapter_sends_saved_pdf_as_document(self):
        from types import ModuleType
        sys.path.insert(0, str(REPO / 'services/hermes'))
        from files import native
        from files.tests.test_files import Backend
        root = Path(self.tmp.name)
        incoming = root / 'incoming'
        incoming.mkdir()
        source = incoming / 'report.pdf'
        source.write_bytes(b'%PDF-1.4 synthetic report')
        backend = Backend(Path(self.config.result_root))
        store = native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(root / 'state'),
            'resultRoot': self.config.result_root, 'readRoots': [str(incoming)]}, backend)
        artifact = store.publish(source, ['synthetic-report'])
        descriptor = '[Отчёт](<' + artifact['localPath'] + '>)'
        self.bridge.action.update(confirmationStage='final', confirmationFiles=[artifact['artifactId']],
                                  confirmationText='Готовый отчёт: ' + descriptor)
        uploads = []
        async def send_document(**kwargs):
            uploads.append(kwargs['document'].read())
            return NS(message_id=77)
        self.bot.send_document = send_document
        self.adapter._bot, self.adapter.platform = self.bot, 'telegram'
        class Media:
            def __init__(self, media, caption=None, parse_mode=None):
                self.media, self.caption, self.parse_mode = media, caption, parse_mode
        telegram = NS(**vars(sys.modules['telegram']))
        for kind in ('Photo', 'Video', 'Audio', 'Document'):
            setattr(telegram, 'InputMedia' + kind, Media)
        base = ModuleType('gateway.platforms.base')
        base.SendResult = lambda **kwargs: NS(**kwargs)
        before = sum(method == 'files.publish' for method, _ in backend.calls)
        with patch.dict(sys.modules, {'brai_files': native, 'telegram': telegram, 'gateway.platforms.base': base}):
            response = json.loads(await self.plugin.request_confirmation(
                {'moveId': MOVE, 'revisionId': REVISION, 'stage': 'final'}))
        self.assertTrue(response['ok'], response)
        self.assertEqual(uploads, [source.read_bytes()])
        self.assertEqual(sum(method == 'files.publish' for method, _ in backend.calls), before)
        self.assertTrue(any(method == 'files.fetch' for method, _ in backend.calls))
        self.assertNotIn(self.config.result_root, self.bot.sent[0]['text'])

    async def test_saved_file_is_delivered_via_artifacts_without_exposing_path(self):
        second = '00000000-0000-4000-8000-000000000006'
        self.bridge.action.update(confirmationStage='final', confirmationFiles=[ARTIFACT, second],
                                  confirmationText='Итог: ' + self.markdown)
        calls = []
        files = NS(_MEDIA=re.compile(r'MEDIA:"([^"\n]+)"'),
                   final_text=lambda text, identity: text.replace(self.markdown, 'MEDIA:"/tmp/ready.pdf"'),
                   active_sub=lambda pattern, replace, text: pattern.sub(replace, text),
                   output_items=lambda paths: ([{'file': {'artifactId': ARTIFACT}}], 'files'),
                   resolve_artifact=lambda aid, identity: {'artifactId': aid, 'filename': 'other.pdf'},
                   store=lambda: NS(checked=lambda value: value), presentation=lambda value: 'document')
        async def send_set(adapter, chat, items, mode, metadata, identity):
            calls.append((chat, [item['file']['artifactId'] for item in items], identity))
            return NS(success=True)
        files.send_set = send_set
        with patch.dict(sys.modules, {'brai_files': files}):
            self.assertTrue(json.loads(await self.plugin.request_confirmation(
                {'moveId': MOVE, 'revisionId': REVISION, 'stage': 'final'}))['ok'])
            self.assertTrue(json.loads(await self.plugin.request_confirmation(
                {'moveId': MOVE, 'revisionId': REVISION, 'stage': 'final'}))['ok'])
        self.assertEqual(calls[0][1], [ARTIFACT, second])
        self.assertEqual(calls[0][2], calls[1][2])
        self.assertNotIn('/tmp/ready.pdf', self.bot.sent[0]['text'])
        self.assertNotIn(self.config.result_root, self.bot.sent[0]['text'])

    async def test_failed_artifact_delivery_never_exposes_descriptor(self):
        self.bridge.action.update(confirmationStage='final', confirmationFiles=[ARTIFACT],
                                  confirmationText='Итог: ' + self.markdown)
        files = NS(_MEDIA=re.compile(r'MEDIA:"([^"\n]+)"'),
                   final_text=lambda text, identity: text.replace(self.markdown, 'MEDIA:"/tmp/ready.pdf"'),
                   active_sub=lambda pattern, replace, text: pattern.sub(replace, text),
                   output_items=lambda paths: ([{'file': {'artifactId': ARTIFACT}}], 'files'))
        async def failed(*args):
            return NS(success=False)
        files.send_set = failed
        with patch.dict(sys.modules, {'brai_files': files}):
            result = json.loads(await self.plugin.request_confirmation(
                {'moveId': MOVE, 'revisionId': REVISION, 'stage': 'final'}))
        self.assertFalse(result['ok'])
        self.assertEqual(self.bot.sent, [])
        self.assertTrue(any(method == 'actions.cancel' for method, _ in self.bridge.calls))

    async def test_unrecognized_result_path_is_never_sent_as_text(self):
        self.bridge.action.update(confirmationStage='final',
                                  confirmationText='Файл находится здесь: ' + self.config.result_root + '/broken')
        result = json.loads(await self.plugin.request_confirmation(
            {'moveId': MOVE, 'revisionId': REVISION, 'stage': 'final'}))
        self.assertFalse(result['ok'])
        self.assertEqual(self.bot.sent, [])

    async def test_missing_reviewable_result_does_not_send_blind_approval_buttons(self):
        self.bridge.action.update(confirmationStage='final', confirmationText=None)
        result = json.loads(await self.plugin.request_confirmation({'moveId': MOVE, 'revisionId': REVISION}))
        self.assertFalse(result['ok'])
        self.assertEqual(self.bot.sent, [])
        self.assertTrue(any(method == 'actions.cancel' for method, _ in self.bridge.calls))

    async def test_integrated_stage_is_persisted_before_ui_and_changes_resumes_review(self):
        for stage, choice in (("planning", "approved"), ("final", "success")):
            for decision in (choice,):
                self.bridge.action.update(status="claimed", attemptStatus="running", confirmationStage=stage,
                                          confirmationText="План или результат для проверки владельцем.")
                send_message = self.bot.send_message
                async def checked_send(**kwargs):
                    if "reply_markup" in kwargs:
                        self.assertEqual(self.plugin.tokens.pending()[0]["stage"], stage)
                    return await send_message(**kwargs)
                self.bot.send_message = checked_send
                data = await self.request("final" if stage == "planning" else "planning")
                self.bot.send_message = send_message
                self.assertEqual(data.rsplit(":", 1)[1], choice)
                data = data.rsplit(":", 1)[0] + ":" + decision
                query = FakeQuery(data, message_id=len(self.bot.sent))
                await self.plugin.callback(NS(callback_query=query), None)
                complete = [args for method, args in self.bridge.calls if method == "actions.complete"][-1]
                self.assertEqual(complete["stage"], stage)  # Bridge owns canonical resource stage.
                facts = json.loads(self.injections[-1][0].splitlines()[1])
                self.assertEqual(facts["stage"], "review" if decision == "changes" else stage)
                self.assertEqual(facts["decision"], decision)
                count = len(self.injections)
                await self.plugin.callback(NS(callback_query=query), None)
                self.assertEqual(len(self.injections), count)

    async def test_substantive_action_rejection_returns_clear_message_without_buttons_or_injection(self):
        original = self.bridge.call
        def reject(method, params, timeout=15):
            if method == "actions.prepare":
                self.bridge.calls.append((method, params))
                raise mod.BridgeError("HUMAN_OUTPUT_REQUIRED")
            return original(method, params, timeout)
        self.bridge.action["status"] = "planned"
        self.bridge.call = reject
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertIn("настоящие результаты работы человека", result["message"])
        self.assertEqual([method for method, _ in self.bridge.calls], ["actions.prepare", "actions.read"])
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertEqual(self.bot.sent, [])
        self.assertEqual(self.injections, [])

    async def test_null_stage_claim_recovery_cancels_without_new_buttons_or_completion(self):
        self.bridge.action["confirmationStage"] = None
        token = self.plugin.tokens.create("123", {"moveId": MOVE, "revisionId": REVISION, "attemptId": ""}, "planning")
        await asyncio.wait_for(self.plugin._recover(token), 1)
        prepare = next(args for method, args in self.bridge.calls if method == "actions.prepare")
        self.assertEqual(prepare["idempotencyKey"], token)
        self.assertEqual(self.bridge.calls[-1], ("actions.cancel", {"moveId": MOVE,
            "attemptId": ATTEMPT, "revisionId": REVISION, "reason": "cancelled"}))
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.assertFalse(any("reply_markup" in message for message in self.bot.sent))
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertEqual(self.injections, [])

    async def test_plan_delivery_fulfils_only_exact_inbound_reply(self):
        source = REPO / "tmp/hermes-pinned-telegram/gateway/response_filters.py"
        if not source.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        spec = importlib.util.spec_from_file_location("native_response_filters_test", source)
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        event = self.event(reply_expected=True)
        next_event = self.event(message_id="43", reply_expected=True)
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "42"
        await self.plugin.incoming(event)
        await self.plugin.incoming(next_event)
        self.assertFalse(native.silence_allowed(None, event.reply_expected))
        await self.request()
        self.assertEqual(len(self.bot.sent), 1)
        self.assertFalse(event.reply_expected)
        self.assertTrue(next_event.reply_expected)
        self.assertTrue(native.silence_allowed(None, event.reply_expected))
        self.assertTrue(native.is_intentional_silence_response("NO_REPLY"))
        self.assertNotIn("Срок", self.bot.sent[0]["text"])
        self.assertNotIn("expires", self.plugin.tokens.pending()[0])

    async def test_failed_plan_delivery_does_not_silence_owner_reply(self):
        event = self.event(reply_expected=True)
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "42"
        await self.plugin.incoming(event)
        self.bot.fail = True
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertTrue(event.reply_expected)

    async def test_unchanged_plan_edit_is_success_without_another_message(self):
        await self.request()
        async def unchanged(**kwargs):
            raise sys.modules["telegram.error"].BadRequest("Message is not modified")
        self.bot.edit_message_text = unchanged
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.bot.sent), 1)
        self.assertFalse(self.plugin.tokens.pending()[0]["consumed"])

    async def test_model_cannot_pass_completion_or_decision(self):
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE,
                            "revisionId": REVISION, "decision": "approved"}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.calls, [])

    async def test_duplicate_tool_request_does_not_claim_or_cancel_active_prompt(self):
        await self.request()
        before = len(self.bridge.calls)
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.bridge.calls), before + 3)
        self.assertEqual(len(self.bot.edited), 1)
        self.assertFalse(any(method == "actions.cancel" for method, _ in self.bridge.calls))
        self.assertEqual(len(self.bot.sent), 1)

    async def test_crash_reservation_recovers_same_key_then_cancels_never_approves(self):
        token = self.plugin.tokens.create("123", {"moveId": MOVE, "revisionId": REVISION, "attemptId": ""}, "planning")
        self.plugin.factory(self.app, self.adapter)
        for _ in range(100):
            if not self.plugin.tokens.pending():
                break
            await asyncio.sleep(0.005)
        prepare = next(args for method, args in self.bridge.calls if method == "actions.prepare")
        self.assertEqual(prepare["idempotencyKey"], token)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.assertNotIn("reply_markup", self.bot.sent[-1])

    async def test_prepare_revision_change_cancels_before_sending_buttons(self):
        original_call = self.bridge.call

        def changed(method, params, timeout=15):
            result = original_call(method, params, timeout)
            if method == "actions.prepare":
                self.bridge.action["revisionId"] = TARGET
            return result

        self.bridge.call = changed
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bot.sent, [])
        self.assertEqual(self.bridge.calls[-1][0], "actions.cancel")

    async def test_reservation_without_remote_claim_does_not_create_new_attempt(self):
        token = self.plugin.tokens.create("123", {"moveId": MOVE, "revisionId": REVISION, "attemptId": ""}, "planning")
        self.bridge.action["status"] = "planned"
        await asyncio.wait_for(self.plugin._recover(token), 1)
        self.assertEqual([method for method, _ in self.bridge.calls], ["actions.read"])
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_recovery_rechecks_after_transient_cancel_failure(self):
        data = await self.request()
        original_call, original_sleep = self.bridge.call, asyncio.sleep
        self.bridge.fail = "actions.cancel"

        def fail_once(method, params, timeout=15):
            try:
                return original_call(method, params, timeout)
            finally:
                if method == "actions.cancel":
                    self.bridge.fail = None

        async def quick_sleep(seconds):
            await original_sleep(0 if seconds == 60 else seconds)

        self.bridge.call = fail_once
        with patch.object(mod.asyncio, "sleep", quick_sleep):
            await asyncio.wait_for(self.plugin._recover(data.split(":")[1]), 2)
        methods = [method for method, _ in self.bridge.calls]
        cancels = [i for i, method in enumerate(methods) if method == "actions.cancel"]
        self.assertEqual(len(cancels), 2)
        self.assertIn("actions.read", methods[cancels[0] + 1:cancels[1]])
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_final_success_changes_and_cancel_decisions(self):
        for stage, decision in (("final", "success"), ("planning", "approved")):
            self.bridge.action.update(status="claimed", attemptStatus="running", confirmationText="План или результат для проверки владельцем.")
            data = await self.request(stage)
            data = data.rsplit(":", 1)[0] + ":" + decision
            message_id = len(self.bot.sent)
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=message_id)), None)
            if decision == "cancelled":
                self.assertEqual(self.bridge.calls[-1][0], "actions.cancel")
            else:
                self.assertEqual(self.bridge.calls[-1], ("actions.complete", {"moveId": MOVE,
                    "attemptId": ATTEMPT, "revisionId": REVISION, "stage": stage, "decision": decision}))

    async def test_timeout_consumes_token_and_never_retries_completion(self):
        data = await self.request()
        self.bridge.fail = "actions.complete"
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertIn("не подтверждена", self.bot.sent[-1]["text"])
        self.assertTrue(self.plugin.tokens.pending()[0]["consumed"])

    async def test_cancelled_callback_releases_active_marker_and_cleans_attempt(self):
        data = await self.request()
        query, started = FakeQuery(data), asyncio.Event()

        async def waiting_answer(*args, **kwargs):
            started.set()
            await asyncio.Future()

        query.answer = waiting_answer
        callback = asyncio.create_task(self.plugin.callback(NS(callback_query=query), None))
        await started.wait()
        callback.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await callback
        self.assertEqual(self.plugin.active_callbacks, set())
        for _ in range(100):
            if not self.plugin.tokens.pending():
                break
            await asyncio.sleep(0.005)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))

    async def test_recovery_cancels_exact_attempt_and_restart_cleans_consumed(self):
        data = await self.request()
        token = data.split(":")[1]
        self.plugin.tokens.consume(token)
        await asyncio.wait_for(self.plugin._recover(token), 1)
        self.assertEqual(self.bridge.calls[-1], ("actions.cancel", {"moveId": MOVE,
            "attemptId": ATTEMPT, "revisionId": REVISION, "reason": "cancelled"}))
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_recovery_does_not_cancel_new_attempt(self):
        data = await self.request()
        self.bridge.action["attemptId"] = TARGET
        await asyncio.wait_for(self.plugin._recover(data.split(":")[1]), 1)
        self.assertFalse(any(method == "actions.cancel" for method, _ in self.bridge.calls))

    async def test_startup_reconciles_consumed_unresolved_immediately(self):
        data = await self.request()
        self.plugin.tokens.consume(data.split(":")[1])
        self.plugin.factory(self.app, self.adapter)
        for _ in range(100):
            if not self.plugin.tokens.pending():
                break
            await asyncio.sleep(0.005)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))

    async def test_failed_send_cancels_human_attempt(self):
        self.bot.fail = True
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.calls[-1][0], "actions.cancel")
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_worker_loop_sends_on_native_loop(self):
        def worker():
            return asyncio.run(self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        result = await asyncio.to_thread(worker)
        self.assertTrue(json.loads(result)["ok"])
        self.assertEqual(len(self.bot.sent), 1)

    async def test_owner_decision_resumes_same_native_session_once_with_exact_facts(self):
        data = await self.request()
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(len(self.injections), 1)
        content, key = self.injections[0]
        facts = json.loads(content.splitlines()[1])
        self.assertEqual(key, self.native_context["HERMES_SESSION_KEY"])
        self.assertEqual(facts, dict(elementId=TARGET, moveId=MOVE, revisionId=REVISION,
                                    attemptId=ATTEMPT, stage="planning", decision="approved"))
        self.assertNotIn(data.split(":")[1], content)
        self.assertIn("автоматическое продолжение работы", self.bot.sent[-1]["text"])
        self.plugin.observe_resume(session_id="other-session", user_message=content)
        with self.plugin.tokens._connect() as db:
            self.assertEqual(db.execute("SELECT resume_outcome FROM tokens").fetchone()[0], "submitted")
        self.plugin.observe_resume(session_id="native-session-1", user_message="[native timestamp]\n" + content)
        self.assertEqual(self.plugin.tokens.uncertain_resumes(), [])

    async def test_old_change_cancel_buttons_are_rejected_without_consuming_acceptance(self):
        data = await self.request()
        before = len(self.bridge.calls)
        for decision in ("changes", "cancelled"):
            query = FakeQuery(data.rsplit(":", 1)[0] + ":" + decision)
            await self.plugin.callback(NS(callback_query=query), None)
            self.assertIn("сообщением", query.answers[-1])
        self.assertEqual(len(self.bridge.calls), before)
        self.assertFalse(self.plugin.tokens.pending()[0]["consumed"])
        self.assertEqual(self.injections, [])

    async def test_one_accept_button_and_exact_text_feedback(self):
        await self.request()
        keyboard = self.bot.sent[-1]["reply_markup"].inline_keyboard
        self.assertEqual(len(keyboard), 1)
        self.assertEqual(len(keyboard[0]), 1)
        self.assertEqual(keyboard[0][0].text, "Принять")
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "42"
        event = self.event(text="Сделай пункты короче, без вводного текста.")
        await self.plugin.incoming(event)
        args = {"elementId": TARGET, "revisionId": REVISION, "moveId": MOVE, "decision": "changes"}
        response = json.loads(await self.plugin.submit_feedback(args))
        self.assertTrue(response["ok"], {"response": response, "calls": self.bridge.calls})
        actual = [params for method, params in self.bridge.calls if method == "actions.feedback"][-1]
        self.assertEqual(actual["feedback"]["content"], event.text)
        self.assertEqual(actual["feedback"]["source"]["message_id"], "42")
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertEqual(self.injections, [])  # Current native turn continues, no second agent turn.
        before = len(self.bridge.calls)
        self.assertTrue(json.loads(await self.plugin.submit_feedback(args))["ok"])
        self.assertEqual(len(self.bridge.calls), before)
        self.assertFalse(json.loads(await self.plugin.submit_feedback({**args, "decision": "cancelled"}))["ok"])

    async def test_clarification_is_plain_text_and_saves_exact_owner_answer_provenance(self):
        self.bridge.action.update(confirmationStage="clarification", confirmationText="Какой результат считать готовым?")
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(result["ok"])
        self.assertIn("Уточнение поручения", self.bot.sent[-1]["text"])
        self.assertIn("Какой результат считать готовым?", self.bot.sent[-1]["text"])
        self.assertNotIn("reply_markup", self.bot.sent[-1])
        self.assertEqual(self.plugin.tokens.pending()[0]["stage"], "clarification")
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "43"
        event = self.event(text="Готово, когда получен письменный ответ от поставщика.", message_id="43")
        await self.plugin.incoming(event)
        args = {"elementId": TARGET, "revisionId": REVISION, "moveId": MOVE, "decision": "clarify"}
        response = json.loads(await self.plugin.submit_feedback(args))
        self.assertTrue(response["ok"], {"response": response, "calls": self.bridge.calls})
        actual = [params for method, params in self.bridge.calls if method == "actions.feedback"][-1]
        self.assertEqual(actual["decision"], "clarify")
        self.assertEqual(actual["feedback"]["content"], event.text)
        self.assertEqual(actual["feedback"]["source"]["message_id"], "43")
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_practical_final_report_then_separate_accept_completes_same_action(self):
        self.bridge.action.update(confirmationStage=None, decision="final", outputContracts=[{"key": "result", "name": "Отчёт"}], confirmationText=None)
        requested = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(requested["ok"], requested)
        self.assertIn("Выполни это практическое действие", self.bot.sent[-1]["text"])
        self.assertNotIn("reply_markup", self.bot.sent[-1])
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "51"
        report = self.event(text="Забрал и проверил часы.", message_id="51")
        await self.plugin.incoming(report)
        first = json.loads(await self.plugin.submit_result({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(first["ok"])
        self.assertEqual(first["status"], "awaiting_decision")
        saved = self.plugin.tokens.human_result("123", MOVE)
        self.assertEqual(saved["content"], report.text)
        self.assertEqual(json.loads(saved["source_json"])["message_id"], "51")
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "52"
        await self.plugin.incoming(self.event(text="Всё принимаю.", message_id="52"))
        final = json.loads(await self.plugin.submit_result({"moveId": MOVE, "revisionId": REVISION}))
        self.assertTrue(final["ok"])
        call = [params for method, params in self.bridge.calls if method == "actions.result"][-1]
        self.assertEqual(call["content"], report.text)
        self.assertEqual(call["decisionText"], "Всё принимаю.")
        self.assertEqual(call["decisionSource"]["message_id"], "52")
        self.assertIsNone(self.plugin.tokens.human_result("123", MOVE))

    async def test_practical_result_is_discarded_after_attempt_replaced(self):
        self.bridge.action.update(confirmationStage=None, decision="final", outputContracts=[{"key": "result", "name": "Отчёт"}], confirmationText=None)
        self.assertTrue(json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))["ok"])
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "61"
        await self.plugin.incoming(self.event(text="Забрал и проверил часы.", message_id="61"))
        self.assertEqual(json.loads(await self.plugin.submit_result({"moveId": MOVE, "revisionId": REVISION}))["status"], "awaiting_decision")
        self.bridge.action["attemptId"] = "00000000-0000-4000-8000-000000000099"
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "62"
        await self.plugin.incoming(self.event(text="Всё принимаю.", message_id="62"))
        response = json.loads(await self.plugin.submit_result({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "STALE_ACTION")
        self.assertIsNone(self.plugin.tokens.human_result("123", MOVE))
        self.assertEqual(sum(method == "actions.result" for method, _ in self.bridge.calls), 1)

    async def test_terminal_session_fails_only_observed_exact_agent_attempt(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"),
                         [{"owner": "123", "session_id": "native-session-1", "move_id": MOVE, "attempt_id": ATTEMPT}])
        await self.plugin.on_session_end(session_id="native-session-1", platform="telegram", completed=True)
        self.assertEqual([params for method, params in self.bridge.calls if method == "actions.fail_agent"],
                         [{"moveId": MOVE, "attemptId": ATTEMPT}])
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [])

    async def test_successful_turn_preserves_claim_for_live_exact_session_delegation(self):
        self.plugin.observe_agent_move(tool_name="mcp__brai__game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        api = ModuleType("tools.async_delegation")
        api.has_live_for_session = lambda **kwargs: kwargs == {"parent_session_id": "native-session-1"}
        api.list_async_delegations = lambda: []
        api.get_durable_delegation = lambda delegation_id: None
        with patch.dict(sys.modules, {"tools": ModuleType("tools"), "tools.async_delegation": api}):
            await self.plugin.on_session_end(session_id="native-session-1", platform="telegram",
                                             completed=True, failed=False, interrupted=False)
        self.assertFalse(any(method == "actions.fail_agent" for method, _ in self.bridge.calls))
        self.assertEqual(len(self.plugin.tokens.agent_attempts("123", "native-session-1")), 1)

    async def test_successful_turn_preserves_claim_for_exact_pending_delivery_only(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        api = ModuleType("tools.async_delegation")
        api.has_live_for_session = lambda **kwargs: False
        api.list_async_delegations = lambda: [{"delegation_id": "deleg_exact", "parent_session_id": "native-session-1",
                                                "completed_at": 123},
                                               {"delegation_id": "deleg_foreign", "parent_session_id": "other-session",
                                                "completed_at": 123}]
        api.get_durable_delegation = lambda delegation_id: {"delivery_state": "pending" if delegation_id == "deleg_exact" else "pending"}
        with patch.dict(sys.modules, {"tools": ModuleType("tools"), "tools.async_delegation": api}):
            await self.plugin.on_session_end(session_id="native-session-1", platform="telegram",
                                             completed=True, failed=False, interrupted=False)
        self.assertFalse(any(method == "actions.fail_agent" for method, _ in self.bridge.calls))

        api.get_durable_delegation = lambda delegation_id: {"delivery_state": "delivered"}
        with patch.dict(sys.modules, {"tools": ModuleType("tools"), "tools.async_delegation": api}):
            await self.plugin.on_session_end(session_id="native-session-1", platform="telegram",
                                             completed=True, failed=False, interrupted=False)
        self.assertEqual(sum(method == "actions.fail_agent" for method, _ in self.bridge.calls), 1)

    async def test_failure_or_interruption_fails_claim_even_with_live_delegation(self):
        for terminal in ({"completed": False, "failed": True, "interrupted": False},
                         {"completed": False, "failed": False, "interrupted": True}):
            with self.subTest(terminal=terminal):
                self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
                    result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
                    session_id="native-session-1", status="ok")
                api = ModuleType("tools.async_delegation")
                api.has_live_for_session = lambda **kwargs: True
                api.list_async_delegations = lambda: []
                api.get_durable_delegation = lambda delegation_id: None
                with patch.dict(sys.modules, {"tools": ModuleType("tools"), "tools.async_delegation": api}):
                    await self.plugin.on_session_end(session_id="native-session-1", platform="telegram", **terminal)
                self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [])
                self.bridge.calls.clear()

    async def test_namespaced_claim_and_completion_are_tracked_but_foreign_prefix_is_ignored(self):
        self.plugin.observe_agent_move(tool_name="mcp__other__game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [])
        self.plugin.observe_agent_move(tool_name="mcp__brai__game_core_move_claim", args={"move_id": MOVE},
            result=json.dumps({"result": json.dumps({"attempt": {
                "id": ATTEMPT, "status": "running", "executor_kind": "agent"}})}),
            session_id="native-session-1", status="ok")
        self.assertEqual(len(self.plugin.tokens.agent_attempts("123", "native-session-1")), 1)
        self.plugin.observe_agent_move(tool_name="mcp__brai__game_core_move_complete", args={"attempt_id": ATTEMPT},
            result=json.dumps({"result": json.dumps({"attempt": {"id": ATTEMPT, "status": "succeeded"}})}),
            session_id="native-session-1", status="ok")
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [])

    async def test_factory_reconnect_does_not_mark_live_claim_as_startup_orphan(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0)
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [
            {"owner": "123", "session_id": "native-session-1", "move_id": MOVE, "attempt_id": ATTEMPT}])
        self.assertFalse(any(method == "actions.fail_agent" for method, _ in self.bridge.calls))

    async def test_durable_agent_failure_is_retried_during_startup_recovery(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        self.bridge.fail = "actions.fail_agent"
        await self.plugin.on_session_end(session_id="native-session-1", platform="telegram", completed=True)
        self.assertEqual(len(self.plugin.tokens.agent_attempts("123", "native-session-1")), 1)
        self.plugin.session_store = None  # Startup can reconcile through the fixed-owner trusted port alone.
        self.bridge.fail = None
        await self.plugin.recover_durable_agent_attempts()
        self.assertEqual(self.plugin.tokens.agent_attempts("123", "native-session-1"), [])
        self.assertEqual(sum(method == "actions.fail_agent" for method, _ in self.bridge.calls), 2)

    async def test_plugin_factory_starts_recovery_for_durable_agent_claims(self):
        startup_config = mod.Config("123", Path(self.tmp.name) / "startup-state", "/test/trusted.mjs",
                                    "/usr/local/bin/node", str(Path(self.tmp.name) / "results"))
        plugin = mod.TelegramPlugin(startup_config, self.bridge, self.inject)
        plugin.tokens.track_agent_attempt("123", "terminal-session", MOVE, ATTEMPT)
        plugin.factory(self.app, self.adapter)
        tasks = tuple(plugin.tasks)
        if tasks:
            await asyncio.gather(*tasks)
        self.assertIn(("actions.fail_agent", {"moveId": MOVE, "attemptId": ATTEMPT}), self.bridge.calls)
        self.assertEqual(plugin.tokens.agent_attempts("123"), [])
        plugin.close()

    async def test_terminal_cleanup_preserves_claims_from_other_session_or_owner(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        await self.plugin.on_session_end(session_id="other-session", platform="telegram", completed=True)
        self.assertFalse(any(method == "actions.fail_agent" for method, _ in self.bridge.calls))
        self.assertEqual(len(self.plugin.tokens.agent_attempts("123", "other-session")), 0)

    async def test_owner_incoming_does_not_fail_active_claim_in_same_or_other_session(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        other_attempt = "00000000-0000-4000-8000-000000000088"
        self.plugin.tokens.track_agent_attempt("123", "other-session", MOVE, other_attempt)
        await self.plugin.incoming(self.event(text="Продолжи планирование."))
        self.assertFalse(any(method == "actions.fail_agent" for method, _ in self.bridge.calls))
        self.assertEqual(len(self.plugin.tokens.agent_attempts("123")), 2)

    async def test_terminal_outage_retries_on_later_owner_incoming(self):
        self.plugin.observe_agent_move(tool_name="game_core_move_claim", args={"move_id": MOVE},
            result={"attempt": {"id": ATTEMPT, "status": "running", "executor_kind": "agent"}},
            session_id="native-session-1", status="ok")
        self.bridge.fail = "actions.fail_agent"
        await self.plugin.on_session_end(session_id="native-session-1", platform="telegram", completed=True)
        self.assertEqual(self.plugin.tokens.agent_attempts("123", terminal_only=True)[0]["attempt_id"], ATTEMPT)
        self.bridge.fail = None
        await self.plugin.incoming(self.event(text="Следующий вопрос."))
        self.assertEqual(self.plugin.tokens.agent_attempts("123"), [])

    async def test_text_cancel_invalidates_button_and_accept_cannot_resume(self):
        data = await self.request()
        self.native_context["HERMES_SESSION_MESSAGE_ID"] = "42"
        await self.plugin.incoming(self.event(text="Отмени эту задачу."))
        result = json.loads(await self.plugin.submit_feedback({"elementId": TARGET, "revisionId": REVISION, "decision": "cancelled"}))
        self.assertTrue(result["ok"])
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(self.injections, [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))

    async def test_feedback_requires_actual_current_owner_message_and_no_model_text(self):
        args = {"elementId": TARGET, "revisionId": REVISION, "moveId": MOVE, "decision": "changes"}
        for extra in ({}, {"comment": "made up"}, {"decision": "approved"}):
            self.assertFalse(json.loads(await self.plugin.submit_feedback({**args, **extra}))["ok"])
        await self.plugin.incoming(self.event(source=NS(platform="telegram", user_id="456", chat_id="123", chat_type="dm")))
        self.assertFalse(json.loads(await self.plugin.submit_feedback(args))["ok"])
        self.assertFalse(any(method == "actions.feedback" for method, _ in self.bridge.calls))

    async def test_false_missing_or_ambiguous_injection_is_visible_and_never_replayed(self):
        for outcome in (False, None, RuntimeError("unknown")):
            self.bridge.action.update(status="claimed", attemptStatus="running")
            data = await self.request()
            attempted = []
            def inject(content, **kwargs):
                attempted.append(content)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            self.plugin.inject_message = None if outcome is None else inject
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=len(self.bot.sent))), None)
            self.assertEqual(len(attempted), 0 if outcome is None else 1)
            self.assertNotIn("автоматическое продолжение работы", self.bot.sent[-1]["text"])
            self.assertRegex(self.bot.sent[-1]["text"], "не принял|недоступно|недоступна|неизвестен")
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=len(self.bot.sent) - 1)), None)
            self.assertEqual(len(attempted), 0 if outcome is None else 1)

    async def test_restart_unknown_dispatch_reports_without_reinject_or_complete(self):
        data = await self.request()
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(len(self.injections), 1)
        calls = list(self.bridge.calls)
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.injections), 1)
        self.assertEqual(self.bridge.calls, calls)
        self.assertIn("исход автоматического продолжения не подтверждён", self.bot.sent[-1]["text"])
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0.01)
        self.assertEqual(sum("был перезапущен" in sent["text"] for sent in self.bot.sent), 1)

    async def test_atomic_reserve_survives_crash_before_public_inject(self):
        data = await self.request()
        token = data.split(":")[1]
        self.plugin.tokens.consume(token)
        self.plugin.tokens.decide(token, "approved")
        self.plugin.tokens.confirm(token)
        self.assertIsNotNone(await asyncio.to_thread(self.plugin.tokens.reserve_resume, token))
        self.assertIsNone(await asyncio.to_thread(self.plugin.tokens.reserve_resume, token))
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0.01)
        self.assertEqual(self.injections, [])
        self.assertIn("перезапущен", self.bot.sent[-1]["text"])

    async def test_unknown_complete_never_resumes_even_when_remote_effect_succeeded(self):
        data = await self.request()
        original = self.bridge.call
        def lost_reply(method, args, timeout=15):
            result = original(method, args, timeout)
            if method == "actions.complete":
                raise mod.BridgeError("OUTCOME_UNKNOWN")
            return result
        self.bridge.call = lost_reply
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        await self.plugin.callback(NS(callback_query=FakeQuery(data)), None)
        self.assertEqual(self.injections, [])
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.plugin.factory(self.app, self.adapter)
        await asyncio.sleep(0.03)
        self.assertEqual(self.injections, [])
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)

    async def test_changed_session_source_or_thread_never_completes_or_injects(self):
        for object_, field, wrong in ((self.entry, "session_id", "replacement"),
                (self.entry.origin, "user_id", "456"), (self.entry.origin, "chat_id", "-1000000000"),
                (self.entry.origin, "thread_id", "other-topic")):
            self.bridge.action.update(status="claimed", attemptStatus="running")
            data = await self.request()
            original = getattr(object_, field)
            setattr(object_, field, wrong)
            before = sum(method == "actions.complete" for method, _ in self.bridge.calls)
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=len(self.bot.sent))), None)
            self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), before)
            setattr(object_, field, original)
        self.assertEqual(self.injections, [])

    async def test_confirmation_uses_native_context_and_actual_topic_before_any_effect(self):
        self.native_context["HERMES_SESSION_USER_ID"] = "456"
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.bot.sent, [])
        self.native_context["HERMES_SESSION_USER_ID"] = "123"
        self.native_context["HERMES_SESSION_THREAD_ID"] = self.entry.origin.thread_id = "37"
        data = await self.request()
        self.assertEqual(self.bot.sent[-1]["message_thread_id"], 37)
        wrong = FakeQuery(data)
        await self.plugin.callback(NS(callback_query=wrong), None)
        self.assertFalse(self.plugin.tokens.pending()[0]["consumed"])
        query = FakeQuery(data)
        query.message.message_thread_id = 37
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(len(self.injections), 1)
        self.assertEqual(self.bot.sent[-1]["message_thread_id"], 37)

    async def test_cached_native_turn_uses_dispatch_session_id_in_group(self):
        """Native повторно использует agent; ContextVar ID пуст, dispatch ID настоящий."""
        upstream = REPO / "tmp/hermes-pinned-telegram"
        source = upstream / "gateway/session_context.py"
        if not source.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        spec = importlib.util.spec_from_file_location("native_session_context_test", source)
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        await self.set_group_route()
        self.entry.origin.thread_id = "1"
        # Точное поведение gateway._set_session_env: ID не передаётся повторно.
        tokens = native.set_session_vars(platform="telegram", chat_id=self.config.chat,
            chat_type="supergroup", thread_id="1", user_id=self.config.owner,
            session_key=self.native_context["HERMES_SESSION_KEY"])
        try:
            self.assertEqual(native.get_session_env("HERMES_SESSION_ID"), "")
            with patch.dict(sys.modules, {"gateway.session_context": native}):
                result = json.loads(await self.plugin.request_confirmation(
                    {"moveId": MOVE, "revisionId": REVISION}, session_id=self.entry.session_id))
            self.assertTrue(result["ok"], result)
            self.assertNotIn("message_thread_id", self.bot.sent[-1])
            row = self.plugin.tokens.pending()[0]
            self.assertEqual(row["session_id"], self.entry.session_id)
            self.assertEqual(row["session_key"], self.native_context["HERMES_SESSION_KEY"])
        finally:
            native.clear_session_vars(tokens)

    async def test_general_topic_sends_without_thread_and_accepts_only_its_bound_callback(self):
        """Telegram General rejects send thread=1 and omits it on callbacks."""
        await self.set_group_route()
        self.native_context["HERMES_SESSION_THREAD_ID"] = self.entry.origin.thread_id = "1"
        original_send = self.bot.send_message
        async def telegram_send(**kwargs):
            if kwargs.get("message_thread_id") == 1:
                raise RuntimeError("Bad Request: message thread not found")
            return await original_send(**kwargs)
        self.bot.send_message = telegram_send
        data = await self.request()
        self.assertNotIn("message_thread_id", self.bot.sent[-1])
        row = self.plugin.tokens.pending()[0]
        self.assertEqual(row["thread_id"], "1")
        # Another topic and another message must not consume the real button.
        wrong_topic = FakeQuery(data, chat=int(GROUP), chat_type="supergroup")
        wrong_topic.message.message_thread_id = 37
        wrong_message = FakeQuery(data, chat=int(GROUP), chat_type="supergroup", message_id=99)
        for query in (wrong_topic, wrong_message):
            await self.plugin.callback(NS(callback_query=query), None)
            self.assertFalse(self.plugin.tokens.pending()[0]["consumed"])
            self.assertEqual(self.injections, [])
        query = FakeQuery(data, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        self.assertEqual(sum(method == "actions.complete" for method, _ in self.bridge.calls), 1)
        self.assertEqual(len(self.injections), 1)
        self.assertEqual(len(self.bot.sent), 2)
        self.assertTrue(all("message_thread_id" not in message for message in self.bot.sent))

    async def test_dispatch_session_id_cannot_override_another_or_missing_session(self):
        cases = (("native-session-1", "wrong-session"), ("", "wrong-session"), ("", ""))
        for bound, dispatched in cases:
            with self.subTest(bound=bound, dispatched=dispatched):
                self.native_context["HERMES_SESSION_ID"] = bound
                result = json.loads(await self.plugin.request_confirmation(
                    {"moveId": MOVE, "revisionId": REVISION}, session_id=dispatched))
                self.assertFalse(result["ok"])
                self.assertEqual(self.bridge.calls, [])
                self.assertEqual(self.bot.sent, [])
                self.assertEqual(self.plugin.tokens.pending(), [])
        # Модель не передаёт служебный session_id через аргументы инструмента.
        result = json.loads(await self.plugin.request_confirmation({
            "moveId": MOVE, "revisionId": REVISION, "session_id": self.entry.session_id}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.calls, [])

    async def test_incoming_binds_public_session_store_only_for_owner_route(self):
        self.plugin.session_store = None
        await self.plugin.incoming(self.event(source=NS(platform="telegram", user_id="456", chat_id="123", chat_type="dm")),
                                   session_store=self.store)
        self.assertIsNone(self.plugin.session_store)
        await self.plugin.incoming(self.event(), session_store=self.store)
        self.assertIs(self.plugin.session_store, self.store)

    def generated_image(self, name="Картинка.png"):
        """Создать native cache и опубликованную копию без генератора и сети."""
        home = Path(self.tmp.name) / "native"
        image = home / "cache/generated/images" / name
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"png")
        target = Path(self.config.result_root) / ARTIFACT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"png")
        self.bridge.file.update(filename=name, localPath=str(target), mimeType="image/png",
                                markdown=f"![Картинка](<{target}>)")
        self.image_context = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_CHAT_ID": self.config.chat,
                              "HERMES_SESSION_CHAT_TYPE": "dm", "HERMES_SESSION_USER_ID": self.config.owner}
        self.image_modules = {"gateway.session_context": NS(get_session_env=lambda key: self.image_context.get(key, "")),
                              "hermes_constants": NS(get_hermes_home=lambda: home)}
        return {"success": True, "image": str(image), "provider": "openai-codex", "model": "native-image",
                "prompt": "Нарисуй картинку", "aspect_ratio": "1:1", "modality": "text"}

    def publish_image(self, payload, **identity):
        """Пропустить native success shape через реальный hook плагина."""
        with patch.dict(sys.modules, self.image_modules):
            return self.plugin.tool_result("image_generate", json.dumps(payload),
                                           **{"session_id": "session-1", "tool_call_id": "call-1", **identity})

    async def test_generated_image_publishes_verified_copy_and_preserves_provider_metadata(self):
        payload = self.generated_image("Рисунок [план] 1.png")
        payload.update(host_image=payload["image"], agent_visible_image=payload["image"],
                       prompt=f"Пример MEDIA:{payload['image']}", provider_metadata={"quality": "high"})
        encoded = self.publish_image(payload)
        result = json.loads(encoded)
        for key in ("provider", "model", "prompt", "aspect_ratio", "modality", "provider_metadata"):
            self.assertEqual(result[key], payload[key])
        self.assertEqual(result["artifactId"], ARTIFACT)
        self.assertEqual(result["markdown"], self.bridge.file["markdown"])
        for key in ("image", "host_image", "agent_visible_image"):
            self.assertEqual(result[key], self.bridge.file["localPath"])
        self.assertNotIn("MEDIA:", encoded)
        self.assertEqual(self.bridge.calls[0][0], "files.publish")
        self.assertEqual(self.bridge.calls[0][1]["path"], payload["image"])
        outgoing = self.plugin.outgoing(result["markdown"], platform="telegram")
        self.assertIn(f'MEDIA:"{result["image"]}"', outgoing)
        self.assertNotIn(payload["image"], outgoing)

    async def test_private_generated_image_uses_actual_chat_identity(self):
        """Одна native image identity в разных личках получает разные publisher keys."""
        await self.set_private_participant()
        payload = self.generated_image()
        self.image_context.update(HERMES_SESSION_USER_ID="456", HERMES_SESSION_CHAT_ID="456")
        self.assertTrue(json.loads(self.publish_image(payload))["success"])
        self.image_context.update(HERMES_SESSION_USER_ID="789", HERMES_SESSION_CHAT_ID="789")
        self.assertTrue(json.loads(self.publish_image(payload))["success"])
        self.assertNotEqual(self.bridge.calls[0][1]["requestId"], self.bridge.calls[1][1]["requestId"])
        self.image_context["HERMES_SESSION_USER_ID"] = "456"
        self.assertFalse(json.loads(self.publish_image(payload))["success"])
        self.assertEqual(len(self.bridge.calls), 2)

    async def test_generated_image_replay_uses_same_key_and_new_call_has_new_key(self):
        payload = self.generated_image()
        self.publish_image(payload)
        self.publish_image(payload)
        self.publish_image(payload, tool_call_id="call-2")
        keys = [params["requestId"] for method, params in self.bridge.calls]
        self.assertEqual(keys[0], keys[1])
        self.assertNotEqual(keys[0], keys[2])
        self.assertRegex(keys[0], r"^tg-image:[a-f0-9]{64}$")
        self.assertTrue(all(method == "files.publish" for method, _ in self.bridge.calls))

    async def test_generated_image_other_tools_errors_and_platforms_do_not_publish(self):
        payload = self.generated_image()
        self.assertIsNone(self.plugin.tool_result("read_file", json.dumps(payload)))
        for original in ('not json', '{"success":false,"image":null,"error":"failed"}', '[]'):
            self.assertIsNone(self.plugin.tool_result("image_generate", original))
        self.image_context["HERMES_SESSION_PLATFORM"] = "discord"
        self.assertIsNone(self.publish_image(payload))
        self.assertEqual(self.bridge.calls, [])

    async def test_generated_image_rejects_foreign_route_owner_and_missing_call_identity_before_rpc(self):
        payload = self.generated_image()
        for key, value in (("HERMES_SESSION_CHAT_ID", "999"), ("HERMES_SESSION_USER_ID", "999"),
                           ("HERMES_SESSION_CHAT_TYPE", "group")):
            before = self.image_context[key]
            self.image_context[key] = value
            self.assertFalse(json.loads(self.publish_image(payload))["success"])
            self.image_context[key] = before
        for identity in ({"session_id": ""}, {"tool_call_id": ""}):
            self.assertFalse(json.loads(self.publish_image(payload, **identity))["success"])
        self.assertEqual(self.bridge.calls, [])
        self.plugin.config = replace(self.config, chat_id=GROUP)
        self.image_context.update(HERMES_SESSION_CHAT_ID=GROUP, HERMES_SESSION_CHAT_TYPE="group")
        self.assertTrue(json.loads(self.publish_image(payload))["success"])

    async def test_generated_image_rejects_remote_foreign_symlink_and_missing_paths_before_rpc(self):
        payload = self.generated_image()
        image = Path(payload["image"])
        foreign = Path(self.tmp.name) / "foreign.png"
        foreign.write_bytes(b"png")
        link = image.with_name("link.png")
        link.symlink_to(foreign)
        for path in ("https://example.test/image.png", str(foreign), str(link), str(image.with_name("missing.png")), None):
            result = json.loads(self.publish_image({**payload, "image": path}))
            self.assertFalse(result["success"])
            self.assertIsNone(result["image"])
        self.assertEqual(self.bridge.calls, [])

    async def test_generated_image_publication_failures_never_expose_cache_or_retry(self):
        payload = self.generated_image()
        valid = dict(self.bridge.file)
        for invalid in (None, {"artifactId": TARGET}, {"markdown": "![foreign](<https://example.test/image.png>)"},
                        {"localPath": payload["image"]}, {"mimeType": "application/pdf"}):
            self.bridge.file = {**valid, **(invalid or {})}
            self.bridge.fail = "files.publish" if invalid is None else None
            before = len(self.bridge.calls)
            encoded = self.publish_image(payload)
            result = json.loads(encoded)
            self.assertEqual(result["error_type"], "artifact_publication_failed")
            self.assertIsNone(result["image"])
            self.assertNotIn(payload["image"], encoded)
            self.assertEqual(len(self.bridge.calls), before + 1)

    async def test_native_tool_transform_then_autoappend_uses_only_published_image(self):
        upstream = REPO / "tmp/hermes-pinned-telegram"
        if not upstream.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        from typing import Any, Optional
        env = {"re": re, "json": json, "Any": Any, "Optional": Optional, "_CallIds": object,
               "logger": NS(debug=lambda *args: None), "_tool_result_observer_fields": lambda *args: ("success", None, None)}
        tool_tree = ast.parse((upstream / "model_tools.py").read_text())
        hook = next(node for node in tool_tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == "_apply_transform_tool_result_hook")
        repair_tree = ast.parse((upstream / "gateway/media_repair.py").read_text())
        names = next(node for node in repair_tree.body if isinstance(node, ast.FunctionDef) and node.name == "tool_name_by_call_id")
        run_tree = ast.parse((upstream / "gateway/run.py").read_text())
        constants = {"_AUTO_APPEND_MEDIA_TOOL_NAMES", "_JSON_MEDIA_TOOL_PATH_FIELDS", "_TOOL_MEDIA_RE"}
        nodes = [node for node in run_tree.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id in constants for target in node.targets)]
        collect = next(node for node in run_tree.body if isinstance(node, ast.FunctionDef)
                       and node.name == "_collect_auto_append_media_tags")
        exec(compile(ast.Module(body=[hook, names, *nodes, collect], type_ignores=[]), "native-image-contract", "exec"), env)
        env["_tool_name_by_call_id"] = env["tool_name_by_call_id"]
        payload = self.generated_image()
        payload["prompt"] = f"Пример MEDIA:{payload['image']}"
        lifecycle = NS(has_hook=lambda name: True,
                       invoke_hook=lambda name, **kwargs: [self.plugin.tool_result(**kwargs)])
        with patch.dict(sys.modules, {**self.image_modules, "hermes_cli.lifecycle": lifecycle}):
            transformed = env[hook.name]("image_generate", {}, json.dumps(payload), 1,
                                         NS(hook_kwargs=lambda: {"session_id": "session-1", "tool_call_id": "call-1"}))
        def collected(content):
            messages = [{"role": "assistant", "tool_calls": [{"id": "call-1", "function": {"name": "image_generate"}}]},
                        {"role": "tool", "tool_call_id": "call-1", "content": content}]
            return env[collect.name](messages)[0]
        self.assertEqual(collected(transformed), ["MEDIA:" + self.bridge.file["localPath"]])
        self.bridge.fail = "files.publish"
        self.assertEqual(collected(self.publish_image(payload)), [])

    async def test_outgoing_foreign_root_urls_and_noncanonical_uuid_not_fetched(self):
        text = "\n".join([self.markdown.replace(self.config.result_root, self.config.result_root + ".evil"), self.markdown.replace(self.config.result_root, "https://evil.test/files"),
                          self.markdown.replace(ARTIFACT, ARTIFACT.upper().replace("00000000", "AAAAAAAA", 1)),
                          "https://example.test/file.pdf", "[file](/local/file.pdf)"])
        self.assertIsNone(self.plugin.outgoing(text, platform="telegram"))
        self.assertEqual(self.bridge.calls, [])

    async def test_unchanged_long_reply_leaves_final_delivery_to_native_stream(self):
        text = "## Условия\n\n" + ("**Описание** с _выделением_.\n" * 400)
        self.assertIsNone(self.plugin.outgoing(text, platform="telegram", session_id="s", turn_id="t"))
        self.assertEqual(self.bridge.calls, [])

    async def test_raw_media_is_published_once_and_only_verified_copy_is_delivered(self):
        path = Path(self.config.result_root) / ARTIFACT / self.bridge.file["filename"]
        path.parent.mkdir(parents=True)
        path.write_bytes(b"pdf")
        self.bridge.file.update(localPath=str(path), markdown=f"[Отчёт](<{path}>)")
        raw = "/profile/usercustom/userdata/files/exports/report.pdf"
        message = f"Отчёт\nMEDIA:{raw}\nMEDIA:{raw}"
        text = self.plugin.outgoing(message, platform="telegram", session_id="s", turn_id="t")
        self.assertEqual(text.count("MEDIA:"), 1)
        self.assertNotIn(raw, text)
        self.assertIn(f'MEDIA:"{path}"', text)
        self.assertEqual(self.bridge.calls[0][0], "files.publish")
        first = self.bridge.calls[0][1]
        self.assertEqual(first["path"], raw)
        self.assertTrue(first["requestId"].startswith("tg-output:"))
        self.plugin.outgoing(message, platform="telegram", session_id="s", turn_id="t")
        self.assertEqual(first["requestId"], self.bridge.calls[-1][1]["requestId"])
        self.plugin.outgoing(message, platform="telegram", session_id="s", turn_id="t2")
        self.assertNotEqual(first["requestId"], self.bridge.calls[-1][1]["requestId"])

    async def test_raw_published_file_is_fetched_instead_of_published_again(self):
        path = Path(self.config.result_root) / ARTIFACT / "Файл [готов].pdf"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"pdf")
        self.bridge.file.update(localPath=str(path), filename=path.name)
        text = self.plugin.outgoing(f'MEDIA:"{path}"', platform="telegram")
        self.assertEqual(text.strip(), f'MEDIA:"{path}"')
        self.assertEqual([m for m, _ in self.bridge.calls], ["files.fetch"])

    async def test_raw_media_failure_hides_path_and_never_retries(self):
        self.bridge.fail = "files.publish"
        raw = "/profile/usercustom/userdata/files/exports/report.pdf"
        text = self.plugin.outgoing(f"MEDIA:{raw}", platform="telegram", session_id="s", turn_id="t")
        self.assertIn("не отправлен", text)
        self.assertNotIn(raw, text)
        self.assertNotIn("MEDIA:", text)
        self.assertEqual(len(self.bridge.calls), 1)

    async def test_media_examples_in_code_do_not_publish(self):
        text = '```text\nMEDIA:/profile/example.pdf\n```\n`MEDIA:"/profile/example.png"`'
        self.assertIsNone(self.plugin.outgoing(text, platform="telegram", session_id="s", turn_id="t"))
        self.assertEqual(self.bridge.calls, [])

    async def test_three_export_files_are_published_as_distinct_verified_copies(self):
        paths = ["/profile/exports/02-careers.png", "/profile/exports/03-pools.png", "/profile/exports/plan.pdf"]
        results = []
        for index, raw in enumerate(paths, 10):
            artifact = f"00000000-0000-4000-8000-{index:012d}"
            path = Path(self.config.result_root) / artifact / Path(raw).name
            path.parent.mkdir(parents=True)
            path.write_bytes(b"test")
            results.append({**self.bridge.file, "artifactId": artifact, "filename": path.name,
                            "localPath": str(path), "markdown": f"[Файл](<{path}>)"})
        def publish(method, params, timeout=15):
            self.bridge.calls.append((method, params))
            self.assertEqual(method, "files.publish")
            return results[paths.index(params["path"])]
        with patch.object(self.bridge, "call", side_effect=publish):
            text = self.plugin.outgoing("\n\n".join("MEDIA:" + path for path in paths),
                                        platform="telegram", session_id="s", turn_id="t")
        self.assertEqual(text.count("MEDIA:"), 3)
        self.assertEqual(len(self.bridge.calls), 3)
        for result in results:
            self.assertIn(f'MEDIA:"{result["localPath"]}"', text)
        self.assertNotIn("/profile/exports", text)

    async def test_outgoing_native_quoted_media_unicode_voice_and_dedup(self):
        path = Path(self.config.result_root) / ARTIFACT / "Голос сообщение.ogg"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"ogg")
        self.bridge.file.update(localPath=str(path), filename=path.name)
        self.markdown = f"[Голос](<{path}>)"
        text = self.plugin.outgoing(self.markdown + "\n" + self.markdown, platform="telegram")
        self.assertEqual(text.count("MEDIA:"), 1)
        self.assertIn(f'MEDIA:"{path}"', text)
        self.assertIn("[[audio_as_voice]]", text)
        self.assertEqual(len(self.bridge.calls), 1)

    async def test_outgoing_rejects_wrong_identity_symlinks_controls_and_missing_file(self):
        path = Path(self.tmp.name) / "ok.pdf"
        path.write_bytes(b"ok")
        link = path.with_name("link.pdf")
        link.symlink_to(path)
        for artifact, local in ((TARGET, str(path)), (ARTIFACT, str(link)),
                                (ARTIFACT, "/missing.pdf"), (ARTIFACT, str(path) + "\nMEDIA:/etc/passwd")):
            self.bridge.file.update(artifactId=artifact, localPath=local)
            text = self.plugin.outgoing(self.markdown, platform="telegram")
            self.assertNotIn("MEDIA:", text)
            self.assertIn("не отправлен", text)


class BridgeTests(unittest.TestCase):
    """Проверяет настоящий ограниченный stdio клиент с локальным Python child process."""

    def setUp(self):
        """Создать временный исполняемый RPC fixture."""
        self.tmp = tempfile.TemporaryDirectory(prefix="telegram-rpc-")
        self.entry = Path(self.tmp.name) / "rpc.py"
        self.config = mod.Config("123", Path(self.tmp.name), str(self.entry), sys.executable, ROOT)

    def tearDown(self):
        """Удалить только свой fixture."""
        self.tmp.cleanup()

    def run_bridge(self, code, timeout=2):
        """Исполнить fixture через настоящий Bridge без сети."""
        self.entry.write_text("import json,sys,time\nr=json.loads(sys.stdin.readline())\n" + code)
        return mod.Bridge(self.config).call("actions.read", {"moveId": MOVE}, timeout=timeout)

    def test_single_matching_rpc_response(self):
        self.assertEqual(self.run_bridge("print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'ok':True}}))"), {"ok": True})

    def test_wrong_id_version_result_error_and_extra_line_rejected(self):
        for value in ("{'jsonrpc':'2.0','id':'wrong','result':{}}", "{'jsonrpc':'1.0','id':r['id'],'result':{}}",
                      "{'jsonrpc':'2.0','id':r['id'],'result':{},'error':{}}", "{'jsonrpc':'2.0','id':r['id'],'result':[]}"):
            with self.assertRaises(mod.BridgeError):
                self.run_bridge(f"print(json.dumps({value}))")
        with self.assertRaises(mod.BridgeError):
            self.run_bridge("print('{}\\n{}')")

    def test_timeout_and_oversized_output_are_bounded(self):
        started = time.monotonic()
        with self.assertRaises(mod.BridgeError):
            self.run_bridge("time.sleep(20)", timeout=0.05)
        self.assertLess(time.monotonic() - started, 2)
        with self.assertRaises(mod.BridgeError):
            self.run_bridge("print('x'*2000000)")

    def test_rpc_error_never_exposes_raw_stderr_or_message(self):
        with self.assertRaises(mod.BridgeError) as result:
            self.run_bridge("print('secret',file=sys.stderr)\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'secret'}}))")
        self.assertNotIn("secret", str(result.exception))

    def test_only_allowlisted_substantive_output_error_crosses_rpc_boundary(self):
        response = "print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'secret','data':{'code':%r}}}))"
        with self.assertRaises(mod.BridgeError) as result:
            self.run_bridge(response % "HUMAN_OUTPUT_REQUIRED")
        self.assertEqual(str(result.exception), "HUMAN_OUTPUT_REQUIRED")
        with self.assertRaises(mod.BridgeError) as result:
            self.run_bridge(response % "UNTRUSTED_SECRET")
        self.assertEqual(str(result.exception), "RPC_REJECTED")

    def test_timeout_kills_private_descendant_process_group(self):
        marker = Path(self.tmp.name) / "orphan-marker"
        code = ("import subprocess\n"
                "subprocess.Popen([sys.executable,'-c'," + repr("import time,pathlib; time.sleep(0.4); pathlib.Path(" + repr(str(marker)) + ").write_text('orphan')") + "])\n"
                "time.sleep(20)")
        with self.assertRaises(mod.BridgeError):
            self.run_bridge(code, timeout=0.1)
        time.sleep(0.5)
        self.assertFalse(marker.exists())

    def test_shared_concurrency_slots_are_bounded(self):
        bridge = mod.Bridge(self.config)
        self.assertTrue(bridge.slots.acquire(False))
        self.assertTrue(bridge.slots.acquire(False))
        with self.assertRaises(mod.BridgeError):
            bridge.call("actions.read", {}, timeout=0.01)
        bridge.slots.release()
        bridge.slots.release()


class NativeContractTests(unittest.TestCase):
    """Проверяет API по закреплённому source без установки Hermes зависимостей."""

    def test_registration_matches_exact_public_api(self):
        upstream = REPO / "tmp/hermes-pinned-telegram"
        if not upstream.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        tree = ast.parse((upstream / "hermes_cli/plugins.py").read_text())
        methods = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        self.assertEqual([a.arg for a in methods["register_telegram_handler"].args.args], ["self", "factory"])
        self.assertIn("is_async", [a.arg for a in methods["register_tool"].args.args])
        self.assertIn("callback", [a.arg for a in methods["on_unload"].args.args])
        tree = ast.parse((upstream / "plugins/platforms/telegram/adapter.py").read_text())
        register = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_register_handlers")
        groups = [next((kw.value.value for kw in n.keywords if kw.arg == "group"), 0)
                  for n in ast.walk(register) if isinstance(n, ast.Call)
                  and isinstance(n.func, ast.Attribute) and n.func.attr == "add_handler"]
        self.assertTrue(groups)
        self.assertTrue(all(-100 < group for group in groups))
        calls = []
        ctx = NS(register_telegram_handler=lambda f: calls.append(("factory", f)),
                 register_hook=lambda name, f: calls.append((name, f)),
                 register_tool=lambda **kw: calls.append(("tool", kw)), on_unload=lambda f: calls.append(("unload", f)))
        with patch.object(mod.Config, "from_env", return_value=NS()), patch.object(mod, "TelegramPlugin") as plugin:
            mod.register(ctx)
            self.assertEqual([name for name, _ in calls], ["factory", "pre_gateway_dispatch", "transform_llm_output", "transform_tool_result", "post_llm_call", "post_tool_call", "on_session_end", "agent_loop_stopped", "tool", "tool", "tool", "unload"])
            self.assertTrue(calls[8][1]["is_async"])
            self.assertIs(calls[8][1]["handler"], plugin.return_value.request_confirmation)
            self.assertIn("Never invent IDs", calls[8][1]["schema"]["description"])
            self.assertIs(calls[9][1]["handler"], plugin.return_value.submit_feedback)
            self.assertIs(calls[10][1]["handler"], plugin.return_value.submit_result)
        manifest = (REPO / "services/hermes/telegram/plugin.yaml").read_text()
        for name in ("brai_telegram_request_confirmation", "brai_telegram_submit_feedback", "brai_telegram_submit_result",
                     "pre_gateway_dispatch", "transform_llm_output", "post_tool_call", "on_session_end", "agent_loop_stopped"):
            self.assertIn(name, manifest)
        inject = methods["inject_message"]
        self.assertEqual([a.arg for a in inject.args.args], ["self", "content", "role"])
        self.assertEqual([a.arg for a in inject.args.kwonlyargs], ["session_key", "origin"])

    def test_exact_public_injection_uses_internal_event_and_busy_native_fifo(self):
        upstream = REPO / "tmp/hermes-pinned-telegram"
        if not upstream.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        from contextlib import asynccontextmanager
        from types import MethodType
        def load_method(path, name, env):
            tree = ast.parse((upstream / path).read_text())
            node = next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)
            future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
            module = ast.fix_missing_locations(ast.Module(body=[future, node], type_ignores=[]))
            exec(compile(module, str(upstream / path), "exec"), env)
            return env[name]
        async def scenario():
            source = NS(platform=NS(value="telegram"), user_id="123", chat_id=GROUP, chat_type="group", thread_id="37")
            entry = NS(session_id="original-session", origin=source)
            human, key = NS(text="queued human message"), "native-session-key"
            state = NS(conversation=NS(queued_events=[]))
            adapter = NS(_pending_messages={key: human})
            async def lookup(_):
                return entry
            async def no_approval(*args):
                return False
            @asynccontextmanager
            async def scope(_):
                yield
            runner = NS(_running=True, _draining=False, _gateway_loop=asyncio.get_running_loop(),
                _background_tasks=set(), async_session_store=NS(lookup_by_session_key=lookup),
                _plugin_injection_accepting=lambda: True, _restored_source=lambda e: e.origin,
                _plugin_injection_authorized=lambda *args, **kw: True, _plugin_injection_scope=scope,
                _delivery_adapter_for=lambda _: adapter, _is_user_authorized_for_source=lambda _: True,
                _admit_bot_message_for_source=lambda _: True, _effective_busy_input_mode=lambda _: "interrupt",
                _route_plaintext_approval_while_busy=no_approval, _session_state=lambda _: state)
            logger = NS(info=lambda *a, **kw: None, warning=lambda *a, **kw: None)
            env = dict(asyncio=asyncio, logger=logger, MessageEvent=lambda **kw: NS(**kw), MessageType=NS(TEXT="text"))
            enqueue = load_method("gateway/run_busy.py", "_enqueue_fifo", env)
            runner._queue_or_replace_pending_event = lambda k, e: enqueue(runner, k, e, adapter)
            busy = load_method("gateway/run_busy.py", "_handle_active_session_busy_message", env)
            async def handle(event):
                await busy(runner, event, key)
            adapter.handle_message = handle
            dispatch = load_method("gateway/run_plugin_injection.py", "_dispatch_plugin_message_injection", env)
            runner._dispatch_plugin_message_injection = MethodType(dispatch, runner)
            schedule = load_method("gateway/run_plugin_injection.py", "_schedule_plugin_message_injection", env)
            injection = {}
            exec((upstream / "hermes_cli/plugins_injection.py").read_text(), injection)
            inject = load_method("hermes_cli/plugins.py", "inject_message", {})
            manager = NS(_cli_ref=None, has_tui_message_injector=False, has_gateway_message_injector=True,
                         inject_gateway_message=MethodType(schedule, runner))
            ctx = NS(_manager=manager, plugin_id="brai-telegram", _gateway_injection_allowed=lambda: True)
            modules = {"hermes_cli.plugins_injection": NS(inject_plugin_message=injection["inject_plugin_message"]),
                       "gateway.run": NS(_AGENT_PENDING_SENTINEL=object(), safe_schedule_threadsafe=None),
                       "gateway.session_identity": NS(replace_source=lambda s: NS(**vars(s)))}
            with patch.dict(sys.modules, modules):
                self.assertIs(inject(ctx, "/approve is ordinary text", session_key=key), True)
                await asyncio.gather(*tuple(runner._background_tasks))
            self.assertIs(adapter._pending_messages[key], human)
            self.assertEqual(len(state.conversation.queued_events), 1)
            event = state.conversation.queued_events[0]
            self.assertTrue(event.internal)
            self.assertFalse(event.allow_gateway_control)
            self.assertEqual(event.source.chat_id, GROUP)
            self.assertEqual(event.source.thread_id, "37")
            self.assertEqual(event.metadata["gateway_session_key"], key)
            self.assertEqual(event.metadata["gateway_session_id"], entry.session_id)
            self.assertIs(event.metadata["gateway_session_strict"], True)
        asyncio.run(scenario())

    def test_exact_native_media_parser_understands_quoted_unicode(self):
        source = REPO / "tmp/hermes-pinned-telegram/gateway/platforms/base.py"
        if not source.exists():
            self.skipTest("read-only pinned upstream fixture not present")
        tree = ast.parse(source.read_text())
        names = {"MEDIA_DELIVERY_EXTS", "_MEDIA_EXT_ALTERNATION", "_MEDIA_CJK_TERMINATORS", "MEDIA_TAG_CLEANUP_RE"}
        nodes = [n for n in tree.body if isinstance(n, (ast.Assign, ast.AnnAssign)) and
                 any(isinstance(x, ast.Name) and x.id in names for x in ast.walk(n))]
        nodes += [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_normalize_media_tag_path"]
        extract = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "extract_media")
        extract.decorator_list = []
        nodes.append(extract)
        env = {"re": re, "os": os, "_AUDIO_EXTS": {".ogg", ".opus"},
               "_mask_media_scan_text": lambda s: s, "_extensionless_media_matches": lambda s: [],
               "_deliverable_tag_spans": lambda s: []}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), env)
        paths, _ = env["extract_media"]('[[audio_as_voice]]\nMEDIA:"/tmp/Голос сообщение.ogg"\n')
        self.assertEqual(paths, [("/tmp/Голос сообщение.ogg", True)])


if __name__ == "__main__":
    unittest.main()
