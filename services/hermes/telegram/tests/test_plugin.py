# ABOUTME: Проверяет границы native Telegram плагина без сети и сторонних пакетов.
# ABOUTME: Подменяет private Brai порт и PTB, сохраняя реальные SQLite и loop transitions.
import ast
import asyncio
from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace as NS
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
        if method == "actions.cancel":
            self.action["attemptStatus"] = "failed"
            return {"ok": True}
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
        self.tmp = tempfile.TemporaryDirectory(dir=REPO / "tmp", prefix="telegram-test-")
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
                        if key == self.native_context["HERMES_SESSION_KEY"] else None)
        self.markdown = MARKDOWN.replace(ROOT, self.config.result_root)
        self.bridge.file["markdown"] = self.markdown
        self.plugin = mod.TelegramPlugin(self.config, self.bridge, self.inject)
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
        self.plugin.factory(self.app, object())
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

    async def set_group_route(self, chat=GROUP):
        """Перезапустить только плагин с прежним SQLite и новым защищённым route."""
        self.plugin.close()
        await asyncio.sleep(0)
        await asyncio.gather(*tuple(self.plugin.tasks), return_exceptions=True)
        self.config = replace(self.config, chat_id=chat)
        self.native_context.update(HERMES_SESSION_CHAT_ID=chat, HERMES_SESSION_CHAT_TYPE="supergroup")
        self.entry.origin.chat_id, self.entry.origin.chat_type = chat, "supergroup"
        self.plugin = mod.TelegramPlugin(self.config, self.bridge, self.inject)
        self.plugin.factory(self.app, object())
        self.plugin.session_store = self.store

    def update(self, chat=GROUP, owner=123, chat_type="supergroup", **message):
        """Создать native update с отдельными sender, chat и effective message."""
        return NS(effective_chat=NS(id=int(chat), type=chat_type), effective_user=NS(id=owner),
                  effective_message=NS(**message))

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
                  self.update(chat="123", chat_type="private"), self.update(sender_chat=NS(id=int(GROUP))),
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
        data = await self.request()
        await self.set_group_route()
        query = FakeQuery(data, chat=int(GROUP), chat_type="supergroup")
        await self.plugin.callback(NS(callback_query=query), None)
        for _ in range(100):
            if not self.plugin.tokens.pending():
                break
            await asyncio.sleep(0.005)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertFalse(any(method == "actions.complete" for method, _ in self.bridge.calls))
        self.assertTrue(any(method == "actions.cancel" for method, _ in self.bridge.calls))
        self.assertEqual(self.bot.sent[-1]["chat_id"], 123)

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

    async def test_publication_failure_or_limit_drops_event_and_notifies_owner(self):
        self.bridge.fail = "files.publish"
        result = await self.plugin.incoming(self.event(media_urls=["/file.pdf"]))
        self.assertEqual(result["action"], "skip")
        self.assertIn("не принято", self.bot.sent[-1]["text"])
        result = await self.plugin.incoming(self.event(media_urls=["/file.pdf"] * 11))
        self.assertEqual(result["action"], "skip")
        self.assertEqual(len(self.bridge.calls), 1)

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
        self.assertIn(preview, text)
        self.assertNotIn(MOVE, text)
        for message in self.bot.sent:
            self.assertLessEqual(len(message['text'].encode('utf-16-le')) // 2, 4096)
        self.assertTrue(all('reply_markup' not in item for item in self.bot.sent[:-1]))
        keyboard = self.bot.sent[-1]['reply_markup'].inline_keyboard
        self.assertEqual([row[0].text for row in keyboard], ['Принять', 'Нужны изменения', 'Отменить'])
        self.assertEqual(self.plugin.tokens.pending()[0]['message_id'], str(len(self.bot.sent)))

    async def test_missing_reviewable_result_does_not_send_blind_approval_buttons(self):
        self.bridge.action.update(confirmationStage='final', confirmationText=None)
        result = json.loads(await self.plugin.request_confirmation({'moveId': MOVE, 'revisionId': REVISION}))
        self.assertFalse(result['ok'])
        self.assertEqual(self.bot.sent, [])
        self.assertTrue(any(method == 'actions.cancel' for method, _ in self.bridge.calls))

    async def test_integrated_stage_is_persisted_before_ui_and_changes_resumes_review(self):
        for stage, choice in (("planning", "approved"), ("final", "success")):
            for decision in (choice, "changes"):
                self.bridge.action.update(status="claimed", attemptStatus="running", confirmationStage=stage)
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
        self.plugin.factory(self.app, object())
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
        for stage, decision in (("final", "success"), ("review", "changes"), ("planning", "cancelled")):
            self.bridge.action.update(status="claimed", attemptStatus="running")
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
        self.plugin.factory(self.app, object())
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

    async def test_changes_resumes_discussion_but_cancel_never_injects(self):
        for decision in ("changes", "cancelled"):
            self.bridge.action.update(status="claimed", attemptStatus="running")
            data = await self.request()
            data = data.rsplit(":", 1)[0] + ":" + decision
            await self.plugin.callback(NS(callback_query=FakeQuery(data, message_id=len(self.bot.sent))), None)
        self.assertEqual(len(self.injections), 1)
        self.assertIn('"decision": "changes"', self.injections[0][0])
        self.assertIn("Не выполняй подтверждаемый этап", self.injections[0][0])
        self.assertIn("Запрос отменён", self.bot.sent[-1]["text"])

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
        self.plugin.factory(self.app, object())
        await asyncio.sleep(0.01)
        self.assertEqual(len(self.injections), 1)
        self.assertEqual(self.bridge.calls, calls)
        self.assertIn("исход автоматического продолжения не подтверждён", self.bot.sent[-1]["text"])
        self.plugin.factory(self.app, object())
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
        self.plugin.factory(self.app, object())
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
        self.plugin.factory(self.app, object())
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
        self.assertEqual(self.plugin.outgoing(text, platform="telegram"), text)
        self.assertEqual(self.bridge.calls, [])

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
        self.tmp = tempfile.TemporaryDirectory(dir=REPO / "tmp", prefix="telegram-rpc-")
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
            self.assertEqual([name for name, _ in calls], ["factory", "pre_gateway_dispatch", "transform_llm_output", "transform_tool_result", "post_llm_call", "tool", "unload"])
            self.assertTrue(calls[5][1]["is_async"])
            self.assertIs(calls[5][1]["handler"], plugin.return_value.request_confirmation)
            self.assertIn("Never invent IDs", calls[5][1]["schema"]["description"])
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
