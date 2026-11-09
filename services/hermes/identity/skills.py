# ABOUTME: Собирает общий системный каталог из закреплённых bundled и продуктовых навыков.
# ABOUTME: Не читает личные каталоги; возвращает байты для readonly сборки установщика.
"""Единый системный набор с отдельным пользовательским create_dir."""
from pathlib import Path
import re


def catalog_files(bundled, instructions):
    """Вернуть полный общий набор; канонический продуктовый router заменяет bundled по пути."""
    if not bundled.is_dir() or not instructions.is_dir():
        raise ValueError('SYSTEM_SKILLS_SOURCE_MISSING')
    result = {}
    total = 0
    for source in sorted(bundled.rglob('*')):
        if any(part.startswith('.') or part == '__pycache__' for part in source.relative_to(bundled).parts):
            continue
        if source.is_symlink():
            raise ValueError('SYSTEM_SKILL_LINK')
        if source.is_file():
            raw = source.read_bytes()
            total += len(raw)
            if total > 64 * 1024 * 1024:
                raise ValueError('SYSTEM_SKILLS_TOO_LARGE')
            result[str(source.relative_to(bundled))] = raw
    for source in sorted(instructions.rglob('*')):
        if source.is_symlink():
            raise ValueError('SYSTEM_SKILL_LINK')
        if not source.is_file():
            continue
        relative = source.relative_to(instructions)
        raw = source.read_bytes()
        total += len(raw)
        if total > 64 * 1024 * 1024:
            raise ValueError('SYSTEM_SKILLS_TOO_LARGE')
        if source.name != 'SKILL.md':
            result[str(relative)] = raw
            continue
        text = raw.decode('utf-8')
        front = re.match(r'\A---\n.*?\n---\n', text, re.S)
        if not front or not re.search(r'^name:\s*\S+', front.group(), re.M):
            raise ValueError('SYSTEM_SKILL_METADATA')
        destination = '/opt/brai-profile/instructions/skills/' + relative.as_posix()
        result[str(relative)] = (front.group() + '\nПеред выполнением полностью прочитай '
            '[каноническую инструкцию](' + destination + ').\n').encode()
    if not any(Path(name).name == 'SKILL.md' for name in result):
        raise ValueError('SYSTEM_SKILLS_EMPTY')
    return result

# AIDEV-NOTE: Пути определяет readonly namespace, личный config.yaml их не меняет.
SYSTEM_SKILLS = Path('/opt/brai-profile/system-skills/skills')
BUNDLED_SKILLS = Path('/opt/brai-profile/skills')


def policy_roots(home, system=None, bundled=None):
    """Системный каталог имеет приоритет; личные навыки читаются только из custom."""
    return [(-2, Path(system or SYSTEM_SKILLS)), (-1, Path(bundled or BUNDLED_SKILLS)),
            (1, Path(home) / 'usercustom/userdata/skills')]


def protected_root(root):
    """Проверить Root-владение и отсутствие записи пользователем во всём пути."""
    import stat
    for path in (root, *root.parents):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('SYSTEM_SKILLS_UNTRUSTED')


def system_aliases(utils, roots=None):
    """Вернуть имена и пути всех системных навыков, включая новый каталог обновления."""
    aliases = set()
    for root in roots or (SYSTEM_SKILLS, BUNDLED_SKILLS):
        for path in utils.iter_skill_index_files(root, 'SKILL.md'):
            protected_root(path.parent)
            info = path.lstat()
            if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1048576:
                raise PermissionError('SYSTEM_SKILLS_UNTRUSTED')
            front, _ = utils.parse_frontmatter(path.read_text(encoding='utf-8'))
            aliases.update((str(front.get('name', path.parent.name)), path.parent.name,
                            path.parent.relative_to(root).as_posix()))
    return aliases


def install_policy():
    """Закрепить общие навыки выше личных и исключить их из всех disabled-фильтров.

    Вызывается до импорта native gateway. Штатные skill_view и skill_manage
    сохраняются; их единая точка поиска получает обязательные системные корни.
    """
    import os
    from agent import skill_utils as utils
    for root in (SYSTEM_SKILLS, BUNDLED_SKILLS):
        protected_root(root)
    if getattr(utils, '_brai_system_skills', False):
        return
    original_disabled = utils.get_disabled_skill_names
    original_entry = utils.is_disabled_entry
    home = Path(os.environ['HERMES_HOME'])
    personal = home / 'usercustom/userdata/skills'
    utils.get_skill_search_roots = lambda local=None, include_project=True: policy_roots(home)
    utils.get_external_skills_dirs = lambda: [SYSTEM_SKILLS, BUNDLED_SKILLS]
    utils.get_skill_create_dir = lambda: personal
    utils.get_disabled_skill_names = lambda platform=None: original_disabled(platform) - system_aliases(utils)
    utils.is_disabled_entry = lambda entry, disabled: (
        False if Path(entry['root']) in (SYSTEM_SKILLS, BUNDLED_SKILLS)
        else original_entry(entry, disabled))
    utils.ESSENTIAL_SKILLS = utils.ESSENTIAL_SKILLS | system_aliases(utils)
    utils._brai_system_skills = True
