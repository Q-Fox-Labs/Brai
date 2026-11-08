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
    for source in sorted(instructions.rglob('SKILL.md')):
        if source.is_symlink():
            raise ValueError('SYSTEM_SKILL_LINK')
        relative = source.relative_to(instructions)
        text = source.read_text(encoding='utf-8')
        front = re.match(r'\A---\n.*?\n---\n', text, re.S)
        if not front or not re.search(r'^name:\s*\S+', front.group(), re.M):
            raise ValueError('SYSTEM_SKILL_METADATA')
        destination = '/opt/brai-profile/instructions/skills/' + relative.as_posix()
        result[str(relative)] = (front.group() + '\nПеред выполнением полностью прочитай '
            '[каноническую инструкцию](' + destination + ').\n').encode()
    if not any(Path(name).name == 'SKILL.md' for name in result):
        raise ValueError('SYSTEM_SKILLS_EMPTY')
    return result
