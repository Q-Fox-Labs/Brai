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

    def retry_blocked(self, ident, owner, body, receipt):
        """Адресно вернуть ошибочно запрещённую отправку после операторской проверки.

        Сверяет неизменные ID, owner, тело и прежнюю квитанцию. Pending/sent
        повторно не открывает; актуальные права проверяет обычный deliver.
        """
        row = self.db.execute('SELECT owner,body,state,receipt FROM reply_outbox WHERE id=?', (ident,)).fetchone()
        if row is None or row[:2] != (owner, canonical(body)):
            raise ValueError('OUTBOX_RETRY_CONFLICT')
        if row[2] in ('pending', 'sending', 'sent'):
            return False
        if row[2] != 'blocked' or json.loads(row[3]) != receipt:
            raise ValueError('OUTBOX_RETRY_CONFLICT')
        return self.db.execute("UPDATE reply_outbox SET state='pending' WHERE id=? AND state='blocked' AND receipt=?",
                               (ident, row[3])).rowcount == 1

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
                state = 'sent' if sent else 'blocked' if blocked else 'pending'
                self.db.execute('UPDATE reply_outbox SET state=?,receipt=? WHERE id=?', (state, canonical(result), ident))
                if state == 'pending':
                    break

    async def flush(self):
        """Повторить незавершённую доставку при восстановлении existing supervisor."""
        owners = [row[0] for row in self.db.execute("SELECT DISTINCT owner FROM reply_outbox WHERE state IN ('pending','sending')")]
        await asyncio.gather(*(self.flush_owner(owner) for owner in owners))
