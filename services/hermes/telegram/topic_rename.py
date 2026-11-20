# ABOUTME: Передаёт из MCP в Telegram-шлюз только одноразовые подтверждённые вызовы переименования.
# ABOUTME: Адрес темы и аргументы операции захватываются до передачи вызова из Hermes в MCP.
import asyncio
import errno
import json
import os
import secrets
import socket
import stat
import threading
import unicodedata


class TopicRenameError(Exception):
    """Безопасный код отказа без токена, адреса темы и текста запроса."""


def rename_arguments(args):
    if not isinstance(args, dict) or set(args) not in ({'title'}, {'text'}):
        raise TopicRenameError('INVALID_ARGUMENT')
    key, value = next(iter(args.items()))
    if not isinstance(value, str) or not value.strip():
        raise TopicRenameError('INVALID_ARGUMENT')
    value = value.strip()
    if key == 'title' and (len(value) > 128 or any(unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} for char in value)):
        raise TopicRenameError('INVALID_ARGUMENT')
    return {key: value}


class RenamePort:
    """Держит допуски только до вызова или окончания native tool call."""

    def __init__(self, path, apply):
        self.path = path
        self.apply = apply
        self.lock = threading.Lock()
        self.grants = {}
        self.server = None
        self.inode = None
        self.edit_lock = asyncio.Lock()

    def grant(self, call_id, context, args):
        ticket = secrets.token_urlsafe(32)
        with self.lock:
            self.grants[ticket] = (call_id, context, args)
        return ticket

    def revoke(self, session_id, call_id=None):
        with self.lock:
            for ticket, (call, ctx, _) in tuple(self.grants.items()):
                if ctx['session_id'] == session_id and (call_id is None or call_id == call):
                    self.grants.pop(ticket)

    async def start(self):
        if self.server is not None:
            return
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise TopicRenameError('TELEGRAM_RENAME_SOCKET_INVALID')
            with socket.socket(socket.AF_UNIX) as probe:
                result = probe.connect_ex(str(self.path))
                if result not in (errno.ECONNREFUSED, errno.ENOENT):
                    raise TopicRenameError('TELEGRAM_RENAME_SOCKET_IN_USE')
            self.path.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self.handle, path=self.path)
        self.inode = self.path.lstat().st_ino
        self.path.chmod(0o600)

    def close(self):
        if self.server is not None:
            self.server.close()
            self.server = None
        try:
            if self.inode is not None and self.path.lstat().st_ino == self.inode:
                self.path.unlink()
        except FileNotFoundError:
            pass
        self.inode = None
        with self.lock:
            self.grants.clear()

    async def handle(self, reader, writer):
        try:
            ticket = (await reader.readline()).decode('ascii').strip()
            with self.lock:
                grant = self.grants.pop(ticket, None)
            if grant is None:
                raise TopicRenameError('TOPIC_RENAME_CONTEXT_REQUIRED')
            _, context, args = grant
            async with self.edit_lock:
                result = await self.apply(context, args, lambda: not reader.at_eof())
        except TopicRenameError as error:
            result = {'ok': False, 'code': str(error)}
        except Exception:
            result = {'ok': False, 'code': 'TOPIC_RENAME_UNCONFIRMED'}
        try:
            writer.write((json.dumps(result, ensure_ascii=False) + '\n').encode())
            await writer.drain()
        except OSError:
            pass
        finally:
            writer.close()

