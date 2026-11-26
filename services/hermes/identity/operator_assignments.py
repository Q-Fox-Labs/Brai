# ABOUTME: Хранит операторские поручения в закрытом журнале ingress.
# ABOUTME: Сохраняет подготовленный ответ отдельно от исходящей очереди Telegram.
"""Durable operator assignments on an existing ingress-owned SQLite connection."""
import json
import uuid

from .delivery_journal import canonical, delivery_id


class OperatorAssignments:
    def __init__(self, db):
        self.db = db
        db.execute("""CREATE TABLE IF NOT EXISTS operator_assignments (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
            request TEXT NOT NULL, state TEXT NOT NULL, result TEXT, receipt TEXT
        )""")
        db.execute("UPDATE operator_assignments SET state='interrupted' WHERE state='running'")

    def create(self, ident, owner, request):
        if (not isinstance(ident, str) or str(uuid.UUID(ident)) != ident
                or not isinstance(owner, str) or not owner):
            raise ValueError('Invalid operator assignment')
        record = canonical(request)
        if len(record.encode()) > 65536:
            raise ValueError('Operator assignment too large')
        fingerprint = delivery_id([owner, request])
        self.db.execute("""INSERT OR IGNORE INTO operator_assignments
            (id,owner,fingerprint,request,state) VALUES(?,?,?,?,'prepared')""",
            (ident, owner, fingerprint, record))
        value = self.read(ident, owner)
        if value is None or value['fingerprint'] != fingerprint:
            raise ValueError('Operator assignment conflict')
        return value

    def read(self, ident, owner):
        row = self.db.execute("""SELECT fingerprint,request,state,result,receipt
            FROM operator_assignments WHERE id=? AND owner=?""", (ident, owner)).fetchone()
        if row is None:
            return None
        return {'id': ident, 'fingerprint': row[0], 'request': json.loads(row[1]), 'state': row[2],
                'result': json.loads(row[3]) if row[3] else None,
                'receipt': json.loads(row[4]) if row[4] else None}

    def begin(self, ident, owner):
        """Reserve the only run before crossing the worker boundary."""
        return self.db.execute("""UPDATE operator_assignments SET state='running'
            WHERE id=? AND owner=? AND state='prepared'""", (ident, owner)).rowcount == 1

    def busy(self, ident, owner):
        """Reopen only on a worker receipt proving no turn was started."""
        return self.db.execute("""UPDATE operator_assignments SET state='prepared'
            WHERE id=? AND owner=? AND state='running'""", (ident, owner)).rowcount == 1

    def ready(self, ident, owner, result):
        raw = canonical(result)
        if len(raw.encode()) > 262144:
            raise ValueError('Operator assignment result too large')
        return self.db.execute("""UPDATE operator_assignments SET state='ready',result=?
            WHERE id=? AND owner=? AND state='running'""", (raw, ident, owner)).rowcount == 1

    def fail(self, ident, owner):
        return self.db.execute("""UPDATE operator_assignments SET state='failed'
            WHERE id=? AND owner=? AND state='running'""", (ident, owner)).rowcount == 1

    def cancel(self, ident, owner):
        return self.db.execute("""UPDATE operator_assignments SET state='cancelled'
            WHERE id=? AND owner=? AND state IN ('prepared','running','ready','approved')""",
            (ident, owner)).rowcount == 1

    def approve(self, ident, owner, result_digest):
        """Approve only the privately inspected immutable result."""
        value = self.read(ident, owner)
        if value is None or value['state'] != 'ready' or delivery_id(value['result']) != result_digest:
            return False
        return self.db.execute("""UPDATE operator_assignments SET state='approved'
            WHERE id=? AND owner=? AND state='ready' AND result=?""",
            (ident, owner, canonical(value['result']))).rowcount == 1

    def sending(self, ident, owner):
        """After a crash the delivery must be reconciled against the outbox receipt."""
        return self.db.execute("""UPDATE operator_assignments SET state='sending'
            WHERE id=? AND owner=? AND state='approved'""", (ident, owner)).rowcount == 1

    def complete(self, ident, owner, receipt):
        state = 'delivered' if receipt.get('success') is True and receipt.get('message_id') else 'delivery_blocked'
        return self.db.execute("""UPDATE operator_assignments SET state=?,receipt=?
            WHERE id=? AND owner=? AND state IN ('approved','sending')""",
            (state, canonical(receipt), ident, owner)).rowcount == 1
