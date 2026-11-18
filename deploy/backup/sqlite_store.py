# ABOUTME: Создаёт штатную SQLite backup-копию с сохранением всех таблиц и FTS.
# ABOUTME: Исходная БД открывается read-only; WAL не копируется отдельно от снимка.
import contextlib
import os
from pathlib import Path
import shutil
import sqlite3
import uuid
from common import Failure


def sqlite_snapshot(source, destination):
    """Заменить копию файла согласованным SQLite backup без фильтрации содержимого."""
    source, destination = Path(source), Path(destination)
    temporary = destination.with_name('.sqlite-' + uuid.uuid4().hex)
    try:
        with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live:
            with contextlib.closing(sqlite3.connect(temporary)) as snapshot:
                live.backup(snapshot, pages=256)
                snapshot.execute('PRAGMA journal_mode=DELETE')
                if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise Failure('RECOVERY_SQLITE_INTEGRITY_FAILED')
                if snapshot.execute('PRAGMA foreign_key_check').fetchall():
                    raise Failure('RECOVERY_SQLITE_FOREIGN_KEYS_FAILED')
                snapshot.commit()
        original = destination.stat()
        shutil.copystat(destination, temporary)
        if os.geteuid() == 0:
            os.chown(temporary, original.st_uid, original.st_gid)
        os.replace(temporary, destination)
        for suffix in ('-wal', '-shm', '-journal'):
            Path(str(destination) + suffix).unlink(missing_ok=True)
    finally:
        temporary.unlink(missing_ok=True)
