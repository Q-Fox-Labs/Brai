# ABOUTME: Проверяет журнал и безопасное восстановление истории Telegram.
# ABOUTME: Использует только синтетические сообщения и временную SQLite.
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import tempfile
import json
import sqlite3
from types import SimpleNamespace
import unittest

HERE = Path(__file__).resolve().parents[1] / "observer"


def load(name):
    spec = importlib.util.spec_from_file_location("observer_test_" + name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


journal_module, history = load("journal"), load("history")


class JournalTest(unittest.TestCase):
    """Покрывает повторы, изменения и сохранность данных при импорте."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = journal_module.TelegramJournal(Path(self.temp.name))
        self.chat = SimpleNamespace(id=123, type="private", title=None)
        self.user = SimpleNamespace(id=123, full_name="Анна")

    def message(self, text="Привет", edited=None):
        return SimpleNamespace(message_id=44, text=text, date=datetime(2026, 1, 1, tzinfo=timezone.utc), edit_date=edited, photo=[1])

    def test_duplicate_edit_and_attachment_do_not_erase_each_other(self):
        self.journal.incoming(self.message(), self.chat, self.user)
        self.journal.incoming(self.message(), self.chat, self.user)
        ref = {"artifactId": "00000000-0000-4000-8000-000000000001", "filename": "a.png", "mimeType": "image/png"}
        self.journal.attachments(123, 44, [ref])
        self.journal.incoming(self.message("Изменено", datetime(2026, 1, 2, tzinfo=timezone.utc)), self.chat, self.user)
        self.journal.incoming(self.message(), self.chat, self.user)
        with self.journal.db() as db:
            row = db.execute("SELECT * FROM messages").fetchone()
            self.assertEqual((row["text"], row["attachment_state"]), ("Изменено", "ready"))
            self.assertIn(ref["artifactId"], row["attachments"])
            self.assertEqual(db.execute("SELECT count(*) FROM changes").fetchone()[0], 3)

    def test_import_does_not_overwrite_live_message_or_invent_delivery(self):
        self.journal.incoming(self.message(), self.chat, self.user)
        class Source:
            def list_sessions_rich(self, **kwargs):
                return [{"id": "s1", "chat_id": "123", "thread_id": "", "chat_type": "private"},
                        {"id": "foreign", "chat_id": "777", "thread_id": "", "chat_type": "private"}]
            def get_messages(self, session_id, **kwargs):
                return [{"id": 1, "role": "user", "content": "Обработанный текст", "platform_message_id": "44", "timestamp": 1},
                        {"id": 2, "role": "assistant", "content": "Ответ", "timestamp": 2},
                        {"id": 3, "role": "tool", "content": "служебное", "timestamp": 3}]
        history.import_history(Source(), self.journal, lambda session: session["chat_id"] == "123")
        history.import_history(Source(), self.journal, lambda session: session["chat_id"] == "123")
        with self.journal.db() as db:
            rows = db.execute("SELECT * FROM messages ORDER BY identity").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(next(row for row in rows if row["direction"] == "in")["text"], "Привет")
            self.assertEqual(next(row for row in rows if row["direction"] == "out")["delivery"], "unknown")

    def test_queued_delivery_updates_same_message_after_confirmation(self):
        self.journal.outgoing("123", "", "Ответ", None, "pending", identity="job")
        self.journal.outgoing("123", "", "Ответ", "88", "sent", identity="job")
        self.journal.outgoing("123", "", "Ответ", None, "pending", identity="job")
        with self.journal.db() as db:
            rows = db.execute("SELECT * FROM messages").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]["delivery"], rows[0]["telegram_id"]), ("sent", "88"))

    def test_link_to_confirmed_session_keeps_artifacts_and_is_stable(self):
        self.journal.incoming(self.message(), self.chat, self.user)
        ref = {"artifactId": "00000000-0000-4000-8000-000000000001", "filename": "a.png", "mimeType": "image/png"}
        self.journal.attachments(123, 44, [ref])
        self.journal.link_session(123, 44, 'session-1')
        self.journal.link_session(123, 44, 'session-2')
        with self.journal.db() as db:
            row = db.execute("SELECT session_id, attachments FROM messages").fetchone()
            self.assertEqual(row['session_id'], 'session-1')
            self.assertEqual(json.loads(row['attachments']), [ref])

    def test_import_links_only_confirmed_input_artifacts_and_can_be_repeated(self):
        aliases = sqlite3.connect(":memory:")
        self.addCleanup(aliases.close)
        aliases.executescript("CREATE TABLE aliases(path TEXT,artifact TEXT,ref TEXT); CREATE TABLE items(source TEXT,position INTEGER,artifact TEXT,ref TEXT);")
        ref = {"artifactId": "00000000-0000-4000-8000-000000000001", "filename": "photo.png", "mimeType": "image/png"}
        source = {"platform": "telegram", "chat": "123", "thread": "", "messageId": "50"}
        aliases.execute("INSERT INTO items VALUES (?,?,?,?)", (json.dumps(source), 0, ref["artifactId"], json.dumps(ref)))
        class Source:
            def list_sessions_rich(self, **kwargs):
                return [{"id": "s", "chat_id": "123", "user_id": "123", "chat_type": "private"}]
            def get_messages(self, session_id, **kwargs):
                return [{"id": 5, "role": "user", "content": [{"type": "image_url"}], "platform_message_id": "50", "timestamp": 1}]
        for _ in range(2):
            history.import_history(Source(), self.journal, lambda session: True, aliases=aliases)
        with self.journal.db() as db:
            rows = db.execute("SELECT * FROM messages").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["attachment_state"], "ready")
            self.assertEqual(json.loads(rows[0]["attachments"]), [ref])

    def test_import_pages_all_sessions_including_compression_children(self):
        class Source:
            def list_sessions_rich(self, **kwargs):
                assert kwargs['include_children'] is True and kwargs['project_compression_tips'] is False
                offset = kwargs['offset']
                return [{"id": f"s{index}", "chat_id": "123", "chat_type": "private"}
                        for index in range(offset, min(offset + 100, 101))]
            def get_messages(self, session_id, **kwargs):
                return [{"id": 501, "role": "user", "content": "последняя страница", "timestamp": 1}] if session_id == 's100' else []
        history.import_history(Source(), self.journal, lambda session: True)
        with self.journal.db() as db:
            self.assertEqual(db.execute("SELECT text FROM messages").fetchone()[0], "последняя страница")


if __name__ == "__main__":
    unittest.main()
