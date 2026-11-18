# ABOUTME: Передаёт готовый снимок через закреплённый контейнер Duplicati и скачивает его обратно.
# ABOUTME: В контейнер не передаются рабочие корни; пароль и OAuth остаются в закрытом файле.
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import uuid
from urllib.parse import urlsplit, unquote
from common import Failure, run, js, write_json


@contextlib.contextmanager
def parameters(root, credentials):
    """Создать временный файл параметров без секретов в argv, удалить при любом исходе."""
    if not credentials.get('passphrase') or any(
        not isinstance(value, str) or '\n' in value or '\r' in value or not value
        for value in credentials.values()
    ) or set(credentials) - {'passphrase', 'authid'}:
        raise Failure('RECOVERY_CREDENTIAL_INVALID')
    fd, name = tempfile.mkstemp(prefix='.parameters-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            for key, value in credentials.items():
                stream.write('--' + key + '=' + value + '\n')
        yield Path(name)
    finally:
        Path(name).unlink(missing_ok=True)


def cleanup_parameters(root):
    """Убрать собственные закрытые параметры после аварии между CLI-вызовами."""
    for path in root.glob('.parameters-*'):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise Failure('RECOVERY_PARAMETER_FILE_UNTRUSTED')
        path.unlink()


def resume(root):
    """Подтвердить отсутствие собственного контейнера до удаления durable transfer journal."""
    journal = root / 'transfer-journal.json'
    if not journal.exists():
        return
    info = journal.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Failure('RECOVERY_TRANSFER_JOURNAL_UNTRUSTED')
    value = js(journal)
    identity, name = value.get('identity'), value.get('name')
    if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{32}', identity) or name != 'brai-backup-transfer-' + identity:
        raise Failure('RECOVERY_TRANSFER_JOURNAL_INVALID')
    query = ['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']
    # Ошибка Docker означает неизвестный исход, а не отсутствие контейнера.
    if run(query).strip():
        found = json.loads(run(['docker', 'inspect', name]))[0]
        if (found['Config'].get('Labels') or {}).get('brai.backup.transfer') != identity:
            raise Failure('RECOVERY_TRANSFER_CONTAINER_CHANGED')
        run(['docker', 'rm', '-f', name])
        if run(query).strip():
            raise Failure('RECOVERY_TRANSFER_STILL_RUNNING')
    database = value.get('database')
    if database is not None:
        if database != 'restore-' + identity + '.sqlite':
            raise Failure('RECOVERY_TRANSFER_JOURNAL_INVALID')
        for suffix in ('', '-wal', '-shm', '-journal'):
            (root / 'duplicati' / (database + suffix)).unlink(missing_ok=True)
    journal.unlink()


def invoke(image, action, destination, options, catalog, *, bundle=None, remote=None, download=None, keep_versions=None, version=0):
    """Выполнить один CLI-вызов и убрать только свой контейнер, включая случай отмены."""
    identity = uuid.uuid4().hex
    name = 'brai-backup-transfer-' + identity
    argv = ['docker', 'run', '--rm', '--pull=never', '--name', name,
            '--label', 'brai.backup.transfer=' + identity,
            '--read-only', '--tmpfs', '/tmp:rw', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--entrypoint', '/opt/duplicati/duplicati-cli',
            '--mount', 'type=bind,src=' + str(catalog) + ',dst=/data',
            '--mount', 'type=bind,src=' + str(options) + ',dst=/run/backup.params,readonly']
    if bundle is not None:
        argv += ['--mount', 'type=bind,src=' + str(bundle) + ',dst=/source,readonly']
    if remote is not None:
        argv += ['--network=none', '--mount', 'type=bind,src=' + str(remote) + ',dst=/remote']
    if download is not None:
        argv += ['--mount', 'type=bind,src=' + str(download) + ',dst=/restore']
    argv += [image, action, destination]
    if action == 'backup':
        argv += ['/source/']
    elif action == 'test':
        argv += ['all', '--full-remote-verification=true']
    elif action == 'restore':
        if type(version) is not int or version < 0:
            raise Failure('RECOVERY_VERSION_INVALID')
        argv += ['*', '--version=' + str(version), '--restore-path=/restore']
    elif action == 'delete':
        if type(keep_versions) is not int or keep_versions <= 0:
            raise Failure('RECOVERY_RETENTION_REQUIRES_EXPLICIT_ARGUMENT')
        argv += ['--keep-versions=' + str(keep_versions)]
    else:
        raise Failure('RECOVERY_TRANSFER_ACTION_INVALID')
    db = '/data/restore-' + identity + '.sqlite' if action == 'restore' else '/data/backup.sqlite'
    argv += ['--parameters-file=/run/backup.params', '--dbpath=' + db,
             '--encryption-module=aes', '--symlink-policy=Store',
             '--disable-module=console-password-input']
    root = catalog.parent
    if (root / 'transfer-journal.json').exists():
        raise Failure('RECOVERY_TRANSFER_RESUME_REQUIRED')
    write_json(root / 'transfer-journal.json', {'identity': identity, 'name': name,
               'database': Path(db).name if action == 'restore' else None})
    try:
        run(argv)
    finally:
        # AIDEV-NOTE: SIGKILL не выполняет finally; ExecStopPost повторяет ту же операцию по journal.
        resume(root)


def destination(value, bundle=None):
    """Отделить Google URL от локального backend без передачи credentials в адресе."""
    destination = value['destination']
    remote = None
    if destination.startswith('file:///'):
        target = urlsplit(destination)
        if target.netloc or target.query or target.fragment:
            raise Failure('RECOVERY_DESTINATION_INVALID')
        remote = Path(unquote(target.path))
        if not remote.is_absolute() or any(p.is_symlink() for p in (remote, *remote.parents)):
            raise Failure('RECOVERY_DESTINATION_INVALID')
        if bundle is not None and (remote == bundle or remote.is_relative_to(bundle) or bundle.is_relative_to(remote)):
            raise Failure('RECOVERY_RECURSIVE_SOURCE')
        remote.mkdir(mode=0o700, parents=False, exist_ok=True)
        destination = 'file:///remote'
    return destination, remote


def fetch(value, root, credentials, version=0):
    """Скачать последнюю версию без чтения источников и без прежней локальной БД Duplicati."""
    image = value['duplicati']['image']
    target, remote = destination(value)
    catalog = root / 'duplicati'
    catalog.mkdir(mode=0o700, exist_ok=True)
    downloaded = root / ('download-' + uuid.uuid4().hex)
    downloaded.mkdir(mode=0o700)
    try:
        with parameters(root, credentials) as options:
            invoke(image, 'restore', target, options, catalog, remote=remote, download=downloaded, version=version)
        if not (downloaded / 'manifest.json').is_file():
            raise Failure('RECOVERY_REMOTE_RESTORE_MISSING')
        return downloaded
    except BaseException:
        shutil.rmtree(downloaded)
        raise


def transfer(value, bundle, root, credentials, verify):
    """Backup/test/cold-restore через один образ; при отказе не выполнять retention."""
    image = value['duplicati']['image']
    target, remote = destination(value, bundle)
    catalog = root / 'duplicati'
    catalog.mkdir(mode=0o700, exist_ok=True)
    download = root / ('.download-' + uuid.uuid4().hex)
    download.mkdir(mode=0o700)
    try:
        with parameters(root, credentials) as options:
            invoke(image, 'backup', target, options, catalog, bundle=bundle, remote=remote)
            invoke(image, 'test', target, options, catalog, remote=remote)
            invoke(image, 'restore', target, options, catalog, remote=remote, download=download)
            if not (download / 'manifest.json').is_file():
                raise Failure('RECOVERY_REMOTE_RESTORE_MISSING')
            verify(download)
            if value.get('keep_versions') is not None:
                invoke(image, 'delete', target, options, catalog, remote=remote,
                       keep_versions=value['keep_versions'])
    finally:
        shutil.rmtree(download)
