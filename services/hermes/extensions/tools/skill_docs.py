#!/usr/bin/env python3
# ABOUTME: Устанавливает только тексты навыков из закреплённого Git-коммита.
# ABOUTME: Не меняет скрипты, модель или службы; сохраняет локальные отличия.
"""Независимое обновление документации навыков установленного профиля."""
import argparse
import fcntl
import stat
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from connect import destination_safe, render

PREFIXES = ('docs/user-agent/instructions/hermes/skills/', 'docs/user-agent/instructions/skills/')
RECEIPT = 'docs/skill-documentation.json'


def sha(raw):
    """Вернуть SHA-256 точных байтов."""
    return hashlib.sha256(raw).hexdigest()


def git(repository, *args):
    """Прочитать Git без выполнения кода из репозитория."""
    result = subprocess.run(['/usr/bin/git', '-c', 'safe.directory=' + str(repository), '-C', str(repository), *args], capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError('SKILL_DOCUMENTATION_GIT_READ_FAILED')
    return result.stdout


def collect(repository, revision, home, owner, *, system=False):
    """Прочитать только UTF-8 документы конкретного коммита, без checkout."""
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('SKILL_DOCUMENTATION_EXACT_REVISION_REQUIRED')
    if git(repository, 'rev-parse', revision + '^{commit}').decode().strip() != revision:
        raise ValueError('SKILL_DOCUMENTATION_REVISION_MISMATCH')
    entries = {}
    for prefix in PREFIXES:
        for row in filter(None, git(repository, 'ls-tree', '-rz', revision, '--', prefix).split(b'\0')):
            metadata, name = row.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split()
            name = name.decode('utf-8')
            relative = Path(name.removeprefix(prefix))
            if (not name.startswith(prefix) or mode != '100644' or kind != 'blob'
                    or relative.suffix not in ('.md', '.txt') or '..' in relative.parts):
                raise ValueError('SKILL_DOCUMENTATION_NON_TEXT_ENTRY')
            raw = git(repository, 'cat-file', 'blob', oid)
            if not raw or len(raw) > 1024 * 1024:
                raise ValueError('SKILL_DOCUMENTATION_SIZE_INVALID')
            raw.decode('utf-8')
            target = 'skills/' + relative.as_posix()
            personal = home / 'usercustom/userdata/skills/productivity/brai-task-workflows'
            if not system and relative.parts[0] == 'brai-task-workflows' and personal.is_dir():
                target = 'usercustom/userdata/skills/productivity/' + relative.as_posix()
            if target in entries:
                raise ValueError('SKILL_DOCUMENTATION_DUPLICATE_TARGET')
            # AIDEV-NOTE: Текст не закрепляет digest текущего кода; stable alias меняется вместе с runtime.
            if system:
                content = raw.replace(b'${HERMESCUSTOM_ROOT}', b'/opt/brai-profile/instructions')
            else:
                text = raw.replace(b'${HERMESCUSTOM_ROOT}', str(home / 'usercustom/hermescustom').encode())
                content = render(text, home, owner)
            entries[target] = {'source': name, 'sourceSha256': sha(raw), 'content': content}
    if not entries or not any(name.endswith('/SKILL.md') for name in entries):
        raise ValueError('SKILL_DOCUMENTATION_EMPTY')
    return entries


def read_receipt(home):
    """Читать отдельную квитанцию установленной документации."""
    path = destination_safe(home, Path(RECEIPT))
    if not path.exists():
        return None
    value = json.loads(path.read_bytes())
    if value.get('format') != 'brai-skill-documentation-v1' or not isinstance(value.get('files'), dict):
        raise ValueError('SKILL_DOCUMENTATION_RECEIPT_INVALID')
    return value


def verify(home, *, system=False):
    """Проверить тексты по квитанции без Git, записи и вызова модели."""
    receipt = read_receipt(home)
    if receipt is None:
        raise ValueError('SKILL_DOCUMENTATION_NOT_INSTALLED')
    for name, row in receipt['files'].items():
        if not name.startswith(('skills/', 'usercustom/userdata/skills/productivity/brai-task-workflows/')):
            raise ValueError('SKILL_DOCUMENTATION_TARGET_INVALID')
        path = destination_safe(home, Path(name))
        if system:
            for parent in (path, *path.parents):
                info = parent.lstat()
                if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                    raise ValueError('SYSTEM_SKILLS_UNTRUSTED')
                if parent.is_relative_to(home) and stat.S_ISDIR(info.st_mode) and info.st_mode & 0o555 != 0o555:
                    raise ValueError('SYSTEM_SKILLS_UNREADABLE')
            if path.stat().st_mode & 0o444 != 0o444:
                raise ValueError('SYSTEM_SKILLS_UNREADABLE')
        if sha(path.read_bytes()) != row['installedSha256']:
            raise ValueError('SKILL_DOCUMENTATION_LOCAL_CHANGE')
    return {'verified': True, 'revision': receipt['revision'], 'documents': len(receipt['files']),
            'overrides': [name for name, row in receipt['files'].items() if row['override']]}


def plan(home, entries, revision, adopt=False, *, system=False):
    """Проверить весь набор до записи; при первичном переносе сохранить отличия."""
    receipt = read_receipt(home)
    previous = receipt['files'] if receipt else {}
    changes, files = [], {}
    for name, entry in sorted(entries.items()):
        target = destination_safe(home, Path(name))
        before = target.read_bytes() if target.exists() else None
        old, desired = previous.get(name), entry['content']
        if old and (before is None or sha(before) != old['installedSha256']):
            raise ValueError('SKILL_DOCUMENTATION_LOCAL_CHANGE: ' + name)
        override = bool(old and old['override'] and before != desired)
        if not old and before is not None and before != desired:
            if not adopt:
                raise ValueError('SKILL_DOCUMENTATION_ADOPTION_REQUIRED: ' + name)
            override = True
        after = before if override else desired
        mode = 0o644 if system else (target.stat().st_mode & 0o777 if before is not None else 0o600)
        if before != after or (target.exists() and target.stat().st_mode & 0o777 != mode):
            changes.append((target, name, before, after, mode))
        files[name] = {'source': entry['source'], 'sourceSha256': entry['sourceSha256'],
                       'installedSha256': sha(after), 'override': override}
    # AIDEV-NOTE: Исчезновение текста из каталога не разрешает удалять личные дополнения.
    for name in previous.keys() - files.keys():
        if sha(destination_safe(home, Path(name)).read_bytes()) != previous[name]['installedSha256']:
            raise ValueError('SKILL_DOCUMENTATION_LOCAL_CHANGE: ' + name)
        files[name] = {**previous[name], 'override': True}
    value = {'format': 'brai-skill-documentation-v1', 'revision': revision, 'files': files}
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    marker = destination_safe(home, Path(RECEIPT))
    before = marker.read_bytes() if marker.exists() else None
    if before != raw:
        changes.append((marker, RECEIPT, before, raw, 0o600))
    return changes, value


def atomic(path, raw, mode):
    """Атомарно заменить один файл в уже проверенном назначении."""
    missing = []
    directory = path.parent
    while not directory.exists():
        missing.append(directory)
        directory = directory.parent
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755 if mode == 0o644 else 0o700)
    if mode == 0o644:
        for directory in missing:
            directory.chmod(0o755)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.skill-doc-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(home, changes, *, system=False):
    """Сохранить прежние тексты и откатить свою запись при ошибке применения."""
    backup = None
    if changes:
        backup = home / 'backups' / ('skill-docs-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        destination_safe(home, backup.relative_to(home) / 'placeholder')
        for _, name, before, _, _ in changes:
            if before is not None:
                atomic(backup / name, before, 0o600)
    written = []
    try:
        for target, name, before, after, mode in changes:
            destination_safe(home, Path(name))
            if (target.read_bytes() if target.exists() else None) != before:
                raise ValueError('SKILL_DOCUMENTATION_CONCURRENT_CHANGE')
            atomic(target, after, mode)
            written.append((target, before, after, mode))
        verify(home, system=system)
    except Exception:
        for target, before, after, mode in reversed(written):
            if target.read_bytes() != after:
                raise ValueError('SKILL_DOCUMENTATION_ROLLBACK_CONFLICT') from None
            if before is None:
                target.unlink()
            else:
                atomic(target, before, mode)
        raise
    return str(backup) if backup else None


def main():
    """Вход для Ansible; stdout содержит только пути и статусы."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'apply', 'verify'))
    parser.add_argument('--profile-dir', required=True)
    parser.add_argument('--source-root')
    parser.add_argument('--revision')
    parser.add_argument('--owner-name')
    parser.add_argument('--adopt-existing', action='store_true')
    parser.add_argument('--system', action='store_true')
    args = parser.parse_args()
    home = Path(args.profile_dir).absolute()
    if args.system:
        if os.geteuid() != 0 or args.adopt_existing:
            raise ValueError('SYSTEM_SKILLS_ROOT_OPERATION_REQUIRED')
        for parent in (home, *home.parents):
            if parent == home and not parent.exists():
                continue
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('SYSTEM_SKILLS_UNTRUSTED')
        if args.action == 'apply':
            os.umask(0o022)
            home.mkdir(mode=0o755, exist_ok=True)
    if args.action == 'verify':
        result = verify(home, system=args.system)
    else:
        if not args.source_root or not args.revision:
            parser.error('--source-root и --revision обязательны')
        entries = collect(Path(args.source_root), args.revision, home, args.owner_name, system=args.system)
        changes, receipt = plan(home, entries, args.revision, args.adopt_existing, system=args.system)
        result = {'changed': [row[1] for row in changes], 'revision': args.revision,
                  'documents': len(receipt['files']),
                  'overrides': [name for name, row in receipt['files'].items() if row['override']],
                  'applied': args.action == 'apply'}
        if args.action == 'apply':
            lock_path = destination_safe(home, Path('docs/skill-documentation.lock'))
            lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with open(lock_path, 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                # Пересчитываем план после ожидания, чтобы не применить старую квитанцию.
                changes, receipt = plan(home, entries, args.revision, args.adopt_existing, system=args.system)
                result['changed'] = [row[1] for row in changes]
                result['backup'] = apply(home, changes, system=args.system)
                verify(home, system=args.system)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, UnicodeError) as error:
        raise SystemExit(str(error))
