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
        if method in {"actions.complete", "actions.cancel"}:
            self.action["attemptStatus"] = "completed" if method.endswith("complete") else "failed"
            return {"ok": True}
        return dict(self.file)


class FakeBot:
    """Проверяет, что native отправки идут только в loop приложения."""

    def __init__(self):
        """Запомнить текущий loop и отправленные сообщения."""
        self.loop = asyncio.get_running_loop()
        self.sent = []
        self.fail = False

    async def send_message(self, **kwargs):
        """Проверить loop; не выполнять Telegram запрос."""
        if asyncio.get_running_loop() is not self.loop:
            raise AssertionError("wrong native loop")
        if self.fail:
            raise RuntimeError("Telegram failed")
        self.sent.append(kwargs)
        return NS(message_id=len(self.sent))


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
    return {"telegram": telegram, "telegram.ext": ext}


class PluginTests(unittest.IsolatedAsyncioTestCase):
    """Проверяет авторизацию, publication и весь callback lifecycle."""

    async def asyncSetUp(self):
        """Поднять изолированные SQLite и native loop для каждого сценария."""
        self.tmp = tempfile.TemporaryDirectory(dir=REPO / "tmp", prefix="telegram-test-")
        self.config = mod.Config("123", Path(self.tmp.name) / "brai-telegram", "/test/trusted.mjs",
                                 "/usr/local/bin/node", str(Path(self.tmp.name) / "results"))
        self.bridge = FakeBridge()
        self.markdown = MARKDOWN.replace(ROOT, self.config.result_root)
        self.bridge.file["markdown"] = self.markdown
        self.plugin = mod.TelegramPlugin(self.config, self.bridge)
        self.bot = FakeBot()
        self.app = NS(bot=self.bot, handlers=[])
        def add_handler(handler, group=0):
            handler.group = group
            self.app.handlers.append(handler)
        self.app.add_handler = add_handler
        self.app.remove_handler = lambda h, group=0: self.app.handlers.remove(h)
        self.stubs = patch.dict(sys.modules, ptb_stubs())
        self.stubs.start()
        self.plugin.factory(self.app, object())

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
        self.plugin = mod.TelegramPlugin(self.config, self.bridge)
        self.plugin.factory(self.app, object())

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

    async def test_group_restart_keeps_pending_until_expiry_then_cancels_in_recorded_chat(self):
        await self.set_group_route()
        data = await self.request()
        token = data.split(":")[1]
        await self.set_group_route()
        self.assertEqual(self.plugin.tokens.pending()[0]["chat_id"], GROUP)
        self.assertFalse(any(method == "actions.cancel" for method, _ in self.bridge.calls))
        await asyncio.wait_for(self.plugin._expire(token, time.time() - 1), 1)
        self.assertEqual(self.plugin.tokens.pending(), [])
        self.assertEqual(self.bridge.calls[-1][0], "actions.cancel")
        self.assertEqual(self.bot.sent[-1]["chat_id"], int(GROUP))

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
        for value in (MOVE, TARGET, REVISION, "planning", "Проверить описанный план"):
            self.assertIn(value, text)
        for row in self.bot.sent[-1]["reply_markup"].inline_keyboard:
            self.assertLessEqual(len(row[0].callback_data.encode()), 64)

    async def test_model_cannot_pass_completion_or_decision(self):
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE,
                            "revisionId": REVISION, "decision": "approved"}))
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.calls, [])

    async def test_duplicate_tool_request_does_not_claim_or_cancel_active_prompt(self):
        await self.request()
        before = len(self.bridge.calls)
        result = json.loads(await self.plugin.request_confirmation({"moveId": MOVE, "revisionId": REVISION}))
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.bridge.calls), before)
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
        await asyncio.wait_for(self.plugin._expire(token, time.time() - 1), 1)
        self.assertEqual([method for method, _ in self.bridge.calls], ["actions.read"])
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_expiry_cleanup_rechecks_after_transient_cancel_failure(self):
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
            await asyncio.wait_for(self.plugin._expire(data.split(":")[1], time.time() - 1), 2)
        methods = [method for method, _ in self.bridge.calls]
        cancels = [i for i, method in enumerate(methods) if method == "actions.cancel"]
        self.assertEqual(len(cancels), 2)
        self.assertIn("actions.read", methods[cancels[0] + 1:cancels[1]])
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_final_success_changes_and_cancel_decisions(self):
        for stage, decision in (("final", "success"), ("review", "changes"), ("planning", "cancelled")):
            self.bridge.action["attemptStatus"] = "running"
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

    async def test_expiry_cancels_exact_attempt_and_restart_cleans_consumed(self):
        data = await self.request()
        token = data.split(":")[1]
        self.plugin.tokens.consume(token)
        await asyncio.wait_for(self.plugin._expire(token, time.time() - 1), 1)
        self.assertEqual(self.bridge.calls[-1], ("actions.cancel", {"moveId": MOVE,
            "attemptId": ATTEMPT, "revisionId": REVISION, "reason": "expired"}))
        self.assertEqual(self.plugin.tokens.pending(), [])

    async def test_expiry_does_not_cancel_new_attempt(self):
        data = await self.request()
        self.bridge.action["attemptId"] = TARGET
        await asyncio.wait_for(self.plugin._expire(data.split(":")[1], time.time() - 1), 1)
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
            self.assertEqual([name for name, _ in calls], ["factory", "pre_gateway_dispatch", "transform_llm_output", "tool", "unload"])
            self.assertTrue(calls[3][1]["is_async"])
            self.assertIs(calls[3][1]["handler"], plugin.return_value.request_confirmation)

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
