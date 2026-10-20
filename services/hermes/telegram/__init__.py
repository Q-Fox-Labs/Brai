# ABOUTME: Связывает штатный Telegram gateway Hermes с private портом Brai.
# ABOUTME: Проверяет владельца и одноразовые подтверждения, не запускает отдельный бот.
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from contextlib import contextmanager
from hashlib import sha256
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
RPC_TIMEOUT = 15
OUTPUT_TIMEOUT = 20
HUMAN_OUTPUT_REQUIRED = "Для этого действия нужны настоящие результаты работы человека. Кнопка решения их не создаёт; сначала выполните работу и сохраните её результаты штатным способом."
FAILURE = "Операция Brai не подтверждена. Проверьте состояние и явно запросите новую кнопку."
CONFIRMATION_DESCRIPTION = (
    "Ask the owner to confirm a human Action in the configured Telegram chat. First create "
    "the Element and Action with the available game-core structure/create tools, or use existing ones. "
    "Call elements_request_human_action for the real moveId; pass its returned moveId and revisionId here. "
    "Never invent IDs or pass placeholder UUIDs. For integrated plans this tool accepts only decision-only confirm/final Actions with one output; human work requiring substantive results is rejected before claim. The real Action determines its stage. The tool sends the saved plan/result with buttons itself. Do not send a separate copy. After ok=true, finish with NO_REPLY; after failure, explain it. A verified owner decision automatically resumes this session."
)


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
    chat_id: str = ""

    @property
    def chat(self):
        """Вернуть отдельный маршрут либо прежний личный чат владельца."""
        return self.chat_id or self.owner

    @classmethod
    def from_env(cls):
        """Проверить обязательные параметры; секреты остаются в окружении child process."""
        owner = os.environ.get("BRAI_TELEGRAM_OWNER_ID", "")
        chat = os.environ.get("BRAI_TELEGRAM_CHAT_ID", "")
        state = Path(os.environ.get("BRAI_TELEGRAM_STATE_DIR", ""))
        entry = os.environ.get("BRAI_HERMES_TRUSTED_ENTRY", "")
        node = os.environ.get("BRAI_HERMES_NODE_EXECUTABLE", "")
        root = os.environ.get("BRAI_TELEGRAM_RESULT_ROOT", "")
        if (not re.fullmatch(r"[1-9][0-9]*", owner)
                or (chat and not re.fullmatch(r"-?[1-9][0-9]*", chat))
                or (chat and not chat.startswith("-") and chat != owner) or not state.is_absolute()
                or state.name != "brai-telegram" or not Path(entry).is_absolute()
                or Path(entry).name != "trusted.mjs" or not Path(node).is_absolute()
                or not Path(root).is_absolute() or str(Path(root)) != root
                or re.search(r"[\\<>?#%\x00-\x1f\x7f]", root)):
            raise ValueError("BRAI_TELEGRAM_CONFIG_INVALID")
        return cls(owner, state, entry, node, root, chat)


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
                if error["code"] == -32000 and isinstance(error.get("data"), dict) and error["data"].get("code") == "HUMAN_OUTPUT_REQUIRED":
                    raise BridgeError("HUMAN_OUTPUT_REQUIRED")
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
    """Хранит одноразовые owner/chat/message/attempt привязки между перезапусками."""

    def __init__(self, directory):
        """Создать private SQLite, не используя БД соседнего компонента."""
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "confirmations.sqlite3"
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY, owner TEXT NOT NULL, move_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL, revision_id TEXT NOT NULL, stage TEXT NOT NULL,
                consumed INTEGER NOT NULL DEFAULT 0, message_id TEXT,
                resolved INTEGER NOT NULL DEFAULT 0)""")
            columns = {row[1] for row in db.execute("PRAGMA table_info(tokens)")}
            if "expires" in columns:
                db.execute("ALTER TABLE tokens DROP COLUMN expires")
            if "chat_id" not in columns:
                # AIDEV-NOTE: Прежние кнопки могли принадлежать только личному чату owner.
                db.execute("ALTER TABLE tokens ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''")
                db.execute("UPDATE tokens SET chat_id=owner")
            for name in ("session_key", "session_id", "thread_id", "target_id", "decision", "resume_outcome"):
                if name not in columns:
                    db.execute(f"ALTER TABLE tokens ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
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

    def create(self, owner, action, stage, chat_id=None, context=None):
        """Сохранить токен до отправки кнопок; не более 100 ожидающих подтверждений."""
        token = secrets.token_urlsafe(24)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT count(*) FROM tokens WHERE resolved=0").fetchone()[0] >= 100:
                raise BridgeError("CONFIRMATION_LIMIT")
            if db.execute("SELECT 1 FROM tokens WHERE move_id=? AND resolved=0", (action["moveId"],)).fetchone():
                raise BridgeError("CONFIRMATION_PENDING")
            context = context or {}
            db.execute("""INSERT INTO tokens
                       (token,owner,move_id,attempt_id,revision_id,stage,chat_id,session_key,session_id,thread_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                       (token, owner, action["moveId"], action["attemptId"],
                        action["revisionId"], stage, chat_id or owner,
                        context.get("session_key", ""), context.get("session_id", ""), context.get("thread_id", "")))
        return token

    def bind(self, token, message_id):
        """Привязать токен к реально отправленному сообщению бота."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET message_id=? WHERE token=? AND consumed=0",
                       (str(message_id), token))

    def set_attempt(self, token, attempt_id, target_id="", stage=None):
        """Сохранить результат idempotent prepare перед отправкой кнопки."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET attempt_id=?,target_id=?,stage=COALESCE(?,stage) WHERE token=? AND resolved=0",
                       (attempt_id, target_id, stage, token))

    def consume(self, token, owner=None, message_id=None, chat_id=None, thread_id=None):
        """Атомарно погасить токен перед внешним эффектом; чужой message не погашает его."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM tokens WHERE token=? AND consumed=0", (token,)).fetchone()
            if (row is None or (owner is not None and
                    (row["owner"] != owner or row["message_id"] != str(message_id) or row["chat_id"] != chat_id))
                    or (thread_id is not None and row["thread_id"] != thread_id
                        and not (row["thread_id"] == "1" and thread_id == ""))):
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


    def decide(self, token, decision):
        """Сохранить принятое решение до единственного complete RPC."""
        with self._connect() as db:
            db.execute("""UPDATE tokens SET decision=?,resume_outcome='completing',
                stage=CASE WHEN ?='changes' THEN 'review' ELSE stage END WHERE token=?""", (decision, decision, token))

    def confirm(self, token):
        """Закрепить доказанный complete отдельно от попытки продолжения."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET resolved=1,resume_outcome='confirmed' WHERE token=?", (token,))

    def reserve_resume(self, token):
        """Разрешить один inject; crash после reserve не повторяет возможную работу."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("""UPDATE tokens SET resume_outcome='attempted'
                WHERE token=? AND resolved=1 AND resume_outcome='confirmed'""", (token,)).rowcount
            row = db.execute("SELECT * FROM tokens WHERE token=?", (token,)).fetchone() if changed else None
            return dict(row) if row else None

    def resume_outcome(self, token, outcome):
        """Уточнить исход единственного inject, не перезаписав наблюдённый ход."""
        with self._connect() as db:
            db.execute("""UPDATE tokens SET resume_outcome=? WHERE token=?
                AND resume_outcome IN ('attempted','submitted')""", (outcome, token))

    def uncertain_resumes(self):
        """После restart погасить неоднозначные продолжения без нового inject/complete."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = [dict(row) for row in db.execute("""SELECT * FROM tokens
                WHERE resume_outcome IN ('completing','confirmed','attempted','submitted')""")]
            db.execute("""UPDATE tokens SET resume_outcome='unknown'
                WHERE resume_outcome IN ('completing','confirmed','attempted','submitted')""")
            return rows

    def observe_resume(self, session_id, user_message):
        """Отметить post_llm_call точного продолжения; это наблюдение, не authority."""
        with self._connect() as db:
            for row in db.execute("""SELECT * FROM tokens WHERE session_id=?
                    AND resume_outcome IN ('attempted','submitted')""", (session_id,)):
                if _resume_message(row) in user_message:
                    db.execute("UPDATE tokens SET resume_outcome='observed' WHERE token=?", (row["token"],))


def _resume_message(row):
    """Передать модели только доказанный результат и предел следующего шага."""
    mode = ("Обсуди необходимые изменения и доработай предложение. Не выполняй подтверждаемый этап: "
            "владелец запросил изменения." if row["decision"] == "changes" else
            "Продолжи исходный запрос после подтверждённого этапа. Сначала прочитай актуальное состояние "
            "game-core. Выполняй только следующий разрешённый шаг; не повторяй уже завершённые действия.")
    facts = {key: row[column] for key, column in (("elementId", "target_id"), ("moveId", "move_id"),
             ("revisionId", "revision_id"), ("attemptId", "attempt_id"), ("stage", "stage"), ("decision", "decision"))}
    return ("Событие Brai: реальный владелец нажал кнопку Telegram; результат записан game-core.\n"
            + json.dumps(facts, ensure_ascii=False, sort_keys=True) + "\n" + mode)


def _platform(value):
    return getattr(value, "value", value)


def _uuid(value):
    return isinstance(value, str) and re.fullmatch(UUID, value) is not None


class TelegramPlugin:
    """Собирает native hooks, private RPC и локальное состояние подтверждений."""

    def __init__(self, config, bridge=None, inject_message=None):
        """Создать порт и хранилище; сеть Telegram подключает только native factory."""
        self.config = config
        self.bridge = bridge or Bridge(config)
        self.tokens = Tokens(config.state_dir)
        self.inject_message = inject_message
        self.session_store = None
        self.loop = self.bot = None
        self.tasks = set()
        self.cleanup_tasks = {}
        self.handlers = []
        self.closed = False
        self.active_callbacks = set()
        self.inbound_events = {}
        self.descriptor = re.compile(
            r"!?\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(<" + re.escape(config.result_root.rstrip("/")) + r"/(?P<id>" + UUID
            + r")/(?P<name>[^<>/\r\n]+)>\)")

    def factory(self, app, adapter):
        """Поставить owner/route guard до всех native handlers; сохранить scoped callback."""
        from telegram import Update
        from telegram.ext import CallbackQueryHandler, TypeHandler
        for task in self.tasks:
            task.cancel()
        self.loop, self.bot = asyncio.get_running_loop(), app.bot
        guard = TypeHandler(Update, self.guard)
        app.add_handler(guard, group=-100)
        self.handlers.append((app, guard, -100))
        handler = CallbackQueryHandler(self.callback, pattern=r"^brai:")
        app.add_handler(handler)
        self.handlers.append((app, handler, 0))
        for row in self.tokens.uncertain_resumes():
            task = self.loop.create_task(self._report_unknown_resume(row))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        for row in self.tokens.pending():
            route_changed = row["chat_id"] != self.config.chat or row["owner"] != self.config.owner
            recover_now = (row["consumed"] or not row["attempt_id"] or row["message_id"] is None
                           or route_changed)
            if route_changed:
                self.tokens.consume(row["token"])
            if recover_now:
                self._schedule_cleanup(row["token"])

    def close(self):
        """Убрать только свои handlers/tasks при native unload; SQLite сохраняет recovery."""
        self.closed = True

        def cleanup():
            for task in tuple(self.tasks):
                task.cancel()
            for app, handler, group in self.handlers:
                app.remove_handler(handler, group=group)
            self.handlers.clear()

        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(cleanup)

    def _schedule_cleanup(self, token):
        previous = self.cleanup_tasks.get(token)
        if previous:
            previous.cancel()
        task = self.loop.create_task(self._recover(token))
        self.tasks.add(task)
        self.cleanup_tasks[token] = task

        def finished(done):
            self.tasks.discard(done)
            if self.cleanup_tasks.get(token) is done:
                self.cleanup_tasks.pop(token, None)

        task.add_done_callback(finished)

    async def _on_native_loop(self, coroutine):
        if self.closed or self.loop is None or not self.loop.is_running():
            coroutine.close()
            raise BridgeError("TELEGRAM_UNAVAILABLE")
        if asyncio.get_running_loop() is self.loop:
            return await coroutine
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return await asyncio.wrap_future(future)

    def _route_matches(self, chat_id, chat_type):
        return (str(chat_id) == self.config.chat and chat_type in
                ({"group", "supergroup", "forum"} if self.config.chat.startswith("-") else {"private", "dm"}))

    async def guard(self, update, context):
        """Остановить чужой update до команд, download, native кнопок и inline queries."""
        from telegram.ext import ApplicationHandlerStop
        chat = getattr(update, "effective_chat", None)
        message = getattr(update, "effective_message", None)
        user = getattr(update, "effective_user", None)
        if (self.closed or not self._route_matches(getattr(chat, "id", None), getattr(chat, "type", None))
                or str(getattr(user, "id", "")) != self.config.owner or getattr(user, "is_bot", False)
                or getattr(message, "sender_chat", None) or getattr(message, "business_connection_id", None)):
            raise ApplicationHandlerStop

    async def _notify(self, text, chat_id=None, thread_id=""):
        # Telegram sendMessage rejects the canonical forum General thread ID 1.
        if self.bot is None:
            raise BridgeError("TELEGRAM_UNAVAILABLE")
        route = {"message_thread_id": int(thread_id)} if thread_id and str(thread_id) != "1" else {}
        await self.bot.send_message(chat_id=int(chat_id or self.config.chat), text=text, **route,
                                    connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)

    async def _report_unknown_resume(self, row):
        """Сообщить restart-неопределённость один раз, не повторяя работу."""
        try:
            await self._notify("Hermes был перезапущен: исход автоматического продолжения не подтверждён. "
                               "Повтор работы остановлен; требуется проверка состояния.", row["chat_id"], row["thread_id"])
        except Exception:
            pass  # Без доступного Telegram доставку уведомления подтвердить нельзя.

    def _session_matches(self, row):
        """Проверить сохранённую session и source через публичный read-only SessionStore."""
        if self.session_store is None or not row["session_key"] or not row["session_id"]:
            return False
        entry = self.session_store.lookup_by_session_key(row["session_key"])
        source = getattr(entry, "origin", None)
        return (getattr(entry, "session_id", None) == row["session_id"]
                and _platform(getattr(source, "platform", None)) == "telegram"
                and str(getattr(source, "user_id", "")) == row["owner"] == self.config.owner
                and str(getattr(source, "chat_id", "")) == row["chat_id"] == self.config.chat
                and self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None))
                and str(getattr(source, "thread_id", None) or "") == row["thread_id"])

    async def _resume(self, token):
        """Один раз попросить native gateway продолжить исходную беседу."""
        row = self.tokens.reserve_resume(token)
        if row is None:
            return "Автоматическое продолжение уже было запрошено; повтор работы остановлен."
        try:
            if not callable(self.inject_message):
                self.tokens.resume_outcome(token, "failed")
                return "Решение записано, но автоматическое продолжение Hermes недоступно. Работа не запущена."
            if not await asyncio.to_thread(self._session_matches, row):
                self.tokens.resume_outcome(token, "failed")
                return "Решение записано, но исходная сессия Hermes недоступна или изменилась. Работа не запущена."
            # AIDEV-NOTE: Public API pins session id при dispatch, не при этом read-check; /new race остаётся upstream.
            accepted = self.inject_message(_resume_message(row), session_key=row["session_key"])
            self.tokens.resume_outcome(token, "submitted" if accepted is True else "failed")
            if accepted is True:
                return ("Изменения записаны. Запрашиваю обсуждение и доработку в Hermes."
                        if row["decision"] == "changes" else "Принято. Запрашиваю автоматическое продолжение работы.")
            return "Решение записано, но Hermes не принял автоматическое продолжение. Требуется проверка сессии."
        except Exception:
            self.tokens.resume_outcome(token, "unknown")
            return "Решение записано; исход автоматического продолжения неизвестен. Повтор работы остановлен."

    def observe_resume(self, session_id="", user_message=None, **kwargs):
        """Наблюдать завершённый native turn без изменения ответа и повторного dispatch."""
        if isinstance(user_message, str):
            self.tokens.observe_resume(session_id, user_message)

    async def incoming(self, event, **kwargs):
        """Отсекать чужие Telegram события до auth и публиковать вложения владельца."""
        source = getattr(event, "source", None)
        if _platform(getattr(source, "platform", None)) != "telegram":
            return None
        raw = getattr(event, "raw_message", None)
        if (not self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None))
                or str(getattr(source, "user_id", "")) != self.config.owner
                or getattr(source, "is_bot", False) or getattr(raw, "sender_chat", None)
                or getattr(raw, "business_connection_id", None)):
            return {"action": "skip", "reason": "brai-owner-route-only"}
        if kwargs.get("session_store") is not None:
            self.session_store = kwargs["session_store"]
        key = (str(source.chat_id), str(getattr(source, "thread_id", None) or ""), str(event.message_id))
        self.inbound_events[key] = event
        if len(self.inbound_events) > 128:
            self.inbound_events.pop(next(iter(self.inbound_events)))
        paths = getattr(event, "media_urls", [])
        if not paths:
            return None
        try:
            if len(paths) > MAX_ATTACHMENTS or not re.fullmatch(r"[1-9][0-9]*", str(event.message_id)):
                raise BridgeError("ATTACHMENT_LIMIT")
            descriptors = []
            for index, path in enumerate(paths):
                result = await asyncio.to_thread(self.bridge.call, "files.publish", {
                    "path": path, "requestId": f"tg:{self.config.chat}:{event.message_id}:{index}"})
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

    def _published_path(self, result, artifact_id, filename):
        """Проверить publisher DTO и канонический локальный файл перед native delivery."""
        path = result.get("localPath")
        if (result.get("artifactId") != artifact_id or not isinstance(path, str)
                or not isinstance(filename, str) or not filename or Path(filename).name != filename
                or filename in {".", ".."} or result.get("filename") != filename
                or path != str(Path(self.config.result_root) / artifact_id / filename)
                or Path(path).resolve() != Path(path)
                or type(result.get("sizeBytes")) is not int or not 0 <= result["sizeBytes"] <= 2 * 1024**3
                or not isinstance(result.get("mimeType"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("sha256", "")))
                or not Path(path).is_absolute() or any(ord(c) < 32 for c in path)
                or any(c in path for c in '\\"`') or "MEDIA:" in path
                or not stat.S_ISREG(os.stat(path, follow_symlinks=False).st_mode)):
            raise BridgeError("RPC_MALFORMED")
        return path

    def tool_result(self, tool_name, result, session_id="", tool_call_id="", **kwargs):
        """Опубликовать готовую native image_generate картинку до попадания в model context."""
        if tool_name != "image_generate":
            return None
        try:
            payload = json.loads(result)
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict) or payload.get("success") is not True:
            return None
        try:
            from gateway.session_context import get_session_env
            from hermes_constants import get_hermes_home
            if get_session_env("HERMES_SESSION_PLATFORM") != "telegram":
                return None
            if (not self._route_matches(get_session_env("HERMES_SESSION_CHAT_ID"),
                                        get_session_env("HERMES_SESSION_CHAT_TYPE"))
                    or get_session_env("HERMES_SESSION_USER_ID") != self.config.owner
                    or not all(isinstance(value, str) and value for value in (session_id, tool_call_id))):
                raise BridgeError("IMAGE_CONTEXT_INVALID")
            path = Path(payload.get("image", ""))
            root = Path(get_hermes_home()) / "cache/generated/images"
            if (not path.is_absolute() or path.parent != root or path.resolve() != path
                    or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}
                    or not stat.S_ISREG(path.lstat().st_mode)):
                raise BridgeError("IMAGE_PATH_INVALID")
            identity = json.dumps([self.config.owner, self.config.chat, session_id, tool_call_id],
                                  ensure_ascii=False, separators=(",", ":"))
            published = self.bridge.call("files.publish", {
                "path": str(path), "requestId": "tg-image:" + sha256(identity.encode()).hexdigest()})
            match = self.descriptor.fullmatch(published.get("markdown", ""))
            if not match or not published.get("mimeType", "").startswith("image/"):
                raise BridgeError("RPC_MALFORMED")
            local_path = self._published_path(published, match["id"], match["name"])
            payload.update(image=local_path, artifactId=published["artifactId"], markdown=published["markdown"])
            for alias in ("host_image", "agent_visible_image"):
                if alias in payload:
                    payload[alias] = local_path
            # AIDEV-NOTE: Literal MEDIA в prompt не должен переключать native JSON-image autoappend в regex scan.
            return json.dumps(payload, ensure_ascii=False).replace("MEDIA:", r"MEDIA\u003a")
        except Exception:
            return json.dumps({"success": False, "image": None, "error_type": "artifact_publication_failed",
                               "error": "Картинка создана, но публикация Brai не подтверждена. Не запускайте генерацию повторно; проверьте Artifacts."},
                              ensure_ascii=False)

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
                path = self._published_path(result, artifact_id, match["name"])
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
            from gateway.session_context import get_session_env
            # Native cached agent не восстанавливает ContextVar ID; dispatcher передаёт его отдельно.
            bound_id = get_session_env("HERMES_SESSION_ID")
            dispatch_id = kwargs.get("session_id", "")
            if (not isinstance(dispatch_id, str)
                    or (dispatch_id and bound_id and dispatch_id != bound_id)):
                raise BridgeError("SESSION_CONTEXT_INVALID")
            context = {key: get_session_env(name) for key, name in (
                ("session_key", "HERMES_SESSION_KEY"), ("session_id", "HERMES_SESSION_ID"),
                ("thread_id", "HERMES_SESSION_THREAD_ID"))}
            context["session_id"] = dispatch_id or bound_id
            context["message_id"] = get_session_env("HERMES_SESSION_MESSAGE_ID")
            if (get_session_env("HERMES_SESSION_PLATFORM") != "telegram"
                    or get_session_env("HERMES_SESSION_USER_ID") != self.config.owner
                    or not self._route_matches(get_session_env("HERMES_SESSION_CHAT_ID"),
                                               get_session_env("HERMES_SESSION_CHAT_TYPE"))
                    or not self._session_matches({**context, "owner": self.config.owner, "chat_id": self.config.chat})):
                raise BridgeError("SESSION_CONTEXT_INVALID")
            result = await self._on_native_loop(self._request(args, context))
            if json.loads(result).get("ok"):
                # Public MessageEvent: this exact inbound request has received its reply.
                key = (self.config.chat, context["thread_id"], context["message_id"])
                event = self.inbound_events.pop(key, None)
                if event is not None:
                    event.reply_expected = False
            return result
        except Exception as error:
            code = str(error) if isinstance(error, BridgeError) and str(error) in {
                "INVALID_ARGUMENT", "SESSION_CONTEXT_INVALID", "TELEGRAM_UNAVAILABLE",
                "HUMAN_OUTPUT_REQUIRED", "SEND_UNCONFIRMED"} else "CONFIRMATION_FAILED"
            message = HUMAN_OUTPUT_REQUIRED if code == "HUMAN_OUTPUT_REQUIRED" else "Кнопки не отправлены. Подтверждение пользователя не получено."
            return json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False)

    async def _request(self, args, context):
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        stage = args.get("stage", "planning")
        existing = None
        for pending in self.tokens.pending():
            if pending["move_id"] != args["moveId"]:
                continue
            if (not pending["consumed"] and pending["message_id"] is not None
                    and pending["revision_id"] == args["revisionId"]
                    and await asyncio.to_thread(self._session_matches, pending)
                    and await self._current(pending)):
                existing = pending
                break
            if pending["consumed"]:
                raise BridgeError("CONFIRMATION_PENDING")
            self.tokens.consume(pending["token"])
            await self._cleanup(pending, "cancelled")
            self.tokens.resolve(pending["token"])
        # Reservation до prepare закрывает crash между backend claim и SQLite записью.
        token = existing["token"] if existing else self.tokens.create(
            self.config.owner, {**args, "attemptId": ""}, stage, self.config.chat, context)
        try:
            action = await self._prepare(self.tokens.unresolved(token))
            if action.get("confirmationStage", stage) is None:
                raise BridgeError("HUMAN_OUTPUT_REQUIRED")
            stage = self.tokens.unresolved(token)["stage"]
            if not await self._current(self.tokens.unresolved(token)):
                raise BridgeError("STALE_ACTION")
            decision = "success" if stage == "final" else "approved"
            buttons = [[InlineKeyboardButton(label, callback_data=f"brai:{token}:{choice}")]
                       for label, choice in (("Принять", decision), ("Нужны изменения", "changes"),
                                             ("Отменить", "cancelled"))]
            context = str(action.get("targetDescription") or "")[:1400]
            title = str(action.get("targetTitle") or "")[:400]
            stage_label = {"planning": "План работы", "review": "Проверка результата", "final": "Готовый результат"}[stage]
            if "confirmationText" in action:
                preview = action["confirmationText"]
                if not isinstance(preview, str) or not preview.strip():
                    raise BridgeError("HUMAN_OUTPUT_REQUIRED")
                text = f"{stage_label}\n\n{preview}\n\n"
            else:
                text = f"{stage_label}: {action['title'][:800]}\n{title}\n{context}\n"
            text += "Нужны изменения — обсудить и доработать; отменить — остановить запрос."
            thread_id = self.tokens.unresolved(token)["thread_id"]
            route = {"message_thread_id": int(thread_id)} if thread_id and str(thread_id) != "1" else {}
            # Не обрезаем план/результат. 1800 code points помещаются в 4096 UTF-16 units.
            chunks = [text[index:index + 1800] for index in range(0, len(text), 1800)]
            for index, chunk in enumerate(chunks):
                keyboard = {"reply_markup": InlineKeyboardMarkup(buttons)} if index == len(chunks) - 1 else {}
                if existing and len(chunks) == 1:
                    from telegram.error import BadRequest
                    try:
                        await self.bot.edit_message_text(chat_id=int(self.config.chat),
                            message_id=int(existing["message_id"]), text=chunk, **keyboard,
                            connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)
                    except BadRequest as error:
                        if "message is not modified" not in str(error).lower():
                            raise
                else:
                    message = await self.bot.send_message(chat_id=int(self.config.chat), text=chunk, **route,
                        **keyboard, connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)
                    self.tokens.bind(token, message.message_id)
            return json.dumps({"ok": True, "status": "awaiting_owner", "moveId": action["moveId"],
                               "attemptId": action["attemptId"], "revisionId": action["revisionId"]})
        except Exception as error:
            self.tokens.consume(token)
            try:
                await self._cleanup(self.tokens.unresolved(token), "cancelled")
                self.tokens.resolve(token)
            except Exception:
                self._schedule_cleanup(token)  # Recovery всегда сверяет exact attempt перед cancel.
            code = "HUMAN_OUTPUT_REQUIRED" if isinstance(error, BridgeError) and str(error) == "HUMAN_OUTPUT_REQUIRED" else "SEND_UNCONFIRMED"
            raise BridgeError(code) from None

    async def _prepare(self, row):
        action = await asyncio.to_thread(self.bridge.call, "actions.prepare", {
            "moveId": row["move_id"], "revisionId": row["revision_id"], "idempotencyKey": row["token"]})
        if (action.get("moveId") != row["move_id"] or action.get("revisionId") != row["revision_id"]
                or not _uuid(action.get("attemptId")) or not _uuid(action.get("targetId"))
                or not isinstance(action.get("title"), str) or action.get("status") != "running"):
            raise BridgeError("RPC_MALFORMED")
        # Recovery с null сохраняет attempt для cleanup, но _request не показывает такую кнопку.
        stage = action.get("confirmationStage")
        if stage is not None and stage not in {"planning", "final"}:
            raise BridgeError("RPC_MALFORMED")
        self.tokens.set_attempt(row["token"], action["attemptId"], action["targetId"], stage)
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

    async def _recover(self, token):
        """Восстановить только незавершённую техническую попытку, без срока решения."""
        while token in self.active_callbacks:
            await asyncio.sleep(0.1)
        warned = False
        while not self.closed:
            row = self.tokens.consume(token) or self.tokens.unresolved(token)
            if row is None:
                return
            try:
                cancelled = await self._cleanup(row, "cancelled")
                self.tokens.resolve(token)
                notice = ("Незавершённая попытка отправки отменена. Запросите кнопки ещё раз." if cancelled
                          else "Кнопка Brai больше не активна. Состояние Action уже изменилось.")
                await self._notify(notice, row["chat_id"], row["thread_id"])
                return
            except Exception:
                if not warned:
                    try:
                        await self._notify("Кнопка Brai неактивна; отмена попытки не подтверждена. Проверьте Action.", row["chat_id"])
                    except Exception:
                        pass
                    warned = True
                # Повтор cleanup всегда начинает с чтения exact attempt, не повторяет complete.
                await asyncio.sleep(60)

    async def callback(self, update, context):
        """Принять callback владельца из точного чата/сообщения, погасив token до RPC."""
        query = getattr(update, "callback_query", None)
        message = getattr(query, "message", None)
        chat = getattr(message, "chat", None)
        if (self.closed or query is None
                or not self._route_matches(getattr(chat, "id", None), getattr(chat, "type", None))
                or str(getattr(getattr(query, "from_user", None), "id", "")) != self.config.owner
                or getattr(getattr(query, "from_user", None), "is_bot", False)
                or getattr(message, "sender_chat", None)
                or getattr(message, "business_connection_id", None)):
            return
        data = getattr(query, "data", "")
        match = re.fullmatch(r"brai:([A-Za-z0-9_-]{32}):(approved|success|changes|cancelled)", data or "")
        if not match or len(data.encode("utf-8")) > 64:
            await query.answer("Кнопка недействительна.", show_alert=True)
            return
        row = self.tokens.consume(match[1], self.config.owner, getattr(message, "message_id", None), self.config.chat,
                                  str(getattr(message, "message_thread_id", None) or ""))
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
            if not await asyncio.to_thread(self._session_matches, row) or not await self._current(row):
                await self._cancel(row, "cancelled")
                self.tokens.resolve(match[1])
                notice = "Задача, версия или исходная беседа изменились. Работа не запущена."
            elif decision == "cancelled":
                await self._cancel(row, "cancelled")
                self.tokens.resolve(match[1])
                notice = "Запрос отменён. Работу не продолжаю."
            else:
                self.tokens.decide(match[1], decision)
                result = await asyncio.to_thread(self.bridge.call, "actions.complete", {
                    "moveId": row["move_id"], "attemptId": row["attempt_id"],
                    "revisionId": row["revision_id"], "stage": row["stage"], "decision": decision})
                attempt = result.get("attempt")
                if not isinstance(attempt, dict) or attempt.get("id") != row["attempt_id"] or attempt.get("status") != "succeeded":
                    raise BridgeError("COMPLETE_UNCONFIRMED")
                self.tokens.confirm(match[1])
                notice = await self._resume(match[1])
        except Exception:
            pass
        finally:
            self.active_callbacks.discard(match[1])
            if not self.closed and self.tokens.unresolved(match[1]):
                self._schedule_cleanup(match[1])
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            pass
        await self._notify(notice, row["chat_id"], row["thread_id"])


def register(ctx):
    """Подключить плагин через публичный API закреплённого Hermes."""
    plugin = TelegramPlugin(Config.from_env(), inject_message=getattr(ctx, "inject_message", None))
    ctx.register_telegram_handler(plugin.factory)
    ctx.register_hook("pre_gateway_dispatch", plugin.incoming)
    ctx.register_hook("transform_llm_output", plugin.outgoing)
    ctx.register_hook("transform_tool_result", plugin.tool_result)
    ctx.register_hook("post_llm_call", plugin.observe_resume)
    ctx.register_tool(name="brai_telegram_request_confirmation", toolset="brai_telegram",
        description=CONFIRMATION_DESCRIPTION,
        schema={"name": "brai_telegram_request_confirmation", "description": CONFIRMATION_DESCRIPTION,
                "parameters": {"type": "object", "properties": {"moveId": {"type": "string"},
                    "revisionId": {"type": "string"}, "stage": {"type": "string", "enum": ["planning", "final", "review"]}},
                    "required": ["moveId", "revisionId"], "additionalProperties": False}},
        handler=plugin.request_confirmation, is_async=True)
    ctx.on_unload(plugin.close)
