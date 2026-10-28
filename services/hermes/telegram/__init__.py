# ABOUTME: Связывает штатный Telegram gateway Hermes с private портом Brai.
# ABOUTME: Проверяет владельца и одноразовые подтверждения, не запускает отдельный бот.
from __future__ import annotations

import asyncio
import sys
import importlib
import importlib.util
import logging
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


def _observer_source(config, name):
    root = Path(os.environ.get("BRAI_TELEGRAM_OBSERVER_ROOT") or Path(config.entry).parent)
    if not root.is_absolute():
        raise ValueError("TELEGRAM_OBSERVER_UNAVAILABLE")
    return root / "telegram/observer" / name


def _open_journal(config):
    if os.environ.get("BRAI_TELEGRAM_OBSERVER_ENABLED") != "1":
        return None
    # AIDEV-NOTE: Плагин копируется отдельно; модуль журнала задаётся оператором из принятого runtime.
    path = _observer_source(config, "journal.py")
    spec = importlib.util.spec_from_file_location("_brai_telegram_observer_journal", path)
    if spec is None or spec.loader is None:
        raise ValueError("TELEGRAM_OBSERVER_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.TelegramJournal(config.state_dir)


CONFIRMATION_DESCRIPTION = (
    "Ask the owner to confirm a human Action in the configured Telegram chat. First create "
    "the Element and Action with the available game-core structure/create tools, or use existing ones. "
    "Call game_core_request_human_action for the real moveId; pass its returned moveId and revisionId here. "
    "Never invent IDs or pass placeholder UUIDs. Decision-only plan/final Actions show saved content with one Accept button. Clarification Actions show their question with no button and accept a plain owner answer. Practical human Actions show the required work without a button; after the owner performs it, save only the current real message through brai_telegram_submit_result. Remarks and cancellation are ordinary owner messages handled by brai_telegram_submit_feedback. Do not send a separate copy. After ok=true, finish with NO_REPLY; after failure, explain it. A verified owner decision automatically resumes this session."
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
    allowed_users: tuple[str, ...] = ()

    def allows(self, user_id):
        """Разрешить владельца и назначенных участников общего группового профиля."""
        return str(user_id) == self.owner or (self.chat.startswith("-") and str(user_id) in self.allowed_users)

    @property
    def chat(self):
        """Вернуть отдельный маршрут либо прежний личный чат владельца."""
        return self.chat_id or self.owner

    @classmethod
    def from_env(cls):
        """Проверить обязательные параметры; секреты остаются в окружении child process."""
        owner = os.environ.get("BRAI_TELEGRAM_OWNER_ID", "")
        chat = os.environ.get("BRAI_TELEGRAM_CHAT_ID", "")
        allowed = os.environ.get("TELEGRAM_ALLOWED_USERS", "")
        users = tuple(allowed.split(",")) if allowed else ()
        state = Path(os.environ.get("BRAI_TELEGRAM_STATE_DIR", ""))
        entry = os.environ.get("BRAI_HERMES_TRUSTED_ENTRY", "")
        node = os.environ.get("BRAI_HERMES_NODE_EXECUTABLE", "")
        root = os.environ.get("BRAI_TELEGRAM_RESULT_ROOT", "")
        if (not re.fullmatch(r"[1-9][0-9]*", owner)
                or any(not re.fullmatch(r"[1-9][0-9]*", user) for user in users)
                or len(users) > 20 or len(set(users)) != len(users)
                or (any(user != owner for user in users) and not chat.startswith("-"))
                or (chat and not re.fullmatch(r"-?[1-9][0-9]*", chat))
                or (chat and not chat.startswith("-") and chat != owner) or not state.is_absolute()
                or state.name != "brai-telegram" or not Path(entry).is_absolute()
                or Path(entry).name != "trusted.mjs" or not Path(node).is_absolute()
                or not Path(root).is_absolute() or str(Path(root)) != root
                or re.search(r"[\\<>?#%\x00-\x1f\x7f]", root)):
            raise ValueError("BRAI_TELEGRAM_CONFIG_INVALID")
        return cls(owner, state, entry, node, root, chat, users)


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
        # The managed bootstrap provides this in-memory port only to this exact plugin.
        # Legacy gateway launches retain the existing trusted stdio subprocess below.
        import sys
        private = sys.modules.get('_brai_codeworks_gateway')
        if private is not None:
            try:
                return private.call_plugin(method, params, timeout)
            except Exception as error:
                code = str(error)
                allowed = {'HUMAN_OUTPUT_REQUIRED', 'HUMAN_FINAL_DECISION_REQUIRED', 'HUMAN_OUTPUT_MAPPING_REQUIRED', 'STALE_ACTION', 'NOT_FOUND'}
                raise BridgeError(code if code in allowed else 'RPC_REJECTED') from None
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
                if error["code"] == -32000 and isinstance(error.get("data"), dict) and error["data"].get("code") in {"HUMAN_FINAL_DECISION_REQUIRED", "HUMAN_OUTPUT_MAPPING_REQUIRED", "STALE_ACTION"}:
                    raise BridgeError(error["data"]["code"])
                code = error.get("data", {}).get("code") if isinstance(error.get("data"), dict) else None
                if method == "files.publish" and isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,80}", code):
                    logging.getLogger(__name__).warning("BRAI_FILE_PUBLISH_REJECTED code=%s", code)
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
            db.execute("""CREATE TABLE IF NOT EXISTS agent_attempts (
                owner TEXT NOT NULL, session_id TEXT NOT NULL, move_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL, terminal_pending INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(owner,session_id,move_id))""")
            attempt_columns = {row[1] for row in db.execute("PRAGMA table_info(agent_attempts)")}
            if "terminal_pending" not in attempt_columns:
                db.execute("ALTER TABLE agent_attempts ADD COLUMN terminal_pending INTEGER NOT NULL DEFAULT 0")
            db.execute("""CREATE TABLE IF NOT EXISTS human_results (
                owner TEXT NOT NULL, move_id TEXT NOT NULL, revision_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
                content TEXT NOT NULL, source_json TEXT NOT NULL, PRIMARY KEY(owner,move_id))""")
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

    def set_stage(self, token, stage):
        """Зафиксировать тип ожидания по фактическому Action."""
        with self._connect() as db:
            db.execute("UPDATE tokens SET stage=? WHERE token=? AND resolved=0", (stage, token))

    def save_human_result(self, owner, move_id, revision_id, attempt_id, content, source):
        with self._connect() as db:
            db.execute("INSERT INTO human_results VALUES(?,?,?,?,?,?) ON CONFLICT(owner,move_id) DO UPDATE SET revision_id=excluded.revision_id,attempt_id=excluded.attempt_id,content=excluded.content,source_json=excluded.source_json",
                       (owner, move_id, revision_id, attempt_id, content, json.dumps(source, ensure_ascii=False)))

    def human_result(self, owner, move_id):
        with self._connect() as db:
            row = db.execute("SELECT * FROM human_results WHERE owner=? AND move_id=?", (owner, move_id)).fetchone()
            return dict(row) if row else None

    def clear_human_result(self, owner, move_id):
        with self._connect() as db:
            db.execute("DELETE FROM human_results WHERE owner=? AND move_id=?", (owner, move_id))

    def resolve_attempt(self, owner, attempt_id):
        with self._connect() as db:
            db.execute("UPDATE tokens SET resolved=1 WHERE owner=? AND attempt_id=? AND resolved=0", (owner, attempt_id))

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

    def reserve_clarification(self, token, owner, session_id, thread_id, move_id, target_id, revision_id):
        """Однократно закрепить ответ текущего владельца за pending clarification Action."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM tokens WHERE token=? AND resolved=0 AND consumed=0", (token,)).fetchone()
            if (row is None or row["owner"] != owner or row["session_id"] != session_id
                    or row["thread_id"] != thread_id or row["move_id"] != move_id
                    or row["target_id"] != target_id or row["revision_id"] != revision_id
                    or row["stage"] != "clarification" or not row["attempt_id"]):
                return None
            db.execute("UPDATE tokens SET consumed=1 WHERE token=? AND consumed=0", (token,))
            return dict(row)

    def track_agent_attempt(self, owner, session_id, move_id, attempt_id):
        """Сохранить точные ID подтверждённой model-side Operation claim."""
        if not all(isinstance(value, str) and value for value in (owner, session_id, move_id, attempt_id)):
            return
        with self._connect() as db:
            db.execute("INSERT INTO agent_attempts(owner,session_id,move_id,attempt_id,terminal_pending) VALUES(?,?,?,?,0) "
                       "ON CONFLICT(owner,session_id,move_id) DO UPDATE SET attempt_id=excluded.attempt_id,terminal_pending=0",
                       (owner, session_id, move_id, attempt_id))

    def mark_agent_attempt_terminal(self, owner, session_id, attempt_id):
        with self._connect() as db:
            db.execute("UPDATE agent_attempts SET terminal_pending=1 WHERE owner=? AND session_id=? AND attempt_id=?",
                       (owner, session_id, attempt_id))

    def mark_owner_attempts_orphaned(self, owner):
        """At process startup, only claims persisted by the previous process become terminal."""
        with self._connect() as db:
            db.execute("UPDATE agent_attempts SET terminal_pending=1 WHERE owner=?", (owner,))

    def clear_agent_attempt(self, owner, session_id, attempt_id):
        with self._connect() as db:
            db.execute("DELETE FROM agent_attempts WHERE owner=? AND session_id=? AND attempt_id=?",
                       (owner, session_id, attempt_id))

    def agent_attempts(self, owner, session_id=None, terminal_only=False):
        with self._connect() as db:
            terminal_clause = " AND terminal_pending=1" if terminal_only else ""
            if session_id is None:
                rows = db.execute("SELECT * FROM agent_attempts WHERE owner=?" + terminal_clause, (owner,))
            else:
                rows = db.execute("SELECT * FROM agent_attempts WHERE owner=? AND session_id=?" + terminal_clause,
                                  (owner, session_id))
            return [{key: row[key] for key in ("owner", "session_id", "move_id", "attempt_id")} for row in rows]


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
        self.loop = self.bot = self.adapter = None
        self._stop_outgoing_observer = None
        self.tasks = set()
        self.cleanup_tasks = {}
        self.handlers = []
        self.closed = False
        self.active_callbacks = set()
        self.inbound_events = {}
        self.feedback_results = {}
        self.feedback_inflight = set()
        self.startup_attempt_recovery_initialized = False
        # AIDEV-NOTE: Наблюдение включается отдельно только в DEV; обычный gateway не требует журнала.
        try:
            self.journal = _open_journal(config)
        except Exception:
            self.journal = None
            logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_START_FAILED")
        self.descriptor = re.compile(
            r"!?\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\(<" + re.escape(config.result_root.rstrip("/")) + r"/(?P<id>" + UUID
            + r")/(?P<name>[^<>/\r\n]+)>\)")
        self.output_files = re.compile(
            r"(?P<code>```[\s\S]*?(?:```|\Z)|~~~[\s\S]*?(?:~~~|\Z)|`[^`\r\n]+`)|"
            + self.descriptor.pattern
            + r'|(?m:^[ \t]*MEDIA:(?:"(?P<quoted>[^"\r\n]+)"|(?P<bare>/[^\r\n]+?))[ \t]*$)')
        self.result_path = re.compile(re.escape(config.result_root.rstrip("/"))
                                      + r"/(?P<id>" + UUID + r")/(?P<name>[^/\r\n]+)")

    def factory(self, app, adapter):
        """Поставить owner/route guard до всех native handlers; сохранить scoped callback."""
        from telegram import Update
        from telegram.ext import CallbackQueryHandler, TypeHandler
        for task in self.tasks:
            task.cancel()
        self.loop, self.bot, self.adapter = asyncio.get_running_loop(), app.bot, adapter
        guard = TypeHandler(Update, self.guard)
        app.add_handler(guard, group=-100)
        self.handlers.append((app, guard, -100))
        handler = CallbackQueryHandler(self.callback, pattern=r"^brai:")
        app.add_handler(handler)
        self.handlers.append((app, handler, 0))
        if self.journal is not None and "brai_files" in sys.modules:
            sys.modules["brai_files"].register_telegram_observer(self)
        if self.journal is not None:
            try:
                path = _observer_source(self.config, "outgoing.py")
                spec = importlib.util.spec_from_file_location("_brai_telegram_observer_outgoing", path)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    if self._stop_outgoing_observer:
                        self._stop_outgoing_observer()
                    self._stop_outgoing_observer = module.install(app.bot, self)
            except Exception:
                logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_START_FAILED")
            task = self.loop.create_task(self._recover_history())
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        for row in self.tokens.uncertain_resumes():
            task = self.loop.create_task(self._report_unknown_resume(row))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        for row in self.tokens.pending():
            route_changed = not self._saved_route_matches(row["chat_id"]) or row["owner"] != self.config.owner
            recover_now = (row["consumed"] or not row["attempt_id"] or row["message_id"] is None
                           or route_changed)
            if route_changed:
                self.tokens.consume(row["token"])
            if recover_now:
                self._schedule_cleanup(row["token"])
        if not self.startup_attempt_recovery_initialized:
            self.tokens.mark_owner_attempts_orphaned(self.config.owner)
            self.startup_attempt_recovery_initialized = True
        task = self.loop.create_task(self.recover_durable_agent_attempts())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def close(self):
        """Убрать только свои handlers/tasks при native unload; SQLite сохраняет recovery."""
        self.closed = True

        def cleanup():
            if self._stop_outgoing_observer:
                self._stop_outgoing_observer()
                self._stop_outgoing_observer = None
            for task in tuple(self.tasks):
                task.cancel()
            for app, handler, group in self.handlers:
                app.remove_handler(handler, group=group)
            self.handlers.clear()

        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(cleanup)

    async def observe_files(self, event, state, published=None):
        """Привязать к исходному Telegram message проверенные файлы общей границы."""
        if self.journal is None or self.closed:
            return
        source = getattr(event, "source", None)
        if not self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None),
                                   getattr(source, "user_id", "")):
            return
        refs = [entry["file"] for entry in (published if published is not None else (getattr(event, "metadata", None) or {}).get("_brai_artifacts", []))
                if isinstance(entry, dict) and isinstance(entry.get("file"), dict)]
        try:
            await asyncio.to_thread(self.journal.attachments, source.chat_id, event.message_id, refs, state)
        except Exception:
            logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")

    def _import_history(self):
        """Импортировать только разрешённые Telegram-сессии через read-only native API."""
        if self.journal.history_complete():
            return
        from hermes_state import SessionDB
        path = _observer_source(self.config, "history.py")
        spec = importlib.util.spec_from_file_location("_brai_telegram_observer_history", path)
        if spec is None or spec.loader is None:
            raise ValueError("TELEGRAM_OBSERVER_UNAVAILABLE")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        alias_path = self.config.state_dir.parent / "brai-files/files.sqlite"
        aliases = sqlite3.connect(f"file:{alias_path}?mode=ro", uri=True) if alias_path.is_file() else None
        source = SessionDB(read_only=True)
        try:
            def allows(session):
                return self._route_matches(session.get("chat_id"), session.get("chat_type"), session.get("user_id"))
            file_config = self.bridge.call("files.configuration", {})
            owner_id = file_config.get("ownerId")
            def lookup(artifact_id, chat_id, message_id):
                try:
                    ref = self.bridge.call("files.get", {"artifactId": artifact_id})
                    return ref if module.legacy_input_matches(ref, owner_id, chat_id, message_id) else None
                except BridgeError as error:
                    if str(error) == "NOT_FOUND":
                        return None
                    raise
            module.import_history(source, self.journal, allows, self.config.result_root, aliases, lookup)
            self.journal.mark_history_complete()
        finally:
            source.close()
            if aliases is not None:
                aliases.close()

    async def _recover_history(self):
        """Повторять только безопасное чтение истории после временного отказа."""
        while not self.closed:
            try:
                await asyncio.to_thread(self._import_history)
                return
            except Exception:
                logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_HISTORY_UNAVAILABLE")
                await asyncio.sleep(30)

    async def observe_send(self, chat_id, metadata, text, result, attachments=(), identity=None):
        """Записать итог доставки только в разрешённую группу или личку."""
        if self.journal is None or self.closed or not self._saved_route_matches(chat_id):
            return
        route = metadata or {}
        thread_id = route.get("message_thread_id") or route.get("thread_id") or ""
        message_id = getattr(result, "message_id", None)
        raw = getattr(result, "raw_response", None)
        raw_state = raw.get("status") if isinstance(raw, dict) else None
        state = "sent" if getattr(result, "success", False) and message_id else "failed" if raw_state == "failed" else "pending"
        try:
            await asyncio.to_thread(self.journal.outgoing, chat_id, thread_id, text, message_id, state,
                                    attachments, identity)
        except Exception:
            logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")

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

    def _saved_route_matches(self, chat_id):
        """Проверить сохранённый групповой или личный маршрут текущего списка доступа."""
        return str(chat_id) == self.config.chat or self.config.allows(chat_id)

    def _route_matches(self, chat_id, chat_type, user_id):
        """Разрешить заданную группу либо личный чат самого разрешённого отправителя."""
        chat_id, user_id = str(chat_id), str(user_id)
        if not self.config.allows(user_id):
            return False
        if chat_type in {"private", "dm"}:
            return chat_id == user_id
        return (self.config.chat.startswith("-") and chat_id == self.config.chat
                and chat_type in {"group", "supergroup", "forum"})

    async def guard(self, update, context):
        """Передать Business своему плагину; остальные updates ограничить маршрутами Brai."""
        from telegram.ext import ApplicationHandlerStop
        if self.closed:
            raise ApplicationHandlerStop
        connection = getattr(update, "business_connection", None)
        if connection is not None:
            owner = getattr(connection, "user", None)
            if str(getattr(owner, "id", "")) != self.config.owner or getattr(owner, "is_bot", False):
                raise ApplicationHandlerStop
            return
        # AIDEV-NOTE: У Business свой lifecycle и авторизация подключения; общий Brai turn ниже по-прежнему запрещён.
        if any(getattr(update, field, None) is not None for field in
               ("business_message", "edited_business_message", "deleted_business_messages")):
            return
        chat = getattr(update, "effective_chat", None)
        message = getattr(update, "effective_message", None)
        user = getattr(update, "effective_user", None)
        if (not self._route_matches(getattr(chat, "id", None), getattr(chat, "type", None),
                                    getattr(user, "id", ""))
                or not self.config.allows(getattr(user, "id", "")) or getattr(user, "is_bot", False)
                or getattr(message, "sender_chat", None) or getattr(message, "business_connection_id", None)):
            raise ApplicationHandlerStop
        original = getattr(update, "message", None) or getattr(update, "edited_message", None)
        if self.journal is not None and original is not None:
            try:
                await asyncio.to_thread(self.journal.incoming, original, chat, user)
            except Exception:
                # Ошибка наблюдения не меняет Telegram dispatch; диагностируется без содержимого.
                logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")

    async def _notify(self, text, chat_id=None, thread_id=""):
        # Telegram sendMessage rejects the canonical forum General thread ID 1.
        if self.bot is None:
            raise BridgeError("TELEGRAM_UNAVAILABLE")
        route = {"message_thread_id": int(thread_id)} if thread_id and str(thread_id) != "1" else {}
        sent = await self.bot.send_message(chat_id=int(chat_id or self.config.chat), text=text, **route,
                                           connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)
        from types import SimpleNamespace
        await self.observe_send(chat_id or self.config.chat, route, text,
                                SimpleNamespace(success=True, message_id=getattr(sent, "message_id", None)))

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
                and self.config.allows(getattr(source, "user_id", "")) and row["owner"] == self.config.owner
                and str(getattr(source, "chat_id", "")) == row["chat_id"]
                and self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None),
                                        getattr(source, "user_id", ""))
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

    def _owner_session(self, session_id):
        """Проверить native session id через read-only SessionStore и fixed Telegram owner."""
        if self.session_store is None or not isinstance(session_id, str) or not session_id:
            return None
        entry = self.session_store.lookup_by_session_id(session_id)
        source = getattr(entry, "origin", None)
        if (getattr(entry, "session_id", None) != session_id
                or _platform(getattr(source, "platform", None)) != "telegram"
                or not self.config.allows(getattr(source, "user_id", ""))
                or not self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None),
                                        getattr(source, "user_id", ""))):
            return None
        return entry

    def observe_agent_move(self, tool_name="", args=None, result=None, session_id="", status="", **kwargs):
        """Persist exact successful agent claims and clear observed terminal attempts."""
        entry = self._owner_session(session_id)
        if entry is None or status != "ok" or not isinstance(args, dict):
            return
        # Hermes' Tool Search bridge unwraps tool_call but keeps the registered MCP name.
        # Accept only this connector's exact namespace; other connector names stay inert.
        if isinstance(tool_name, str) and tool_name.startswith("mcp__brai__"):
            tool_name = tool_name[len("mcp__brai__"):]
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except (TypeError, ValueError):
                return
        if isinstance(result, dict) and isinstance(result.get("result"), str):
            try:
                result = json.loads(result["result"])
            except (TypeError, ValueError):
                return
        if not isinstance(result, dict):
            return
        if tool_name == "game_core_move_claim":
            attempt = result.get("attempt") if isinstance(result.get("attempt"), dict) else result
            move_id, attempt_id = args.get("move_id"), attempt.get("id")
            if _uuid(move_id) and _uuid(attempt_id) and attempt.get("executor_kind") == "agent" and attempt.get("status") == "running":
                self.tokens.track_agent_attempt(self.config.owner, session_id, move_id, attempt_id)
        elif tool_name in {"game_core_move_complete", "game_core_move_fail"} and _uuid(args.get("attempt_id")):
            self.tokens.clear_agent_attempt(self.config.owner, session_id, args["attempt_id"])

    async def _fail_stopped_agent_attempts(self, session_id):
        """Fail exact running attempts observed in this owner session after native terminal stop."""
        entry = self._owner_session(session_id)
        if entry is None:
            return
        source = entry.origin
        thread_id = str(getattr(source, "thread_id", None) or "")
        rows = self.tokens.agent_attempts(self.config.owner, session_id)
        for row in rows:
            self.tokens.mark_agent_attempt_terminal(row["owner"], row["session_id"], row["attempt_id"])
        for row in self.tokens.agent_attempts(self.config.owner, session_id, terminal_only=True):
            await self._fail_recorded_agent_attempt(row, thread_id, notify=True)

    async def _fail_recorded_agent_attempt(self, row, thread_id="", notify=False):
        try:
            result = await asyncio.to_thread(self.bridge.call, "actions.fail_agent", {
                "moveId": row["move_id"], "attemptId": row["attempt_id"]})
            attempt = result.get("attempt") if isinstance(result, dict) else None
            if result.get("status") == "already_stopped" or (isinstance(attempt, dict)
                    and attempt.get("id") == row["attempt_id"]
                    and attempt.get("status") in {"failed", "succeeded", "cancelled"}):
                self.tokens.clear_agent_attempt(row["owner"], row["session_id"], row["attempt_id"])
            else:
                raise BridgeError("FAIL_UNCONFIRMED")
        except Exception:
            # Keep the durable exact attempt for the next startup/owner-turn recovery.
            if notify:
                entry = self._owner_session(row["session_id"])
                if entry is not None:
                    await self._notify("Hermes остановил работу, но Brai не подтвердил завершение начатого Хода. Проверьте его состояние.",
                                       str(entry.origin.chat_id), thread_id)

    async def recover_durable_agent_attempts(self):
        """Retry only attempts proven terminal by a lifecycle hook or startup boundary."""
        for row in self.tokens.agent_attempts(self.config.owner, terminal_only=True):
            entry = self._owner_session(row["session_id"])
            source = getattr(entry, "origin", None)
            thread_id = str(getattr(source, "thread_id", None) or "")
            await self._fail_recorded_agent_attempt(row, thread_id, notify=True)

    async def on_session_end(self, session_id="", platform=None, completed=None, failed=None, interrupted=None, **kwargs):
        """Recover stopped claims, preserving successful turns that yielded to a reviewer."""
        if _platform(platform) != "telegram":
            return
        if (completed is True and failed is not True and interrupted is not True
                and isinstance(session_id, str) and session_id):
            try:
                async_delegation = importlib.import_module("tools.async_delegation")
                if async_delegation.has_live_for_session(parent_session_id=session_id):
                    return
                for record in async_delegation.list_async_delegations():
                    if (not isinstance(record, dict) or record.get("parent_session_id") != session_id
                            or not record.get("completed_at")):
                        continue
                    delegation_id = record.get("delegation_id")
                    if not isinstance(delegation_id, str) or not delegation_id:
                        continue
                    durable = async_delegation.get_durable_delegation(delegation_id)
                    if (isinstance(durable, dict)
                            and durable.get("delivery_state") == "pending"):
                        return
            except Exception:
                # A failed lifecycle read cannot prove a reviewer is still pending.
                pass
        await self._fail_stopped_agent_attempts(session_id)

    async def agent_loop_stopped(self, session_key="", platform=None, **kwargs):
        """Recover an exact owner attempt after native /stop or replacement interruption."""
        if _platform(platform) != "telegram" or self.session_store is None or not session_key:
            return
        entry = self.session_store.lookup_by_session_key(session_key)
        source = getattr(entry, "origin", None)
        if (entry is not None and _platform(getattr(source, "platform", None)) == "telegram"
                and self.config.allows(getattr(source, "user_id", ""))
                and self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None),
                                        getattr(source, "user_id", ""))):
            await self._fail_stopped_agent_attempts(entry.session_id)

    async def incoming(self, event, **kwargs):
        """Отсекать чужие Telegram события до auth и публиковать вложения владельца."""
        source = getattr(event, "source", None)
        if _platform(getattr(source, "platform", None)) != "telegram":
            return None
        raw = getattr(event, "raw_message", None)
        if (not self._route_matches(getattr(source, "chat_id", None), getattr(source, "chat_type", None),
                                        getattr(source, "user_id", ""))
                or not self.config.allows(getattr(source, "user_id", ""))
                or getattr(source, "is_bot", False) or getattr(raw, "sender_chat", None)
                or getattr(raw, "business_connection_id", None)):
            return {"action": "skip", "reason": "brai-owner-route-only"}
        if kwargs.get("session_store") is not None:
            self.session_store = kwargs["session_store"]
        await self.recover_durable_agent_attempts()
        key = (str(source.chat_id), str(getattr(source, "thread_id", None) or ""), str(event.message_id))
        self.inbound_events[key] = event
        if len(self.inbound_events) > 128:
            self.inbound_events.pop(next(iter(self.inbound_events)))
        if "brai_files" in sys.modules:
            return None  # Файлы обрабатывает обязательная общая граница после native auth.
        paths = getattr(event, "media_urls", [])
        if not paths:
            return None
        descriptors, observed = [], []
        try:
            if len(paths) > MAX_ATTACHMENTS or not re.fullmatch(r"[1-9][0-9]*", str(event.message_id)):
                raise BridgeError("ATTACHMENT_LIMIT")
            for index, path in enumerate(paths):
                result = await asyncio.to_thread(self.bridge.call, "files.publish", {
                    "path": path, "requestId": f"tg:{source.chat_id}:{event.message_id}:{index}"})
                if not _uuid(result.get("artifactId")) or not isinstance(result.get("markdown"), str):
                    raise BridgeError("RPC_MALFORMED")
                match = self.descriptor.fullmatch(result["markdown"])
                if not match or match["id"] != result["artifactId"]:
                    raise BridgeError("RPC_MALFORMED")
                descriptors.append(result["markdown"])
                observed.append({"artifactId": result["artifactId"], "filename": result.get("filename") or match["name"],
                                 "mimeType": result.get("mimeType") or "application/octet-stream",
                                 "sizeBytes": result.get("sizeBytes")})
            if self.journal is not None:
                try:
                    await asyncio.to_thread(self.journal.attachments, source.chat_id, event.message_id, observed, "ready")
                except Exception:
                    logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")
            return {"action": "rewrite", "text": "\n\n".join([event.text or "", *descriptors]).strip()}
        except Exception as error:
            code = str(error) if isinstance(error, BridgeError) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,80}", str(error)) else "UNEXPECTED_ERROR"
            logging.getLogger(__name__).warning("BRAI_INBOUND_FILE_NOT_STORED code=%s count=%d", code, len(paths))
            if self.journal is not None:
                try:
                    await asyncio.to_thread(self.journal.attachments, source.chat_id, event.message_id, observed, "failed")
                except Exception:
                    logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")
            if code == "ATTACHMENT_LIMIT":
                try:
                    await self._on_native_loop(self._notify("Не удалось обработать вложения. В одном сообщении должно быть не больше десяти файлов.",
                        str(source.chat_id), str(getattr(source, "thread_id", None) or "")))
                except Exception:
                    pass
                return {"action": "skip", "reason": "brai-file-input-invalid"}
            # Native already downloaded these owner-authorized files. A storage failure
            # must not discard their media_urls or turn a received album into an empty turn.
            note = "[Состояние вложений: файлы получены и доступны в этом сообщении, но сохранение всех файлов в Brai не подтверждено.]"
            return {"action": "rewrite", "text": "\n\n".join([event.text or "", *descriptors, note]).strip()}

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
        if "brai_files" in sys.modules:
            return None
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
                                        get_session_env("HERMES_SESSION_CHAT_TYPE"),
                                        get_session_env("HERMES_SESSION_USER_ID"))
                    or not self.config.allows(get_session_env("HERMES_SESSION_USER_ID"))
                    or not all(isinstance(value, str) and value for value in (session_id, tool_call_id))):
                raise BridgeError("IMAGE_CONTEXT_INVALID")
            path = Path(payload.get("image", ""))
            root = Path(get_hermes_home()) / "cache/generated/images"
            if (not path.is_absolute() or path.parent != root or path.resolve() != path
                    or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}
                    or not stat.S_ISREG(path.lstat().st_mode)):
                raise BridgeError("IMAGE_PATH_INVALID")
            identity = json.dumps([self.config.owner, get_session_env("HERMES_SESSION_CHAT_ID"), session_id, tool_call_id],
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

    def outgoing(self, response_text, platform=None, session_id="", turn_id="", **kwargs):
        """Передавать явные файлы через publisher; неизменённый ответ оставить потоку."""
        if self.journal is not None and _platform(platform) == "telegram":
            try:
                from gateway.session_context import get_session_env
                entry = self._owner_session(session_id)
                chat_id = get_session_env("HERMES_SESSION_CHAT_ID")
                message_id = get_session_env("HERMES_SESSION_MESSAGE_ID")
                if (entry is not None and get_session_env("HERMES_SESSION_ID") == session_id
                        and str(entry.origin.chat_id) == str(chat_id) and message_id):
                    self.journal.link_session(chat_id, message_id, session_id)
            except Exception:
                logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_SESSION_UNAVAILABLE")
        if "brai_files" in sys.modules:
            return None
        if _platform(platform) != "telegram":
            return None
        deadline, seen, paths, count = time.monotonic() + OUTPUT_TIMEOUT, set(), set(), 0

        def replace(match):
            nonlocal count
            if match["code"] is not None:
                return match.group()
            try:
                reference = match
                raw = match["quoted"] or match["bare"]
                if raw:
                    if raw in paths:
                        return ""
                    paths.add(raw)
                    reference = self.result_path.fullmatch(raw)
                artifact_id = reference["id"] if reference else None
                if artifact_id in seen:
                    return ""
                count += 1
                if count > MAX_ATTACHMENTS:
                    raise BridgeError("ATTACHMENT_LIMIT")
                if reference:
                    result = self.bridge.call("files.fetch", {"artifactId": artifact_id},
                                          timeout=min(RPC_TIMEOUT, deadline - time.monotonic()))
                else:
                    if not Path(raw).is_absolute() or not session_id or not turn_id:
                        raise BridgeError("FILE_CONTEXT_INVALID")
                    from gateway.session_context import get_session_env
                    entry = self._owner_session(session_id)
                    if entry is not None:
                        chat_id = str(entry.origin.chat_id)
                    else:
                        chat_id = get_session_env("HERMES_SESSION_CHAT_ID")
                        if not self._route_matches(chat_id, get_session_env("HERMES_SESSION_CHAT_TYPE"),
                                                   get_session_env("HERMES_SESSION_USER_ID")):
                            raise BridgeError("FILE_CONTEXT_INVALID")
                    identity = json.dumps([self.config.owner, chat_id, session_id, turn_id, raw],
                                          ensure_ascii=False, separators=(",", ":"))
                    result = self.bridge.call("files.publish", {
                        "path": raw, "requestId": "tg-output:" + sha256(identity.encode()).hexdigest()},
                        timeout=min(RPC_TIMEOUT, deadline - time.monotonic()))
                    reference = self.descriptor.fullmatch(result.get("markdown", ""))
                    if not reference:
                        raise BridgeError("RPC_MALFORMED")
                    artifact_id = reference["id"]
                path = self._published_path(result, artifact_id, reference["name"])
                if artifact_id in seen:
                    return ""
                seen.add(artifact_id)
                # AIDEV-NOTE: Штатный parser принимает quoted paths с пробелами и Unicode.
                voice = "[[audio_as_voice]]\n" if Path(path).suffix.lower() in {".ogg", ".opus"} else ""
                return f'\n{voice}MEDIA:"{path}"\n'
            except Exception:
                return "[Файл не отправлен: Brai не подтвердил доступ к артефакту.]"

        rewritten = self.output_files.sub(replace, response_text)
        # Native Hermes treats any string as a transformed final, even if equal.
        return rewritten if rewritten != response_text else None

    def _tool_context(self, kwargs):
        """Доверенный маршрут текущего native turn; аргументы модели его не задают."""
        from gateway.session_context import get_session_env
        # Native cached agent не восстанавливает ContextVar ID; dispatcher передаёт его отдельно.
        bound_id = get_session_env("HERMES_SESSION_ID")
        dispatch_id = kwargs.get("session_id", "")
        if (not isinstance(dispatch_id, str)
                or (dispatch_id and bound_id and dispatch_id != bound_id)):
            raise BridgeError("SESSION_CONTEXT_INVALID")
        context = {key: get_session_env(name) for key, name in (
            ("session_key", "HERMES_SESSION_KEY"), ("session_id", "HERMES_SESSION_ID"),
            ("thread_id", "HERMES_SESSION_THREAD_ID"), ("chat_id", "HERMES_SESSION_CHAT_ID"))}
        context["session_id"] = dispatch_id or bound_id
        context["message_id"] = get_session_env("HERMES_SESSION_MESSAGE_ID")
        if (get_session_env("HERMES_SESSION_PLATFORM") != "telegram"
                or not self.config.allows(get_session_env("HERMES_SESSION_USER_ID"))
                or not self._route_matches(get_session_env("HERMES_SESSION_CHAT_ID"),
                                           get_session_env("HERMES_SESSION_CHAT_TYPE"),
                                           get_session_env("HERMES_SESSION_USER_ID"))
                or not self._session_matches({**context, "owner": self.config.owner})):
            raise BridgeError("SESSION_CONTEXT_INVALID")
        return context

    async def request_confirmation(self, args, **kwargs):
        """Дать модели только отправку кнопок; завершение доступно только callback handler."""
        try:
            if (not isinstance(args, dict) or set(args) - {"moveId", "revisionId", "stage"}
                    or not _uuid(args.get("moveId")) or not _uuid(args.get("revisionId"))
                    or args.get("stage", "planning") not in {"planning", "final", "review", "clarification"}):
                raise BridgeError("INVALID_ARGUMENT")
            context = self._tool_context(kwargs)
            result = await self._on_native_loop(self._request(args, context))
            if json.loads(result).get("ok"):
                # Public MessageEvent: this exact inbound request has received its reply.
                key = (context["chat_id"], context["thread_id"], context["message_id"])
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

    async def submit_feedback(self, args, **kwargs):
        """Модель выбирает смысл; текст и происхождение берём из реального сообщения."""
        try:
            if (not isinstance(args, dict) or set(args) - {"elementId", "revisionId", "moveId", "decision"}
                    or not _uuid(args.get("elementId")) or not _uuid(args.get("revisionId"))
                    or args.get("decision") not in {"changes", "cancelled", "clarify"}
                    or (args.get("decision") in {"changes", "clarify"} and not _uuid(args.get("moveId")))
                    or ("moveId" in args and not _uuid(args["moveId"]))):
                raise BridgeError("INVALID_ARGUMENT")
            context = self._tool_context(kwargs)
            return await self._on_native_loop(self._feedback(args, context))
        except Exception:
            return json.dumps({"ok": False, "code": "FEEDBACK_UNCONFIRMED",
                               "message": "Решение не подтверждено. Перечитай состояние задачи; не продолжай работу вслепую."}, ensure_ascii=False)

    async def submit_result(self, args, **kwargs):
        """Записывает практический результат из текущего реального owner MessageEvent."""
        try:
            if (not isinstance(args, dict) or set(args) != {"moveId", "revisionId"}
                    or not _uuid(args.get("moveId")) or not _uuid(args.get("revisionId"))):
                raise BridgeError("INVALID_ARGUMENT")
            context = self._tool_context(kwargs)
            return await self._on_native_loop(self._result(args, context))
        except Exception as error:
            code = str(error) if isinstance(error, BridgeError) and str(error) in {
                "INVALID_ARGUMENT", "HUMAN_FINAL_DECISION_REQUIRED", "HUMAN_OUTPUT_MAPPING_REQUIRED",
                "STALE_ACTION", "OWNER_MESSAGE_REQUIRED", "OUTCOME_UNKNOWN"} else "RESULT_UNCONFIRMED"
            message = ("Напиши явно: «принимаю результат» или «нужно доработать»." if code == "HUMAN_FINAL_DECISION_REQUIRED"
                else "Для нескольких результатов пришли JSON с точными названиями всех выходов и отдельным полем decision (success или changes)." if code == "HUMAN_OUTPUT_MAPPING_REQUIRED"
                else "Практический результат не подтверждён. Проверь текущий Ход и его состояние.")
            return json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False)

    async def _result(self, args, context):
        key = (context["chat_id"], context["thread_id"], context["message_id"])
        event = self.inbound_events.get(key)
        content = getattr(event, "text", None) if event is not None else None
        if not isinstance(content, str) or not content.strip() or len(content) > 16000:
            raise BridgeError("OWNER_MESSAGE_REQUIRED")
        source = {"platform": "telegram", "chat_id": context["chat_id"], "thread_id": context["thread_id"], "message_id": context["message_id"]}
        pending = self.tokens.human_result(self.config.owner, args["moveId"])
        if pending and (pending["revision_id"] != args["revisionId"]):
            self.tokens.clear_human_result(self.config.owner, args["moveId"])
            pending = None
        signature = {**args, "content": content}
        if key in self.feedback_results:
            previous, result = self.feedback_results[key]
            if previous != signature:
                raise BridgeError("FEEDBACK_ALREADY_USED")
            return result
        call = {**args, "content": content, "source": source}
        if pending:
            try:
                action = await asyncio.to_thread(self.bridge.call, "actions.read", {"moveId": args["moveId"]})
            except Exception:
                # Keep the exact report if the owner graph is temporarily unavailable.
                raise
            if (action.get("revisionId") != args["revisionId"]
                    or action.get("revisionId") != pending["revision_id"]
                    or action.get("attemptId") != pending["attempt_id"]
                    or action.get("attemptStatus") != "running"
                    or action.get("attemptExecutorKind") != "human"):
                self.tokens.clear_human_result(self.config.owner, args["moveId"])
                raise BridgeError("STALE_ACTION")
            if pending["attempt_id"] == "" or not re.search(r"(?:принимаю|всё принимаю|все принимаю|результат принят|всё готово|все готово|есть замечания|нужно доработать|не принимаю|не принято)", content, re.I):
                raise BridgeError("HUMAN_FINAL_DECISION_REQUIRED")
            call.update(content=pending["content"], source=json.loads(pending["source_json"]), decisionText=content, decisionSource=source)
        try:
            result = await asyncio.to_thread(self.bridge.call, "actions.result", call)
        except BridgeError as error:
            if str(error) == "HUMAN_FINAL_DECISION_REQUIRED" and not pending:
                action = await asyncio.to_thread(self.bridge.call, "actions.read", {"moveId": args["moveId"]})
                if action.get("revisionId") != args["revisionId"] or action.get("attemptStatus") != "running" or action.get("attemptExecutorKind") != "human":
                    raise BridgeError("STALE_ACTION")
                self.tokens.save_human_result(self.config.owner, args["moveId"], args["revisionId"], action["attemptId"], content, source)
                return json.dumps({"ok": True, "status": "awaiting_decision", "next": "Фактический отчёт сохранён. Явно напиши: принимаю результат или нужно доработать."}, ensure_ascii=False)
            if pending and str(error) == "STALE_ACTION":
                self.tokens.clear_human_result(self.config.owner, args["moveId"])
            raise
        if result.get("attempt", {}).get("status") != "succeeded":
            raise BridgeError("RESULT_UNCONFIRMED")
        if pending:
            self.tokens.clear_human_result(self.config.owner, args["moveId"])
        attempt_id = result.get("attempt", {}).get("id")
        if _uuid(attempt_id):
            self.tokens.resolve_attempt(self.config.owner, attempt_id)
        response = json.dumps({"ok": True, "moveId": args["moveId"], "next": "Практический результат и явное решение владельца сохранены в Brai."}, ensure_ascii=False)
        self.feedback_results[key] = (signature, response)
        return response

    async def _feedback(self, args, context):
        key = (context["chat_id"], context["thread_id"], context["message_id"])
        event = self.inbound_events.get(key)
        if event is None or not isinstance(getattr(event, "text", None), str) or not event.text.strip() or len(event.text) > 16000:
            raise BridgeError("OWNER_MESSAGE_REQUIRED")
        signature = {**args, "text": event.text}
        if key in self.feedback_results:
            previous, result = self.feedback_results[key]
            if previous != signature:
                raise BridgeError("FEEDBACK_ALREADY_USED")
            return result
        if key in self.feedback_inflight:
            raise BridgeError("FEEDBACK_PENDING")
        self.feedback_inflight.add(key)
        clarification = None
        try:
            if args["decision"] == "clarify":
                candidates = [row for row in self.tokens.pending() if row["stage"] == "clarification"
                    and row["move_id"] == args["moveId"] and row["target_id"] == args["elementId"]
                    and row["revision_id"] == args["revisionId"] and row["session_id"] == context["session_id"]
                    and row["thread_id"] == context["thread_id"] and row["chat_id"] == context["chat_id"]
                    and not row["consumed"]
                    and await asyncio.to_thread(self._session_matches, row)]
                if len(candidates) != 1:
                    raise BridgeError("CLARIFICATION_NOT_PENDING")
                clarification = self.tokens.reserve_clarification(candidates[0]["token"], self.config.owner,
                    context["session_id"], context["thread_id"], args["moveId"], args["elementId"], args["revisionId"])
                if clarification is None:
                    raise BridgeError("CLARIFICATION_NOT_PENDING")
            # Same actual owner message has one durable request ID, independent of model retries.
            value = sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
            request_id = f"{value[:8]}-{value[8:12]}-5{value[13:16]}-a{value[17:20]}-{value[20:32]}"
            result = await asyncio.to_thread(self.bridge.call, "actions.feedback", {**args, "feedback": {
                "id": request_id, "content": event.text, "source": {"platform": "telegram",
                "chat_id": context["chat_id"], "thread_id": context["thread_id"], "message_id": context["message_id"]}}})
            if args["decision"] == "cancelled":
                if result.get("id") != args["elementId"] or result.get("status") != "cancelled":
                    raise BridgeError("FEEDBACK_UNCONFIRMED")
                targets = set(result.get("element_ids", [args["elementId"]]))
            else:
                if result.get("attempt", {}).get("status") != "succeeded":
                    raise BridgeError("FEEDBACK_UNCONFIRMED")
                targets = {args["elementId"]}
                if clarification:
                    self.tokens.resolve(clarification["token"])
            for row in self.tokens.pending():
                if row["target_id"] in targets:
                    self.tokens.consume(row["token"])
                    self.tokens.resolve(row["token"])
                    if self.bot and row["message_id"]:
                        try:
                            await self.bot.edit_message_reply_markup(chat_id=int(row["chat_id"]),
                                message_id=int(row["message_id"]), reply_markup=None)
                        except Exception:
                            pass  # Owner state already makes the old button invalid.
            next_step = ("Прочитай доступные Ходы и выполни доработку; затем покажи её на подтверждение."
                if args["decision"] == "changes" else "Продолжи постановку по сохранённому ответу владельца."
                if args["decision"] == "clarify" else "Задача и невыполненное продолжение отменены. Сохрани краткий ответ пользователю.")
            response = json.dumps({"ok": True, "decision": args["decision"], "elementId": args["elementId"], "next": next_step}, ensure_ascii=False)
            self.feedback_results[key] = (signature, response)
            if len(self.feedback_results) > 128:
                self.feedback_results.pop(next(iter(self.feedback_results)))
            return response
        finally:
            self.feedback_inflight.discard(key)

    async def _request(self, args, context):
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        stage = args.get("stage", "planning")
        existing = None
        for pending in self.tokens.pending():
            if pending["move_id"] != args["moveId"]:
                continue
            if (pending["chat_id"] != context["chat_id"] or pending["thread_id"] != context["thread_id"]
                    or pending["session_id"] != context["session_id"]):
                raise BridgeError("CONFIRMATION_PENDING")
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
            self.config.owner, {**args, "attemptId": ""}, stage, context["chat_id"], context)
        try:
            action = await self._prepare(self.tokens.unresolved(token))
            stage = self.tokens.unresolved(token)["stage"]
            if action.get("confirmationStage", stage) is None:
                if not action.get("outputContracts") or action.get("decision") == "confirm":
                    raise BridgeError("HUMAN_OUTPUT_REQUIRED")
                stage = "work"
                self.tokens.set_stage(token, stage)
            if not await self._current(self.tokens.unresolved(token)):
                raise BridgeError("STALE_ACTION")
            buttons = None if stage in {"clarification", "work"} else [[InlineKeyboardButton(
                "Принять", callback_data=f"brai:{token}:{'success' if stage == 'final' else 'approved'}")]]
            context = str(action.get("targetDescription") or "")[:1400]
            title = str(action.get("targetTitle") or "")[:400]
            stage_label = {"planning": "План работы", "review": "Проверка результата", "final": "Готовый результат",
                           "clarification": "Уточнение поручения", "work": "Практическая работа"}[stage]
            if stage in {"review", "final"} and not isinstance(action.get("confirmationText"), str):
                raise BridgeError("HUMAN_OUTPUT_REQUIRED")
            if action.get("confirmationText") is not None:
                preview = action["confirmationText"]
                if not isinstance(preview, str) or not preview.strip():
                    raise BridgeError("HUMAN_OUTPUT_REQUIRED")
                text = f"**{stage_label}**\n\n{preview}"
            else:
                text = f"{stage_label}: {action['title'][:800]}\n{title}\n{context}\n"
            if stage == "work":
                footer = ("Выполни это практическое действие и пришли фактический результат обычным сообщением. "
                          "Если это итоговое действие, явно укажи, принимаешь ли результат или нужны изменения.")
            elif stage == "clarification":
                footer = "Ответь на уточнение обычным сообщением; замечания или отмену тоже напиши текстом."
            elif action.get("confirmationText") is None:
                footer = "Замечания или отмену задачи напиши сообщением."
            else:
                footer = ""
            if footer:
                text += ("\n\n" if action.get("confirmationText") is not None else "") + footer
            thread_id = self.tokens.unresolved(token)["thread_id"]
            route = {"message_thread_id": int(thread_id)} if thread_id and str(thread_id) != "1" else {}
            # Файлы проходят через общий owner-bound Artifacts и тот же журнал доставки, что обычные ответы.
            files = sys.modules.get("brai_files")
            artifact_ids = action.get("confirmationFiles", [])
            if not isinstance(artifact_ids, list) or any(not _uuid(value) for value in artifact_ids):
                raise BridgeError("INVALID_ARTIFACTS")
            if files is not None:
                route_id = self.tokens.unresolved(token)["chat_id"]
                stable = json.dumps([self.config.owner, route_id, thread_id, action["moveId"],
                                     action["revisionId"], text, artifact_ids], ensure_ascii=False)
                identity = "confirmation:" + sha256(stable.encode()).hexdigest()
                prepared = await asyncio.to_thread(files.final_text, text, identity)
                paths = []
                def take_file(match):
                    paths.append(next(value for value in match.groups() if value is not None))
                    return ""
                text = files.active_sub(files._MEDIA, take_file, prepared).strip()
                if self.config.result_root in text:
                    raise BridgeError("FILE_REFERENCE_UNRECOGNIZED")
                items, mode = await asyncio.to_thread(files.output_items, paths) if paths else ([], "files")
                seen = {item["file"]["artifactId"] for item in items}
                for artifact_id in artifact_ids:
                    if artifact_id not in seen:
                        value = await asyncio.to_thread(files.resolve_artifact, artifact_id, identity)
                        items.append({"file": files.store().checked(value), "caption": "",
                                      "presentation": files.presentation(value)})
                        seen.add(artifact_id)
                if items:
                    delivery = await files.send_set(self.adapter, route_id, items, mode,
                                                    {"thread_id": thread_id} if thread_id else {}, identity)
                    if not delivery.success:
                        raise BridgeError("FILE_DELIVERY_UNCONFIRMED")
            elif artifact_ids or self.output_files.search(text):
                raise BridgeError("FILE_DELIVERY_UNAVAILABLE")
            if self.config.result_root in text:
                raise BridgeError("FILE_REFERENCE_UNRECOGNIZED")
            # Форматирование и разбиение выполняет закреплённый Telegram adapter; обычный текст не является fallback.
            formatted = self.adapter.format_message(text)
            chunks = self.adapter.truncate_message(formatted, 4096, len_fn=lambda value: len(value.encode("utf-16-le")) // 2)
            if len(chunks) > 1:
                chunks = [re.sub(r" \((\d+)/(\d+)\)$", r" \\(\1/\2\\)", chunk) for chunk in chunks]
                chunks = [re.sub(r"(?m)^``` (\\\(\d+/\d+\\\))$", r"```\n\1", chunk) for chunk in chunks]
            for index, chunk in enumerate(chunks):
                keyboard = {"reply_markup": InlineKeyboardMarkup(buttons)} if buttons and index == len(chunks) - 1 else {}
                if existing and len(chunks) == 1:
                    from telegram.error import BadRequest
                    try:
                        await self.bot.edit_message_text(chat_id=int(self.tokens.unresolved(token)["chat_id"]),
                            message_id=int(existing["message_id"]), text=chunk, parse_mode="MarkdownV2", **keyboard,
                            connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)
                    except BadRequest as error:
                        if "message is not modified" not in str(error).lower():
                            raise
                else:
                    message = await self.bot.send_message(chat_id=int(self.tokens.unresolved(token)["chat_id"]), text=chunk, **route,
                        parse_mode="MarkdownV2", **keyboard, connect_timeout=5, read_timeout=10, write_timeout=10, pool_timeout=5)
                    self.tokens.bind(token, message.message_id)
                from types import SimpleNamespace
                sent_id = existing["message_id"] if existing and len(chunks) == 1 else message.message_id
                await self.observe_send(self.tokens.unresolved(token)["chat_id"], route, chunk,
                                        SimpleNamespace(success=True, message_id=sent_id))
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
        if stage is not None and stage not in {"planning", "final", "clarification"}:
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
                or not self._route_matches(getattr(chat, "id", None), getattr(chat, "type", None),
                    getattr(getattr(query, "from_user", None), "id", ""))
                or not self.config.allows(getattr(getattr(query, "from_user", None), "id", ""))
                or getattr(getattr(query, "from_user", None), "is_bot", False)
                or getattr(message, "sender_chat", None)
                or getattr(message, "business_connection_id", None)):
            return
        data = getattr(query, "data", "")
        match = re.fullmatch(r"brai:([A-Za-z0-9_-]{32}):(approved|success)", data or "")
        if not match or len(data.encode("utf-8")) > 64:
            await query.answer("Используй «Принять». Замечания и отмену напиши сообщением.", show_alert=True)
            return
        row = self.tokens.consume(match[1], self.config.owner, getattr(message, "message_id", None), str(chat.id),
                                  str(getattr(message, "message_thread_id", None) or ""))
        if row is None:
            await query.answer("Кнопка уже использована или не относится к сообщению.", show_alert=True)
            return
        decision = match[2]
        self.active_callbacks.add(match[1])
        allowed = {"success"} if row["stage"] == "final" else {"approved"}
        notice = FAILURE
        try:
            await query.answer("Проверяю подтверждение…")
            if decision not in allowed:
                raise BridgeError("INVALID_DECISION")
            if not await asyncio.to_thread(self._session_matches, row) or not await self._current(row):
                await self._cancel(row, "cancelled")
                self.tokens.resolve(match[1])
                notice = "Задача, версия или исходная беседа изменились. Работа не запущена."
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


def file_rpc(method, params, timeout):
    """Внутренний файловый порт owner MCP без полномочий human actions."""
    if method not in {'files.configuration', 'files.publish', 'files.fetch', 'files.get', 'files.list', 'files.prepare'}:
        raise BridgeError('FORBIDDEN')
    return sys.modules['_brai_codeworks_gateway'].call_plugin(method, params, timeout)


def register(ctx):
    """Подключить плагин через публичный API закреплённого Hermes."""
    from types import SimpleNamespace
    sys.modules['_brai_hermes_file_port'] = SimpleNamespace(call=file_rpc)
    plugin = TelegramPlugin(Config.from_env(), inject_message=getattr(ctx, "inject_message", None))
    ctx.register_telegram_handler(plugin.factory)
    ctx.register_hook("pre_gateway_dispatch", plugin.incoming)
    ctx.register_hook("transform_llm_output", plugin.outgoing)
    ctx.register_hook("transform_tool_result", plugin.tool_result)
    ctx.register_hook("post_llm_call", plugin.observe_resume)
    ctx.register_hook("post_tool_call", plugin.observe_agent_move)
    ctx.register_hook("on_session_end", plugin.on_session_end)
    ctx.register_hook("agent_loop_stopped", plugin.agent_loop_stopped)
    ctx.register_tool(name="brai_telegram_request_confirmation", toolset="brai_telegram",
        description=CONFIRMATION_DESCRIPTION,
        schema={"name": "brai_telegram_request_confirmation", "description": CONFIRMATION_DESCRIPTION,
                "parameters": {"type": "object", "properties": {"moveId": {"type": "string"},
                    "revisionId": {"type": "string"}, "stage": {"type": "string", "enum": ["planning", "final", "review", "clarification"]}},
                    "required": ["moveId", "revisionId"], "additionalProperties": False}},
        handler=plugin.request_confirmation, is_async=True)
    ctx.register_tool(name="brai_telegram_submit_feedback", toolset="brai_telegram",
        description="Record explicit owner remarks, cancellation, or a plain-text answer to a current clarification Action from the current Telegram message. Questions and discussion are not decisions. Read current graph first. Text and provenance are taken from the actual incoming owner message, never supply a comment. For changes or clarification pass the exact current moveId. Positive plan/result acceptance is only the Accept button. After changes execute the available correction and request fresh acceptance; after cancellation stop the task.",
        schema={"name": "brai_telegram_submit_feedback", "parameters": {"type": "object", "additionalProperties": False,
            "properties": {"elementId": {"type": "string"}, "revisionId": {"type": "string"},
                           "moveId": {"type": "string"}, "decision": {"enum": ["changes", "cancelled", "clarify"]}},
            "required": ["elementId", "revisionId", "decision"]}},
        handler=plugin.submit_feedback, is_async=True)
    ctx.register_tool(name="brai_telegram_submit_result", toolset="brai_telegram",
        description="Record practical human work from the actual current Telegram owner message. Pass only the exact moveId and revisionId; content and provenance come from the real message and cannot be supplied by the model. For one output, the whole message is the output. For a final one-output Action, the message must explicitly say it is accepted or needs changes. For multiple outputs, send a JSON object using every exact output contract name and, for final Actions, a separate decision field with success or changes. Never use this to turn a button click into evidence of practical work.",
        schema={"name": "brai_telegram_submit_result", "parameters": {"type": "object", "additionalProperties": False,
            "properties": {"moveId": {"type": "string"}, "revisionId": {"type": "string"}},
            "required": ["moveId", "revisionId"]}},
        handler=plugin.submit_result, is_async=True)
    ctx.on_unload(plugin.close)
