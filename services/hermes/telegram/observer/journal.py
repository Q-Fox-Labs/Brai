# ABOUTME: Сохраняет разрешённые сообщения Telegram для просмотра в Brai.
# ABOUTME: Журнал принадлежит Hermes; повтор событий не меняет переписку и не содержит байтов файлов.
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import threading


def _timestamp(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return None


def _text(value):
    return value if isinstance(value, str) else ""


def message_type(message):
    """Классифицировать исходный payload без чтения или сохранения его содержимого."""
    for field in ("photo", "document", "video", "audio", "voice", "sticker", "location", "venue"):
        if getattr(message, field, None):
            return field
    if getattr(message, "text", None):
        return "text"
    for field in ("animation", "video_note", "contact", "poll", "dice", "game", "story", "paid_media"):
        if getattr(message, field, None):
            return "unsupported:" + field
    service_fields = (
        "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
        "group_chat_created", "supergroup_chat_created", "channel_chat_created", "message_auto_delete_timer_changed",
        "migrate_to_chat_id", "migrate_from_chat_id", "pinned_message", "forum_topic_created", "forum_topic_closed",
        "forum_topic_reopened", "forum_topic_edited", "general_forum_topic_hidden", "general_forum_topic_unhidden",
        "write_access_allowed", "users_shared", "chat_shared", "video_chat_started", "video_chat_ended",
        "video_chat_scheduled", "video_chat_participants_invited", "successful_payment", "refunded_payment",
    )
    return "service" if any(getattr(message, field, None) for field in service_fields) else "unknown"


class TelegramJournal:
    """Хранить сообщения и последовательность изменений в отдельной SQLite с WAL."""

    def __init__(self, directory):
        """Открыть каталог профиля; данные переживают обновление кода Hermes."""
        self._outgoing_lock = threading.RLock()
        self.directory = Path(directory)
        if not self.directory.is_absolute() or self.directory.is_symlink():
            raise ValueError("INVALID_JOURNAL_DIRECTORY")
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "observer.sqlite3"
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS messages (
                  identity TEXT PRIMARY KEY, chat_id TEXT NOT NULL, thread_id TEXT NOT NULL,
                  chat_type TEXT NOT NULL, chat_name TEXT NOT NULL, author_id TEXT NOT NULL,
                  author_name TEXT NOT NULL, direction TEXT NOT NULL, telegram_id TEXT,
                  session_id TEXT NOT NULL, text TEXT NOT NULL, occurred_at TEXT,
                  edited_at TEXT, delivery TEXT NOT NULL, attachment_state TEXT NOT NULL,
                  attachments TEXT NOT NULL, group_id TEXT NOT NULL, changed_seq INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS changes (
                  seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL,
                  FOREIGN KEY(identity) REFERENCES messages(identity)
                );
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, thread_id, occurred_at, identity);
                CREATE INDEX IF NOT EXISTS changes_identity ON changes(identity, seq);
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
            if "message_type" not in columns:
                # AIDEV-NOTE: Старый журнал не хранит raw update; его пустым сообщениям нельзя угадывать тип.
                db.execute("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'unknown'")
        os.chmod(self.path, 0o600)

    def history_complete(self):
        """Вернуть признак завершённого импорта штатной истории."""
        with self.db() as db:
            return db.execute("SELECT 1 FROM settings WHERE key='history_complete' AND value='2'").fetchone() is not None

    def mark_history_complete(self):
        """Сохранить завершение импорта после успешного чтения всех страниц."""
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('history_complete','2')")

    @contextmanager
    def db(self):
        """Создать отдельное соединение для каждого потока и ограничить ожидание блокировки."""
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        finally:
            db.close()

    def record(self, value, *, only_if_new=False):
        """Сохранить единственное событие с устойчивой identity и вернуть номер изменения."""
        fields = ("identity", "chat_id", "thread_id", "chat_type", "chat_name", "author_id",
                  "author_name", "direction", "telegram_id", "session_id", "text", "occurred_at",
                  "edited_at", "delivery", "attachment_state", "attachments", "group_id", "message_type")
        if not value.get("identity") or not value.get("chat_id"):
            raise ValueError("INVALID_MESSAGE")
        value = {name: value.get(name, "") for name in fields}
        value["message_type"] = value["message_type"] or "unknown"
        value["attachments"] = json.dumps(value["attachments"] or [], ensure_ascii=False, separators=(",", ":"))
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM messages WHERE identity=?", (value["identity"],)).fetchone()
            if old:
                if only_if_new:
                    return old["changed_seq"]
                # AIDEV-NOTE: Повтор Telegram не должен затирать уже подтверждённые вложения или позднюю правку.
                previous = json.loads(old["attachments"])
                current = json.loads(value["attachments"])
                if previous and current:
                    merged = previous + [item for item in current if item not in previous]
                    value["attachments"] = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
                elif previous and value["attachment_state"] == "failed":
                    value["attachments"] = old["attachments"]
                if old["direction"] == "out":
                    value["occurred_at"] = old["occurred_at"]
                    if old["delivery"] == "sent" and value["delivery"] != "sent":
                        value["delivery"], value["telegram_id"] = old["delivery"], old["telegram_id"]
                    if not value["text"]:
                        value["text"] = old["text"]
                if old["edited_at"] and (not value["edited_at"] or old["edited_at"] > value["edited_at"]):
                    value["text"], value["edited_at"] = old["text"], old["edited_at"]
                if old["attachment_state"] in {"ready", "failed"} and value["attachment_state"] in {"", "none", "pending"}:
                    value["attachment_state"], value["attachments"] = old["attachment_state"], old["attachments"]
                if not value["session_id"]:
                    value["session_id"] = old["session_id"]
                if value["message_type"] == "unknown":
                    value["message_type"] = old["message_type"]
                if all(old[name] == value[name] for name in fields):
                    return old["changed_seq"]
                columns = ", ".join(f"{name}=?" for name in fields[1:])
                db.execute(f"UPDATE messages SET {columns} WHERE identity=?",
                           [value[name] for name in fields[1:]] + [value["identity"]])
            else:
                db.execute(f"INSERT INTO messages ({', '.join(fields)}) VALUES ({', '.join('?' for _ in fields)})",
                           [value[name] for name in fields])
            seq = db.execute("INSERT INTO changes(identity) VALUES (?)", (value["identity"],)).lastrowid
            db.execute("UPDATE messages SET changed_seq=? WHERE identity=?", (seq, value["identity"]))
            return seq

    def import_record(self, value):
        """Добавить подтверждённые сведения к импорту, не заменяя живое сообщение."""
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM messages WHERE identity=?", (value["identity"],)).fetchone()
            if row is None:
                fields = ("identity", "chat_id", "thread_id", "chat_type", "chat_name", "author_id", "author_name",
                          "direction", "telegram_id", "session_id", "text", "occurred_at", "edited_at", "delivery",
                          "attachment_state", "attachments", "group_id")
                data = {name: value.get(name, "") for name in fields}
                data["attachments"] = json.dumps(data["attachments"] or [], ensure_ascii=False, separators=(",", ":"))
                db.execute(f"INSERT INTO messages ({', '.join(fields)}) VALUES ({', '.join('?' for _ in fields)})", [data[name] for name in fields])
                seq = db.execute("INSERT INTO changes(identity) VALUES (?)", (value["identity"],)).lastrowid
                db.execute("UPDATE messages SET changed_seq=? WHERE identity=?", (seq, value["identity"]))
                return
            refs = json.loads(row["attachments"])
            known = {ref.get("artifactId") for ref in refs}
            for ref in value["attachments"]:
                if ref.get("artifactId") not in known:
                    refs.append(ref)
                    known.add(ref.get("artifactId"))
            state = "ready" if refs and row["attachment_state"] in {"none", "unavailable"} else row["attachment_state"]
            author_id = row["author_id"] or value["author_id"]
            author_name = row["author_name"] or value["author_name"]
            encoded = json.dumps(refs, ensure_ascii=False, separators=(",", ":"))
            if (encoded, state, author_id, author_name) == (row["attachments"], row["attachment_state"], row["author_id"], row["author_name"]):
                return
            seq = db.execute("INSERT INTO changes(identity) VALUES (?)", (value["identity"],)).lastrowid
            db.execute("UPDATE messages SET attachments=?, attachment_state=?, author_id=?, author_name=?, changed_seq=? WHERE identity=?",
                       (encoded, state, author_id, author_name, seq, value["identity"]))

    def incoming(self, message, chat, user):
        """Зафиксировать исходный Telegram message после проверки маршрута и пользователя."""
        mid = getattr(message, "message_id", None)
        chat_id = getattr(chat, "id", None)
        if mid is None or chat_id is None:
            return
        media = any(getattr(message, field, None) for field in
                    ("photo", "document", "video", "audio", "voice", "sticker"))
        full_name = getattr(user, "full_name", None) or getattr(user, "username", None) or str(getattr(user, "id", ""))
        thread = str(getattr(message, "message_thread_id", None) or "")
        self.record({"identity": f"telegram:{chat_id}:{mid}", "chat_id": str(chat_id),
                     "thread_id": "" if thread == "1" else thread,
                     "chat_type": _text(getattr(chat, "type", "")),
                     "chat_name": _text(getattr(chat, "title", "")) or full_name,
                     "author_id": str(getattr(user, "id", "")), "author_name": full_name,
                     "direction": "in", "telegram_id": str(mid), "session_id": "",
                     "text": _text(getattr(message, "text", None) or getattr(message, "caption", None)),
                     "occurred_at": _timestamp(getattr(message, "date", None)),
                     "edited_at": _timestamp(getattr(message, "edit_date", None)),
                     "delivery": "received", "attachment_state": "pending" if media else "none",
                     "attachments": [], "group_id": str(getattr(message, "media_group_id", None) or ""),
                     "message_type": message_type(message)})

    def attachments(self, chat_id, message_id, attachments, state="ready"):
        """Привязать проверенные artifactId к уже сохранённому исходному сообщению."""
        identity = f"telegram:{chat_id}:{message_id}"
        with self.db() as db:
            row = db.execute("SELECT * FROM messages WHERE identity=?", (identity,)).fetchone()
        if not row:
            return
        value = dict(row)
        value["attachment_state"], value["attachments"] = state, attachments
        self.record(value)

    def link_session(self, chat_id, message_id, session_id):
        """Связать сообщение с подтверждённой native сессией, не меняя её при повторе."""
        if not chat_id or not message_id or not session_id:
            return
        with self.db() as db:
            row = db.execute("SELECT * FROM messages WHERE identity=? AND direction='in'",
                             (f"telegram:{chat_id}:{message_id}",)).fetchone()
        if not row or row['session_id']:
            return
        value = dict(row)
        value['session_id'] = str(session_id)
        value['attachments'] = json.loads(value['attachments'])
        self.record(value)

    def outgoing(self, chat_id, thread_id, text, message_id, delivery, attachments=(), identity=None):
        """Сохранить подтверждённую отправку или явно отметить неизвестный исход."""
        if not chat_id or not (message_id or identity):
            return
        pending_id = f"pending:{identity}" if identity else None
        canonical = f"telegram:{chat_id}:{message_id}" if message_id else None
        with self._outgoing_lock:
            with self.db() as db:
                db.execute("BEGIN IMMEDIATE")
                pending = pending_id and db.execute("SELECT 1 FROM messages WHERE identity=?", (pending_id,)).fetchone()
                existing = message_id and db.execute("SELECT identity, thread_id FROM messages WHERE chat_id=? AND telegram_id=? AND direction='out' ORDER BY rowid LIMIT 1", (str(chat_id), str(message_id))).fetchone()
                item_id = pending_id if pending else existing["identity"] if existing else canonical or pending_id
                # A direct Bot observation can arrive before a queued receipt. Keep the
                # pending identity and move its already recorded Telegram changes to it.
                duplicate = canonical and item_id != canonical and db.execute("SELECT * FROM messages WHERE identity=? AND direction='out'", (canonical,)).fetchone()
                if duplicate:
                    attachments = list(attachments) + [ref for ref in json.loads(duplicate["attachments"]) if ref not in attachments]
                    if not text:
                        text = duplicate["text"]
                    db.execute("UPDATE changes SET identity=? WHERE identity=?", (item_id, canonical))
                    db.execute("DELETE FROM messages WHERE identity=?", (canonical,))
            thread = str(thread_id or (existing["thread_id"] if existing else "") or "")
            self.record({"identity": item_id, "chat_id": str(chat_id), "thread_id": "" if thread == "1" else thread,
                         "chat_type": "group" if str(chat_id).startswith("-") else "private", "chat_name": "",
                         "author_id": "brai", "author_name": "Brai", "direction": "out",
                         "telegram_id": str(message_id) if message_id else None, "session_id": "", "text": _text(text),
                         "occurred_at": datetime.now(timezone.utc).isoformat(), "edited_at": None,
                         "delivery": delivery, "attachment_state": "ready" if attachments else "none",
                         "attachments": list(attachments), "group_id": ""})
