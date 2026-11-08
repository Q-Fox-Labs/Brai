# ABOUTME: Хранит подтверждённые ingress маршруты и принадлежность сообщений.
# ABOUTME: Не сохраняет текст, callback data, ключи или историю пользователя.
"""Локальный журнал транспортных прав переживает перезапуск ingress."""
import json
import os
from pathlib import Path
import sqlite3
import stat


class RouteLedger:
    """Права связаны со всей актуальной UID/Auth привязкой, а не только chat ID."""
    def __init__(self, path=':memory:'):
        if path != ':memory:':
            path = Path(path)
            parent = path.parent.lstat()
            if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
                raise PermissionError('Unprotected route directory')
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                    raise PermissionError('Unprotected route ledger')
            finally:
                os.close(fd)
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=3)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS routes (owner TEXT, chat TEXT, thread TEXT, metadata TEXT NOT NULL, PRIMARY KEY(owner,chat,thread))')
        self.db.execute('CREATE TABLE IF NOT EXISTS messages (owner TEXT, chat TEXT, thread TEXT, message TEXT, outgoing INTEGER NOT NULL, PRIMARY KEY(owner,chat,thread,message,outgoing))')

    @staticmethod
    def owner(profile):
        """Смена binding автоматически лишает новый профиль прежних транспортных прав."""
        return json.dumps([profile['uid'], profile['userId'], profile.get('profileId'),
                           str(profile['telegramId'])], separators=(',', ':'))

    def admit(self, profile, route, metadata, message_id=None):
        """Запомнить маршрут только после реального broker ingress.admit."""
        self.db.execute('INSERT OR REPLACE INTO routes VALUES (?,?,?,?)',
            (self.owner(profile), *route, json.dumps(metadata, sort_keys=True)))
        if message_id:
            self.record(profile, route, message_id, outgoing=False)

    def metadata(self, profile, route):
        row = self.db.execute('SELECT metadata FROM routes WHERE owner=? AND chat=? AND thread=?',
                              (self.owner(profile), *route)).fetchone()
        return json.loads(row[0]) if row else None

    def record(self, profile, route, message_id, outgoing=True):
        """Записать только подтверждённый Telegram message ID."""
        if not str(message_id).isdecimal() or int(message_id) <= 0:
            raise ValueError('Invalid Telegram message receipt')
        self.db.execute('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?)',
            (self.owner(profile), *route, str(message_id), int(outgoing)))

    def owns(self, profile, route, message_id, outgoing=None):
        values = (self.owner(profile), *route, str(message_id))
        query = 'SELECT 1 FROM messages WHERE owner=? AND chat=? AND thread=? AND message=?'
        if outgoing is not None:
            query += ' AND outgoing=?'
            values += (int(outgoing),)
        return self.db.execute(query, values).fetchone() is not None

    def close(self):
        self.db.close()
