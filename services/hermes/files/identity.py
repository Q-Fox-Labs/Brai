# ABOUTME: Переносит проверенные inode между профилем и привилегированным Artifacts.
# ABOUTME: Владелец поступает из SO_PEERCRED; root cache недоступен worker.
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import uuid

MAX_FILE = 64 * 1024 * 1024


def open_directory(path, uid):
    """Закрепить каталог без symlink и проверить владельца и права."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise PermissionError('Invalid directory')
    current = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        info = os.fstat(current)
        if info.st_uid != uid or info.st_mode & 0o022:
            raise PermissionError('Foreign directory')
        return os.dup(current)
    finally:
        os.close(current)


def open_file(root, path, uid):
    """Закрепить обычный односсылочный файл в разрешённом корне."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise PermissionError('Invalid path')
    relative = path.relative_to(root)
    if not relative.parts:
        raise PermissionError('Invalid file')
    directory = open_directory(root, uid)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid != uid or info.st_mode & 0o022:
                raise PermissionError('Foreign directory')
        fd = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or not 0 <= info.st_size <= MAX_FILE:
            os.close(fd)
            raise PermissionError('File denied')
        return fd
    finally:
        os.close(directory)


def copy_fd(source, target):
    """Скопировать ограниченный стабильный inode и вычислить SHA-256."""
    before = os.fstat(source)
    digest, size = hashlib.sha256(), 0
    while chunk := os.read(source, 1024 * 1024):
        size += len(chunk)
        if size > MAX_FILE:
            raise ValueError('File too large')
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            count = os.write(target, view)
            if count <= 0:
                raise OSError('Short write')
            view = view[count:]
    after = os.fstat(source)
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != before.st_size:
        raise PermissionError('File changed during copy')
    os.fsync(target)
    return size, digest.hexdigest()


def copy_to_profile(source, home, area, folder, name, uid, expected=None, receipt=None):
    """Атомарно записать личную копию через descriptor каталога."""
    if not isinstance(name, str) or not name or name in ('.', '..') or Path(name).name != name or '\\' in name:
        raise ValueError('Invalid filename')
    parent = open_directory(Path(home) / area, uid)
    directory = None
    temporary = '.copy-' + uuid.uuid4().hex
    try:
        try:
            os.mkdir(folder, 0o700, dir_fd=parent)
            os.chown(folder, uid, -1, dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            pass
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(directory)
        if info.st_uid != uid or info.st_mode & 0o077:
            raise PermissionError('Unsafe destination')
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            size, digest = copy_fd(source, target)
            if expected is not None and (size != expected['sizeBytes'] or digest != expected['sha256']):
                raise PermissionError('Hash mismatch')
            os.fchown(target, uid, -1)
        finally:
            os.close(target)
        os.rename(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        if receipt is not None:
            receipt.update(sizeBytes=size, sha256=digest)
        return str(Path(home) / area / folder / name)
    finally:
        if directory is not None:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)
        os.close(parent)


class OwnerFiles:
    """Выполнить файловые операции только для проверенного профиля."""

    def __init__(self, config, control, config_reader=None):
        self.config, self.control, self.config_reader = config, control, config_reader

    def runtime(self, uid, profile):
        """Перечитать root-owned runtime mapping, включая новые приглашённые профили."""
        if not self.config.get('runtimeProfilesPath'):
            return {'cacheRoot': self.config['artifactCacheRoots'][str(uid)],
                    'stagingRoot': str(Path(self.config['stagingRoot']) / str(uid))}
        if self.config_reader is None:
            raise PermissionError('Runtime mapping unavailable')
        entries = self.config_reader(self.config['runtimeProfilesPath'])
        entry = entries.get(str(uid)) if isinstance(entries, dict) else None
        if (not isinstance(entry, dict) or any(entry.get(key) != profile.get(key)
                for key in ('userId', 'profileId', 'home'))):
            raise PermissionError('Runtime profile mismatch')
        if any(not isinstance(entry.get(key), str) or not Path(entry[key]).is_absolute()
                or '..' in Path(entry[key]).parts for key in ('cacheRoot', 'stagingRoot')):
            raise PermissionError('Invalid runtime path')
        return entry

    async def configuration(self, uid, profile):
        """Проверить owner и личные пути bootstrap до передачи worker."""
        self.runtime(uid, profile)
        value = await self.control.call('files.configuration', {'uid': uid})
        home = Path(profile['home'])
        if (not isinstance(value, dict) or value.get('ownerId') != profile['userId']
                or value.get('stateRoot') != str(home / 'workspace' / 'files')
                or value.get('resultRoot') != str(home / 'results')):
            raise PermissionError('Invalid file configuration')
        for key in ('readRoots', 'temporaryRoots', 'serviceRoots', 'legacyRoots'):
            roots = value.get(key, [])
            if not isinstance(roots, list) or any(not isinstance(p, str) or not Path(p).is_absolute()
                    or '..' in Path(p).parts or (not Path(p).is_relative_to(home) and
                    (key != 'serviceRoots' or p not in (
                        '/opt/brai-profile/engine', '/opt/brai-profile/runtime',
                        '/opt/brai-profile/instructions'))) for p in roots):
                raise PermissionError('Foreign file root')
        return value

    def open_cache(self, uid, result, profile=None):
        """Проверить точный root-owned cache path и метаданные результата."""
        aid = str(uuid.UUID(result['artifactId']))
        name, root = result['filename'], self.runtime(uid, profile)['cacheRoot']
        if (aid != result['artifactId'] or not isinstance(name, str) or not name or name in ('.', '..')
                or Path(name).name != name or '\\' in name or Path(result['localPath']) != Path(root) / aid / name
                or type(result['sizeBytes']) is not int or not 0 <= result['sizeBytes'] <= MAX_FILE
                or not isinstance(result['sha256'], str) or len(result['sha256']) != 64
                or not isinstance(result['mimeType'], str) or not result['mimeType']):
            raise ValueError('Invalid artifact')
        return open_file(root, result['localPath'], 0)

    def materialize(self, uid, profile, result):
        """Вернуть только копию результата в собственном results worker."""
        source = self.open_cache(uid, result, profile)
        try:
            path = copy_to_profile(source, profile['home'], 'results', result['artifactId'], result['filename'], uid, result)
        finally:
            os.close(source)
        name = result['filename'].replace('\\', '\\\\').replace('[', '\\[').replace(']', '\\]')
        marker = '!' if result.get('markdown', '').startswith('![') else ''
        value = {**result, 'localPath': path, 'markdown': marker + '[' + name + '](<' + path + '>)'}
        return {key: value[key] for key in ('artifactId', 'filename', 'mimeType', 'sizeBytes', 'sha256', 'localPath', 'markdown')}

    def input_admission(self, uid, profile, path):
        """Проверить root-квитанцию точного вложения ingress без выдачи общего файлового доступа."""
        path = Path(path)
        relative = path.relative_to(Path(profile['home']) / 'media')
        if len(relative.parts) != 2 or len(relative.parts[0]) != 32 or any(c not in '0123456789abcdef' for c in relative.parts[0]):
            raise PermissionError('Input was not admitted')
        directory = open_directory(path.parent, uid)
        try:
            fd = os.open('.brai-admission.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 4096:
                    raise PermissionError('Invalid input admission')
                with os.fdopen(fd, 'rb', closefd=False) as source:
                    value = json.load(source)
            finally:
                os.close(fd)
        finally:
            os.close(directory)
        if (value.get('path') != str(path) or value.get('userId') != profile['userId']
                or value.get('profileId') != profile['profileId'] or type(value.get('sizeBytes')) is not int
                or not 0 <= value['sizeBytes'] <= MAX_FILE or not isinstance(value.get('sha256'), str)
                or len(value['sha256']) != 64):
            raise PermissionError('Invalid input admission')
        return value

    async def publish(self, uid, profile, params, *, admitted=False):
        """Опубликовать root snapshot с исходным именем и стабильным requestId."""
        if set(params) != {'path', 'requestId'} or not isinstance(params.get('requestId'), str) or not 1 <= len(params['requestId']) <= 256:
            raise ValueError('Invalid publication')
        path, home = Path(params['path']), Path(profile['home'])
        relative = path.relative_to(home)
        if len(relative.parts) < 2 or relative.parts[0] not in ('workspace', 'results', 'media'):
            raise PermissionError('File root denied')
        expected = self.input_admission(uid, profile, path) if admitted else None
        source = open_file(home / relative.parts[0], path, uid)
        folder = None
        try:
            stage = Path(self.runtime(uid, profile)['stagingRoot'])
            checked = open_directory(stage, 0)
            os.close(checked)
            folder = Path(tempfile.mkdtemp(prefix='publish-', dir=stage))
            snapshot = folder / path.name
            target = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                size, digest = copy_fd(source, target)
                if expected is not None and (size != expected['sizeBytes'] or digest != expected['sha256']):
                    raise PermissionError('Input bytes changed')
            finally:
                os.close(target)
            result = await self.control.call('artifacts.publish', {'uid': uid, 'path': str(snapshot), 'requestId': params['requestId']}, timeout=1800)
            return self.materialize(uid, profile, result)
        finally:
            os.close(source)
            if folder is not None:
                shutil.rmtree(folder)

    async def create_text(self, uid, profile, params):
        """Публиковать точные UTF-8 байты без произвольного пути или программы."""
        if (set(params) != {'filename', 'content', 'requestId'}
                or not isinstance(params['filename'], str) or not 1 <= len(params['filename']) <= 180
                or params['filename'] in ('.', '..') or Path(params['filename']).name != params['filename']
                or any(ord(c) < 32 or c in '/\\' for c in params['filename'])
                or not isinstance(params['content'], str)
                or not isinstance(params['requestId'], str) or not 1 <= len(params['requestId']) <= 256):
            raise ValueError('Invalid text artifact')
        raw = params['content'].encode('utf-8')
        if len(raw) > 1024 * 1024:
            raise ValueError('Text artifact too large')
        stage = Path(self.runtime(uid, profile)['stagingRoot'])
        checked = open_directory(stage, 0)
        os.close(checked)
        folder = Path(tempfile.mkdtemp(prefix='text-', dir=stage))
        try:
            path = folder / params['filename']
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
            except BaseException:
                raise
            result = await self.control.call('artifacts.publish', {'uid': uid, 'path': str(path),
                'requestId': params['requestId']}, timeout=1800)
            if result.get('filename') != params['filename'] or result.get('sizeBytes') != len(raw) or result.get('sha256') != hashlib.sha256(raw).hexdigest():
                raise PermissionError('Text artifact bytes changed')
            value = self.materialize(uid, profile, result)
            name = value['filename'].replace('\\','\\\\').replace('[','\\[').replace(']','\\]')
            value['markdown'] = '[' + name + '](artifact:' + value['artifactId'] + ')'
            return value
        finally:
            shutil.rmtree(folder)

    async def read_text(self, uid, profile, params):
        """Читать ограниченный UTF-8 артефакт после owner-проверки Artifacts."""
        if set(params) != {'artifactId'}:
            raise ValueError('Invalid text artifact')
        aid = str(uuid.UUID(params['artifactId']))
        result = await self.control.call('artifacts.fetch', {'uid': uid, 'artifactId': aid}, timeout=120)
        if result.get('artifactId') != aid:
            raise PermissionError('Artifact mismatch')
        fd = self.open_cache(uid, result, profile)
        try:
            if result['sizeBytes'] > 1024 * 1024:
                raise ValueError('Text artifact too large')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(1024 * 1024 + 1)
            if len(raw) != result['sizeBytes'] or hashlib.sha256(raw).hexdigest() != result['sha256']:
                raise PermissionError('Text artifact bytes changed')
            return {'artifactId': aid, 'filename': result['filename'], 'content': raw.decode('utf-8')}
        finally:
            os.close(fd)

    async def fetch(self, uid, profile, params, *, ingress=False):
        """Подтвердить owner у Artifacts; ingress получает свою проверенную копию."""
        if set(params) != {'artifactId'}:
            raise ValueError('Invalid fetch')
        aid = str(uuid.UUID(params['artifactId']))
        result = await self.control.call('artifacts.fetch', {'uid': uid, 'artifactId': aid}, timeout=1800)
        if result.get('artifactId') != aid:
            raise PermissionError('Artifact mismatch')
        if ingress:
            delivery = Path(self.config['ingressDeliveryRoot'])
            fd = self.open_cache(uid, result, profile)
            try:
                path = copy_to_profile(fd, delivery.parent, delivery.name, str(uid) + '-' + aid,
                    result['filename'], self.config['ingressUid'], result)
            finally:
                os.close(fd)
            return {**result, 'localPath': path, 'markdown': '[file](<' + path + '>)'}
        return self.materialize(uid, profile, result)

    async def open_ingress(self, uid, profile, artifact_id):
        """Открыть конкретный owner-bound артефакт; права каталогов не меняются."""
        try:
            from ..identity.artifact_read import FIELDS, verify
        except ImportError:
            from identity.artifact_read import FIELDS, verify
        aid = str(uuid.UUID(artifact_id))
        result = await self.control.call('artifacts.fetch', {'uid': uid, 'artifactId': aid}, timeout=120)
        if result.get('artifactId') != aid:
            raise PermissionError('Artifact mismatch')
        fd = self.open_cache(uid, result, profile)
        try:
            if os.fstat(fd).st_mode & 0o022:
                raise PermissionError('Writable artifact cache')
            metadata = {key: result[key] for key in FIELDS}
            await verify(fd, metadata)
            return metadata, fd
        except BaseException:
            os.close(fd)
            raise

    async def prepare_ingress(self, uid, profile, paths):
        """Перенести уже скачанные файлы ingress в media проверенного профиля."""
        if not isinstance(paths, list) or len(paths) > 100 or any(not isinstance(p, str) for p in paths):
            raise ValueError('Invalid input paths')
        copied = []
        for path in paths:
            roots = [root for root in self.config['ingressReadRoots'] if Path(path).is_relative_to(root)]
            if len(roots) != 1:
                raise PermissionError('Ingress root denied')
            source = open_file(roots[0], path, self.config['ingressUid'])
            try:
                receipt = {}
                destination = copy_to_profile(source, profile['home'], 'media', uuid.uuid4().hex,
                                              Path(path).name, uid, receipt=receipt)
                folder = open_directory(Path(destination).parent, uid)
                try:
                    fd = os.open('.brai-admission.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
                    with os.fdopen(fd, 'w') as marker:
                        json.dump({**receipt, 'path': destination, 'userId': profile['userId'],
                                   'profileId': profile['profileId']}, marker)
                        marker.flush()
                        os.fsync(marker.fileno())
                finally:
                    os.close(folder)
                copied.append(destination)
            finally:
                os.close(source)
        return {'paths': copied}
