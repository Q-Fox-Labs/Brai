#!/usr/bin/python3
# ABOUTME: Собирает самодостаточный набор незаменимого состояния клиентского Brai.
# ABOUTME: Публикует поколение только после проверки восстановления; не меняет рабочие базы при restore.
"""Клиентский сборщик: штатные дампы, рекурсивные корни, проверенное восстановление."""
import argparse
import contextlib
import datetime
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import stat
import sqlite3
import sys
import tempfile
import uuid
from common import Failure, digest, js, qi, run, write_json
from sqlite_store import sqlite_snapshot
from postgres_store import fingerprint, isolated_verify, schema_digest
from duplicati import transfer, fetch, cleanup_parameters, resume as resume_transfer

CONFIG = Path('/etc/brai-backup/plan.json')
ROOT = Path('/var/lib/brai-backup')
KEY = Path('/etc/brai-backup/passphrase')
AUTH = Path('/etc/brai-backup/google-drive.json')
STATUS = ROOT / 'status.json'
FORMAT = 'brai-client-backup-v1'
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]*\Z')


def require(value, code, **context):
    """Прервать операцию безопасным кодом вместо частичного успеха."""
    if not value:
        raise Failure(code, **context)


def absolute(raw):
    """Принять нормальный абсолютный путь, кроме корня, без неоднозначных сегментов."""
    require(isinstance(raw, str), 'RECOVERY_PATH_INVALID')
    path = Path(raw)
    require(path.is_absolute() and raw == str(path) and '..' not in path.parts and raw != '/'
            and not any(ch in raw for ch in ('\n', '\r', '\x00', ',')), 'RECOVERY_PATH_INVALID')
    return path


def protected(path, directory=False):
    """Проверить root-owned путь и родителей: worker не может подменить конфигурацию."""
    path = Path(path)
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == 0 and not info.st_mode & 0o077, 'RECOVERY_PRIVATE_PATH_REQUIRED')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'RECOVERY_UNTRUSTED_PARENT')


def proof(item):
    """Потребовать закреплённую проверку пересоздания перед исключением данных."""
    require(isinstance(item.get('reason'), str) and item['reason'].strip(), 'RECOVERY_EXCLUSION_REASON_REQUIRED')
    reference = item['proof']
    path = absolute(reference['path'])
    protected(path)
    require(digest(path) == reference['sha256'], 'RECOVERY_REBUILD_PROOF_CHANGED')
    receipt = js(path)
    require(receipt.get('format') == 'brai-rebuild-proof-v1' and receipt.get('restored') is True
            and receipt.get('recipe') and receipt.get('software_revision')
            and receipt.get('subject') == {key: item[key] for key in ('path', 'root', 'relative') if key in item},
            'RECOVERY_REBUILD_NOT_PROVEN')


def keys(value, required, optional=()):
    """Отклонить опечатки и неподдерживаемые поля конфигурации до чтения источников."""
    require(isinstance(value, dict) and set(required) <= set(value)
            and set(value) <= set(required) | set(optional), 'RECOVERY_PLAN_FIELDS_INVALID')


def trusted_command(argv):
    """Принять root-owned программу и файлы аргументов только по защищённым путям."""
    require(isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv),
            'RECOVERY_SNAPSHOT_ADAPTER_REQUIRED')
    for raw in [argv[0], *[arg for arg in argv[1:] if arg.startswith('/') and Path(arg).is_file()]]:
        path = absolute(raw)
        actual = path.resolve(strict=True)
        require(actual.is_file(), 'RECOVERY_SNAPSHOT_ADAPTER_UNTRUSTED')
        for item in [actual, *path.parents, *actual.parents]:
            info = item.stat()
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'RECOVERY_SNAPSHOT_ADAPTER_UNTRUSTED')


def validate(value):
    """Проверить декларации каждого установленного компонента и явные исключения."""
    keys(value, ('format', 'installation_manifest', 'environment', 'components', 'installer', 'snapshot',
                 'docker_scope', 'systemd_scope'), ('exclude', 'destination', 'duplicati', 'keep_versions', 'local_keep_versions'))
    require(all(isinstance(value[key], list) and value[key] and all(isinstance(item, str) and item
                for item in value[key]) for key in ('docker_scope', 'systemd_scope')), 'RECOVERY_SCOPE_INVALID')
    require(value.get('format') == 'brai-client-backup-plan-v1', 'RECOVERY_PLAN_INVALID')
    manifest = absolute(value['installation_manifest'])
    protected(manifest)
    installed = js(manifest)['installed'][value['environment']]
    components = value['components']
    require(set(installed) == set(components), 'RECOVERY_COMPONENT_COVERAGE_CHANGED',
            undeclared=sorted(set(installed) - set(components)), obsolete=sorted(set(components) - set(installed)))
    installer = value['installer']
    keys(installer, ('repository', 'revision', 'entrypoint'))
    require(re.fullmatch(r'[0-9a-f]{40}', installer['revision']) and installer.get('repository') and installer.get('entrypoint'), 'RECOVERY_INSTALLER_REVISION_REQUIRED')
    require(js(manifest).get('source_revisions'), 'RECOVERY_SOURCE_REVISIONS_REQUIRED')
    roots, clusters = [], []
    require(isinstance(components, dict), 'RECOVERY_COMPONENT_INVALID')
    for name, component in components.items():
        keys(component, (), ('roots', 'postgres', 'rebuild', 'opaque_roots'))
        require(isinstance(name, str) and name, 'RECOVERY_COMPONENT_INVALID')
        paths = component.get('roots', [])
        databases = component.get('postgres', [])
        if not paths and not databases:
            require(bool(component.get('rebuild')), 'RECOVERY_STATELESS_REASON_REQUIRED')
        require(isinstance(component.get('opaque_roots', []), list)
                and set(component.get('opaque_roots', [])) <= set(paths), 'RECOVERY_OPAQUE_ROOT_INVALID')
        roots += [absolute(path) for path in paths]
        clusters += databases
    require(roots and len(roots) == len(set(roots)), 'RECOVERY_ROOTS_INVALID')
    for root in roots:
        require(not any(root != other and root.is_relative_to(other) for other in roots), 'RECOVERY_ROOTS_OVERLAP')
        require(not root.is_relative_to(ROOT) and not ROOT.is_relative_to(root), 'RECOVERY_RECURSIVE_SOURCE')
        require(root != KEY, 'RECOVERY_KEY_IS_EXTERNAL_DEPENDENCY')
    for item in value.get('exclude', []):
        keys(item, ('reason', 'proof'), ('path', 'root', 'relative'))
        keys(item['proof'], ('path', 'sha256'))
        require(('path' in item) != ('root' in item and 'relative' in item), 'RECOVERY_EXCLUSION_PATTERN_INVALID')
        proof(item)
        if 'path' in item:
            path = absolute(item['path'])
            require(path not in roots and any(path.is_relative_to(root) for root in roots), 'RECOVERY_EXCLUSION_OUTSIDE_ROOT')
        else:
            root = absolute(item['root'])
            pattern = Path(item['relative'])
            require(root in roots and not pattern.is_absolute() and pattern.parts and
                    all(part == '*' or re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in pattern.parts)
                    and not any(part in ('.', '..') for part in pattern.parts), 'RECOVERY_EXCLUSION_PATTERN_INVALID')
    for cluster in clusters:
        keys(cluster, ('container', 'user', 'database', 'data_mounts', 'dedicated'), ('socket',))
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', cluster['container']), 'RECOVERY_CONTAINER_INVALID')
        require(IDENTIFIER.fullmatch(cluster['user']) and IDENTIFIER.fullmatch(cluster['database']), 'RECOVERY_PG_IDENTIFIER_INVALID')
        require(cluster.get('data_mounts'), 'RECOVERY_PG_DATA_MOUNTS_REQUIRED')
        require(cluster.get('dedicated') is True, 'RECOVERY_SHARED_CLUSTER_UNSUPPORTED')
    require(len({c['container'] for c in clusters}) == len(clusters), 'RECOVERY_DUPLICATE_CLUSTER')
    snapshot = value['snapshot']
    keys(snapshot, ('enter', 'leave', 'units', 'containers'), ('ingress_socket', 'ingress_uid'))
    require(all(isinstance(snapshot[key], list) for key in ('units', 'containers')), 'RECOVERY_SNAPSHOT_ADAPTER_REQUIRED')
    require(not {'brai-client-backup.service', 'brai-client-backup.timer'}.intersection(snapshot['units']), 'RECOVERY_SELF_STOP_FORBIDDEN')
    for key in ('enter', 'leave'):
        trusted_command(snapshot[key])
    require(value.get('docker_scope'), 'RECOVERY_DOCKER_SCOPE_REQUIRED')
    for key in ('keep_versions', 'local_keep_versions'):
        if value.get(key) is not None:
            require(type(value[key]) is int and value[key] > 0, 'RECOVERY_RETENTION_INVALID')
    if value.get('destination'):
        keys(value['duplicati'], ('image',))
        require(re.fullmatch(r'googledrive://[A-Za-z0-9_/%.-]+', value['destination'])
                or value['destination'].startswith('file:///'), 'RECOVERY_DESTINATION_INVALID')
        require(re.fullmatch(r'duplicati/duplicati@sha256:[0-9a-f]{64}', value['duplicati']['image']), 'RECOVERY_DUPLICATI_IMAGE_NOT_PINNED')
    return roots, clusters


def pending_files(entries, roots):
    """Прочитать опубликованный storage-контракт Brai Files после остановки писателей."""
    required = set()
    for path in entries:
        if path.name != 'files.sqlite' or path.parent.name != 'brai-files' or path.is_symlink():
            continue
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            for table, columns in (('items', {'path', 'artifact'}), ('publications', {'path', 'confirmed'})):
                actual = {row[1] for row in db.execute('PRAGMA table_info(' + qi(table) + ')')}
                require(columns <= actual, 'RECOVERY_FILE_REGISTRY_SCHEMA_CHANGED')
            for (raw,) in db.execute('SELECT path FROM items WHERE artifact IS NULL UNION SELECT path FROM publications WHERE confirmed=0'):
                target = absolute(raw)
                require(any(target.is_relative_to(root) for root in roots), 'RECOVERY_DEPENDENCY_OUTSIDE_ROOT')
                require(target.is_file() and target.resolve(strict=True) == target, 'RECOVERY_DEPENDENCY_MISSING')
                required.add(target)
    return required


def inspect(value):
    """Найти непокрытые mounts и ссылки; новая БД или подпапка не требует allowlist."""
    roots, clusters = validate(value)
    excluded = [KEY]
    for item in value.get('exclude', []):
        excluded.extend([absolute(item['path'])] if 'path' in item else sorted(absolute(item['root']).glob(item['relative'])))
    def covered(path):
        return any(path.is_relative_to(root) for root in roots) and not any(path.is_relative_to(p) for p in excluded)
    containers = set()
    for selector in value['docker_scope']:
        require(isinstance(selector, str) and selector, 'RECOVERY_DOCKER_SCOPE_REQUIRED')
        containers.update(run(['docker', 'ps', '-aq', '--filter', 'label=' + selector]).decode().split())
    known = {c['container']: c for c in clusters}
    for identifier in sorted(containers):
        container = json.loads(run(['docker', 'inspect', identifier]))[0]
        name = container['Name'].lstrip('/')
        for mount in container.get('Mounts', []):
            if not mount.get('RW'):
                continue
            if name in known and mount['Destination'] in known[name]['data_mounts']:
                excluded.append(Path(mount['Source']))
                continue
            path = Path(mount['Source'])
            if any(path == p for p in excluded):
                continue
            require(covered(path), 'RECOVERY_UNREGISTERED_WRITABLE_MOUNT', container=name, mount=mount['Destination'])
    scoped_names = {json.loads(run(['docker', 'inspect', item]))[0]['Name'].lstrip('/') for item in containers}
    require(set(known).issubset(scoped_names), 'RECOVERY_POSTGRES_OUTSIDE_SCOPE')
    require(scoped_names - set(known) <= set(value['snapshot'].get('containers', [])),
            'RECOVERY_UNQUIESCED_SCOPED_CONTAINER', containers=sorted(scoped_names - set(known) - set(value['snapshot'].get('containers', []))))
    require(value.get('systemd_scope'), 'RECOVERY_SYSTEMD_SCOPE_REQUIRED')
    units = set()
    for pattern in value['systemd_scope']:
        listed = run(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager']).decode()
        units.update(line.split()[0] for line in listed.splitlines()
                     if line.strip() and fnmatch.fnmatchcase(line.split()[0], pattern))
    units -= {'brai-client-backup.service'}
    require(units <= set(value['snapshot'].get('units', [])), 'RECOVERY_UNQUIESCED_SCOPED_UNIT',
            units=sorted(units - set(value['snapshot'].get('units', []))))
    directories = {'StateDirectory': '/var/lib', 'CacheDirectory': '/var/cache', 'LogsDirectory': '/var/log', 'ConfigurationDirectory': '/etc'}
    for unit in sorted(units):
        properties = run(['systemctl', 'show', unit, *['--property=' + key for key in (*directories, 'ReadWritePaths')]]).decode()
        for line in properties.splitlines():
            key, separator, raw = line.partition('=')
            if not separator:
                continue
            for name in shlex.split(raw):
                if key in directories:
                    require(':' not in name and not name.startswith('/'), 'RECOVERY_SYSTEMD_DIRECTORY_UNSUPPORTED')
                    path = Path(directories[key]) / name
                elif key == 'ReadWritePaths':
                    path = Path(name.removeprefix('-'))
                    require(path.is_absolute(), 'RECOVERY_SYSTEMD_DIRECTORY_UNSUPPORTED')
                    if any(path.is_relative_to(volatile) for volatile in (Path('/run'), Path('/tmp'), Path('/dev'))):
                        continue
                else:
                    continue
                require(covered(path) or any(path.is_relative_to(p) for p in excluded), 'RECOVERY_UNREGISTERED_SYSTEMD_STORAGE', unit=unit, property=key)
    opaque = [absolute(path) for name, component in value['components'].items()
              for path in (component.get('roots', []) if name == 'artifacts' else component.get('opaque_roots', []))]
    entries, unknown_databases = [], []
    for root in roots:
        require((root.is_dir() or root.is_file()) and not root.is_symlink(), 'RECOVERY_REQUIRED_ROOT_MISSING')
        require(root.resolve(strict=True) == root, 'RECOVERY_REQUIRED_ROOT_NOT_CANONICAL')
        def walk(path):
            if any(path.is_relative_to(p) for p in excluded):
                return
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = path.resolve(strict=True)
                require(covered(target), 'RECOVERY_UNCOVERED_SYMLINK')
            elif stat.S_ISDIR(info.st_mode):
                for child in sorted(path.iterdir()):
                    walk(child)
            else:
                require(stat.S_ISREG(info.st_mode), 'RECOVERY_UNCLASSIFIED_SPECIAL_FILE')
                with path.open('rb') as stream:
                    header = stream.read(16)
                if path.suffix.lower() in ('.db', '.sqlite', '.sqlite3') and info.st_size:
                    if header != b'SQLite format 3\x00' and not any(path.is_relative_to(root) for root in opaque):
                        unknown_databases.append(path)
            entries.append(path)
        walk(root)
    required = pending_files(entries, roots)
    require(all(path in required for path in unknown_databases), 'RECOVERY_UNKNOWN_DATABASE_FORMAT')
    for path in sorted(required):
        for item in [path, *path.parents]:
            if any(item.is_relative_to(root) for root in roots) and item not in entries:
                entries.append(item)
    return {'roots': roots, 'clusters': clusters, 'entries': entries, 'excluded': excluded, 'required': required, 'opaque': opaque}


def pg(cluster, program, *arguments):
    """Построить argv к штатному PostgreSQL контейнера, не читая пароль в модель."""
    return ['docker', 'exec', '-i', '--user', 'postgres', cluster['container'], program,
            '-h', cluster.get('socket', '/var/run/postgresql'), '-U', cluster['user'], *arguments]


def export_postgres(cluster, folder):
    """Сохранить globals и все non-template БД; исключать только данные доказанных таблиц."""
    folder.mkdir(parents=True)
    query = "SELECT coalesce(json_agg(datname ORDER BY datname),'[]') FROM pg_database WHERE datname NOT IN ('template0','template1') AND datallowconn;"
    unsupported = "SELECT (SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')) + (SELECT count(*) FROM pg_foreign_table);"
    require(run(pg(cluster, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', cluster['database'], '-c', unsupported)).strip() == b'0', 'RECOVERY_EXTERNAL_POSTGRES_STORAGE_UNSUPPORTED')
    unavailable = "SELECT count(*) FROM pg_database WHERE datname NOT IN ('template0','template1') AND NOT datallowconn;"
    require(run(pg(cluster, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', cluster['database'], '-c', unavailable)).strip() == b'0', 'RECOVERY_DATABASE_NOT_ACCESSIBLE')
    names = json.loads(run(pg(cluster, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', cluster['database'], '-c', query)))
    require(all(IDENTIFIER.fullmatch(name) for name in names), 'RECOVERY_PG_IDENTIFIER_INVALID')
    with (folder / 'globals.sql').open('xb') as output:
        run(pg(cluster, 'pg_dumpall', '--globals-only'), output=output)
    fingerprints = {}
    for name in names:
        require(run(pg(cluster, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', name, '-c', 'SELECT count(*) FROM pg_foreign_table;')).strip() == b'0', 'RECOVERY_EXTERNAL_POSTGRES_STORAGE_UNSUPPORTED')
        with (folder / (name + '.dump')).open('xb') as output:
            run(pg(cluster, 'pg_dump', '--create', '--format=custom', '--dbname=' + name), output=output)
        with (folder / (name + '.dump')).open('rb') as data, open(os.devnull, 'wb') as sink:
            run(pg(cluster, 'pg_restore', '--list'), input_file=data, output=sink)
        fingerprints[name] = fingerprint(cluster['container'], cluster['user'], name, socket=cluster.get('socket'))
    configuration = folder / 'configuration'
    configuration.mkdir(mode=0o700)
    config_query = """SELECT coalesce(json_agg(name ORDER BY name),'[]') FROM
      (SELECT DISTINCT name FROM (
       SELECT setting AS name FROM pg_settings WHERE name IN ('config_file','hba_file','ident_file')
       UNION SELECT sourcefile FROM pg_file_settings
       UNION SELECT current_setting('data_directory') || '/postgresql.auto.conf'
       UNION SELECT to_jsonb(r)->>'file_name' FROM pg_hba_file_rules r
       UNION SELECT to_jsonb(r)->>'file_name' FROM pg_ident_file_mappings r
      ) paths WHERE name IS NOT NULL) files;"""
    config_paths = json.loads(run(pg(cluster, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
                                     '-d', cluster['database'], '-c', config_query)))
    configuration_files = {}
    for name in config_paths:
        absolute(name)
        filename = hashlib.sha256(name.encode()).hexdigest() + '.conf'
        with (configuration / filename).open('xb') as output:
            run(['docker', 'exec', '--user', 'postgres', cluster['container'], 'cat', '--', name], output=output)
        configuration_files[name] = 'configuration/' + filename
    image = json.loads(run(['docker', 'inspect', cluster['container']]))[0]['Image']
    references = json.loads(run(['docker', 'image', 'inspect', image]))[0]['RepoDigests']
    require(references, 'RECOVERY_POSTGRES_IMAGE_NOT_PORTABLE')
    return {'databases': names, 'image': image, 'image_ref': references[0], 'fingerprints': fingerprints, 'user': cluster['user'], 'configuration_files': configuration_files}


def records(root):
    """Записать точный состав, владельцев, права, связи и SHA-256 каждого файла."""
    result, hardlinks = {}, {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            path = Path(directory) / name
            info = path.lstat()
            record = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                      'mtime_ns': info.st_mtime_ns,
                      'xattrs': {key: os.getxattr(path, key, follow_symlinks=False).hex() for key in os.listxattr(path, follow_symlinks=False)}}
            if path.is_symlink():
                record.update(kind='link', target=os.readlink(path))
            elif path.is_dir():
                record.update(kind='directory')
            else:
                require(path.is_file(), 'RECOVERY_SPECIAL_FILE_IN_BUNDLE')
                record.update(kind='file', size=info.st_size, sha256=digest(path))
                if info.st_nlink > 1:
                    identity = (info.st_dev, info.st_ino)
                    if identity in hardlinks:
                        record['hardlink'] = hardlinks[identity]
                    else:
                        hardlinks[identity] = str(path.relative_to(root))
            result[str(path.relative_to(root))] = record
    return result


def check_bundle(bundle):
    """Проверить самодостаточный набор после скачивания, включая лишние файлы и ссылки."""
    bundle = Path(bundle).resolve(strict=True)
    require(not (bundle / 'manifest.json').is_symlink(), 'RECOVERY_MANIFEST_LINK')
    manifest = js(bundle / 'manifest.json')
    require(manifest.get('format') == FORMAT, 'RECOVERY_BUNDLE_FORMAT_INVALID')
    current = records(bundle)
    current.pop('manifest.json', None)
    expected = manifest['files']
    require(set(current) == set(expected), 'RECOVERY_BUNDLE_INVENTORY_CHANGED')
    for path, record in current.items():
        # Duplicati может восстанавливать иные uid; исходные metadata вернёт restore.
        require({k: v for k, v in record.items() if k not in ('uid', 'gid', 'mtime_ns', 'mode', 'xattrs', 'hardlink')} ==
                {k: v for k, v in expected[path].items() if k not in ('uid', 'gid', 'mtime_ns', 'mode', 'xattrs', 'hardlink')},
                'RECOVERY_BUNDLE_CORRUPT')
    for name, metadata in expected.items():
        if 'hardlink' in metadata:
            linked = expected.get(metadata['hardlink'], {})
            require(name.startswith('files/') and metadata['hardlink'].startswith('files/')
                    and metadata['kind'] == linked.get('kind') == 'file'
                    and metadata['sha256'] == linked.get('sha256'), 'RECOVERY_HARDLINK_INVALID')
    return manifest


def restore(bundle, target):
    """Вернуть файлы и SQLite в пустой root; не запускать службы и задания из копии."""
    bundle, target = Path(bundle).resolve(), absolute(str(target))
    manifest = check_bundle(bundle)
    require(not target.exists() and not target.is_symlink(), 'RECOVERY_RESTORE_ROOT_MUST_NOT_EXIST')
    require(not target.is_relative_to(bundle), 'RECOVERY_RESTORE_INSIDE_BUNDLE')
    require(not any(p.is_symlink() for p in target.parents), 'RECOVERY_RESTORE_LINK_PARENT')
    target.mkdir(parents=True, mode=0o700)
    run(['rsync', '-aHAX', '--numeric-ids', '--', str(bundle / 'files') + '/', str(target) + '/'])
    for name, metadata in manifest['files'].items():
        if name.startswith('files/') and 'hardlink' in metadata:
            path = target / name.removeprefix('files/')
            first = target / metadata['hardlink'].removeprefix('files/')
            path.unlink()
            os.link(first, path)
    for name, metadata in sorted(manifest['files'].items(), key=lambda item: len(Path(item[0]).parts), reverse=True):
        if not name.startswith('files/'):
            continue
        path = target / name.removeprefix('files/')
        if not path.exists() and not path.is_symlink():
            continue
        if os.geteuid() == 0:
            os.chown(path, metadata['uid'], metadata['gid'], follow_symlinks=False)
        if not path.is_symlink():
            os.chmod(path, metadata['mode'])
            os.utime(path, ns=(metadata['mtime_ns'], metadata['mtime_ns']))
        for key, raw in metadata.get('xattrs', {}).items():
            os.setxattr(path, key, bytes.fromhex(raw), follow_symlinks=False)
    actual = records(target)
    expected = {name.removeprefix('files/'): item for name, item in manifest['files'].items() if name.startswith('files/')}
    require(set(actual) == set(expected), 'RECOVERY_RESTORED_FILES_MISSING')
    payload = lambda item: {key: value for key, value in item.items()
                            if key not in ('uid', 'gid', 'mtime_ns', 'mode', 'xattrs', 'hardlink')}
    require(all(payload(actual[name]) == payload(item) for name, item in expected.items()), 'RECOVERY_RESTORED_FILE_CORRUPT')
    return {'bundle_id': manifest['bundle_id'], 'files_restored': True, 'postgres': manifest['postgres'],
            'services_started': False, 'rebuild': manifest['plan'].get('exclude', [])}


def resume():
    """Повторить идемпотентный leave после обрыва, сохранив журнал при ошибке."""
    resume_transfer(ROOT)
    cleanup_parameters(ROOT)
    journal = ROOT / 'snapshot-journal.json'
    if journal.exists():
        protected(journal)
        state = js(journal)
        result = json.loads(run(state['leave'] + ['--operation-id', state['operation_id']]))
        require(result == {'operation_id': state['operation_id'], 'state': 'resumed'}, 'RECOVERY_RESUME_UNCONFIRMED')
        journal.unlink()


@contextlib.contextmanager
def snapshot(value, operation):
    """Journal-before-enter и finally/ExecStopPost возвращают только собственный hold."""
    journal = ROOT / 'snapshot-journal.json'
    require(not journal.exists(), 'RECOVERY_RESUME_REQUIRED')
    write_json(journal, {'operation_id': operation, 'leave': value['snapshot']['leave']})
    try:
        response = json.loads(run(value['snapshot']['enter'] + ['--operation-id', operation]))
        require(response == {'operation_id': operation, 'state': 'quiesced'}, 'RECOVERY_SNAPSHOT_NOT_QUIESCED')
        yield
    finally:
        resume()


def seal_stage(stage):
    """Сделать staging читаемым root-контейнеру без DAC capabilities; metadata уже в manifest."""
    for path in [stage, *stage.rglob('*')]:
        if os.geteuid() == 0:
            os.chown(path, 0, 0, follow_symlinks=False)
        if not path.is_symlink():
            os.chmod(path, 0o700 if path.is_dir() else 0o600)


def prepare(value):
    """Собрать fresh generation, проверить SQLite restore и атомарно заменить current."""
    require(not (ROOT / 'transfer-journal.json').exists(), 'RECOVERY_TRANSFER_RESUME_REQUIRED')
    validate(value)
    identity = uuid.uuid4().hex
    stage = ROOT / ('build-' + identity)
    stage.mkdir(mode=0o700)
    previous = None
    try:
        with snapshot(value, identity):
            found = inspect(value)
            files = stage / 'files'
            files.mkdir(mode=0o700)
            inclusions = []
            for path in sorted(found['required']):
                inclusions.append('--include=/' + str(path).lstrip('/'))
                inclusions.extend('--include=/' + str(parent).lstrip('/') + '/' for parent in path.parents if str(parent) != '/')
            exclusions = []
            for path in found['excluded']:
                exclusions += ['--exclude=/' + str(path).lstrip('/') + '/***',
                               '--exclude=/' + str(path).lstrip('/')]
            run(['rsync', '-aHAXR', '--numeric-ids', *inclusions, *exclusions, '--',
                 *[str(root) for root in found['roots']], str(files) + '/'])
            sqlite, sqlite_inodes = [], {}
            for path in found['entries']:
                if not path.is_file() or path.is_symlink():
                    continue
                with path.open('rb') as stream:
                    is_sqlite = stream.read(16) == b'SQLite format 3\x00'
                if is_sqlite and path not in found['required'] and not any(path.is_relative_to(root) for root in found['opaque']):
                    copied = files / str(path).lstrip('/')
                    sqlite_inode = (path.stat().st_dev, path.stat().st_ino)
                    if sqlite_inode in sqlite_inodes:
                        copied.unlink()
                        os.link(sqlite_inodes[sqlite_inode], copied)
                    else:
                        sqlite_snapshot(path, copied)
                        sqlite_inodes[sqlite_inode] = copied
                    sqlite.append(str(path))
            postgres = {c['container']: export_postgres(c, stage / 'postgres' / c['container']) for c in found['clusters']}
            installation = stage / 'installation.json'
            shutil.copyfile(value['installation_manifest'], installation)
        # Сеть и контрольное восстановление выполняются уже после снятия hold.
        recovery = stage / 'recovery'
        recovery.mkdir()
        for name in ('common.py', 'sqlite_store.py', 'postgres_store.py', 'recovery.py', 'snapshot.py', 'duplicati.py', 'README.md', 'OPERATIONS.md', 'plan.schema.json'):
            shutil.copyfile(Path(__file__).parent / name, recovery / name)
        manifest = {'format': FORMAT, 'bundle_id': identity, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'source': 'Brai deploy/backup native collector v1',
                    'plan': value, 'sqlite': sqlite, 'postgres': postgres, 'files': records(stage)}
        write_json(stage / 'manifest.json', manifest)
        verification = ROOT / ('.verify-' + identity)
        try:
            restore(stage, verification)
            isolated_verify(stage, manifest)
        finally:
            if verification.exists():
                shutil.rmtree(verification)
        # AIDEV-NOTE: current меняется одним rename; CLI читает реальный build под общим flock.
        current = ROOT / 'current'
        if current.is_symlink():
            previous = current.resolve(strict=True)
            require(previous.parent == ROOT and previous.name.startswith('build-'), 'RECOVERY_PREVIOUS_NOT_OWNED')
            check_bundle(previous)
        else:
            require(not current.exists(), 'RECOVERY_CURRENT_NOT_OWNED')
        seal_stage(stage)
        for path in stage.rglob('*'):
            if path.is_file() and not path.is_symlink():
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
        link = ROOT / ('.current-' + identity)
        link.symlink_to(stage.name)
        os.replace(link, current)
        directory_fd = os.open(ROOT, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        write_json(STATUS, {'stage': 'prepared', 'bundle_id': identity, 'cloud_verified': False})
        return manifest
    except BaseException:
        if stage.exists() and (not (ROOT / 'current').is_symlink() or (ROOT / 'current').resolve() != stage):
            shutil.rmtree(stage)
        raise


def credentials(value):
    """Прочитать root-only ключи транспорта; значения не публикуются в результате."""
    require(value.get('destination'), 'RECOVERY_DESTINATION_REQUIRED')
    protected(KEY)
    credentials = {'passphrase': KEY.read_text().removesuffix('\n')}
    if value['destination'].startswith('googledrive://'):
        protected(AUTH)
        credentials['authid'] = js(AUTH)['authid']
    return credentials


def plan_digest(value):
    """Привязать квитанцию к точному плану без публикации его содержимого."""
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


def prune_local(keep, current_id):
    """Применить только явно выбранное число локальных поколений после remote restore."""
    if keep is None:
        return
    candidates = []
    for path in ROOT.glob('build-*'):
        if not path.is_dir() or path.is_symlink() or not (path / 'manifest.json').is_file():
            continue
        item = js(path / 'manifest.json')
        if item.get('format') == FORMAT and path.name == 'build-' + item.get('bundle_id', ''):
            candidates.append((item['created_at'], item['bundle_id'], path))
    candidates.sort(reverse=True)
    retained = {current_id}
    for _, identity, _ in candidates:
        if len(retained) >= keep:
            break
        retained.add(identity)
    for _, identity, path in candidates:
        if identity not in retained:
            check_bundle(path)
            shutil.rmtree(path)


def upload(value):
    """Подготовить снимок и принять только реально скачанную и восстановленную копию."""
    private = credentials(value)
    write_json(STATUS, {'stage': 'preparing', 'cloud_verified': False})
    manifest = prepare(value)
    bundle = (ROOT / 'current').resolve(strict=True)
    write_json(STATUS, {'stage': 'uploading', 'bundle_id': manifest['bundle_id'], 'cloud_verified': False})
    def verify(downloaded):
        restored = check_bundle(downloaded)
        require(restored['bundle_id'] == manifest['bundle_id'], 'RECOVERY_REMOTE_WRONG_GENERATION')
        target = ROOT / ('.restore-check-' + uuid.uuid4().hex)
        try:
            restore(downloaded, target)
            isolated_verify(downloaded, restored)
        finally:
            if target.exists():
                shutil.rmtree(target)
    transfer(value, bundle, ROOT, private, verify)
    prune_local(value.get('local_keep_versions'), manifest['bundle_id'])
    receipt = {'stage': 'verified', 'bundle_id': manifest['bundle_id'], 'plan_sha256': plan_digest(value),
               'cloud_verified': value['destination'].startswith('googledrive://'),
               'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    write_json(ROOT / 'last-verified.json', receipt)
    write_json(STATUS, receipt)
    return receipt


def public_status():
    """Вернуть только фиксированные поля состояния, без путей, планов и credentials."""
    if not CONFIG.exists():
        return {'stage': 'not_configured', 'cloud_verified': False}
    if not STATUS.exists():
        return {'stage': 'not_started', 'cloud_verified': False}
    protected(STATUS)
    value = js(STATUS)
    protected(CONFIG)
    if value.get('stage') == 'verified' and value.get('plan_sha256') != plan_digest(js(CONFIG)):
        value = {'stage': 'configuration_changed', 'cloud_verified': False}
    result = {key: value[key] for key in ('stage', 'bundle_id', 'cloud_verified', 'verified_at', 'error_code') if key in value}
    success = ROOT / 'last-verified.json'
    if success.exists():
        protected(success)
        result['last_verified'] = {key: item for key, item in js(success).items() if key in ('bundle_id', 'cloud_verified', 'verified_at')}
    return result


def global_root(config, state):
    """Принять операторские пути; CLI остаётся root-only, пути проверяются перед работой."""
    global CONFIG, ROOT, STATUS, KEY, AUTH
    CONFIG, ROOT = absolute(str(config)), absolute(str(state))
    STATUS = ROOT / 'status.json'
    KEY, AUTH = CONFIG.parent / 'passphrase', CONFIG.parent / 'google-drive.json'


def main():
    """Сериализовать операции; root-only CLI не принимает путь или роль из чата."""
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['inspect', 'prepare', 'run', 'verify', 'restore', 'fetch', 'resume', 'status'])
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--version', type=int, default=0)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--config', type=Path, default=CONFIG)
    parser.add_argument('--state', type=Path, default=ROOT)
    args = parser.parse_args()
    global_root(args.config, args.state)
    require(os.geteuid() == 0, 'RECOVERY_ROOT_REQUIRED')
    os.umask(0o077)
    if args.action == 'status':
        result = public_status()
    elif args.action in ('verify', 'restore'):
        require(args.bundle is not None, 'RECOVERY_BUNDLE_REQUIRED')
        require(args.action != 'restore' or args.root is not None, 'RECOVERY_RESTORE_ROOT_REQUIRED')
        result = check_bundle(args.bundle) if args.action == 'verify' else restore(args.bundle, args.root)
        if args.action == 'verify':
            isolated_verify(args.bundle, result)
        result = {key: result[key] for key in ('bundle_id', 'files_restored', 'services_started') if key in result}
    else:
        protected(ROOT, directory=True)
        with (ROOT / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'resume':
                resume()
                result = {'resumed': True}
            else:
                protected(CONFIG)
                value = js(CONFIG)
                if args.action == 'fetch':
                    require(re.fullmatch(r'duplicati/duplicati@sha256:[0-9a-f]{64}', value['duplicati']['image']), 'RECOVERY_DUPLICATI_IMAGE_NOT_PINNED')
                    require(re.fullmatch(r'googledrive://[A-Za-z0-9_/%.-]+', value['destination']) or value['destination'].startswith('file:///'), 'RECOVERY_DESTINATION_INVALID')
                    downloaded = fetch(value, ROOT, credentials(value), version=args.version)
                    manifest = check_bundle(downloaded)
                    result = {'bundle_id': manifest['bundle_id'], 'bundle': str(downloaded), 'services_started': False}
                elif args.action == 'inspect':
                    found = inspect(value)
                    result = {'source_roots': len(found['roots']), 'entries': len(found['entries']), 'clusters': len(found['clusters'])}
                else:
                    try:
                        result = prepare(value) if args.action == 'prepare' else upload(value)
                    except BaseException as error:
                        code = str(error) if isinstance(error, Failure) and re.fullmatch(r'RECOVERY_[A-Z_]+', str(error)) else 'RECOVERY_FAILED'
                        write_json(STATUS, {'stage': 'failed', 'cloud_verified': False, 'error_code': code})
                        raise
                    result = {'bundle_id': result['bundle_id']}
    print(json.dumps(result))


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        code = str(error)
        print(code if re.fullmatch(r'RECOVERY_[A-Z_]+', code) else 'RECOVERY_FAILED', file=sys.stderr)
        if isinstance(error, Failure) and error.context:
            print(json.dumps({'context': error.context}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
