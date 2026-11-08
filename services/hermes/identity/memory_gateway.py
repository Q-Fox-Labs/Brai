# ABOUTME: Ограничивает все обращения MemOS проверенным UID личного процесса.
# ABOUTME: Административное чтение доступно через отдельный закрытый сокет.
"""Доверенный AF_UNIX HTTP шлюз; исходный MemOS недоступен пользовательской сети."""

import argparse
import base64
import bisect
import hashlib
import hmac
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import struct
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import unicodedata

from .broker import protected_json
from .memory_registry import load_registry

MAX_BODY = 8 * 1024 * 1024
MAX_RESULT = 128 * 1024 * 1024
MAX_ADMIN_LIST = 820000
ADMIN_TEXT_BYTES = 2048
MAX_SPOOL = 2 * 1024 * 1024 * 1024
SPOOL_SLOTS = threading.BoundedSemaphore(2)
MAX_IDS = 1000
_SCOPE = {
    'info.hermes_home_scope': 'homeScope',
    'info.hermes_memory_epoch': 'memoryEpoch',
    'info.hermes_author_id': 'authorId',
}
_MUTABLE_ID_KEYS = {'memory_ids'}
_ADD_FIELDS = {'session_id', 'messages', 'info', 'user_id', 'writable_cube_ids',
               'async_mode', 'mode', 'chat_history', 'mem_cube_id'}


class Denied(ValueError):
    """Отказ области или формы запроса, безопасный для возврата клиенту."""


class VerifiedSpool:
    """Закрытый временный файл с квотой и ограничением числа одновременных чтений."""

    def __init__(self, directory=None):
        if not SPOOL_SLOTS.acquire(blocking=False):
            raise Denied('SPOOL_BUSY')
        try:
            self.file = tempfile.TemporaryFile(mode='w+b', dir=directory)
        except BaseException:
            SPOOL_SLOTS.release()
            raise
        self.size = 0

    def write(self, value):
        """Записать пакет целиком или отказать до превышения общей квоты."""
        if self.size + len(value) > MAX_SPOOL:
            raise Denied('SPOOL_LIMIT')
        self.file.write(value)
        self.size += len(value)

    def close(self):
        """Закрыть файл и освободить слот ровно один раз."""
        if self.file is not None:
            stream = self.file
            self.file = None
            try:
                stream.close()
            finally:
                SPOOL_SLOTS.release()


def physical_cube(profile, logical):
    """Вернуть уникальный физический куб авторизованного профиля."""
    profile_id = profile.get('profileId')
    quarantine_name = (profile.get('_quarantine') is True and isinstance(logical, str)
                       and 0 < len(logical) <= 1024 and all(not unicodedata.category(c).startswith('C') for c in logical))
    if (not isinstance(profile_id, str) or not re.fullmatch(r'[A-Za-z0-9-]+', profile_id)
            or not isinstance(logical, str) or not (quarantine_name or re.fullmatch(r'[A-Za-z0-9_-]+', logical))
            or logical not in profile['cubes']):
        raise Denied('CUBE_DENIED')
    return profile_id + '__' + logical


def client_type():
    """Загрузить единственный поставляемый транспорт без импорта плагина Hermes."""
    file = Path(__file__).parents[1] / 'extensions/plugins/memos-rest/client.py'
    spec = importlib.util.spec_from_file_location('brai_identity_memos_client', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Client


class Boundary:
    """Собрать проверяемую область; внешние операции передаются через порты."""

    def __init__(self, registry, upstream, *, authorize, cursor_key, admin_uid=0,
                 registry_loader=load_registry, clients=None, spool_dir=None, quarantine_profile=None):
        self.registry = registry
        self.upstream = upstream
        self.spool_dir = spool_dir
        self.quarantine_profile = quarantine_profile
        self.authorize = authorize
        self.cursor_key = cursor_key
        self.admin_uid = admin_uid
        self.registry_loader = registry_loader
        self.clients = clients or client_type()
        self.lock = threading.RLock()

    def profile(self, uid, target=None):
        """Получить актуальную привязку и проверить доступ перед каждым вызовом."""
        profiles = self.registry_loader(self.registry)
        if target is None:
            profile = profiles.get(uid)
        else:
            profile = next((p for p in profiles.values() if p['userId'] == target), None)
        if not profile or profile['status'] != 'active':
            raise Denied('PROFILE_UNAVAILABLE')
        if not self.authorize(profile['userId'], profile['profileId']):
            raise Denied('PROFILE_UNAVAILABLE')
        return profile

    def client(self, profile, cube):
        """Выбрать куб только из серверного каталога профиля."""
        return self.clients({'base_url': self.upstream, 'user_id': profile['userId'],
                             'cube_id': physical_cube(profile, cube), 'request_timeout': 120})

    @staticmethod
    def owner(profile, body):
        """Не принимать заданного клиентом чужого владельца."""
        if body.get('user_id', profile['userId']) != profile['userId']:
            raise Denied('OWNER_DENIED')

    @staticmethod
    def checked_row(profile, cube, row, *, include_private=False, quarantine=False):
        """Проверить физическую запись до любой передачи пользовательскому процессу."""
        if not isinstance(row, dict) or not isinstance(row.get('id'), str):
            raise Denied('UPSTREAM_INVALID')
        metadata = row.get('metadata') or {}
        info = metadata.get('info') or {}
        physical = physical_cube(profile, cube)
        cubes = {physical_cube(profile, logical): logical for logical in profile['cubes']}
        memberships = info.get('hermes_memberships')
        if (metadata.get('user_id') != profile['userId']
                or row.get('_cube_id', physical) != physical
                or info.get('hermes_home_scope') != profile['homeScope']
                or info.get('hermes_memory_epoch') != profile['memoryEpoch']
                or (not quarantine and info.get('hermes_author_id') != profile['authorId'])
                or (quarantine and (info.get('hermes_quarantined') is not True
                    or info.get('hermes_profile_id') != profile['profileId'] or info.get('hermes_user_id') != profile['userId']))
                or info.get('hermes_cube') != physical
                or not isinstance(memberships, list) or physical not in memberships
                or any(item not in cubes for item in memberships)
                or ('hermes_primary_cube' in info and info['hermes_primary_cube'] not in memberships)):
            raise Denied('UPSTREAM_SCOPE_MISMATCH')
        if not include_private and (info.get('hermes_visibility') == 'business_private' or info.get('hermes_business_scope') is not None):
            raise Denied('PRIVATE_RECORD')
        clean_info = {**info, 'hermes_cube': cube,
                      'hermes_memberships': [cubes[item] for item in memberships]}
        if 'hermes_primary_cube' in info:
            clean_info['hermes_primary_cube'] = cubes[info['hermes_primary_cube']]
        return {**row, '_cube_id': cube, 'metadata': {**metadata, 'info': clean_info}}

    @staticmethod
    def filters(profile, value, *, quarantine=False):
        """Добавить все обязательные условия; входной фильтр может только сужать их."""
        if not isinstance(value, dict):
            raise Denied('INVALID_FILTER')
        result = dict(value)
        for field, key in _SCOPE.items():
            if quarantine and key == 'authorId':
                if field in result:
                    raise Denied('SCOPE_DENIED')
                continue
            if field in result and result[field] != profile[key]:
                raise Denied('SCOPE_DENIED')
            result[field] = profile[key]
        if quarantine:
            result['info.hermes_quarantined'] = True
        for field in ('user_id', 'info.hermes_owner_id', 'info.hermes_profile_id'):
            if field in result:
                expected = profile['profileId'] if field.endswith('profile_id') else profile['userId']
                if result[field] != expected:
                    raise Denied('SCOPE_DENIED')
        if 'info.hermes_cube' in result:
            result['info.hermes_cube'] = physical_cube(profile, result['info.hermes_cube'])
        if 'info.hermes_memberships' in result:
            memberships = result['info.hermes_memberships']
            if not isinstance(memberships, list):
                raise Denied('CUBE_DENIED')
            result['info.hermes_memberships'] = [physical_cube(profile, cube) for cube in memberships]
        return result

    def rows(self, profile, cube, filter_=None, *, include_private=False, quarantine=False):
        """Прочитать только scoped stream; старый неограниченный export запрещён."""
        requested = self.filters(profile, filter_ or {}, quarantine=quarantine)
        client = self.client(profile, cube)
        capabilities = client.request('/product/memory_capabilities')
        data = capabilities.get('data') or {}
        if data.get('memory_stream') != 1 or type(data.get('memory_stream')) is not int:
            raise Denied('SECURE_STREAM_UNAVAILABLE')
        physical = physical_cube(profile, cube)
        response = client._memory_read({
            'mem_cube_id': physical, 'user_id': profile['userId'], 'filter': requested},
            timeout=120)
        groups = (response.get('data') or {}).get('text_mem')
        if not isinstance(groups, list) or len(groups) != 1 or groups[0].get('cube_id') != physical:
            raise Denied('UPSTREAM_INVALID')
        rows = [self.checked_row(profile, cube, row, include_private=include_private, quarantine=quarantine) for row in groups[0].get('memories', [])]
        if len({row['id'] for row in rows}) != len(rows):
            raise Denied('UPSTREAM_INVALID')
        if len(json.dumps(rows, ensure_ascii=False).encode()) > MAX_RESULT:
            raise Denied('RESULT_TOO_LARGE')
        return rows

    def spool_read(self, profile, method, path, body, *, include_private=False, quarantine=False):
        """Проверить весь upstream-поток в закрытом файле до передачи клиенту."""
        if method != 'POST' or path not in ('/product/get_memory', '/product/get_memory_stream') or not isinstance(body, dict):
            raise Denied('INVALID_READ')
        self.owner(profile, body)
        allowed = {'mem_cube_id', 'user_id', 'filter', 'include_preference',
                   'include_tool_memory', 'include_skill_memory'}
        if set(body) - allowed or any(body.get(k, False) is not False for k in
                ('include_preference', 'include_tool_memory', 'include_skill_memory')):
            raise Denied('INVALID_READ')
        cube = body.get('mem_cube_id')
        client = self.client(profile, cube)
        data = client.request('/product/memory_capabilities').get('data') or {}
        if type(data.get('memory_stream')) is not int or data['memory_stream'] != 1:
            raise Denied('SECURE_STREAM_UNAVAILABLE')
        physical = physical_cube(profile, cube)
        request = {'mem_cube_id': physical, 'user_id': profile['userId'],
                   'filter': self.filters(profile, body.get('filter', {}), quarantine=quarantine)}
        output = VerifiedSpool(self.spool_dir)
        stream = path == '/product/get_memory_stream'
        encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        try:
            if stream:
                output.write(encode({'type': 'header', 'version': 1, 'cube_id': cube,
                                     'user_id': profile['userId']}) + b'\n')
            else:
                output.write(b'{"code":200,"data":{"text_mem":[{"cube_id":' + encode(cube) + b',"memories":[')
            count = 0
            iterator = client.iter_memory(request, time.monotonic() + 120)
            try:
                for raw in iterator:
                    row = self.checked_row(profile, cube, raw, include_private=include_private, quarantine=quarantine)
                    if stream:
                        output.write(encode({'type': 'memory', 'memory': row}) + b'\n')
                    else:
                        output.write((b',' if count else b'') + encode(row))
                    count += 1
            finally:
                iterator.close()
            if stream:
                output.write(encode({'type': 'end', 'count': count}) + b'\n')
            else:
                output.write(b']}]}}')
            output.file.seek(0)
            return output
        except BaseException:
            output.close()
            raise

    def handle(self, uid, method, path, body):
        """Выполнить разрешённую операцию в области проверенного peer UID."""
        profile = self.profile(uid)
        if not isinstance(body, dict):
            raise Denied('INVALID_BODY')
        self.owner(profile, body)
        if path == '/health' and method == 'GET':
            return {'status': 'ok'}
        if path == '/product/memory_capabilities' and method == 'GET':
            data = self.client(profile, profile['cubes'][0]).request(path).get('data') or {}
            if data.get('memory_stream') != 1 or data.get('recall_index') != 1:
                raise Denied('SECURE_MEMORY_UNAVAILABLE')
            return {'code': 200, 'data': {'memory_stream': 1, 'recall_index': 1}}
        parsed = urllib.parse.urlsplit(path)
        if parsed.path == '/product/scheduler/status':
            if method != 'GET' or body or parsed.scheme or parsed.netloc or parsed.fragment or len(path) > 2048:
                raise Denied('INVALID_STATUS_REQUEST')
            try:
                pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
            except ValueError:
                raise Denied('INVALID_STATUS_REQUEST') from None
            query = dict(pairs)
            if len(query) != len(pairs) or set(query) - {'user_id', 'task_id'}:
                raise Denied('INVALID_STATUS_REQUEST')
            if 'user_id' in query and query['user_id'] != profile['userId']:
                raise Denied('OWNER_DENIED')
            task = query.get('task_id')
            if task is not None and not re.fullmatch(r'[A-Za-z0-9._:-]{1,256}', task):
                raise Denied('INVALID_STATUS_REQUEST')
            selected = {'user_id': profile['userId']}
            if task is not None:
                selected['task_id'] = task
            value = self.client(profile, profile['cubes'][0]).request(
                '/product/scheduler/status?' + urllib.parse.urlencode(selected),
                timeout=10, max_response_bytes=262144)
            if (not isinstance(value, dict) or set(value) != {'code', 'message', 'data'}
                    or value.get('code') != 200 or not isinstance(value.get('data'), list)):
                raise Denied('INVALID_STATUS_RESPONSE')
            seen = set()
            items = []
            for item in value['data']:
                if (not isinstance(item, dict) or set(item) != {'task_id', 'status'}
                        or not isinstance(item.get('task_id'), str)
                        or not re.fullmatch(r'[A-Za-z0-9._:-]{1,256}', item['task_id'])
                        or item['task_id'] in seen or task is not None and item['task_id'] != task
                        or item.get('status') not in ('waiting', 'in_progress', 'completed', 'failed', 'cancelled')):
                    raise Denied('INVALID_STATUS_RESPONSE')
                seen.add(item['task_id'])
                items.append({'task_id':item['task_id'], 'status':item['status']})
            return {'code':200, 'message':'Memory get status successfully', 'data':items}
        if method != 'POST':
            raise Denied('METHOD_DENIED')
        if path in ('/product/get_memory', '/product/get_memory_stream'):
            allowed = {'mem_cube_id', 'user_id', 'filter', 'include_preference',
                       'include_tool_memory', 'include_skill_memory'}
            if set(body) - allowed or any(body.get(k, False) is not False for k in
                    ('include_preference', 'include_tool_memory', 'include_skill_memory')):
                raise Denied('INVALID_READ')
            cube = body.get('mem_cube_id')
            rows = self.rows(profile, cube, body.get('filter', {}))
            return {'code': 200, 'data': {'text_mem': [{'cube_id': cube, 'memories': rows}]}}
        if path == '/product/recall_index':
            allowed = {'query', 'cubes', 'user_id', 'scope', 'author_id', 'shared_infra', 'project', 'goal'}
            if set(body) - allowed or not isinstance(body.get('query'), str) or not body['query'].strip():
                raise Denied('INVALID_SEARCH')
            cubes = body.get('cubes')
            if not isinstance(cubes, list) or not cubes or any(c not in profile['cubes'] for c in cubes):
                raise Denied('CUBE_DENIED')
            expected = {'hermes_home_scope': profile['homeScope'],
                        'hermes_memory_epoch': profile['memoryEpoch']}
            if body.get('scope', expected) != expected or body.get('author_id', profile['authorId']) != profile['authorId']:
                raise Denied('SCOPE_DENIED')
            if body.get('shared_infra') is True:
                raise Denied('SHARED_MEMORY_DISABLED')
            if body.get('project') is not None and not isinstance(body['project'], str):
                raise Denied('INVALID_SEARCH')
            client = self.client(profile, cubes[0])
            capabilities = client.request('/product/memory_capabilities').get('data') or {}
            if type(capabilities.get('recall_index')) is not int or capabilities['recall_index'] != 1:
                raise Denied('SECURE_INDEX_UNAVAILABLE')
            physical_cubes = {physical_cube(profile, cube): cube for cube in cubes}
            value = client.indexed_search(
                body['query'], cubes=list(physical_cubes), scope=expected, author_id=profile['authorId'],
                shared_infra=False, project=body.get('project'),
                goal=body.get('goal', 'evidence'))
            if value is None:
                raise Denied('SECURE_INDEX_UNAVAILABLE')
            if any(not isinstance(row, dict) or row.get('_cube_id') not in physical_cubes
                   for row in value.get('memories', [])):
                raise Denied('UPSTREAM_SCOPE_MISMATCH')
            value = {key: value[key] for key in ('version', 'complete', 'physical_count', 'logical_count', 'matched_count', 'elapsed_seconds') if key in value} | {
                'memories': [self.checked_row(profile, physical_cubes[row['_cube_id']], row) for row in value['memories']]}
            if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_RESULT:
                raise Denied('RESULT_TOO_LARGE')
            return {'code': 200, 'data': value}
        if path == '/product/search':
            # AIDEV-NOTE: Старый поиск не ограничивает profile до backend rerank.
            raise Denied('USE_SCOPED_RECALL_INDEX')
        if path == '/product/add':
            if set(body) - _ADD_FIELDS:
                raise Denied('INVALID_WRITE')
            cubes = body.get('writable_cube_ids')
            if not isinstance(cubes, list) or len(cubes) != 1:
                raise Denied('CUBE_DENIED')
            cube = cubes[0]
            client = self.client(profile, cube)
            physical = physical_cube(profile, cube)
            info = dict(body.get('info') or {})
            fixed = {'hermes_home_scope': profile['homeScope'], 'hermes_memory_epoch': profile['memoryEpoch'],
                     'hermes_author_id': profile['authorId'], 'hermes_cube': cube}
            for key, value in fixed.items():
                if key in info and info[key] != value:
                    raise Denied('SCOPE_DENIED')
                info[key] = value
            memberships = info.get('hermes_memberships', [cube])
            if not isinstance(memberships, list) or cube not in memberships or any(c not in profile['cubes'] for c in memberships):
                raise Denied('CUBE_DENIED')
            if 'hermes_primary_cube' in info and info['hermes_primary_cube'] not in memberships:
                raise Denied('CUBE_DENIED')
            if body.get('mem_cube_id', cube) != cube:
                raise Denied('CUBE_DENIED')
            if 'hermes_primary_cube' in info:
                info['hermes_primary_cube'] = physical_cube(profile, info['hermes_primary_cube'])
            info.update(hermes_cube=physical, hermes_memberships=[physical_cube(profile, c) for c in memberships])
            if info.get('hermes_visibility') == 'business_private' or info.get('hermes_business_scope') is not None:
                raise Denied('PRIVATE_RECORD')
            messages = body.get('messages')
            if (not isinstance(messages, list) or not messages
                    or any(not isinstance(m, dict) or set(m) - {'role', 'content'}
                           or m.get('role') not in ('user', 'assistant') or not isinstance(m.get('content'), str)
                           for m in messages)):
                raise Denied('INVALID_MESSAGES')
            payload = {**body, 'user_id': profile['userId'], 'info': info,
                       'writable_cube_ids': [physical], 'chat_history': [], 'async_mode': 'sync', 'mode': 'fast'}
            if 'mem_cube_id' in payload:
                payload['mem_cube_id'] = physical
            with self.lock:
                # add не обладает exactly-once: не повторяем после неизвестного ответа.
                result = client.request(path, payload)
            rows = result.get('data')
            if (not isinstance(rows, list) or not rows
                    or any(not isinstance(row, dict) or row.get('cube_id') != physical
                           or not isinstance(row.get('memory_id'), str) or not row['memory_id']
                           for row in rows)):
                raise Denied('UPSTREAM_SCOPE_MISMATCH')
            # Вернуть тот же логический куб, который был разрешён на входе.
            # Physical IDs остаются за границей личного шлюза.
            return {**result, 'data': [{**row, 'cube_id': cube} for row in rows]}
        if path == '/product/feedback':
            allowed={'user_id','writable_cube_ids','retrieved_memory_ids','history',
                     'feedback_content','session_id','async_mode','corrected_answer'}
            if (set(body)-allowed or body.get('async_mode') != 'sync'
                    or body.get('corrected_answer',False) is not False):
                raise Denied('INVALID_FEEDBACK')
            cubes=body.get('writable_cube_ids'); ids=body.get('retrieved_memory_ids')
            if not isinstance(cubes,list) or len(cubes)!=1:
                raise Denied('CUBE_DENIED')
            cube=cubes[0]
            self.client(profile,cube)
            if (not isinstance(ids,list) or not 1<=len(ids)<=32
                    or any(not isinstance(i,str) or not 0<len(i)<=128 for i in ids)
                    or len(set(ids))!=len(ids)):
                raise Denied('INVALID_FEEDBACK_TARGETS')
            content=body.get('feedback_content'); session=body.get('session_id')
            history=body.get('history')
            if (not isinstance(content,str) or not content.strip() or len(content)>16000
                    or not isinstance(session,str) or not 0<len(session)<=255
                    or not isinstance(history,list) or len(history)>16
                    or any(not isinstance(item,dict) or set(item)!={'role','content'}
                           or item['role'] not in ('user','assistant')
                           or not isinstance(item['content'],str) or len(item['content'])>16000
                           for item in history)):
                raise Denied('INVALID_FEEDBACK')
            try:
                from ..files.identity import open_directory
            except ImportError:
                from files.identity import open_directory
            directory=open_directory(profile['home'],uid)
            try:
                fd=os.open('memos-rest.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
                with os.fdopen(fd,'rb') as source:
                    meta=os.fstat(source.fileno())
                    if (not stat.S_ISREG(meta.st_mode) or meta.st_uid!=0 or meta.st_nlink!=1
                            or meta.st_mode&0o022 or meta.st_size>1048576):
                        raise Denied('PRIVATE_MEMORY_CONFIG_INVALID')
                    raw=source.read(1048577)
                if len(raw)>1048576: raise Denied('PRIVATE_MEMORY_CONFIG_INVALID')
                policy=json.loads(raw)
            finally:
                os.close(directory)
            if (not isinstance(policy,dict) or policy.get('user_id')!=profile['userId']
                    or policy.get('memory_epoch')!=profile['memoryEpoch']
                    or policy.get('enabled') is not True
                    or policy.get('frozen') is not False or policy.get('suspended') is True):
                raise Denied('PRIVATE_MEMORY_WRITES_FROZEN')
            with self.lock:
                for identifier in ids:
                    found=self.rows(profile,cube,{'id':identifier})
                    if len(found)!=1 or found[0]['id']!=identifier:
                        raise Denied('MEMORY_NOT_FOUND')
                payload={'scope':{'user_id':profile['userId'],'cube_id':physical_cube(profile,cube),
                    'home_scope':profile['homeScope'],'memory_epoch':profile['memoryEpoch'],
                    'author_id':profile['authorId'],'target_ids':ids},
                    'feedback_content':content,'history':history,'session_id':session}
                result=self.client(profile,cube).request('/product/feedback_scoped',payload,
                    timeout=120,max_response_bytes=1048576)
                data=result.get('data') if isinstance(result,dict) else None
                if (not isinstance(data,dict) or set(data)!={'record','readback'}
                        or not isinstance(data['record'],dict) or set(data['record'])!={'add','update'}
                        or not isinstance(data['readback'],dict)
                        or set(data['readback'])!={'checked_ids','deleted_ids'}):
                    raise Denied('FEEDBACK_READBACK_FAILED')
                checked=data['readback']['checked_ids']; deleted=data['readback']['deleted_ids']
                if (not isinstance(checked,list) or not isinstance(deleted,list)
                        or len(checked)>96 or len(deleted)>96
                        or any(not isinstance(i,str) or not 0<len(i)<=128 for i in checked+deleted)
                        or len(set(checked+deleted))!=len(checked+deleted)
                        or not set(ids)<=set(checked+deleted)):
                    raise Denied('FEEDBACK_READBACK_FAILED')
                for identifier in checked:
                    found=self.rows(profile,cube,{'id':identifier})
                    if len(found)!=1 or found[0]['id']!=identifier:
                        raise Denied('FEEDBACK_READBACK_FAILED')
                for identifier in deleted:
                    if self.rows(profile,cube,{'id':identifier}):
                        raise Denied('FEEDBACK_READBACK_FAILED')
                record=data['record']
                if (any(not isinstance(record[key],list) for key in ('add','update'))
                        or any(not isinstance(item,dict) or item.get('id') not in checked
                               for item in record['add']+record['update'])):
                    raise Denied('FEEDBACK_READBACK_FAILED')
                return result
        if path == '/product/delete_memory':
            if set(body) - {'user_id', 'mem_cube_id', 'memory_ids', 'writable_cube_ids', 'auto_cleanup_working'} or body.get('auto_cleanup_working', False) is not False:
                raise Denied('INVALID_DELETE')
            ids = body.get('memory_ids')
            if (not isinstance(ids, list) or not ids or len(ids) > MAX_IDS
                    or len(set(ids)) != len(ids) or any(not isinstance(i, str) or not i for i in ids)):
                raise Denied('INVALID_DELETE')
            cubes = body.get('writable_cube_ids', [body.get('mem_cube_id')])
            if not isinstance(cubes, list) or len(cubes) != 1:
                raise Denied('CUBE_DENIED')
            cube = cubes[0]
            self.client(profile, cube)
            with self.lock:
                for memory_id in ids:
                    rows = self.rows(profile, cube, {'id': memory_id})
                    if len(rows) != 1 or rows[0]['id'] != memory_id:
                        raise Denied('MEMORY_NOT_FOUND')
                return self.client(profile, cube).request(path, {
                    'writable_cube_ids': [physical_cube(profile, cube)], 'memory_ids': ids, 'auto_cleanup_working': False})
        raise Denied('OPERATION_DENIED')

    def admin(self, uid, path, body):
        """Читать целевой профиль только от отдельного доверенного control процесса."""
        if uid != self.admin_uid or not isinstance(body, dict):
            raise Denied('ADMIN_PEER_DENIED')
        allowed = {'userId', 'query', 'cursor', 'limit'} if path == '/admin/list' else {'userId', 'memoryId'}
        if path not in ('/admin/list', '/admin/read') or set(body) - allowed or not isinstance(body.get('userId'), str):
            raise Denied('INVALID_ADMIN_REQUEST')
        profiles = self.registry_loader(self.registry)
        quarantine = self.quarantine_profile
        if quarantine and any(p['userId'] == quarantine['userId'] or p['profileId'] == quarantine['profileId']
                              or (p['homeScope'], p['memoryEpoch']) == (quarantine['homeScope'], quarantine['memoryEpoch'])
                              for p in profiles.values()):
            raise Denied('PROFILE_CONFLICT')
        is_quarantine = bool(quarantine and quarantine['userId'] == body['userId'])
        profile = quarantine if is_quarantine else next((p for p in profiles.values() if p['userId'] == body['userId']), None)
        if not profile:
            raise Denied('PROFILE_UNAVAILABLE')
        if path == '/admin/read':
            rows = []
            for cube in profile['cubes']:
                rows.extend(self.rows(profile, cube, {'id': body['memoryId']}, include_private=True, quarantine=is_quarantine))
            row = next((row for row in rows if row['id'] == body.get('memoryId')), None)
            if row is None:
                raise Denied('MEMORY_NOT_FOUND')
            return {**row, 'profileId': profile['profileId']}
        query = body.get('query', '')
        if not isinstance(query, str) or len(query) > 4096:
            raise Denied('INVALID_QUERY')
        query_hash = hashlib.sha256(query.encode()).hexdigest()
        after = None
        if body.get('cursor'):
            try:
                encoded, signature = body['cursor'].split('.')
                actual = hmac.new(self.cursor_key, encoded.encode(), hashlib.sha256).hexdigest()
                if not hmac.compare_digest(signature, actual):
                    raise ValueError()
                cursor = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
                if cursor[:3] != [profile['userId'], profile['profileId'], query_hash]:
                    raise ValueError()
                after = cursor[3]
                if (len(cursor) != 4 or not isinstance(after, list) or len(after) != 2
                        or any(not isinstance(v, str) for v in after) or after[0] not in profile['cubes']):
                    raise ValueError()
                after = tuple(after)
            except (ValueError, TypeError, IndexError):
                raise Denied('INVALID_CURSOR') from None
        limit = body.get('limit', 50)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise Denied('INVALID_LIMIT')
        def make_cursor(row):
            raw = json.dumps([profile['userId'], profile['profileId'], query_hash,
                              [row['cubeId'], row['id']]], separators=(',', ':')).encode()
            encoded = base64.urlsafe_b64encode(raw).decode().rstrip('=')
            return encoded + '.' + hmac.new(self.cursor_key, encoded.encode(), hashlib.sha256).hexdigest()

        page, has_more, page_full = [], False, False
        for cube in sorted(profile['cubes']):
            spool = self.spool_read(profile, 'POST', '/product/get_memory_stream',
                                    {'mem_cube_id': cube}, include_private=True, quarantine=is_quarantine)
            try:
                # Храним только ключи и позиции будущей страницы, а не все тексты.
                candidates = []
                while True:
                    position = spool.file.tell()
                    raw = spool.file.readline()
                    if not raw:
                        break
                    item = json.loads(raw)
                    if item.get('type') != 'memory':
                        continue
                    row = item['memory']
                    key = (cube, row['id'])
                    if (after is not None and key <= after) or (query and query.casefold() not in str(row.get('memory', '')).casefold()):
                        continue
                    if len(page) == limit or page_full:
                        has_more = True
                        continue
                    bisect.insort(candidates, (row['id'], position))
                    if len(candidates) > limit - len(page) + 1:
                        candidates.pop()
                take = limit - len(page)
                if len(candidates) > take:
                    has_more = True
                for _, position in candidates[:take]:
                    spool.file.seek(position)
                    row = json.loads(spool.file.readline())['memory']
                    info = row['metadata'].get('info') or {}
                    text = row.get('memory', '')
                    if not isinstance(text, str):
                        raise Denied('UPSTREAM_INVALID')
                    text_bytes = text.encode('utf-8')
                    kind = info.get('hermes_kind', 'memory')
                    created = row['metadata'].get('created_at')
                    if not isinstance(kind, str) or len(kind.encode('utf-8')) > 256:
                        kind = 'memory'
                    if created is not None and (not isinstance(created, str) or len(created.encode('utf-8')) > 256):
                        created = None
                    display = {'id': row['id'], 'kind': kind,
                               'text': text_bytes[:ADMIN_TEXT_BYTES].decode('utf-8', errors='ignore'),
                               'textTruncated': len(text_bytes) > ADMIN_TEXT_BYTES,
                               'totalMemoryBytes': len(text_bytes), 'cubeId': cube,
                               'createdAt': created, 'profileId': profile['profileId']}
                    # Reserve space for the signed continuation even on the final page.
                    candidate = {'items': page + [display], 'nextCursor': make_cursor(display)}
                    if len(json.dumps(candidate, ensure_ascii=False).encode('utf-8')) > MAX_ADMIN_LIST:
                        if not page:
                            raise Denied('RESULT_TOO_LARGE')
                        page_full = has_more = True
                        break
                    page.append(display)
            finally:
                spool.close()
        return {'items': page, 'nextCursor': make_cursor(page[-1]) if has_more else None}


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """Ограниченный сервер без сетевого TCP listener и без журнала содержимого."""
    daemon_threads = True
    block_on_close = True
    request_queue_size = 16

    def __init__(self, path, boundary, *, admin=False):
        self.boundary, self.admin = boundary, admin
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(path, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass


class Handler(BaseHTTPRequestHandler):
    """Проверить peer до parse/dispatch; не возвращать сырые upstream ошибки."""
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond('GET')

    def do_POST(self):
        self.respond('POST')

    def respond(self, method):
        self.connection.settimeout(125)
        status, value, content_type = 200, None, 'application/json'
        spool = None
        try:
            if self.headers.get('Transfer-Encoding') or self.headers.get('Expect'):
                raise Denied('INVALID_FRAMING')
            raw_length = self.headers.get('Content-Length', '0')
            if not raw_length.isdecimal() or int(raw_length) > MAX_BODY:
                raise Denied('INVALID_LENGTH')
            raw = self.rfile.read(int(raw_length))
            if len(raw) != int(raw_length):
                raise Denied('INCOMPLETE_BODY')
            body = json.loads(raw) if raw else {}
            uid = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            if self.server.admin:
                if method != 'POST':
                    raise Denied('METHOD_DENIED')
                value = self.server.boundary.admin(uid, self.path, body)
            else:
                initial_profile = self.server.boundary.profile(uid)
                if self.path in ('/product/get_memory', '/product/get_memory_stream'):
                    spool = self.server.boundary.spool_read(initial_profile, method, self.path, body)
                    if self.path == '/product/get_memory_stream':
                        content_type = 'application/x-ndjson'
                else:
                    value = self.server.boundary.handle(uid, method, self.path, body)
            if spool is None:
                payload = json.dumps(value, ensure_ascii=False).encode()
            if not self.server.admin and self.server.boundary.profile(uid) != initial_profile:
                raise Denied('PROFILE_CHANGED')
        except Denied as error:
            status, payload = 403, json.dumps({'error': str(error)}).encode()
        except (ValueError, KeyError, TypeError):
            status, payload = 400, b'{"error":"INVALID_ARGUMENT"}'
        except Exception:
            status, payload = 503, b'{"error":"MEMORY_UNAVAILABLE"}'
        if status != 200 and spool is not None:
            spool.close()
            spool = None
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(spool.size if spool is not None else len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if spool is None:
                self.wfile.write(payload)
            else:
                self.connection.settimeout(1)
                checked = time.monotonic()
                while chunk := spool.file.read(65536):
                    if time.monotonic() - checked >= 1:
                        if self.server.boundary.profile(uid) != initial_profile:
                            raise Denied('PROFILE_CHANGED')
                        checked = time.monotonic()
                    self.wfile.write(chunk)
        finally:
            if spool is not None:
                spool.close()


def validate_config(config):
    """Проверить операторский конфиг без обращения к реестру или MemOS."""
    keys = {'registryPath', 'upstream', 'authorizationSocket', 'cursorKey', 'socketPath', 'adminSocket'}
    if not isinstance(config, dict) or not keys <= set(config) or set(config) - keys - {'spoolDirectory', 'quarantineProfile'}:
        raise ValueError('Invalid memory gateway configuration')
    if 'spoolDirectory' in config:
        directory = config['spoolDirectory']
        if not isinstance(directory, str) or not directory.startswith('/') or '\x00' in directory or '..' in Path(directory).parts:
            raise ValueError('Invalid spool directory')
        path = Path(directory)
        for parent in (path, *path.parents):
            info = parent.lstat()
            denied = 0o077 if parent == path else 0o022
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & denied:
                raise ValueError('Unprotected spool directory')
    for key in ('registryPath', 'authorizationSocket', 'socketPath', 'adminSocket'):
        path = config[key]
        if not isinstance(path, str) or not path.startswith('/') or '\x00' in path or '..' in Path(path).parts:
            raise ValueError('Invalid memory gateway path')
    if len({config['authorizationSocket'], config['socketPath'], config['adminSocket']}) != 3:
        raise ValueError('Conflicting memory gateway sockets')
    try:
        parsed = urllib.parse.urlsplit(config['upstream'])
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError('Invalid MemOS upstream') from None
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1') or not port
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise ValueError('Invalid MemOS upstream')
    try:
        key = bytes.fromhex(config['cursorKey'])
    except (TypeError, ValueError):
        raise ValueError('Invalid cursor key') from None
    if len(key) != 32 or len(config['cursorKey']) != 64:
        raise ValueError('Invalid cursor key')
    result = {**config, 'cursorKey': key, 'upstream': config['upstream'].rstrip('/')}
    if 'quarantineProfile' in config:
        q = config['quarantineProfile']
        if (not isinstance(q, dict) or set(q) != {'userId', 'profileId', 'homeScope', 'memoryEpoch', 'cubes'}
                or any(not isinstance(q[k], str) or not re.fullmatch(r'[0-9a-f]{64}', q[k])
                       for k in ('profileId', 'homeScope', 'memoryEpoch'))
                or q['userId'] != 'quarantine-' + q['profileId'] or not isinstance(q['cubes'], list)
                or not q['cubes'] or any(not isinstance(c, str) for c in q['cubes'])
                or len(set(q['cubes'])) != len(q['cubes'])):
            raise ValueError('Invalid quarantine profile')
        q = {**q, '_quarantine': True}
        for cube in q['cubes']:
            physical_cube(q, cube)
        result['quarantineProfile'] = q
    return result


def broker_authorizer(registry_path, socket_path):
    """Проверять текущий UID через root broker для каждого обращения."""
    def authorize(user_id, profile_id):
        try:
            profiles = load_registry(registry_path)
            matches = [uid for uid, profile in profiles.items()
                       if profile['userId'] == user_id and profile['profileId'] == profile_id
                       and profile['status'] == 'active']
            if len(matches) != 1:
                return False
            request = {'jsonrpc': '2.0', 'id': 1, 'method': 'authorize', 'params': {'uid': matches[0]}}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(4)
                connection.connect(socket_path)
                peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if peer[1] != 0:
                    return False
                connection.sendall(json.dumps(request, separators=(',', ':')).encode() + b'\n')
                raw = bytearray()
                while b'\n' not in raw and len(raw) <= 8192:
                    chunk = connection.recv(8193 - len(raw))
                    if not chunk:
                        return False
                    raw.extend(chunk)
            if len(raw) > 8192 or not raw.endswith(b'\n') or raw.count(b'\n') != 1:
                return False
            response = json.loads(raw)
            result = response.get('result') if isinstance(response, dict) else None
            return (isinstance(response, dict) and response.get('jsonrpc') == '2.0'
                    and type(response.get('id')) is int and response['id'] == 1
                    and 'error' not in response and isinstance(result, dict)
                    and set(result) == {'allowed'} and result['allowed'] is True)
        except Exception:
            return False
    return authorize


def prepare_socket(path):
    """Удалить только неработающий root-owned сокет в защищённом каталоге."""
    path = Path(path)
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError('Unprotected socket directory')
    try:
        before = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0:
        raise PermissionError('Foreign socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(path))
        except ConnectionRefusedError:
            pass
        else:
            raise RuntimeError('Memory gateway socket is active')
    after = path.lstat()
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise PermissionError('Socket changed during inspection')
    path.unlink()


def bootstrap(config):
    """Проверить реестр и версии безопасных операций без чтения памяти."""
    profiles = load_registry(config['registryPath'])
    q = config.get('quarantineProfile')
    if q and any(p['userId'] == q['userId'] or p['profileId'] == q['profileId']
                 or (p['homeScope'], p['memoryEpoch']) == (q['homeScope'], q['memoryEpoch'])
                 for p in profiles.values()):
        raise RuntimeError('Quarantine profile conflicts with registry')
    client = client_type()({'base_url': config['upstream'], 'user_id': 'bootstrap',
                            'cube_id': 'bootstrap', 'request_timeout': 4})
    response = client.request('/product/memory_capabilities', timeout=4)
    data = response.get('data')
    if not isinstance(data, dict) or any(type(data.get(k)) is not int or data[k] != 1
                                        for k in ('memory_stream', 'recall_index')):
        raise RuntimeError('Secure MemOS capabilities unavailable')


def notify_ready():
    """Сообщить systemd о готовности, если передан его локальный сокет."""
    address = os.environ.get('NOTIFY_SOCKET')
    if address:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
            channel.sendto(b'READY=1', '\x00' + address[1:] if address.startswith('@') else address)


def start_listener(path, boundary, *, admin):
    """Открыть listener с приватным umask до установки конечного режима."""
    prepare_socket(path)
    previous = os.umask(0o077)
    try:
        server = Server(path, boundary, admin=admin)
    finally:
        os.umask(previous)
    try:
        os.chmod(path, 0o600 if admin else 0o666)
        info = Path(path).lstat()
        return server, (info.st_dev, info.st_ino)
    except BaseException:
        server.server_close()
        Path(path).unlink(missing_ok=True)
        raise


def close_listener(server, path, identity):
    """Закрыть listener и удалить только созданный им inode."""
    server.server_close()
    try:
        info = Path(path).lstat()
        if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == identity:
            Path(path).unlink()
    except FileNotFoundError:
        pass


def serve(config):
    """Запустить оба listener и завершить их после SIGINT/SIGTERM."""
    bootstrap(config)
    boundary = Boundary(config['registryPath'], config['upstream'],
                        authorize=broker_authorizer(config['registryPath'], config['authorizationSocket']),
                        cursor_key=config['cursorKey'], admin_uid=0,
                        spool_dir=config.get('spoolDirectory'),
                        quarantine_profile=config.get('quarantineProfile'))
    stopped = threading.Event()
    def stop(_signum, _frame):
        stopped.set()
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    listeners = []
    try:
        for key, admin in (('socketPath', False), ('adminSocket', True)):
            path = config[key]
            server, identity = start_listener(path, boundary, admin=admin)
            listeners.append((server, path, identity, None))
        for index, (server, path, identity, _) in enumerate(listeners):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            listeners[index] = (server, path, identity, thread)
        notify_ready()
        print('READY', flush=True)
        stopped.wait()
    finally:
        for server, path, identity, thread in reversed(listeners):
            if thread is not None:
                server.shutdown()
                thread.join()
            close_listener(server, path, identity)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main():
    """Запустить gateway только от root с защищённым конфигом."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError('Root memory gateway required')
    serve(validate_config(protected_json(args.config)))


if __name__ == '__main__':
    main()
