#!/usr/bin/env python3
# ABOUTME: Проверяет и подключает поставляемые расширения Hermes к профилю.
# ABOUTME: Не применяет патчи движка и не изменяет пользовательские данные userdata.
"""Структурная проверка и подключение расширений к отдельному профилю."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

PACKAGE = Path(__file__).resolve().parent.parent
SOURCE = PACKAGE.parents[2]
BEGIN = '<!-- docshermes:begin -->'
END = '<!-- docshermes:end -->'


def regular(root, rel):
    """Проверить относительный путь и обычный файл без ссылок."""
    if not isinstance(rel, str) or not rel or str(PurePosixPath(rel)) != rel:
        raise ValueError(f'Недопустимый путь: {rel}')
    path = PurePosixPath(rel)
    if path.is_absolute() or any(p in ('.', '..') for p in path.parts):
        raise ValueError(f'Недопустимый путь: {rel}')
    target = root
    for part in path.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError(f'Ссылка в исходном пути: {target}')
    if not stat.S_ISREG(target.lstat().st_mode) or target.stat().st_nlink != 1:
        raise ValueError(f'Не обычный файл: {target}')
    return target


def check_source():
    """Проверить состав и, если доступен, hashes внешнего manifest поставки."""
    data = json.loads(regular(PACKAGE, 'manifest.json').read_text())
    files = data.get('runtimeFiles')
    if data.get('format') != 'brai-hermes-extensions-v1' or not isinstance(files, list) or any(not isinstance(x, str) for x in files) or files != sorted(set(files)) or 'manifest.json' in files:
        raise ValueError('Некорректный manifest расширений')
    for rel in files:
        regular(PACKAGE, rel)
    outer_path = SOURCE / 'artifact-manifest.json'
    if outer_path.exists():
        outer = json.loads(regular(SOURCE, 'artifact-manifest.json').read_text())
        hashes = {row['path']: row['sha256'] for row in outer['files']}
        for rel in files + ['manifest.json']:
            actual = hashlib.sha256(regular(PACKAGE, rel).read_bytes()).hexdigest()
            if hashes.get('services/hermes/extensions/' + rel) != actual:
                raise ValueError(f'Контрольная сумма поставки не совпадает: {rel}')
    return files, outer_path.exists()


def destination_safe(root, relative):
    """Отклонить ссылки и неподходящие объекты в пути назначения."""
    path = root
    if any(p.is_symlink() for p in (root, *root.parents)):
        raise ValueError(f'Ссылка в назначении: {root}')
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f'Ссылка в назначении: {path}')
        if path.exists() and path != root / relative and not path.is_dir():
            raise ValueError(f'Ожидался каталог: {path}')
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise ValueError(f'Ожидался файл: {path}')
    return path


def soul_text(existing, instructions, home):
    """Обновить управляемый блок, сохраняя остальной текст SOUL."""
    block = (f'{BEGIN}\n## Обязательное чтение\n\n'
             'При каждой новой сессии до первого ответа или действия полностью прочитай по порядку:\n'
             f'1. [INDEX.md]({instructions / "INDEX.md"})\n'
             f'2. [BASE.md]({instructions / "BASE.md"})\n'
             f'3. [ROUTING.md]({home / "usercustom/userdata/instructions/ROUTING.md"})\n\n'
             'Читай до конца; если вывод обрезан, дочитай оставшиеся части. Пустой ROUTING.md допустим. '
             'Ссылка, пересказ или снимок прошлой сессии чтение не заменяют. Затем читай только обязательные '
             'и подходящие задаче маршруты. При недоступном файле сообщи владельцу и останови зависимую работу.\n'
             f'{END}')
    if BEGIN in existing or END in existing:
        if existing.count(BEGIN) != 1 or existing.count(END) != 1 or existing.index(BEGIN) > existing.index(END):
            raise ValueError('Повреждён блок docshermes в SOUL.md')
        before, rest = existing.split(BEGIN, 1)
        return before + block + rest.split(END, 1)[1]
    return existing.rstrip() + '\n\n' + block + '\n'


def render(data, home, owner):
    """Подставить параметры профиля в текст, сохраняя нетекстовые байты."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return data
    if '{{OWNER_NAME}}' in text:
        if not owner:
            raise ValueError('Требуется --owner-name')
        text = text.replace('{{OWNER_NAME}}', owner)
    return text.replace('${HERMES_HOME}', str(home)).replace('${HERMESCUSTOM_ROOT}', str(PACKAGE)).encode('utf-8')


def build_plan(home, instructions, runtime, only, overwrite, owner):
    """Проверить все назначения и подготовить изменения до первой записи."""
    entries = {}
    for rel in runtime:
        if rel.startswith(('plugins/', 'scripts/', 'locales/')):
            source = regular(PACKAGE, rel)
            entries[rel] = (render(source.read_bytes(), home, owner), stat.S_IMODE(source.stat().st_mode))
        elif rel.startswith('skill-scripts/'):
            source = regular(PACKAGE, rel)
            entries['skills/' + rel.removeprefix('skill-scripts/')] = (render(source.read_bytes(), home, owner), stat.S_IMODE(source.stat().st_mode))
    for group in ('skills', 'policies', 'prompts'):
        directory = instructions / group
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError(f'Нет инструкций: {directory}')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError(f'Ссылка в инструкциях: {path}')
            if path.is_file():
                rel = path.relative_to(directory).as_posix()
                dest = ('skills/' + rel if group == 'skills' else rel if group == 'policies' else 'telegram-business/reply-prompt.md' if rel == 'telegram-reply.md' else 'prompts/' + rel)
                source = regular(instructions, path.relative_to(instructions).as_posix())
                entries[dest] = (render(source.read_bytes(), home, owner), 0o600)
    for name in ('INDEX.md', 'BASE.md'):
        regular(instructions, name)
    soul = destination_safe(home, Path('SOUL.md'))
    previous = soul.read_text() if soul.exists() else render(regular(PACKAGE, 'profile/SOUL.template.txt').read_bytes(), home, owner).decode()
    entries['SOUL.md'] = (soul_text(previous, instructions, home).encode(), 0o600)
    if only:
        selected = {}
        for prefix in only:
            path = PurePosixPath(prefix)
            if path.is_absolute() or str(path) != prefix or any(p in ('.', '..') for p in path.parts):
                raise ValueError(f'Недопустимый --only: {prefix}')
            if prefix == 'hermes-core/AGENTS.md':
                continue
            matches = {k: v for k, v in entries.items() if k == prefix or k.startswith(prefix + '/')}
            if not matches:
                raise ValueError(f'Нет подключаемого пути: {prefix}')
            selected.update(matches)
        entries = selected
    changes = []
    for rel, (content, source_mode) in sorted(entries.items()):
        target = destination_safe(home, Path(rel))
        old = target.read_bytes() if target.exists() else None
        if old != content:
            managed_soul = rel == 'SOUL.md' and old is not None
            if old is not None and not overwrite and not managed_soul:
                raise ValueError(f'Файл отличается; требуется --overwrite: {target}')
            mode = stat.S_IMODE(target.stat().st_mode) if old is not None else source_mode
            changes.append((target, rel, content, old, mode))
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-dir', default=os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
    parser.add_argument('--hermes-root')
    parser.add_argument('--owner-name')
    parser.add_argument('--instructions-root', default=str(SOURCE / 'docs/user-agent/instructions/hermes'))
    group = parser.add_mutually_exclusive_group()
    for action in ('check', 'plan', 'apply'):
        group.add_argument('--' + action, action='store_true')
    parser.add_argument('--overwrite', action='store_true')
    parser.add_argument('--apply-core', action='store_true')
    parser.add_argument('--only', action='append', default=[])
    args = parser.parse_args()
    if args.apply_core:
        raise ValueError('Патчи движка применяет операторский builder; --apply-core недоступен')
    if args.owner_name and any(c in args.owner_name for c in '\n\r{}'):
        raise ValueError('Недопустимое имя владельца')
    files, sealed = check_source()
    if args.check:
        print(json.dumps({'files': len(files), 'outerHashesChecked': sealed, 'sourceTrust': 'operator'}, ensure_ascii=False))
        return
    home = Path(os.path.abspath(os.path.expanduser(args.profile_dir)))
    instructions = Path(os.path.abspath(os.path.expanduser(args.instructions_root)))
    changes = build_plan(home, instructions, files, args.only, args.overwrite, args.owner_name)
    backup = None
    if args.apply:
        if any(old is not None for _, _, _, old, _ in changes):
            backup = home / 'backups' / ('hermes-extensions-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
            destination_safe(home, backup.relative_to(home) / 'placeholder')
            for _, rel, _, old, _ in changes:
                if old is not None:
                    path = backup / rel
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    for directory in (path.parent, *path.parent.parents):
                        if directory == backup.parent: break
                        directory.chmod(0o700)
                    path.write_bytes(old)
                    path.chmod(0o600)
        for target, _, content, _, mode in changes:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(mode)
    print(json.dumps({'changed': [rel for _, rel, _, _, _ in changes], 'backup': str(backup) if backup else None, 'applied': args.apply}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit(str(error))
