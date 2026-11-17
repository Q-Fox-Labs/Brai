# ABOUTME: Сохраняет приём входов worker и готовые исходящие ответы между перезапусками.
# ABOUTME: Не даёт полномочий: владельца, маршрут и паузу проверяет действующий transport.
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
from contextlib import contextmanager


def canonical(value):
    """Получить неизменяемое представление одного сообщения без NaN."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


class DeliveryJournal:
    """Один private SQLite на владельца; срок хранения не ограничивает обработку."""
    def __init__(self, path, owner):
        self.path, self.owner = Path(path), owner
        if not self.path.is_absolute() or not isinstance(owner, str) or not owner:
            raise ValueError('DELIVERY_OWNER_REQUIRED')
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_nlink != 1 or meta.st_mode & 0o077:
                raise PermissionError('DELIVERY_STORE_UNPROTECTED')
        finally:
            os.close(fd)
        with self.open() as db:
            db.execute('CREATE TABLE IF NOT EXISTS delivery_owner (owner TEXT PRIMARY KEY)')
            rows = db.execute('SELECT owner FROM delivery_owner').fetchall()
            if not rows:
                db.execute('INSERT INTO delivery_owner VALUES(?)', (owner,))
            elif rows != [(owner,)]:
                raise PermissionError('DELIVERY_STORE_OWNER_CHANGED')
            db.execute('''CREATE TABLE IF NOT EXISTS input_deliveries (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT)''')
            db.execute('''CREATE TABLE IF NOT EXISTS output_deliveries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                action TEXT NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT)''')
            db.execute('''CREATE TABLE IF NOT EXISTS continuation_inputs (
                session_key TEXT PRIMARY KEY, input_id TEXT NOT NULL, chat_generation INTEGER NOT NULL)''')

    @contextmanager
    def open(self):
        """Открыть журнал текущего процесса с durable commit."""
        db = sqlite3.connect(self.path)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def identity(ident, digest):
        """Проверить opaque SHA256 ID и хеш исходного входа."""
        for value in (ident, digest):
            if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                raise ValueError('DELIVERY_ID_INVALID')

    def input_status(self, ident, digest):
        """Вернуть прежний receipt; отсутствие записи означает, что выполнение не начиналось."""
        self.identity(ident, digest)
        with self.open() as db:
            row = db.execute('SELECT digest,phase,receipt FROM input_deliveries WHERE id=?', (ident,)).fetchone()
        if row is None:
            return {'state': 'not_received'}
        if row[0] != digest:
            raise ValueError('DELIVERY_INPUT_CONFLICT')
        return {'state': row[1], 'receipt': json.loads(row[2]) if row[2] else None}

    def input_boundary(self):
        """Вернуть последний начатый input до native приёма; смена phase не меняет границу."""
        with self.open() as db:
            return db.execute('SELECT rowid,id,digest FROM input_deliveries ORDER BY rowid DESC LIMIT 1').fetchone()

    def save_continuation(self, session_key, input_id, chat_generation):
        """Связать незавершённую сессию с исходным durable input и поколением чата."""
        self.identity(input_id, input_id)
        if not isinstance(session_key, str) or not session_key or type(chat_generation) is not int or chat_generation < 0:
            raise ValueError('CONTINUATION_BINDING_INVALID')
        with self.open() as db:
            if db.execute('SELECT 1 FROM input_deliveries WHERE id=?', (input_id,)).fetchone() is None:
                raise ValueError('CONTINUATION_INPUT_UNKNOWN')
            db.execute('INSERT OR REPLACE INTO continuation_inputs VALUES(?,?,?)',
                       (session_key, input_id, chat_generation))

    def continuation(self, session_key):
        """Читать привязку без повторной передачи исходного сообщения."""
        with self.open() as db:
            row = db.execute('SELECT input_id,chat_generation FROM continuation_inputs WHERE session_key=?',
                             (session_key,)).fetchone()
        return {'input_id': row[0], 'chat_generation': row[1]} if row else None

    def clear_continuation(self, session_key):
        """Удалить привязку только после подтверждённого завершения native хода."""
        with self.open() as db:
            db.execute('DELETE FROM continuation_inputs WHERE session_key=?', (session_key,))

    def begin_input(self, ident, digest):
        """До native handler закрепить попытку; dispatching после crash не переисполняется."""
        self.identity(ident, digest)
        with self.open() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT digest FROM input_deliveries WHERE id=?', (ident,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise ValueError('DELIVERY_INPUT_CONFLICT')
                return False
            db.execute("INSERT INTO input_deliveries VALUES(?,?,'dispatching',NULL)", (ident, digest))
        return True

    def accept_input(self, ident, digest, receipt):
        """Commit фактический native receipt до ответа на RPC."""
        self.identity(ident, digest)
        raw = canonical(receipt)
        with self.open() as db:
            changed = db.execute("UPDATE input_deliveries SET phase='accepted',receipt=? WHERE id=? AND digest=? AND phase='dispatching'",
                                 (raw, ident, digest)).rowcount
            if changed != 1:
                raise ValueError('DELIVERY_INPUT_STATE_CHANGED')

    def decline_input(self, ident, digest):
        """Native явно не принял input: разрешить последующую передачу, не заявляя обработку."""
        self.identity(ident, digest)
        with self.open() as db:
            changed = db.execute("DELETE FROM input_deliveries WHERE id=? AND digest=? AND phase='dispatching'",
                                 (ident, digest)).rowcount
            if changed != 1:
                raise ValueError('DELIVERY_INPUT_STATE_CHANGED')

    def complete_turn(self, turn_id):
        """Закрепить окончание native task для сверки после потери уведомления."""
        with self.open() as db:
            for ident, raw in db.execute("SELECT id,receipt FROM input_deliveries WHERE phase='accepted'").fetchall():
                if json.loads(raw).get('turn_id') == turn_id:
                    db.execute("UPDATE input_deliveries SET phase='completed' WHERE id=?", (ident,))

    def queue_output(self, ident, action, payload):
        """Сохранить готовые байты ответа до сетевой попытки; повтор ID не меняет содержимое."""
        self.identity(ident, ident)
        raw = canonical(payload)
        with self.open() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT action,payload FROM output_deliveries WHERE id=?', (ident,)).fetchone()
            if old is not None and old != (action, raw):
                raise ValueError('DELIVERY_OUTPUT_CONFLICT')
            if old is None:
                db.execute("INSERT INTO output_deliveries(id,action,payload,phase) VALUES(?,?,?,'pending')", (ident, action, raw))
        return self.output(ident)

    def output(self, ident):
        """Читать один исходящий ответ без повторной генерации."""
        with self.open() as db:
            row = db.execute('SELECT action,payload,phase,receipt FROM output_deliveries WHERE id=?', (ident,)).fetchone()
        if row is None:
            return None
        return {'id': ident, 'action': row[0], 'payload': json.loads(row[1]), 'state': row[2],
                'receipt': json.loads(row[3]) if row[3] else None}

    def pending_outputs(self):
        """Вернуть сохранённые ответы в порядке записи, включая прерванную отправку."""
        with self.open() as db:
            ids = [row[0] for row in db.execute("SELECT id FROM output_deliveries WHERE phase IN ('pending','sending') ORDER BY seq")]
        return [self.output(ident) for ident in ids]

    def output_state(self, ident, state, receipt=None):
        """Сохранить реальную доставку либо доказанный постоянный запрет."""
        if state not in ('pending', 'sending', 'sent', 'blocked'):
            raise ValueError('DELIVERY_OUTPUT_STATE_INVALID')
        if state == 'sent' and (not isinstance(receipt, dict) or receipt.get('success') is not True or not receipt.get('message_id')):
            raise ValueError('DELIVERY_OUTPUT_RECEIPT_REQUIRED')
        with self.open() as db:
            db.execute("UPDATE output_deliveries SET phase=?,receipt=? WHERE id=? AND phase NOT IN ('sent','blocked')",
                       (state, canonical(receipt) if receipt is not None else None, ident))


def delivery_id(value):
    """Построить стабильный ID входа либо сохранённого ответа."""
    return hashlib.sha256(canonical(value).encode()).hexdigest()
