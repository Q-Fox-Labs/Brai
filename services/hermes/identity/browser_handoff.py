# ABOUTME: Фиксирует команды и передачу браузерной сессии до обращения к браузеру.
# ABOUTME: Не переносит состояние сайта и не управляет размещением или бэкапом БД.
"""Защитный механизм для будущего адаптера переключения браузеров."""

import asyncio
import sqlite3
import uuid


class UncertainBrowserState(RuntimeError):
    """Результат команды неизвестен; повтор или переключение запрещены."""


class BrowserJournal:
    """Хранить сведения о сессиях в доверенной SQLite-базе их владельца.

    Вызывающий управляет подключением, защитой и согласованным бэкапом БД.
    При восстановлении из копии он обязан вызвать quarantine_restored до работы.
    """

    def __init__(self, db):
        if not isinstance(db, sqlite3.Connection) or db.in_transaction:
            raise ValueError('An idle SQLite connection is required')
        if not db.execute('PRAGMA database_list').fetchone()[2]:
            raise ValueError('A persistent SQLite database is required')
        self.db = db
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS browser_handoff (
            session_id TEXT PRIMARY KEY, backend TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('idle', 'unknown')),
            operation_id TEXT,
            CHECK ((state = 'idle' AND operation_id IS NULL) OR
                   (state = 'unknown' AND operation_id IS NOT NULL)))''')
        self.db.commit()

    def create(self, backend, session):
        """Зарегистрировать новую логическую сессию; существующую не заменять."""
        if not isinstance(backend, str) or not backend or not isinstance(session, str) or not session:
            raise ValueError('Browser and session are required')
        with self.db:
            self.db.execute('INSERT INTO browser_handoff VALUES (?, ?, ?, NULL)',
                            (session, backend, 'idle'))
        return BrowserSession(self, session)

    def attach(self, session):
        """Открыть существующую сессию, сохранив её неопределённое состояние."""
        if self._row(session) is None:
            raise ValueError('Unknown browser session')
        return BrowserSession(self, session)

    def quarantine_restored(self):
        """Заблокировать сессии после восстановления копии до запуска runtime."""
        with self.db:
            self.db.execute("UPDATE browser_handoff SET state='unknown', operation_id=? WHERE state='idle'",
                            ('restored',))

    def _row(self, session):
        return self.db.execute('SELECT backend, state, operation_id FROM browser_handoff WHERE session_id=?',
                               (session,)).fetchone()

    def _claim(self, session):
        token = uuid.uuid4().hex
        with self.db:
            result = self.db.execute("UPDATE browser_handoff SET state='unknown', operation_id=? "
                                     "WHERE session_id=? AND state='idle' RETURNING backend", (token, session))
            row = result.fetchone()
            result.close()
            if row is None:
                raise UncertainBrowserState('Browser session is missing or has an unknown result')
        return token, row[0]

    def _complete(self, session, token, backend):
        with self.db:
            result = self.db.execute("UPDATE browser_handoff SET backend=?, state='idle', operation_id=NULL "
                                     "WHERE session_id=? AND state='unknown' AND operation_id=?",
                                     (backend, session, token))
            if result.rowcount != 1:
                raise UncertainBrowserState('Browser operation no longer owns the session')


class BrowserSession:
    """Сериализовать операции, сохраняя неизвестный результат между запусками.

    Все операции с браузером должны проходить через execute. Журнал создаётся
    и открывается доверенным владельцем, а не браузером или содержимым сайта.
    """

    def __init__(self, journal, session):
        self._journal = journal
        self._session = session
        self._lock = asyncio.Lock()

    @property
    def backend(self):
        """Вернуть последнего подтверждённого владельца сессии."""
        row = self._journal._row(self._session)
        if row is None:
            raise UncertainBrowserState('Browser session is missing')
        return row[0]

    async def execute(self, operation):
        """Передать одну команду; потерянный ответ не разрешает её повтор."""
        async with self._lock:
            token, backend = self._journal._claim(self._session)
            # AIDEV-NOTE: Запись завершается до передачи команды браузеру.
            result = await operation(backend, self._session)
            self._journal._complete(self._session, token, backend)
            return result

    async def switch(self, target, verify):
        """Сменить владельца после подтверждения сохранности всей сессии.

        Доверенный verify не выполняет действия сайта. Он должен подтвердить
        возможность продолжения без повторения команд; одних cookies недостаточно.
        Исходный браузер не останавливается.
        """
        if not isinstance(target, str) or not target:
            raise ValueError('Target browser is required')
        async with self._lock:
            token, backend = self._journal._claim(self._session)
            verified = target == backend or await verify(backend, target, self._session) is True
            self._journal._complete(self._session, token, target if verified else backend)
            return verified
