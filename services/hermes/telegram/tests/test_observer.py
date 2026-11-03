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

    def test_payload_types_preserve_empty_text_and_distinguish_service_and_unsupported(self):
        """Нетекстовый input хранит тип, не подменяя текст машинной подписью."""
        cases = [('photo', [1], 'photo', 'pending'), ('sticker', object(), 'sticker', 'pending'),
                 ('video_note', object(), 'unsupported:video_note', 'none'),
                 ('forum_topic_closed', object(), 'service', 'none'), ('unused', None, 'unknown', 'none')]
        for index, (field, value, kind, state) in enumerate(cases):
            message = SimpleNamespace(message_id=100+index, text=None, **{field:value})
            self.journal.incoming(message,self.chat,self.user)
        with self.journal.db() as db:
            rows=db.execute('SELECT text,message_type,attachment_state FROM messages ORDER BY rowid').fetchall()
        self.assertEqual([tuple(row) for row in rows],[('',kind,state) for _,_,kind,state in cases])

    def test_old_database_migrates_empty_input_as_unknown_without_guessing(self):
        """Старая БД сохраняет содержимое и число событий при добавлении типа."""
        self.journal.incoming(SimpleNamespace(message_id=103,text=None),self.chat,self.user)
        with self.journal.db() as db:
            db.execute('ALTER TABLE messages DROP COLUMN message_type')
        reopened=journal_module.TelegramJournal(self.journal.directory)
        with reopened.db() as db:
            row=db.execute('SELECT text,message_type FROM messages').fetchone()
            self.assertEqual(tuple(row),('','unknown'))
            self.assertEqual(db.execute('SELECT count(*) FROM changes').fetchone()[0],1)

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

    def test_existing_history_gains_two_images_and_audio_without_replacing_live_text(self):
        refs = [
            {"artifactId": "00000000-0000-4000-8000-000000000001", "filename": "one.jpg", "mimeType": "image/jpeg", "status": "ready"},
            {"artifactId": "00000000-0000-4000-8000-000000000002", "filename": "two.jpg", "mimeType": "image/jpeg", "status": "ready"},
            {"artifactId": "00000000-0000-4000-8000-000000000003", "filename": "voice.ogg", "mimeType": "audio/ogg", "status": "ready"},
        ]
        aliases = sqlite3.connect(":memory:")
        self.addCleanup(aliases.close)
        aliases.executescript("CREATE TABLE aliases(path TEXT,artifact TEXT,ref TEXT); CREATE TABLE items(source TEXT,position INTEGER,artifact TEXT,ref TEXT);")
        for ref in refs[:2]:
            aliases.execute("INSERT INTO aliases VALUES (?,?,?)", (f"/results/{ref['artifactId']}/{ref['filename']}", ref['artifactId'], json.dumps(ref)))
        text = "\n".join(f"[Image attached at: /results/{ref['artifactId']}/{ref['filename']}]" for ref in refs[:2])
        voice = f"[voice.ogg](</results/{refs[2]['artifactId']}/voice.ogg>)"
        class Source:
            def list_sessions_rich(self, **kwargs):
                return [{"id": "s", "chat_id": "123", "user_id": "123", "display_name": "Анна", "chat_type": "private"}]
            def get_messages(self, session_id, **kwargs):
                return [{"id": 1, "role": "user", "content": text, "platform_message_id": "44", "timestamp": 1},
                        {"id": 2, "role": "user", "content": voice, "platform_message_id": "45", "timestamp": 2}]
        self.journal.incoming(self.message("Текст из Telegram"), self.chat, self.user)
        history.import_history(Source(), self.journal, lambda _: True, "/results", aliases, lambda aid, chat, mid: next((x for x in refs if x['artifactId'] == aid), None))
        history.import_history(Source(), self.journal, lambda _: True, "/results", aliases, lambda aid, chat, mid: next((x for x in refs if x['artifactId'] == aid), None))
        with self.journal.db() as db:
            rows = db.execute("SELECT * FROM messages ORDER BY telegram_id").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]['text'], "Текст из Telegram")
            self.assertEqual(len(json.loads(rows[0]['attachments'])), 2)
            self.assertEqual(json.loads(rows[1]['attachments'])[0]['mimeType'], "audio/ogg")
            self.assertEqual(rows[1]['author_name'], "Анна")

    def test_group_author_requires_exact_original_message_or_sender(self):
        origin = {"chat_id": "-100", "user_id": "123", "user_name": "Анна", "message_id": "50"}
        session = {"origin_json": json.dumps(origin), "user_id": "123", "display_name": "Название группы"}
        self.assertEqual(history._author(session, "-100", "", "50", None), ("123", "Анна"))
        self.assertEqual(history._author(session, "-100", "", "51", None), ("", ""))
        aliases = sqlite3.connect(":memory:")
        self.addCleanup(aliases.close)
        aliases.execute("CREATE TABLE items(source TEXT)")
        source = {"platform": "telegram", "chat": "-100", "thread": "", "messageId": "51", "sender": "123"}
        aliases.execute("INSERT INTO items VALUES (?)", (json.dumps(source),))
        self.assertEqual(history._author(session, "-100", "", "51", aliases), ("123", "Анна"))
        source["sender"] = "456"
        aliases.execute("INSERT INTO items VALUES (?)", (json.dumps(source),))
        self.assertEqual(history._author(session, "-100", "", "51", aliases), ("", ""))

    def test_legacy_audio_key_is_bound_to_message_and_owner(self):
        from hashlib import sha256
        owner, chat, message = "owner", "123", "45"
        raw = json.dumps([owner, f"tg:{chat}:{message}:0"], ensure_ascii=False, separators=(",", ":"))
        ref = {"requestId": "brai:agent:publish:v1:" + sha256(raw.encode()).hexdigest()}
        self.assertTrue(history.legacy_input_matches(ref, owner, chat, message))
        self.assertFalse(history.legacy_input_matches(ref, owner, chat, "46"))
        self.assertFalse(history.legacy_input_matches(ref, "other", chat, message))

    def test_direct_bot_receipt_and_queued_receipt_do_not_duplicate(self):
        self.journal.outgoing("123", "9", "Полный ответ", None, "pending", identity="job")
        self.journal.outgoing("123", "9", "Техническое сообщение", "88", "sent")
        self.journal.outgoing("123", "9", "Полный ответ", "88", "sent", identity="job")
        self.journal.outgoing("123", "", "Изменённый ответ", "88", "sent")
        with self.journal.db() as db:
            rows = db.execute("SELECT * FROM messages").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]['identity'], rows[0]['thread_id'], rows[0]['text']), ("pending:job", "9", "Изменённый ответ"))
            self.assertEqual(db.execute("SELECT count(*) FROM changes WHERE identity != ?", ("pending:job",)).fetchone()[0], 0)


class DirectSendTest(unittest.IsolatedAsyncioTestCase):
    async def test_direct_send_and_edit_observed_without_changing_bot_behavior(self):
        outgoing = load("outgoing")
        class Bot:
            async def send_message(self, chat_id, text, message_thread_id=None):
                return SimpleNamespace(chat=SimpleNamespace(id=chat_id), message_id=7, text=text, message_thread_id=message_thread_id)
            async def edit_message_text(self, chat_id, message_id, text):
                return SimpleNamespace(chat=SimpleNamespace(id=chat_id), message_id=message_id, text=text)
        class Observer:
            closed = False
            def __init__(self): self.events = []
            async def observe_send(self, chat, route, text, result): self.events.append((chat, route, text, result.message_id))
        bot, other, observer = Bot(), Bot(), Observer()
        stop = outgoing.install(bot, observer)
        try:
            await bot.send_message(123, "Служебное", message_thread_id=5)
            await bot.edit_message_text(123, 7, "Обновлено")
            await other.send_message(456, "Не наш бот")
            self.assertEqual([x[2] for x in observer.events], ["Служебное", "Обновлено"])
            self.assertEqual(observer.events[0][1]['message_thread_id'], 5)
        finally:
            stop()
        await bot.send_message(123, "После отключения")
        self.assertEqual(len(observer.events), 2)


if __name__ == "__main__":
    unittest.main()
