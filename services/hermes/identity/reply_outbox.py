# ABOUTME: Сохраняет готовые Telegram-ответы и реальные квитанции в existing ingress SQLite.
# ABOUTME: Повторяет доставку байтов, а не модель или действия пользователя; права проверяет порт отправки.
import asyncio
import json
from .delivery_journal import canonical, DeliveryJournal


class ReplyOutbox:
    """Очередь принадлежит ingress; одна блокировка на владельца сохраняет порядок его ответов."""
    def __init__(self, db, deliver):
        self.db, self.deliver = db, deliver
        self.locks = {}
        db.execute('''CREATE TABLE IF NOT EXISTS reply_outbox (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            owner TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT)''')

    def enqueue(self, ident, owner, body):
        """Commit ответа до первой внешней попытки; прежний ID не меняет байты и адресата."""
        DeliveryJournal.identity(ident, ident)
        raw = canonical(body)
        old = self.db.execute('SELECT owner,body FROM reply_outbox WHERE id=?', (ident,)).fetchone()
        if old is not None and old != (owner, raw):
            raise ValueError('OUTBOX_ID_CONFLICT')
        self.db.execute("INSERT OR IGNORE INTO reply_outbox(id,owner,body,state) VALUES(?,?,?,'pending')", (ident, owner, raw))

    def result(self, ident):
        """Квитанция относится к фактическому message ID, включая ответ после потери IPC."""
        row = self.db.execute('SELECT state,receipt FROM reply_outbox WHERE id=?', (ident,)).fetchone()
        return json.loads(row[1]) if row and row[1] else None

    def recover_legacy_binding_blocks(self):
        """Вернуть только ответы, отвергнутые старым сравнением отсутствующего автора.

        Прежний _deliver_saved_reply всегда отвергал такой profile до Bot API:
        identity.resolve возвращает непустого автора, а profile.get — None.
        Тело, адресат и ID сохраняются; обычная доставка заново проверяет права.
        Новые отказы помечены error_kind и повторно сюда не попадают.
        """
        legacy = {'success': False, 'retryable': False, 'error': 'Delivery forbidden'}
        recovered = 0
        for ident, raw, receipt in self.db.execute(
                "SELECT id,body,receipt FROM reply_outbox WHERE state='blocked'").fetchall():
            profile = json.loads(raw).get('profile', {})
            author = profile.get('telegramId')
            if ('authorTelegramId' not in profile and isinstance(author, str)
                    and author.isascii() and author.isdecimal() and int(author) > 0
                    and json.loads(receipt or 'null') == legacy):
                recovered += self.db.execute(
                    "UPDATE reply_outbox SET state='pending' WHERE id=? AND state='blocked'", (ident,)).rowcount
        return recovered

    async def flush_owner(self, owner):
        """Отправить сохранённые ответы по порядку; один отказ не блокирует других владельцев."""
        async with self.locks.setdefault(owner, asyncio.Lock()):
            rows = self.db.execute("SELECT id,body FROM reply_outbox WHERE owner=? AND state IN ('pending','sending') ORDER BY seq", (owner,)).fetchall()
            for ident, raw in rows:
                self.db.execute("UPDATE reply_outbox SET state='sending' WHERE id=?", (ident,))
                try:
                    result = await self.deliver(json.loads(raw))
                except PermissionError:
                    result = {'success': False, 'retryable': False, 'error': 'Delivery forbidden', 'error_kind': 'forbidden'}
                except asyncio.CancelledError:
                    raise
                except Exception:
                    result = {'success': False, 'retryable': True, 'error': 'Delivery pending'}
                sent = result.get('success') is True and bool(result.get('message_id'))
                blocked = result.get('retryable') is False
                if blocked and not sent:
                    result.setdefault('error_kind', 'blocked')
                state = 'sent' if sent else 'blocked' if blocked else 'pending'
                self.db.execute('UPDATE reply_outbox SET state=?,receipt=? WHERE id=?', (state, canonical(result), ident))
                if state == 'pending':
                    break

    async def flush(self):
        """Повторить незавершённую доставку при восстановлении existing supervisor."""
        owners = [row[0] for row in self.db.execute("SELECT DISTINCT owner FROM reply_outbox WHERE state IN ('pending','sending')")]
        await asyncio.gather(*(self.flush_owner(owner) for owner in owners))
