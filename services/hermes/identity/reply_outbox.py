# ABOUTME: Сохраняет готовые Telegram-ответы и реальные квитанции в existing ingress SQLite.
# ABOUTME: Повторяет доставку байтов, а не модель или действия пользователя; права проверяет порт отправки.
import asyncio
import json
import logging
from .delivery_journal import canonical, DeliveryJournal


class DeliveryDeferred(Exception):
    """The delivery port verified that no network call could have started."""


class ReplyOutbox:
    """Очередь принадлежит ingress; одна блокировка на владельца сохраняет порядок его ответов."""
    def __init__(self, db, deliver, *, retry_unknown=True):
        self.db, self.deliver = db, deliver
        self.retry_unknown = retry_unknown
        self.locks = {}
        db.execute('''CREATE TABLE IF NOT EXISTS reply_outbox (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            owner TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT)''')

    def enqueue(self, ident, owner, body, *, request_digest=None, matches=None):
        """Сохранять первый конверт и подтверждать повтор без изменения записи."""
        DeliveryJournal.identity(ident, ident)
        raw = canonical(body)
        inserted = self.db.execute(
            "INSERT OR IGNORE INTO reply_outbox(id,owner,body,state) VALUES(?,?,?,'pending')",
            (ident, owner, raw))
        if inserted.rowcount:
            return
        previous = self.db.execute('SELECT owner,body FROM reply_outbox WHERE id=?', (ident,)).fetchone()
        if previous is not None and previous[0] == owner:
            saved = json.loads(previous[1])
            # RELEASE уже выпускал записи со встроенным отпечатком.
            previous_digest = saved.get('requestDigest')
            if previous_digest is not None:
                if previous_digest == request_digest:
                    return
            elif previous[1] == raw or (matches is not None and matches(saved)):
                return
        raise ValueError('OUTBOX_ID_CONFLICT')

    def result(self, ident):
        """Квитанция относится к фактическому message ID, включая ответ после потери IPC."""
        row = self.db.execute('SELECT state,receipt FROM reply_outbox WHERE id=?', (ident,)).fetchone()
        return json.loads(row[1]) if row and row[1] else None

    def cancel_pending(self, ident, owner):
        receipt = {'success': False, 'retryable': False, 'error_kind': 'cancelled'}
        return self.db.execute("UPDATE reply_outbox SET state='blocked',receipt=? WHERE id=? AND owner=? AND state='pending'",
                               (canonical(receipt), ident, owner)).rowcount == 1

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

    @staticmethod
    def _unknown_delivery(ident, stage):
        logging.getLogger(__name__).warning(
            'TELEGRAM_OUTBOX_DELIVERY_UNCONFIRMED deliveryId=%s stage=%s', ident, stage)
        return {'success': False, 'retryable': False,
                'error': 'Telegram delivery outcome unknown', 'error_kind': 'delivery_unknown'}

    async def flush_owner(self, owner):
        """Отправить сохранённые ответы по порядку; один отказ не блокирует других владельцев."""
        async with self.locks.setdefault(owner, asyncio.Lock()):
            rows = self.db.execute("SELECT id,body,state FROM reply_outbox WHERE owner=? AND state IN ('pending','sending') ORDER BY seq", (owner,)).fetchall()
            for ident, raw, previous in rows:
                body = json.loads(raw)
                operator_assignment = 'operatorAssignmentId' in body
                retry_unknown = self.retry_unknown and not operator_assignment
                if previous == 'sending' and not retry_unknown:
                    result = self._unknown_delivery(ident, 'restarted_while_sending')
                else:
                    attempted = False

                    def begin_attempt():
                        nonlocal attempted
                        if not self.db.execute("UPDATE reply_outbox SET state='sending' WHERE id=? AND state='pending'",
                                               (ident,)).rowcount:
                            raise PermissionError('Delivery reservation changed')
                        attempted = True
                    try:
                        if operator_assignment:
                            result = await self.deliver(body, begin_attempt=begin_attempt)
                        else:
                            self.db.execute("UPDATE reply_outbox SET state='sending' WHERE id=?", (ident,))
                            result = await self.deliver(body)
                    except DeliveryDeferred:
                        continue
                    except PermissionError:
                        result = {'success': False, 'retryable': False, 'error': 'Delivery forbidden', 'error_kind': 'forbidden'}
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        if operator_assignment:
                            logging.getLogger(__name__).warning(
                                'BRAI_OPERATOR_DELIVERY_EXCEPTION id=%s attempted=%s class=%s',
                                body['operatorAssignmentId'], attempted, type(error).__name__)
                        else:
                            logging.getLogger(__name__).warning(
                                'TELEGRAM_OUTBOX_DELIVERY_EXCEPTION deliveryId=%s stage=dispatch class=%s',
                                ident, type(error).__name__)
                        if operator_assignment and not attempted:
                            if isinstance(error, (ConnectionError, TimeoutError)):
                                continue
                            result = {'success': False, 'retryable': False, 'error_kind': 'preparation_failed'}
                        else:
                            result = ({'success': False, 'retryable': True, 'error': 'Delivery pending'}
                                      if retry_unknown else self._unknown_delivery(ident, 'dispatch_exception'))
                sent = result.get('success') is True and bool(result.get('message_id'))
                if operator_assignment and not sent and result.get('retryable') is not False:
                    result = self._unknown_delivery(ident, 'unconfirmed_result')
                blocked = result.get('retryable') is False
                state = 'sent' if sent else 'blocked' if blocked else 'pending'
                self.db.execute("UPDATE reply_outbox SET state=?,receipt=? WHERE id=? AND state IN ('pending','sending')",
                                (state, canonical(result), ident))
                if state == 'pending':
                    break

    async def flush(self):
        """Повторить незавершённую доставку при восстановлении existing supervisor."""
        owners = [row[0] for row in self.db.execute("SELECT DISTINCT owner FROM reply_outbox WHERE state IN ('pending','sending')")]
        await asyncio.gather(*(self.flush_owner(owner) for owner in owners))
