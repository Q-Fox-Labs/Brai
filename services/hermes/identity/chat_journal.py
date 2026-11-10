# ABOUTME: Сохраняет фактические сообщения Telegram отдельно для каждого личного профиля.
# ABOUTME: Читает только допущенные updates и успешные Bot API receipts; не импортирует ответы модели.
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import inspect
import json
import logging
import os
from pathlib import Path
import sqlite3
import stat
import uuid
from types import SimpleNamespace

_scope = ContextVar('brai_telegram_journal_scope', default=None)
_log = logging.getLogger(__name__)
_METHODS = ('send_message', 'edit_message_text', 'edit_message_caption', 'send_photo',
            'send_audio', 'send_voice', 'send_video', 'send_animation', 'send_document',
            'send_media_group', 'delete_message', 'do_api_request')


def _stamp(value):
    return value.astimezone(timezone.utc).isoformat() if isinstance(value, datetime) else None



def _message(value):
    """Преобразовать raw Bot API receipt без использования отправленного запроса."""
    if not isinstance(value, dict):
        return value
    if isinstance(value.get('result'), dict):
        value = value['result']
    if not value.get('message_id') or not isinstance(value.get('chat'), dict):
        return None
    data = dict(value)
    data['chat'] = SimpleNamespace(**data['chat'])
    for key in ('date', 'edit_date'):
        if type(data.get(key)) in (int, float):
            data[key] = datetime.fromtimestamp(data[key], timezone.utc)
    return SimpleNamespace(**data)


class IdentityJournal:
    """Хранить точный Telegram payload в каталоге доверенного ingress, без доступа worker."""
    def __init__(self, root):
        self.root = Path(root)
        if not self.root.is_absolute():
            raise ValueError('INVALID_JOURNAL_ROOT')
        self.routes = {}
        self.generation = None
        self.restore = None

    def database(self, profile):
        """Открыть только UUID профиля из broker; UID не принимает модель."""
        ident = profile['profileId']
        if str(uuid.UUID(ident)) != ident:
            raise ValueError('INVALID_PROFILE_ID')
        directory = self.root / ident
        for path in (self.root, directory):
            path.mkdir(mode=0o700, parents=False, exist_ok=True)
            meta = path.lstat()
            if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
                raise ValueError('INVALID_JOURNAL_DIRECTORY')
        path = directory / 'telegram.sqlite3'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_nlink != 1 or meta.st_mode & 0o077:
                raise ValueError('INVALID_JOURNAL_FILE')
        finally:
            os.close(fd)
        db = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA busy_timeout=1000')
        db.executescript("""
            CREATE TABLE IF NOT EXISTS messages(
              id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, thread TEXT NOT NULL,
              telegram_id TEXT NOT NULL, direction TEXT NOT NULL, name TEXT NOT NULL,
              username TEXT NOT NULL, text TEXT NOT NULL, at TEXT, edited TEXT,
              kind TEXT NOT NULL, attachments TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
              rich TEXT NOT NULL DEFAULT 'null', UNIQUE(chat,telegram_id));
            CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, message INTEGER NOT NULL);
        """)
        if 'rich' not in {row[1] for row in db.execute('PRAGMA table_info(messages)')}:
            db.execute("ALTER TABLE messages ADD COLUMN rich TEXT NOT NULL DEFAULT 'null'")
            db.commit()
        return db

    def incoming(self, profile, message, chat, user):
        """Записать оригинал до ASR, обёрток и объединения native очередями."""
        self.routes[str(chat.id)] = profile
        self.save(profile, message, 'in', getattr(user, 'full_name', '') or '',
                  getattr(user, 'username', '') or '')

    def save(self, profile, message, direction, name='Brai', username='', refs=()):
        """Записать фактический text/caption, включая пробелы и пустую правку."""
        chat = str(message.chat.id)
        mid = str(message.message_id)
        thread = str(getattr(message, 'message_thread_id', None) or '')
        active = _scope.get()
        if not thread and direction == 'out' and active and active[0] is self and active[1]['profileId'] == profile['profileId']:
            thread = active[4]
        if thread == '1':
            thread = ''
        kind = next((key for key in ('photo', 'voice', 'audio', 'video', 'animation', 'document',
                                     'sticker', 'location', 'contact', 'poll')
                     if getattr(message, key, None)), 'text')
        text = getattr(message, 'text', None)
        if text is None:
            text = getattr(message, 'caption', None)
        if not isinstance(text, str):
            text = ''
        rich = getattr(message, 'rich_message', None) or (getattr(message, 'api_kwargs', None) or {}).get('rich_message')
        if callable(getattr(rich, 'to_dict', None)):
            rich = rich.to_dict()
        if rich is not None:
            kind = 'rich'
        db = self.database(profile)
        try:
            with db:
                old = db.execute('SELECT * FROM messages WHERE chat=? AND telegram_id=?', (chat, mid)).fetchone()
                if old and old['thread']:
                    thread = old['thread']
                attachments = list(refs) or (json.loads(old['attachments']) if old else [])
                values = (chat, thread, mid, direction, name, username, text, _stamp(getattr(message, 'date', None)),
                          _stamp(getattr(message, 'edit_date', None)), kind,
                          json.dumps(attachments, ensure_ascii=False, separators=(',', ':')), 0,
                          json.dumps(rich, ensure_ascii=False, separators=(',', ':')))
                fields = ('chat', 'thread', 'telegram_id', 'direction', 'name', 'username', 'text',
                          'at', 'edited', 'kind', 'attachments', 'deleted', 'rich')
                if old and old['edited'] and (not values[8] or old['edited'] > values[8]):
                    return
                if old and all(old[key] == value for key, value in zip(fields, values)):
                    return
                if old:
                    db.execute('UPDATE messages SET ' + ','.join(key + '=?' for key in fields) + ' WHERE id=?',
                               (*values, old['id']))
                    row = old['id']
                else:
                    row = db.execute('INSERT INTO messages(' + ','.join(fields) + ') VALUES(' +
                                     ','.join('?' for _ in fields) + ')', values).lastrowid
                db.execute('INSERT INTO changes(message) VALUES(?)', (row,))
        finally:
            db.close()

    def delete(self, profile, chat, mid):
        """Сохранить tombstone только после подтверждённого Bot API удаления."""
        db = self.database(profile)
        try:
            with db:
                row = db.execute('SELECT id FROM messages WHERE chat=? AND telegram_id=? AND deleted=0',
                                 (str(chat), str(mid))).fetchone()
                if row:
                    db.execute("UPDATE messages SET deleted=1,text='',attachments='[]',rich='null' WHERE id=?", (row['id'],))
                    db.execute('INSERT INTO changes(message) VALUES(?)', (row['id'],))
        finally:
            db.close()

    @contextmanager
    def scope(self, profile, files=(), thread=''):
        """Связать receipt с проверенным владельцем и упорядоченными готовыми файлами."""
        token = _scope.set((self, profile, [item['file'] for item in files], set(), str(thread or '')))
        try:
            yield
        finally:
            _scope.reset(token)

    def install(self, bot):
        """Наблюдать успешные публичные методы только этого Bot; вернуть восстановление."""
        if self.restore is not None:
            self.restore()
        generation = object()
        self.generation = generation
        cls, installed = type(bot), {}
        for method in _METHODS:
            original = getattr(cls, method, None)
            if original is None:
                continue
            signature = inspect.signature(original)

            @wraps(original)
            async def wrapped(instance, *args, __original=original, __signature=signature, __method=method, **kwargs):
                result = await __original(instance, *args, **kwargs)
                if instance is not bot or self.generation is not generation:
                    return result
                try:
                    values = __signature.bind(instance, *args, **kwargs).arguments
                    active = _scope.get()
                    endpoint = (__method if __method != 'do_api_request' else str(values.get('endpoint') or (args[0] if args else ''))).replace('_', '').casefold()
                    if __method == 'do_api_request':
                        values = values.get('api_kwargs') or {}
                    messages = result if isinstance(result, (list, tuple)) else [result]
                    for raw in messages:
                        message = _message(raw)
                        chat = str(getattr(getattr(message, 'chat', None), 'id', None) or values.get('chat_id') or '')
                        profile = active[1] if active and active[0] is self else self.routes.get(chat)
                        if profile is None:
                            continue
                        if endpoint == 'deletemessage':
                            if result is True:
                                self.delete(profile, chat, values.get('message_id'))
                            continue
                        if not getattr(message, 'message_id', None):
                            continue
                        refs = []
                        media = any(getattr(message, key, None) for key in
                                    ('photo', 'voice', 'audio', 'video', 'animation', 'document'))
                        if media and active and active[0] is self and active[2]:
                            key = (chat, str(message.message_id))
                            if key not in active[3]:
                                refs = [active[2].pop(0)]
                                active[3].add(key)
                        self.save(profile, message, 'out', refs=refs)
                except Exception:
                    _log.warning('BRAI_TELEGRAM_JOURNAL_WRITE_FAILED')
                return result

            installed[method] = (original, wrapped, method in cls.__dict__)
            setattr(cls, method, wrapped)

        def restore():
            if self.generation is generation:
                self.generation = None
            for name, (original, wrapped, owned) in installed.items():
                if cls.__dict__.get(name) is wrapped:
                    if owned:
                        setattr(cls, name, original)
                    else:
                        delattr(cls, name)
        self.restore = restore
        return restore
