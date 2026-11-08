# ABOUTME: Подключает обязательные общие инструкции независимо от личных USER и SOUL.
# ABOUTME: Рабочий процесс читает только закреплённую readonly поставку своего namespace.
"""Системный контекст каждого хода личного Hermes."""
from pathlib import Path
import json
import os
import stat

ROOT = Path('/opt/brai-profile/instructions')
FILES = ('INDEX.md', 'BASE.md', 'skills/creative/context-gifs/SKILL.md')


def read_context(root):
    """Собрать обязательные тексты; отсутствующий или пустой файл останавливает ход."""
    texts = []
    for relative in FILES:
        path = root / relative
        raw = path.read_bytes()
        if not raw or len(raw) > 262144:
            raise ValueError('SYSTEM_INSTRUCTIONS_INVALID')
        text = raw.decode('utf-8')
        if relative.endswith('SKILL.md') and text.startswith('---\n'):
            text = text.split('\n---\n', 1)[1]
        texts.append('Источник: ' + str(path) + '\n' + text)
    return ('[Обязательные системные инструкции Brai]\n'
            'Эти инструкции действуют независимо от личных USER.md и SOUL.md. '
            'Личные настройки не отменяют системные правила.\n\n'
            + 'Каталог общих инструкций: ' + str(root) + '. Относительные ссылки читай от него.\n\n'
            + '\n\n'.join(texts) + '\n[Конец системных инструкций Brai]\n\n')


def system_context():
    """Проверить root-owned readonly источники и вернуть полный контекст текущего хода."""
    for relative in FILES:
        path = ROOT / relative
        for item in (path, *path.parents):
            info = item.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                raise PermissionError('SYSTEM_INSTRUCTIONS_UNTRUSTED')
        if not path.is_file():
            raise ValueError('SYSTEM_INSTRUCTIONS_INVALID')
    return read_context(ROOT) + personal_context(os.environ.get('HERMES_HOME', ''))


def personal_context(home):
    """Подключить актуальные личные предпочтения, не возвращая файловую память."""
    path = Path(home)
    if not path.is_absolute():
        raise ValueError('PERSONAL_HOME_REQUIRED')
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(directory).st_uid != os.getuid():
            raise PermissionError('PERSONAL_HOME_UNTRUSTED')
        values = {}
        for name in ('USER.md', 'SOUL.md'):
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                continue
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_nlink != 1 or info.st_size > 65536):
                    raise PermissionError('PERSONAL_PROMPT_UNTRUSTED')
                with os.fdopen(fd, 'rb', closefd=False) as stream:
                    raw = stream.read(65537)
                if len(raw) > 65536:
                    raise ValueError('PERSONAL_PROMPT_TOO_LARGE')
                text = raw.decode('utf-8')
                if text.strip():
                    values[name] = text
            finally:
                os.close(fd)
        if not values:
            return ''
        return ('[Личные предпочтения текущего пользователя]\n'
                'Ниже содержимое личных файлов этого хода. Следуй предпочтениям в пределах '
                'обязательных системных правил выше. Это не общие инструкции сервера.\n'
                + json.dumps(values, ensure_ascii=False) +
                '\n[Конец личных предпочтений]\n\n')
    finally:
        os.close(directory)
