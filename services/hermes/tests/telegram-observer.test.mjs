// ABOUTME: Проверяет чтение Telegram-журнала и привязку файлов к сообщениям.
// ABOUTME: Использует SQLite в памяти и не подключается к NATS или пользовательским данным.
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryJournal } from '../telegram/observer/server.mjs';

test('постраничная история учитывает время импорта, а доступ к файлам требует точной связи', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (identity TEXT, chat_id TEXT, thread_id TEXT, chat_type TEXT, chat_name TEXT,
    text TEXT, occurred_at TEXT, attachments TEXT, attachment_state TEXT);
    CREATE TABLE changes (seq INTEGER PRIMARY KEY, identity TEXT);`);
  const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)');
  const aid = '00000000-0000-4000-8000-000000000001';
  insert.run('new', '1', '', 'private', 'Анна', 'Новое', '2026-02', '[]', 'none');
  insert.run('old', '1', '', 'private', 'Анна', 'Старое', '2026-01', JSON.stringify([{ artifactId: aid }]), 'ready');
  insert.run('other', '2', '', 'private', 'Борис', 'Другое', '2026-03', '[]', 'none');
  db.exec("INSERT INTO changes VALUES (1,'new'); INSERT INTO changes VALUES (2,'old');");
  const newest = queryJournal(db, { action: 'messages', chatId: '1', threadId: '', limit: 1 });
  assert.equal(newest.messages[0].identity, 'new');
  assert.equal(queryJournal(db, { action: 'chats' }).chats.find(chat => chat.chat_id === '1').last_text, 'Новое');
  const older = queryJournal(db, { action: 'messages', chatId: '1', threadId: '', limit: 1, before: newest.before });
  assert.equal(older.messages[0].identity, 'old');
  assert.equal(queryJournal(db, { action: 'attachment', identity: 'old', artifactId: aid }).allowed, true);
  assert.equal(queryJournal(db, { action: 'attachment', identity: 'other', artifactId: aid }).allowed, false);
  assert.equal(queryJournal(db, { action: 'changes', after: 1 }).changes[0].identity, 'old');
  assert.throws(() => queryJournal(db, { action: 'messages', chatId: '2', threadId: '', before: newest.before }));
  db.close();
});
