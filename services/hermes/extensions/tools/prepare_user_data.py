#!/usr/bin/env python3
"""Prepare usercustom/userdata and native personal skill discovery, preserving user files."""
import argparse
import os
from pathlib import Path
import tempfile
import yaml


def configure_skills(home, root):
    config = home / 'config.yaml'
    if config.is_symlink():
        raise ValueError('config.yaml должен быть обычным файлом активного профиля')
    cfg = (yaml.safe_load(config.read_text()) or {}) if config.exists() else {}
    if not isinstance(cfg, dict):
        raise ValueError('Ожидалась карта настроек Hermes')
    skills = cfg.setdefault('skills', {})
    target = str(root / 'skills')
    if skills.get('create_dir') == target:
        return []
    previous = skills.get('create_dir')
    if previous:
        path = Path(os.path.expandvars(previous)).expanduser()
        if not path.is_absolute():
            path = home / path
        if path.exists() and path.resolve() != (root / 'skills').resolve():
            raise ValueError('Сначала перенесите личные навыки из прежнего skills.create_dir')
    skills['create_dir'] = target
    mode = config.stat().st_mode & 0o777 if config.exists() else 0o600
    with tempfile.NamedTemporaryFile('w', dir=home, delete=False, encoding='utf-8') as stream:
        yaml.safe_dump(cfg, stream, allow_unicode=True, sort_keys=False)
        temporary = Path(stream.name)
    temporary.chmod(mode & 0o600)
    temporary.replace(config)
    return [str(config)]


def prepare(home):
    home = home.expanduser().resolve()
    custom = home / 'usercustom'
    root = custom / 'userdata'
    changed = []
    for path in (custom, root):
        if path.is_symlink() or not path.resolve().is_relative_to(home):
            raise ValueError(f'Пользовательский каталог должен быть внутри профиля: {path}')
    for relative in ('', 'projects', 'files', 'files/uploads', 'files/exports',
                     'files/admin', 'instructions', 'instructions/overrides', 'skills'):
        path = root / relative
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError(f'Пользовательский каталог должен быть внутри userdata: {path}')
        if not path.exists():
            path.mkdir(parents=True, mode=0o700)
            changed.append(str(path))
        if not path.is_dir():
            raise ValueError(f'Ожидался каталог: {path}')
    templates = Path(__file__).resolve().parent.parent / 'profile/userdata'
    for name, directory in (('ROUTING.md', 'instructions'),
                            ('BACKUP_SCOPE.md', 'files/admin'), ('databases.json', 'files/admin')):
        target = root / directory / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f'Ожидался обычный файл инструкций: {target}')
        if not target.exists():
            text = (templates / name).read_text().replace('${HERMES_HOME}', str(home))
            with target.open('x', encoding='utf-8') as stream:
                stream.write(text)
            target.chmod(0o600)
            changed.append(str(target))
    soul = home / 'SOUL.md'
    if not soul.is_file() or soul.is_symlink():
        raise ValueError('Сначала подключите SOUL.md активного профиля')
    begin, end = '<!-- user-data:begin -->', '<!-- user-data:end -->'
    text = soul.read_text()
    block = (f'{begin}\n## Пользовательские данные\n\n'
             f'Все постоянные пользовательские материалы — {root}/. '
             f'Проекты — {root}/projects/; файлы — {root}/files/; '
             f'личные правила — {root}/instructions/; собственные навыки — {root}/skills/. '
             'Для каждого нового правила добавляй в ROUTING.md ссылку, назначение и условие чтения. '
             'Личные маршруты не добавляй в административные INDEX.md/BASE.md. '
             'Бэкап должен сохранять userdata целиком; базы и штатные хранилища учитываются отдельно.\n'
             f'{end}')
    if begin in text or end in text:
        if text.count(begin) != 1 or text.count(end) != 1 or text.index(begin) > text.index(end):
            raise ValueError('Неполный или повторяющийся блок пользовательских инструкций')
        before, rest = text.split(begin, 1)
        _, after = rest.split(end, 1)
        updated = before + block + after
    else:
        updated = text.rstrip() + '\n\n' + block + '\n'
    if updated != text:
        soul.write_text(updated)
        changed.append(str(soul))
    changed.extend(configure_skills(home, root))
    return changed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-dir', required=True)
    args = parser.parse_args()
    changes = prepare(Path(args.profile_dir))
    print(f'Пользовательские папки готовы; изменено объектов: {len(changes)}. Бэкапы не настроены.')
