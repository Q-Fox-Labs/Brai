# ABOUTME: Фиксирует операторскую Root-паузу до запуска нового ingress и worker.
# ABOUTME: Сверяет protected inputs и registry, сбрасывает привилегии; не запускает runtime и не заменяет Auth.
"""Одноразовый pause-only CLI; вызывающий оператор удерживает остановленную lifecycle границу."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

from .chat_journal import IdentityJournal
from .memory_registry import load_registry

_CONFIG = {'version', 'registryPath', 'telegramJournalRoot', 'ingressUid', 'ingressGid'}
_REQUEST = {'version', 'operationId', 'expectedUserId', 'expectedProfileId', 'expectedWorkerUid',
            'expectedAuthorTelegramId', 'chat', 'thread', 'reason'}


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_KEY')
        result[key] = value
    return result


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _absolute(value):
    return isinstance(value, str) and value.startswith('/') and '\x00' not in value and '..' not in Path(value).parts


def _positive(value):
    return type(value) is int and 0 < value <= 2147483647


def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def protected_json(path):
    """Прочитать root0600 JSON до drop UID; запретить symlink, hardlink и writable ancestors."""
    if not _absolute(path):
        raise ValueError('INVALID_INPUT_PATH')
    target = Path(path)
    for directory in target.parents:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('UNPROTECTED_INPUT_PARENT')
    fd = os.open(target, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1 or info.st_size > 8192):
            raise PermissionError('UNPROTECTED_INPUT_FILE')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            raw = source.read(8193)
        if len(raw) > 8192:
            raise ValueError('INPUT_TOO_LARGE')
        return json.loads(raw, object_pairs_hook=_pairs)
    finally:
        os.close(fd)


def validate_config(value):
    """Проверить только операторские пути и ingress identity, без credentials и команд."""
    if (not isinstance(value, dict) or set(value) != _CONFIG
            or type(value.get('version')) is not int or value['version'] != 1
            or not _absolute(value.get('registryPath')) or not _absolute(value.get('telegramJournalRoot'))
            or not _positive(value.get('ingressUid')) or not _positive(value.get('ingressGid'))):
        raise ValueError('INVALID_CONFIG')
    return value


def validate_request(value):
    """Допустить только точную canonical owner-binding и одну личную Telegram тему."""
    if (not isinstance(value, dict) or set(value) != _REQUEST
            or type(value.get('version')) is not int or value['version'] != 1
            or any(not _uuid(value.get(key)) for key in ('operationId', 'expectedUserId', 'expectedProfileId'))
            or not _positive(value.get('expectedWorkerUid'))
            or not isinstance(value.get('expectedAuthorTelegramId'), str)
            or re.fullmatch(r'[1-9][0-9]{0,19}', value['expectedAuthorTelegramId']) is None
            or value.get('chat') != value['expectedAuthorTelegramId']
            or not isinstance(value.get('thread'), str) or value['thread'] == '1'
            or value['thread'] and re.fullmatch(r'[1-9][0-9]{0,15}', value['thread']) is None
            or not isinstance(value.get('reason'), str) or not value['reason'].strip()
            or len(value['reason']) > 512 or '\x00' in value['reason']):
        raise ValueError('INVALID_REQUEST')
    return value


def exact_binding(config, request, registry):
    """Сверить единственное полное соответствие; ingress UID не может быть worker."""
    if config['ingressUid'] in registry:
        raise PermissionError('INGRESS_IS_WORKER')
    matches = [(uid, profile) for uid, profile in registry.items()
               if uid == request['expectedWorkerUid'] or profile['userId'] == request['expectedUserId']
               or profile['profileId'] == request['expectedProfileId']]
    if len(matches) != 1:
        raise PermissionError('BINDING_MISMATCH')
    uid, profile = matches[0]
    if (uid != request['expectedWorkerUid'] or profile['userId'] != request['expectedUserId']
            or profile['profileId'] != request['expectedProfileId']
            or str(profile['telegramId']) != request['expectedAuthorTelegramId']):
        raise PermissionError('BINDING_MISMATCH')
    return profile


def _journal_path(path, ingress_uid):
    target = Path(path)
    for directory in target.parents:
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, ingress_uid)
                or info.st_mode & 0o022):
            raise PermissionError('UNPROTECTED_JOURNAL_PARENT')
    try:
        info = target.lstat()
    except FileNotFoundError:
        return
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != ingress_uid or info.st_mode & 0o077):
        raise PermissionError('UNPROTECTED_JOURNAL_ROOT')


def _drop_privileges(uid, gid):
    # AIDEV-NOTE: Все protected inputs уже закрыты; saved Root UID не остаётся в процессе.
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.getresuid() != (uid, uid, uid) or os.getresgid() != (gid, gid, gid) or os.getgroups():
        raise PermissionError('PRIVILEGE_DROP_FAILED')


def execute(config_path, request_path):
    """Зафиксировать Root pause+audit атомарно и вернуть fresh-connection readback receipt."""
    if os.getuid() != 0 or os.geteuid() != 0:
        raise PermissionError('ROOT_REQUIRED')
    config = validate_config(protected_json(config_path))
    request = validate_request(protected_json(request_path))
    profile = exact_binding(config, request, load_registry(config['registryPath']))
    _journal_path(config['telegramJournalRoot'], config['ingressUid'])
    payload = {'actor': 'os:root', 'operationId': request['operationId'],
               'binding': {'userId': profile['userId'], 'profileId': profile['profileId'],
                           'workerUid': request['expectedWorkerUid'], 'authorTelegramId': str(profile['telegramId'])},
               'chat': request['chat'], 'thread': request['thread'], 'reason': request['reason'],
               'configSha256': hashlib.sha256(_canonical(config).encode('utf-8')).hexdigest()}
    fingerprint = hashlib.sha256(_canonical(payload).encode('utf-8')).hexdigest()
    _drop_privileges(config['ingressUid'], config['ingressGid'])
    journal = IdentityJournal(config['telegramJournalRoot'])
    return journal.seed_operator_pause(profile, (request['chat'], request['thread']),
                                       request['operationId'], fingerprint, payload)


def main(argv=None):
    """Выполнить только pause; ошибки не выводят inputs, paths или пользовательские данные."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--request', required=True)
    args = parser.parse_args(argv)
    try:
        receipt = execute(args.config, args.request)
    except Exception:
        sys.stderr.write('OPERATOR_PAUSE_PRESEED_FAILED\n')
        return 1
    sys.stdout.write(json.dumps(receipt, ensure_ascii=False, separators=(',', ':')) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
