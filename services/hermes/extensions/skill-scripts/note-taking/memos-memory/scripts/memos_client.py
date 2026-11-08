#!/usr/bin/env python3
# ABOUTME: Выполняет явные команды памяти в области выбранного профиля.
# ABOUTME: Личный worker использует только защищённый конфиг и Unix gateway по UID.
"""Scoped stdlib client for the locally installed MemOS product API."""
import argparse
import hashlib
import importlib.util
import math
import os
from pathlib import Path
import re
import stat
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def build_request(a):
    scope = {'user_id': a.user}
    if a.command == 'health':
        return '/health', None
    if a.command == 'status':
        return '/product/scheduler/status?' + urllib.parse.urlencode(scope), None
    if a.command == 'search':
        return '/product/search', dict(scope, readable_cube_ids=[a.cube], query=a.query,
            mode='fast', top_k=a.top_k, relativity=0, rerank=False, dedup='no',
            include_preference=False, search_tool_memory=False, include_skill_memory=False,
            internet_search=False, chat_history=[])
    if a.command == 'list':
        return '/product/get_memory', dict(scope, mem_cube_id=a.cube, page=a.page,
            page_size=a.page_size, include_preference=True, include_tool_memory=True,
            include_skill_memory=True)
    if a.command == 'get':
        # Scoped retrieval rather than unscoped GET /get_memory/{id}.
        return '/product/get_memory', dict(scope, mem_cube_id=a.cube,
            filter={'id': a.id}, include_preference=True, include_tool_memory=True,
            include_skill_memory=True)
    if a.command == 'add':
        return '/product/add', dict(scope, writable_cube_ids=[a.cube],
            async_mode='sync', mode='fast', session_id=a.session,
            messages=[{'role': 'user', 'content': a.text}], chat_history=[],
            custom_tags=['hermes'], info=json.loads(a.info))
    if a.command == 'feedback':
        return '/product/feedback', dict(scope, writable_cube_ids=[a.cube],
            session_id=a.session, async_mode='sync', history=[],
            feedback_content=a.text, retrieved_memory_ids=a.id,
            corrected_answer=False)
    if a.command == 'delete':
        if not a.confirm_delete:
            raise ValueError('Deletion requires --confirm-delete and explicit memory IDs')
        return '/product/delete_memory', {'writable_cube_ids': [a.cube],
            'memory_ids': a.id, 'auto_cleanup_working': False}
    raise ValueError('Unsupported command')



PRIVATE_SOCKET = '/run/brai-profile/memory.sock'
PRIVATE_CLIENT = Path('/opt/brai-profile/runtime/services/hermes/extensions/plugins/memos-rest/client.py')


def worker_config():
    """Прочитать root-owned конфиг своего HOME; gateway остаётся границей доступа."""
    home = Path(os.environ.get('HERMES_HOME', ''))
    owner = os.environ.get('BRAI_IDENTITY_USER_ID', '')
    if not home.is_absolute() or home.resolve() != home or not owner:
        raise ValueError('PRIVATE_MEMORY_CONFIG_INVALID')
    fd = os.open(home / 'memos-rest.json', os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o022 or info.st_size > 1048576):
            raise ValueError('PRIVATE_MEMORY_CONFIG_INVALID')
        raw = source.read(1048577)
    if len(raw) > 1048576:
        raise ValueError('PRIVATE_MEMORY_CONFIG_INVALID')
    config = json.loads(raw)
    if (not isinstance(config, dict) or config.get('user_id') != owner
            or config.get('socket_path') != PRIVATE_SOCKET or config.get('routing_enabled') is not True
            or not isinstance(config.get('memory_epoch'), str) or not config['memory_epoch']
            or not isinstance(config.get('cube_id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+', config['cube_id'])
            or config.get('enabled') is not True or config.get('suspended') is True):
        raise ValueError('PRIVATE_MEMORY_CONFIG_INVALID')
    return config


def worker_client(config):
    """Загрузить единственный readonly SDK без импорта runtime-плагина Hermes."""
    info = PRIVATE_CLIENT.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022):
        raise ValueError('PRIVATE_MEMORY_SDK_INVALID')
    spec = importlib.util.spec_from_file_location('brai_skill_memory_client', PRIVATE_CLIENT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Client(config)


def private_request(a, config):
    """Использовать только операции, поддержанные owner-bound Unix gateway."""
    if a.base_url is not None or a.user not in (None, config['user_id']):
        raise ValueError('PRIVATE_MEMORY_SCOPE_OVERRIDE_DENIED')
    cube = a.cube if a.cube is not None else config['cube_id']
    if not isinstance(cube, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', cube):
        raise ValueError('PRIVATE_MEMORY_CUBE_INVALID')
    if not math.isfinite(a.timeout) or not 0 < a.timeout <= 300:
        raise ValueError('PRIVATE_MEMORY_TIMEOUT_INVALID')
    if a.command in {'status', 'feedback'}:
        raise ValueError('PRIVATE_MEMORY_' + a.command.upper() + '_UNSUPPORTED')
    if a.command in {'add', 'delete'} and config.get('frozen') is not False:
        raise ValueError('PRIVATE_MEMORY_WRITES_FROZEN')
    a.user, a.cube = config['user_id'], cube
    api = worker_client({**config, 'cube_id': cube, 'request_timeout': a.timeout})
    if a.command == 'health':
        return api.health()
    if a.command == 'search':
        if not 1 <= a.top_k <= 100:
            raise ValueError('PRIVATE_MEMORY_LIMIT_INVALID')
        home = str(Path(os.environ['HERMES_HOME']))
        home_scope = hashlib.sha256(json.dumps(home, ensure_ascii=False, sort_keys=True,
                                               separators=(',', ':')).encode()).hexdigest()
        author = os.environ.get('BRAI_IDENTITY_TELEGRAM_ID', '')
        if not re.fullmatch(r'[1-9][0-9]*', author):
            raise ValueError('PRIVATE_MEMORY_AUTHOR_INVALID')
        data = api.indexed_search(a.query, cubes=[cube], scope={'hermes_home_scope': home_scope,
            'hermes_memory_epoch': config['memory_epoch']}, author_id=author)
        if data is None:
            raise ValueError('PRIVATE_MEMORY_INDEX_UNAVAILABLE')
        rows = data['memories'][:a.top_k]
        return {'code': 200, 'data': {**data, 'memories': rows,
                'returned_count': len(rows), 'truncated': len(rows) < data['matched_count']}}
    if a.command in {'list', 'get'}:
        if a.command == 'list' and (a.page < 1 or not 1 <= a.page_size <= 100):
            raise ValueError('PRIVATE_MEMORY_LIMIT_INVALID')
        rows = api.get({'id': a.id} if a.command == 'get' else {})
        count = len(rows)
        if a.command == 'list':
            rows = rows[(a.page - 1) * a.page_size:a.page * a.page_size]
        return {'code': 200, 'data': {'text_mem': [{'cube_id': cube, 'memories': rows}]},
                'total': count, 'returned_count': len(rows)}
    path, payload = build_request(a)
    payload.pop('custom_tags', None)
    if a.command == 'add' and not isinstance(payload.get('info'), dict):
        raise ValueError('PRIVATE_MEMORY_INFO_INVALID')
    return api.request(path, payload)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url', default=None)
    p.add_argument('--user', default=None)
    p.add_argument('--cube', default=None)
    p.add_argument('--timeout', type=float, default=240)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('health')
    sub.add_parser('status')
    s = sub.add_parser('search')
    s.add_argument('--query', required=True)
    s.add_argument('--top-k', type=int, default=5)
    s = sub.add_parser('list')
    s.add_argument('--page', type=int, default=1)
    s.add_argument('--page-size', type=int, default=20)
    s = sub.add_parser('get')
    s.add_argument('--id', required=True)
    s = sub.add_parser('add')
    s.add_argument('--text', required=True)
    s.add_argument('--session', required=True)
    s.add_argument('--info', default='{"source_type":"hermes"}')
    s = sub.add_parser('feedback')
    s.add_argument('--text', required=True)
    s.add_argument('--id', action='append', required=True)
    s.add_argument('--session', required=True)
    s = sub.add_parser('delete')
    s.add_argument('--id', action='append', required=True)
    s.add_argument('--confirm-delete', action='store_true')
    a = p.parse_args()
    try:
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            result = private_request(a, worker_config())
        else:
            a.base_url = 'http://127.0.0.1:8001' if a.base_url is None else a.base_url
            a.user = 'root' if a.user is None else a.user
            a.cube = 'main' if a.cube is None else a.cube
            path, payload = build_request(a)
            body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
            req = urllib.request.Request(a.base_url.rstrip('/') + path, data=body,
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=a.timeout) as r:
                result = json.load(r)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if isinstance(result, dict) and result.get('code', 200) != 200:
            return 1
        return 0
    except (ValueError, OSError, RuntimeError, urllib.error.URLError) as error:
        # Do not print request payloads or credentials in error output.
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('PRIVATE_MEMORY_') else 'MEMOS_HELPER_FAILED'
        print(json.dumps({'error': code}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
