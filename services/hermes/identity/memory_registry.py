# ABOUTME: Загружает защищённое соответствие системных UID профилям памяти.
# ABOUTME: Повторно проверяет владельца, права и конфликты при каждом чтении.
"""Реестр version=1 читается целиком из атомарно заменяемого root-owned файла."""

import json
import os
from pathlib import Path
import stat


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate registry key')
        result[key] = value
    return result


def load_registry(path):
    """Вернуть сопоставление UID; ошибку доступа или конфликта не игнорировать."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('Registry path must be absolute')
    for directory in (path.parent, *path.parent.parents):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Registry directory is not protected')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('Registry file is not protected')
        raw = source.read(1048577)
    if len(raw) > 1048576:
        raise ValueError('Registry is too large')
    return parse_registry(raw)


def parse_registry(raw):
    """Проверить все записи реестра до выбора профиля по UID."""
    registry = json.loads(raw, object_pairs_hook=_object)
    if not isinstance(registry, dict) or set(registry) != {'version', 'profiles'}:
        raise ValueError('Invalid registry')
    if type(registry['version']) is not int or registry['version'] != 1 or not isinstance(registry['profiles'], dict):
        raise ValueError('Unsupported registry')
    profiles, profile_ids, scopes, users, telegram_ids = {}, set(), set(), set(), set()
    fields = {'userId', 'profileId', 'telegramId', 'home', 'homeScope', 'memoryEpoch', 'authorId', 'cubes', 'status'}
    optional = {'username', 'workerSocket', 'role', 'backgroundsSuspended', 'generation'}
    for uid, entry in registry['profiles'].items():
        if not uid.isascii() or not uid.isdecimal() or str(int(uid)) != uid or int(uid) == 0:
            raise ValueError('Invalid registry UID')
        if not isinstance(entry, dict) or not fields <= set(entry) or set(entry) - fields - optional:
            raise ValueError('Invalid registry profile')
        if any(not isinstance(entry[key], str) or not entry[key] for key in fields - {'cubes'}):
            raise ValueError('Invalid registry profile field')
        if (not entry['telegramId'].isascii() or not entry['telegramId'].isdecimal()
                or not entry['home'].startswith('/') or '\x00' in entry['home']
                or any(not isinstance(entry[key], str) for key in (optional - {'backgroundsSuspended', 'generation'}) & set(entry))
                or ('workerSocket' in entry and (not entry['workerSocket'].startswith('/') or '\x00' in entry['workerSocket']))):
            raise ValueError('Invalid registry identity')
        if 'generation' in entry and (type(entry['generation']) is not int or entry['generation'] < 0):
            raise ValueError('Invalid runtime generation')
        if 'backgroundsSuspended' in entry and type(entry['backgroundsSuspended']) is not bool:
            raise ValueError('Invalid background policy')
        if 'role' in entry and entry['role'] not in ('creator','admin','user','guest'):
            raise ValueError('Unknown registry role')
        cubes = entry['cubes']
        if not isinstance(cubes, list) or not cubes or any(not isinstance(c, str) or not c for c in cubes) or len(set(cubes)) != len(cubes):
            raise ValueError('Invalid registry cubes')
        scope = (entry['homeScope'], entry['memoryEpoch'])
        if (entry['status'] not in ('active', 'provisioning', 'blocked', 'disabled') or entry['profileId'] in profile_ids
                or scope in scopes or entry['userId'] in users or entry['telegramId'] in telegram_ids):
            raise ValueError('Conflicting registry profile')
        profile_ids.add(entry['profileId'])
        scopes.add(scope)
        users.add(entry['userId'])
        telegram_ids.add(entry['telegramId'])
        profiles[int(uid)] = entry
    return profiles
