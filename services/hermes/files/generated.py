# ABOUTME: Root-owned, single-use admission tickets for generated files.
# ABOUTME: The producer receives one fixed path, never a publication capability.
import asyncio
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import time

from .identity import MAX_FILE, copy_fd, open_directory

NAMES = {'image': 'image.png', 'audio': 'audio.ogg', 'screenshot': 'screenshot.png'}


class GeneratedFiles:
    def __init__(self, files, authorize, *, ttl=1800, limit=16, global_limit=1024, clock=time.monotonic):
        self.files, self.authorize = files, authorize
        self.ttl, self.limit, self.global_limit, self.clock = ttl, limit, global_limit, clock
        self.tickets = {}
        self.lock = asyncio.Lock()

    def _clean(self, ticket):
        # Only entries that this broker created are touched, relative to held FDs.
        try:
            try:
                os.unlink(ticket['name'], dir_fd=ticket['dir'])
            except OSError:
                pass
            try:
                info = os.stat(ticket['folder'], dir_fd=ticket['parent'], follow_symlinks=False)
                held = os.fstat(ticket['dir'])
                if (info.st_dev, info.st_ino) == (held.st_dev, held.st_ino):
                    os.rmdir(ticket['folder'], dir_fd=ticket['parent'])
            except (FileNotFoundError, OSError):
                pass
        finally:
            os.close(ticket['dir'])
            os.close(ticket['parent'])

    def _expire(self):
        for key, ticket in list(self.tickets.items()):
            if ticket['expires'] <= self.clock():
                del self.tickets[key]
                self._clean(ticket)

    async def reap(self):
        """Periodically release expired descriptors even with no new requests."""
        async with self.lock:
            self._expire()

    async def close(self):
        """Release every outstanding ticket when the broker shuts down."""
        async with self.lock:
            tickets, self.tickets = self.tickets, {}
            for ticket in tickets.values():
                self._clean(ticket)

    async def begin(self, uid, profile, params):
        if set(params) != {'kind'} or params['kind'] not in NAMES or profile.get('role') != 'guest':
            raise PermissionError('Generation denied')
        if await self.authorize(uid) != profile:
            raise PermissionError('Principal changed')
        async with self.lock:
            self._expire()
            if len(self.tickets) >= self.global_limit or sum(t['uid'] == uid for t in self.tickets.values()) >= self.limit:
                raise PermissionError('Too many generation tickets')
            parent_path = Path(profile['home']) / 'results'
            parent = open_directory(parent_path, uid)
            directory = None
            folder = 'generated-' + secrets.token_hex(24)
            try:
                os.mkdir(folder, 0o700, dir_fd=parent)
                os.chown(folder, uid, -1, dir_fd=parent, follow_symlinks=False)
                directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                info = os.fstat(directory)
                if info.st_uid != uid or info.st_mode & 0o077:
                    raise PermissionError('Unsafe generation directory')
                key = secrets.token_urlsafe(32)
                name = NAMES[params['kind']]
                self.tickets[key] = {'uid': uid, 'profile': dict(profile), 'parent': parent,
                    'dir': directory, 'folder': folder, 'name': name, 'expires': self.clock() + self.ttl}
                return {'ticket': key, 'path': str(parent_path / folder / name)}
            except BaseException:
                if directory is not None:
                    os.close(directory)
                try:
                    os.rmdir(folder, dir_fd=parent)
                except OSError:
                    pass
                os.close(parent)
                raise

    async def _take(self, uid, profile, key):
        async with self.lock:
            self._expire()
            ticket = self.tickets.get(key) if isinstance(key, str) else None
            if ticket is None or ticket['uid'] != uid or ticket['profile'] != profile:
                raise PermissionError('Invalid generation ticket')
            del self.tickets[key]
            return ticket

    async def abort(self, uid, profile, params):
        if set(params) != {'ticket'}:
            raise ValueError('Invalid abort')
        ticket = await self._take(uid, profile, params['ticket'])
        self._clean(ticket)
        return {'aborted': True}

    async def finish(self, uid, profile, params):
        if (set(params) != {'ticket', 'sizeBytes', 'sha256'} or type(params['sizeBytes']) is not int
                or not 0 < params['sizeBytes'] <= MAX_FILE or not isinstance(params['sha256'], str)
                or not re.fullmatch('[0-9a-f]{64}', params['sha256'])):
            raise ValueError('Invalid generation receipt')
        ticket = await self._take(uid, profile, params['ticket'])
        source = None
        try:
            if await self.authorize(uid) != profile:
                raise PermissionError('Principal changed')
            source = os.open(ticket['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=ticket['dir'])
            info = os.fstat(source)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or info.st_size > MAX_FILE:
                raise PermissionError('Generated file denied')
            stage = Path(self.files.runtime(uid, profile)['stagingRoot'])
            stage_fd = open_directory(stage, 0)
            os.close(stage_fd)
            with tempfile.TemporaryDirectory(prefix='generated-', dir=stage) as folder:
                path = Path(folder) / ticket['name']
                target = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    size, digest = copy_fd(source, target)
                finally:
                    os.close(target)
                if size != params['sizeBytes'] or not secrets.compare_digest(digest, params['sha256']):
                    raise PermissionError('Generated bytes changed')
                if await self.authorize(uid) != profile:
                    raise PermissionError('Principal changed')
                result = await self.files.control.call('artifacts.publish', {'uid': uid, 'path': str(path),
                    'requestId': 'generated-' + params['ticket']}, timeout=1800)
                if result.get('sizeBytes') != size or result.get('sha256') != digest or result.get('filename') != ticket['name']:
                    raise PermissionError('Artifact mismatch')
                if await self.authorize(uid) != profile:
                    raise PermissionError('Principal changed')
                return self.files.materialize(uid, profile, result)
        finally:
            if source is not None:
                os.close(source)
            self._clean(ticket)
