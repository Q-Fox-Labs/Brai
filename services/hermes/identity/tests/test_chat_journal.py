# ABOUTME: Проверяет точность Telegram payload и изоляцию журналов личных профилей.
# ABOUTME: Использует временные SQLite и управляемый Bot без сети и пользовательских данных.
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.chat_journal import IdentityJournal

A = {'profileId': '11111111-1111-4111-8111-111111111111'}
B = {'profileId': '22222222-2222-4222-8222-222222222222'}
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)

def message(mid, text=None, **extra):
    return NS(chat=NS(id=123), message_id=mid, text=text, date=NOW, **extra)

class Bot:
    def __init__(self):
        self.next = []
    async def send_message(self, chat_id, text):
        result = self.next.pop(0)
        if isinstance(result, Exception):
            raise result
        return result
    async def send_media_group(self, chat_id, media):
        return self.next.pop(0)
    async def edit_message_text(self, chat_id, message_id, text):
        return self.next.pop(0)
    async def do_api_request(self, endpoint, api_kwargs):
        return self.next.pop(0)
    async def delete_message(self, chat_id, message_id):
        return True

class JournalTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[4] / 'tmp')
        self.journal = IdentityJournal(Path(self.temp.name) / 'chats')
        self.bot = Bot()
        self.restore = self.journal.install(self.bot)
    def tearDown(self):
        self.journal.restore()
        self.temp.cleanup()
    def rows(self, profile=A):
        db = self.journal.database(profile)
        try:
            return [dict(row) for row in db.execute('SELECT * FROM messages ORDER BY id')]
        finally:
            db.close()

    async def test_actual_two_error_messages_replace_no_internal_model_text(self):
        texts = ['❌ HTTP 403: Error code: 403', '🔑 Подключение отклонено\n\nКод: auth\n  👩‍💻  ']
        self.bot.next = [message(i + 1, text) for i, text in enumerate(texts)]
        with self.journal.scope(A):
            for _ in texts:
                await self.bot.send_message(123, 'Your request was not processed.')
        self.assertEqual([row['text'] for row in self.rows()], texts)

    async def test_original_incoming_preserves_username_unicode_and_edits(self):
        user = NS(full_name='Имя 👩‍💻', username='actual_user')
        chat = NS(id=123)
        original = message(10, '  Строка\n**буквальные символы**  ')
        self.journal.incoming(A, original, chat, user)
        self.journal.incoming(A, original, chat, user)
        edited = message(10, '  правка  ', edit_date=NOW)
        self.journal.incoming(A, edited, chat, user)
        self.journal.incoming(A, original, chat, user)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['text'], rows[0]['name'], rows[0]['username']),
                         ('  правка  ', 'Имя 👩‍💻', 'actual_user'))

    async def test_media_refs_remain_separate_from_exact_caption_and_survive_restart(self):
        files = [{'file': {'artifactId': str(i), 'filename': name, 'mimeType': mime}}
                 for i, name, mime in ((1, 'image.bin', 'image/png'), (2, 'voice.bin', 'audio/ogg'))]
        self.bot.next = [(message(21, caption='  подпись  ', photo=True), message(22, voice=True))]
        with self.journal.scope(A, files):
            await self.bot.send_media_group(123, ['synthetic files'])
        other = IdentityJournal(self.journal.root)
        db = other.database(A)
        try:
            rows = db.execute('SELECT * FROM messages ORDER BY id').fetchall()
            self.assertEqual(rows[0]['text'], '  подпись  ')
            self.assertEqual(rows[1]['text'], '')
            self.assertEqual(json.loads(rows[1]['attachments'])[0]['mimeType'], 'audio/ogg')
        finally:
            db.close()

    async def test_failed_foreign_bot_and_other_profile_do_not_mix(self):
        self.bot.next = [RuntimeError('refused'), message(31, 'Профиль A'), message(31, 'Профиль B')]
        with self.journal.scope(A):
            with self.assertRaises(RuntimeError):
                await self.bot.send_message(123, 'failed')
            await self.bot.send_message(123, 'draft')
        with self.journal.scope(B):
            await self.bot.send_message(123, 'draft')
        foreign = Bot()
        foreign.next = [message(99, 'чужой бот')]
        with self.journal.scope(A):
            await foreign.send_message(123, 'draft')
        self.assertEqual([row['text'] for row in self.rows(A)], ['Профиль A'])
        self.assertEqual([row['text'] for row in self.rows(B)], ['Профиль B'])

    async def test_receipt_without_topic_keeps_the_authorized_original_topic(self):
        self.bot.next = [message(81, 'первый текст'), message(81, 'правка', edit_date=NOW)]
        with self.journal.scope(A, thread='77'):
            await self.bot.send_message(123, 'draft')
        with self.journal.scope(A):
            await self.bot.edit_message_text(123, 81, 'draft edit')
        self.assertEqual([(row['thread'], row['text']) for row in self.rows()], [('77', 'правка')])

    async def test_raw_rich_receipt_keeps_server_blocks_instead_of_request_markdown(self):
        rich = {'blocks': [{'type': 'paragraph', 'text': ['  Точный ', {'type': 'bold', 'text': 'ответ'}, '  ']}]}
        self.bot.next = [{'message_id': 61, 'chat': {'id': 123}, 'date': int(NOW.timestamp()), 'rich_message': rich}]
        with self.journal.scope(A):
            await self.bot.do_api_request('sendRichMessage', {'chat_id': 123, 'rich_message': {'markdown': 'внутренний запрос'}})
        row = self.rows()[0]
        self.assertEqual(json.loads(row['rich']), rich)
        self.assertEqual((row['text'], row['kind']), ('', 'rich'))

    async def test_reconnection_stops_observing_the_previous_bot(self):
        fresh = Bot()
        self.journal.install(fresh)
        self.bot.next = [message(71, 'старый Bot')]
        fresh.next = [message(72, 'новый Bot')]
        with self.journal.scope(A):
            await self.bot.send_message(123, 'draft')
            await fresh.send_message(123, 'draft')
        self.assertEqual([row['text'] for row in self.rows()], ['новый Bot'])

    async def test_delete_emits_tombstone_and_restore_removes_hook(self):
        self.bot.next = [message(41, 'удалить')]
        with self.journal.scope(A):
            await self.bot.send_message(123, 'draft')
            await self.bot.delete_message(123, 41)
        self.assertEqual((self.rows()[0]['deleted'], self.rows()[0]['text']), (1, ''))
        self.restore()
        self.bot.next = [message(42, 'после остановки')]
        with self.journal.scope(A):
            await self.bot.send_message(123, 'draft')
        self.assertEqual(len(self.rows()), 1)
