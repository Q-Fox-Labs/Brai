# ABOUTME: Связывает штатный Telegram gateway Hermes с private портом Brai.
# ABOUTME: Проверяет владельца и одноразовые подтверждения, не запускает отдельный бот.
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import sqlite3
import stat
import subprocess
import threading
import time


UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
MAX_ATTACHMENTS = 10
TOKEN_TTL = 900
RPC_TIMEOUT = 15
OUTPUT_TIMEOUT = 20
FAILURE = "Операция Brai не подтверждена. Проверьте состояние и явно запросите новую кнопку."


class BridgeError(Exception):
    """Обозначает безопасную ошибку private порта без входных данных и stderr."""


@dataclass(frozen=True)
class Config:
    """Содержит только переданные оператором параметры доверенного профиля."""

    owner: str
    state_dir: Path
    entry: str
    node: str
    result_root: str

    @classmethod
    def from_env(cls):
        """Проверить обязательные параметры; секреты остаются в окружении child process."""
        owner = os.environ.get("BRAI_TELEGRAM_OWNER_ID", "")
        state = Path(os.environ.get("BRAI_TELEGRAM_STATE_DIR", ""))
        entry = os.environ.get("BRAI_HERMES_TRUSTED_ENTRY", "")
        node = os.environ.get("BRAI_HERMES_NODE_EXECUTABLE", "")
        root = os.environ.get("BRAI_TELEGRAM_RESULT_ROOT", "")
        if (not re.fullmatch(r"[1-9][0-9]*", owner) or not state.is_absolute()
                or state.name != "brai-telegram" or not Path(entry).is_absolute()
                or Path(entry).name != "trusted.mjs" or not Path(node).is_absolute()
                or not Path(root).is_absolute() or str(Path(root)) != root
                or re.search(r"[\\<>?#%\x00-\x1f\x7f]", root)):
            raise ValueError("BRAI_TELEGRAM_CONFIG_INVALID")
        return cls(owner, state, entry, node, root)


class Bridge:
    """Вызывает ровно один JSON-RPC запрос в отдельном процессе без повторов."""

    def __init__(self, config):
        """Сохранить путь запуска из защищённой конфигурации."""
        self.config = config
        self.slots = threading.BoundedSemaphore(2)

    def call(self, method, params, timeout=RPC_TIMEOUT):
        """Вернуть object result; ограничить ожидание, stdout и размер запроса."""
        started = time.monotonic()
        if timeout <= 0 or not self.slots.acquire(timeout=timeout):
            raise BridgeError("RPC_OVERLOADED")
        try:
            return self._call(method, params, timeout - (time.monotonic() - started))
        finally:
            self.slots.release()

    def _call(self, method, params, timeout):
        request_id = secrets.token_hex(16)
        request = (json.dumps({"jsonrpc": "2.0", "id": request_id,
                               "method": method, "params": params}, ensure_ascii=False) + "\n").encode()
        if len(request) > 65_536 or timeout <= 0:
            raise BridgeError("RPC_LIMIT")
        process = None
        try:
            process = subprocess.Popen([self.config.node, self.config.entry], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            deadline, output, sent = time.monotonic() + timeout, bytearray(), 0
            with selectors.DefaultSelector() as selector:
                for stream, mode in ((process.stdin, selectors.EVENT_WRITE),
                                     (process.stdout, selectors.EVENT_READ)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, mode)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise BridgeError("RPC_TIMEOUT")
                    for key, _ in selector.select(remaining):
                        if key.fileobj is process.stdin:
                            sent += os.write(process.stdin.fileno(), request[sent:])
                            if sent == len(request):
                                selector.unregister(process.stdin)
                                process.stdin.close()
                        else:
                            chunk = os.read(process.stdout.fileno(), 65_536)
                            if not chunk:
                                selector.unregister(process.stdout)
                            else:
                                output.extend(chunk)
                                if len(output) > 1_048_576:
                                    raise BridgeError("RPC_LIMIT")
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
            if process.returncode != 0:
                raise BridgeError("RPC_FAILED")
            lines = output.decode("utf-8", errors="strict").splitlines()
            if len(lines) != 1 or not output.endswith(b"\n"):
                raise BridgeError("RPC_MALFORMED")
            response = json.loads(lines[0])
            if (not isinstance(response, dict) or response.get("jsonrpc") != "2.0"
                    or response.get("id") != request_id
                    or ("result" in response) == ("error" in response)
                    or set(response) - {"jsonrpc", "id", "result", "error"}):
                raise BridgeError("RPC_MALFORMED")
            if "error" in response:
                error = response["error"]
                if (not isinstance(error, dict) or type(error.get("code")) is not int
                        or not isinstance(error.get("message"), str)):
                    raise BridgeError("RPC_MALFORMED")
                raise BridgeError("RPC_REJECTED")
            if not isinstance(response["result"], dict):
                raise BridgeError("RPC_MALFORMED")
            return response["result"]
        except BridgeError:
            raise
        except Exception:
            raise BridgeError("RPC_FAILED") from None
        finally:
            if process:
                # AIDEV-NOTE: Private Node запускает publisher child; timeout завершает всю свою группу.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                for stream in (process.stdin, process.stdout):
                    if stream and not stream.closed:
                        stream.close()


class Tokens:
    """Хранит одноразовые owner/message/attempt привязки между перезапусками."""

    def __init__(self, directory):
        """Создать private SQLite, не используя БД соседнего компонента."""
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "confirmations.sqlite3"
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY, owner TEXT NOT NULL, move_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL, revision_id TEXT NOT NULL, stage TEXT NOT NULL,
                expires REAL NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, message_id TEXT,
                resolved INTEGER NOT NULL DEFAULT 0)""")
        self.path.chmod(0o600)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, owner, action, stage):
        """Сохранить токен до отправки кнопок; не более 100 ожидающих подтверждений."""
        token = secrets.token_urlsafe(24)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT count(*) FROM tokens WHERE resolved=0").fetchone()[0] >= 100:
                raise BridgeError("CONFIRMATION_LIMIT")
            if db.execute("SELECT 1 FROM tokens WHERE move_id=? AND resolved=0", (action["moveId"],)).fetchone():
                raise BridgeError("CONFIRMATION_PENDING")
            db.execute("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,0,NULL,0)",
                       (token, owner, action["moveId"], action["attemptId"],
                        action["revisionId"], stage, time.time() + TOKEN_TTL))
        return token

    def bind(self, token, message_id):
        """Привязать токен к реально отправленному сообщению бота."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET message_id=? WHERE token=? AND consumed=0",
                       (str(message_id), token))

    def set_attempt(self, token, attempt_id):
        """Сохранить результат idempotent prepare перед отправкой кнопки."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET attempt_id=? WHERE token=? AND resolved=0", (attempt_id, token))

    def consume(self, token, owner=None, message_id=None):
        """Атомарно погасить токен перед внешним эффектом; чужой message не погашает его."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM tokens WHERE token=? AND consumed=0", (token,)).fetchone()
            if row is None or (owner is not None and
                               (row["owner"] != owner or row["message_id"] != str(message_id))):
                return None
            db.execute("UPDATE tokens SET consumed=1 WHERE token=?", (token,))
            return dict(row)

    def pending(self):
        """Вернуть незавершённые записи, включая consumed до crash/неопределённого RPC."""
        with self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM tokens WHERE resolved=0")]

    def unresolved(self, token):
        """Прочитать запись для безопасной отмены; повтор approval запрещён."""
        with self._connect() as db:
            row = db.execute("SELECT * FROM tokens WHERE token=? AND resolved=0", (token,)).fetchone()
            return dict(row) if row else None

    def resolve(self, token):
        """Зафиксировать подтверждённое завершение или отмену попытки."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET resolved=1 WHERE token=?", (token,))


def _platform(value):
    return getattr(value, "value", value)


def _uuid(value):
    return isinstance(value, str) and re.fullmatch(UUID, value) is not None


class TelegramPlugin:
    """Собирает native hooks, private RPC и локальное состояние подтверждений."""

    def __init__(self, config, bridge=None):
        """Создать порт и хранилище; сеть Telegram подключает только native factory."""
        self.config = config
        self.bridge = bridge or Bridge(config)
        self.tokens = Tokens(config.state_dir)
        self.loop = self.bot = None
        self.tasks = set()
        self.expiry_tasks = {}
        self.handlers = []
        self.closed = False
        self.active_callbacks = set()
        self.descriptor = re.compile(
            r"!?\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(<" + re.escape(config.result_root.rstrip("/")) + r"/(?P<id>" + UUID
            + r")/(?P<name>[^<>/\r\n]+)>\)")

    def factory(self, app, adapter):
        """Зарегистрировать scoped PTB callback и запомнить loop без изменения adapter."""
        from telegram.ext import CallbackQueryHandler
        for task in self.tasks:
            task.cancel()
        self.loop, self.bot = asyncio.get_running_loop(), app.bot
        handler = CallbackQueryHandler(self.callback, pattern=r"^brai:")
        app.add_handler(handler)
        self.handlers.append((app, handler))
        for row in self.tokens.pending():
            recover_now = row["consumed"] or not row["attempt_id"] or row["message_id"] is None
            self._schedule_expiry(row["token"], time.time() if recover_now else row["expires"])

    def close(self):
        """Убрать только свои handlers/tasks при native unload; SQLite сохраняет recovery."""
        self.closed = True

        def cleanup():
            for task in tuple(self.tasks):
                task.cancel()
            for app, handler in self.handlers:
                app.remove_handler(handler)
            self.handlers.clear()

        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(cleanup)

    def _schedule_expiry(self, token, expires):
        previous = self.expiry_tasks.get(token)
        if previous:
            previous.cancel()
        task = self.loop.create_task(self._expire(token, expires))
        self.tasks.add(task)
        self.expiry_tasks[token] = task

        def finished(done):
            self.tasks.discard(done)
            if self.expiry_tasks.get(token) is done:
                self.expiry_tasks.pop(token, None)

        task.add_done_callback(finished)

    async def _on_native_loop(self, coroutine):
        if self.closed or self.loop is None or not self.loop.is_running():
            coroutine.close()
            raise BridgeError("TELEGRAM_UNAVAILABLE")
        if asyncio.get_running_loop() is self.loop:
            return await coroutine
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return await asyncio.wrap_future(future)

    async def _notify(self, text):
        if self.bot is None:
            raise BridgeError("TELEGRAM_UNAVAILABLE")
        await self.bot.send_message(chat_id=int(self.config.owner), text=text,
                                    connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)

    async def incoming(self, event, **kwargs):
        """Отсекать чужие Telegram события до auth и публиковать вложения владельца."""
        source = getattr(event, "source", None)
        if _platform(getattr(source, "platform", None)) != "telegram":
            return None
        raw = getattr(event, "raw_message", None)
        if (getattr(source, "chat_type", None) != "dm"
                or str(getattr(source, "user_id", "")) != self.config.owner
                or str(getattr(source, "chat_id", "")) != self.config.owner
                or getattr(raw, "business_connection_id", None)):
            return {"action": "skip", "reason": "brai-owner-private-only"}
        paths = getattr(event, "media_urls", [])
        if not paths:
            return None
        try:
            if len(paths) > MAX_ATTACHMENTS or not re.fullmatch(r"[1-9][0-9]*", str(event.message_id)):
                raise BridgeError("ATTACHMENT_LIMIT")
            descriptors = []
            for index, path in enumerate(paths):
                result = await asyncio.to_thread(self.bridge.call, "files.publish", {
                    "path": path, "requestId": f"tg:{self.config.owner}:{event.message_id}:{index}"})
                if not _uuid(result.get("artifactId")) or not isinstance(result.get("markdown"), str):
                    raise BridgeError("RPC_MALFORMED")
                match = self.descriptor.fullmatch(result["markdown"])
                if not match or match["id"] != result["artifactId"]:
                    raise BridgeError("RPC_MALFORMED")
                descriptors.append(result["markdown"])
            return {"action": "rewrite", "text": "\n\n".join([event.text or "", *descriptors]).strip()}
        except Exception:
            try:
                await self._on_native_loop(self._notify("Вложение не принято Brai. Повторите отправку файла."))
            except Exception:
                pass
            return {"action": "skip", "reason": "brai-file-publication-failed"}

    def outgoing(self, response_text, platform=None, **kwargs):
        """Заменять только точные publisher descriptors native MEDIA; не скачивать URL."""
        if _platform(platform) != "telegram":
            return None
        deadline, seen, count = time.monotonic() + OUTPUT_TIMEOUT, set(), 0

        def replace(match):
            nonlocal count
            artifact_id = match["id"]
            if artifact_id in seen:
                return ""
            seen.add(artifact_id)
            count += 1
            try:
                if count > MAX_ATTACHMENTS:
                    raise BridgeError("ATTACHMENT_LIMIT")
                result = self.bridge.call("files.fetch", {"artifactId": artifact_id},
                                          timeout=min(RPC_TIMEOUT, deadline - time.monotonic()))
                path = result.get("localPath")
                filename = result.get("filename")
                if (result.get("artifactId") != artifact_id or not isinstance(path, str)
                        or not isinstance(filename, str) or not filename or Path(filename).name != filename
                        or filename in {".", ".."} or filename != match["name"]
                        or path != str(Path(self.config.result_root) / artifact_id / filename)
                        or Path(path).resolve() != Path(path)
                        or type(result.get("sizeBytes")) is not int or not 0 <= result["sizeBytes"] <= 2 * 1024**3
                        or not isinstance(result.get("mimeType"), str)
                        or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("sha256", "")))
                        or not Path(path).is_absolute() or any(ord(c) < 32 for c in path)
                        or any(c in path for c in '\\"`') or "MEDIA:" in path
                        or not stat.S_ISREG(os.stat(path, follow_symlinks=False).st_mode)):
                    raise BridgeError("RPC_MALFORMED")
                # AIDEV-NOTE: Штатный parser принимает quoted paths с пробелами и Unicode.
                voice = "[[audio_as_voice]]\n" if Path(path).suffix.lower() in {".ogg", ".opus"} else ""
                return f'\n{voice}MEDIA:"{path}"\n'
            except Exception:
                return "[Файл не отправлен: Brai не подтвердил доступ к артефакту.]"

        return self.descriptor.sub(replace, response_text)

    async def request_confirmation(self, args, **kwargs):
        """Дать модели только отправку кнопок; завершение доступно только callback handler."""
        try:
            if (not isinstance(args, dict) or set(args) - {"moveId", "revisionId", "stage"}
                    or not _uuid(args.get("moveId")) or not _uuid(args.get("revisionId"))
                    or args.get("stage", "planning") not in {"planning", "final", "review"}):
                raise BridgeError("INVALID_ARGUMENT")
            return await self._on_native_loop(self._request(args))
        except Exception:
            return json.dumps({"ok": False, "message": FAILURE}, ensure_ascii=False)

    async def _request(self, args):
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        stage = args.get("stage", "planning")
        # AIDEV-NOTE: Reservation до prepare закрывает crash между backend claim и SQLite записью.
        token = self.tokens.create(self.config.owner, {**args, "attemptId": ""}, stage)
        self._schedule_expiry(token, time.time() + TOKEN_TTL)
        try:
            action = await self._prepare(self.tokens.unresolved(token))
            if not await self._current(self.tokens.unresolved(token)):
                raise BridgeError("STALE_ACTION")
            decision = "success" if stage == "final" else "approved"
            buttons = [[InlineKeyboardButton(label, callback_data=f"brai:{token}:{choice}")]
                       for label, choice in (("Принять", decision), ("Нужны изменения", "changes"),
                                             ("Отменить", "cancelled"))]
            context = str(action.get("targetDescription") or "")[:1400]
            title = str(action.get("targetTitle") or "")[:400]
            text = (f"Подтверждение Brai: {action['title'][:800]}\n{title}\n{context}\nЭтап: {stage}\n"
                    f"Action: {action['moveId']}\nОбъект: {action['targetId']}\n"
                    f"Ревизия: {action['revisionId']}\nСрок: 15 минут.")
            message = await self.bot.send_message(chat_id=int(self.config.owner), text=text,
                reply_markup=InlineKeyboardMarkup(buttons), connect_timeout=5, read_timeout=10,
                write_timeout=10, pool_timeout=5)
            self.tokens.bind(token, message.message_id)
            return json.dumps({"ok": True, "status": "awaiting_owner", "moveId": action["moveId"],
                               "attemptId": action["attemptId"], "revisionId": action["revisionId"]})
        except Exception:
            self.tokens.consume(token)
            try:
                await self._cleanup(self.tokens.unresolved(token), "cancelled")
                self.tokens.resolve(token)
            except Exception:
                pass  # Native expiry/restart recovery проверит состояние перед новой отменой.
            raise BridgeError("SEND_UNCONFIRMED") from None

    async def _prepare(self, row):
        action = await asyncio.to_thread(self.bridge.call, "actions.prepare", {
            "moveId": row["move_id"], "revisionId": row["revision_id"], "idempotencyKey": row["token"]})
        if (action.get("moveId") != row["move_id"] or action.get("revisionId") != row["revision_id"]
                or not _uuid(action.get("attemptId")) or not _uuid(action.get("targetId"))
                or not isinstance(action.get("title"), str) or action.get("status") != "running"):
            raise BridgeError("RPC_MALFORMED")
        self.tokens.set_attempt(row["token"], action["attemptId"])
        return action

    async def _current(self, row):
        action = await asyncio.to_thread(self.bridge.call, "actions.read", {"moveId": row["move_id"]})
        return (action.get("moveId") == row["move_id"] and action.get("attemptId") == row["attempt_id"]
                and action.get("revisionId") == row["revision_id"] and action.get("status") == "claimed"
                and action.get("attemptStatus") == "running" and action.get("attemptExecutorKind") == "human")

    async def _cancel(self, row, reason):
        action = await asyncio.to_thread(self.bridge.call, "actions.read", {"moveId": row["move_id"]})
        if (action.get("attemptId") != row["attempt_id"] or action.get("attemptStatus") != "running"
                or action.get("attemptExecutorKind") != "human"):
            return False
        await asyncio.to_thread(self.bridge.call, "actions.cancel", {"moveId": row["move_id"],
            "attemptId": row["attempt_id"], "revisionId": row["revision_id"], "reason": reason})
        return True

    async def _cleanup(self, row, reason):
        if not row["attempt_id"]:
            # Только SAME-key prepare может восстановить неизвестный claim; approval не повторяется.
            current = await asyncio.to_thread(self.bridge.call, "actions.read", {"moveId": row["move_id"]})
            if current.get("status") != "claimed":
                return False
            await self._prepare(row)
            row = self.tokens.unresolved(row["token"])
        return await self._cancel(row, reason)

    async def _expire(self, token, expires):
        await asyncio.sleep(max(0, expires - time.time()))
        while token in self.active_callbacks:
            await asyncio.sleep(0.1)
        warned = False
        while not self.closed:
            row = self.tokens.consume(token) or self.tokens.unresolved(token)
            if row is None:
                return
            try:
                cancelled = await self._cleanup(row, "expired")
                self.tokens.resolve(token)
                notice = ("Срок кнопки Brai истёк; попытка отменена. Запросите новую кнопку." if cancelled
                          else "Кнопка Brai больше не активна. Состояние Action уже изменилось.")
                await self._notify(notice)
                return
            except Exception:
                if not warned:
                    try:
                        await self._notify("Кнопка Brai неактивна; отмена попытки не подтверждена. Проверьте Action.")
                    except Exception:
                        pass
                    warned = True
                # Повтор cleanup всегда начинает с чтения exact attempt, не повторяет complete.
                await asyncio.sleep(60)

    async def callback(self, update, context):
        """Принять только private callback владельца от точного сообщения, погасив token до RPC."""
        query = getattr(update, "callback_query", None)
        message = getattr(query, "message", None)
        chat = getattr(message, "chat", None)
        if (self.closed or query is None or getattr(chat, "type", None) != "private"
                or str(getattr(chat, "id", "")) != self.config.owner
                or str(getattr(getattr(query, "from_user", None), "id", "")) != self.config.owner
                or getattr(message, "business_connection_id", None)):
            return
        data = getattr(query, "data", "")
        match = re.fullmatch(r"brai:([A-Za-z0-9_-]{32}):(approved|success|changes|cancelled)", data or "")
        if not match or len(data.encode("utf-8")) > 64:
            await query.answer("Кнопка недействительна.", show_alert=True)
            return
        row = self.tokens.consume(match[1], self.config.owner, getattr(message, "message_id", None))
        if row is None:
            await query.answer("Кнопка уже использована или не относится к сообщению.", show_alert=True)
            return
        decision = match[2]
        self.active_callbacks.add(match[1])
        allowed = {"success", "changes", "cancelled"} if row["stage"] == "final" else {"approved", "changes", "cancelled"}
        notice = FAILURE
        try:
            await query.answer("Проверяю подтверждение…")
            if decision not in allowed:
                raise BridgeError("INVALID_DECISION")
            if row["expires"] <= time.time():
                await self._cancel(row, "expired")
                self.tokens.resolve(match[1])
                notice = "Срок подтверждения истёк. Запросите новую кнопку."
            elif not await self._current(row):
                await self._cancel(row, "cancelled")
                self.tokens.resolve(match[1])
                notice = "Action или ревизия изменились. Запросите новую кнопку."
            elif decision == "cancelled":
                await self._cancel(row, "cancelled")
                self.tokens.resolve(match[1])
                notice = "Попытка отменена."
            else:
                await asyncio.to_thread(self.bridge.call, "actions.complete", {
                    "moveId": row["move_id"], "attemptId": row["attempt_id"],
                    "revisionId": row["revision_id"], "stage": row["stage"], "decision": decision})
                self.tokens.resolve(match[1])
                notice = "Результат подтверждён Brai." if decision != "changes" else "Изменения запрошены в Brai."
        except Exception:
            pass
        finally:
            self.active_callbacks.discard(match[1])
            if not self.closed and self.tokens.unresolved(match[1]):
                self._schedule_expiry(match[1], time.time())
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass
        await self._notify(notice)


def register(ctx):
    """Подключить плагин через публичный API закреплённого Hermes."""
    plugin = TelegramPlugin(Config.from_env())
    ctx.register_telegram_handler(plugin.factory)
    ctx.register_hook("pre_gateway_dispatch", plugin.incoming)
    ctx.register_hook("transform_llm_output", plugin.outgoing)
    ctx.register_tool(name="brai_telegram_request_confirmation", toolset="brai_telegram",
        description="Ask the owner to confirm a human Action in their private Telegram chat.",
        schema={"name": "brai_telegram_request_confirmation", "description": "Send owner confirmation buttons; never completes an Action.",
                "parameters": {"type": "object", "properties": {"moveId": {"type": "string"},
                    "revisionId": {"type": "string"}, "stage": {"type": "string", "enum": ["planning", "final", "review"]}},
                    "required": ["moveId", "revisionId"], "additionalProperties": False}},
        handler=plugin.request_confirmation, is_async=True)
    ctx.on_unload(plugin.close)
