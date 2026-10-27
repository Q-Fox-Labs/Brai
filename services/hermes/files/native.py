# ABOUTME: Подключает Artifacts к обязательным границам движка Hermes для всех каналов.
# ABOUTME: Сохраняет состав наборов и квитанции; локальные байты используются временно.
from __future__ import annotations
import asyncio
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
import inspect
import shutil
import shlex
import json
import mimetypes
from pathlib import Path
import re
import uuid
from urllib.parse import unquote, urlparse
from .store import FileStore, FileError, canonical, key, deliver, workspace_in_use

_store = None
_recovery_targets = {}
_operation = ContextVar('brai_file_operation', default=None)
_sending = ContextVar('brai_file_sending', default=False)
_inbound = ContextVar('brai_file_inbound', default=None)
_prepared_inbound = ContextVar('brai_file_prepared_inbound', default=None)
_inline_images = ContextVar('brai_file_inline_images', default=frozenset())
_MEDIA = re.compile(r'MEDIA:\s*(?:"([^"\n]+)"|\x27([^\x27\n]+)\x27|([^\s<>]+))')
_DESCRIPTOR = re.compile(r'!?\[(?P<label>(?:\\.|[^\]\\\n])*)\]\((?:<(?P<angle>[^>\n]+)>|(?P<plain>[^)\n]+))\)')
_SET = re.compile(r'^BRAI_FILES:(\{[^\n]+\})\s*$', re.M)


def configure(config, backend):
    """Привязать owner и publisher из защищённой конфигурации запуска."""
    global _store
    _store = FileStore(config['stateRoot'], config['resultRoot'], config['ownerId'], backend,
                       config['readRoots'], config.get('serviceRoots', []))
    _store.account = config['account']
    _store.legacy_roots = tuple(Path(p).resolve() for p in config.get('legacyRoots', []))
    _store.temporary_roots = tuple(Path(p).resolve() for p in config.get('temporaryRoots', [_store.work, _store.cache]))
    return _store


def store():
    """Остановить файловые операции без обязательного адаптера."""
    if _store is None:
        raise FileError('FILES_NOT_CONFIGURED')
    return _store


def source_of(event):
    """Изолировать канал, экземпляр, чат, тему и отправителя."""
    s = event.source
    return {'platform': str(getattr(s.platform, 'value', s.platform)),
            'account': store().account + ':' + str(getattr(s, 'profile', '') or ''),
            'chat': str(s.chat_id or ''), 'thread': str(s.thread_id or ''), 'sender': str(s.user_id or '')}


def batch_key(event, group):
    """Устойчивый ключ штатного окна сборки."""
    return key([source_of(event), str(group)])


async def capture(adapter, event):
    """Сохранить элемент после авторизации, до debounce и декодирования."""
    runner = getattr(adapter, 'gateway_runner', None)
    raw = getattr(event, 'raw_message', None)
    if (runner is None or not runner._is_user_authorized_for_source(event.source)
            or not getattr(event.source, 'user_id', None) or getattr(event.source, 'is_bot', False)
            or getattr(raw, 'sender_chat', None) or getattr(raw, 'business_connection_id', None)):
        raise FileError('FILES_NOT_AUTHORIZED')
    await accept_event(event, admit=False)
    if not getattr(event, '_brai_capture_leases', None) and event.metadata.get('_brai_artifacts'):
        refs = [item['file'] for item in event.metadata['_brai_artifacts']]
        lease = store().materialize(refs, ['capture', source_of(event), str(event.message_id)])
        await asyncio.to_thread(lease.__enter__)
        event._brai_capture_leases = [lease]


async def accept_event(event, admit=True):
    """Сохранить весь принятый состав и допустить только новые готовые элементы."""
    if (getattr(event, 'metadata', None) or {}).get('fileSetStatus') == 'incomplete':
        raise FileError('INCOMPLETE_FILE_SET')
    paths = list(getattr(event, 'media_urls', []) or [])
    if not paths:
        paths = [item['localPath'] for item in (getattr(event, 'metadata', None) or {}).get('_brai_artifacts', [])]
    if not paths:
        _prepared_inbound.set(None)
        return True
    files = store()
    event.metadata = dict(getattr(event, 'metadata', None) or {})
    refs = event.metadata.get('_brai_artifacts')
    if refs is None:
        source, msg = source_of(event), str(event.message_id or '')
        if not msg:
            raise FileError('SOURCE_MESSAGE_REQUIRED')
        group = str(getattr(getattr(event, 'raw_message', None), 'media_group_id', None) or msg)
        position = int(msg) if msg.isdecimal() else 0
        refs, failures = [], []
        with files.db() as db:
            for index, path in enumerate(paths):
                identity = key([files.owner, source, msg + ':' + str(index)])
                gid = key([files.owner, source, group])
                db.execute('INSERT OR IGNORE INTO groups(identity) VALUES (?)', (gid,))
                db.execute('INSERT OR IGNORE INTO items VALUES (?,?,?,?,?,?,NULL,NULL)',
                           (identity, gid, canonical({**source, 'itemId': msg + ':' + str(index), 'messageId': msg,
                                      'attachmentId': str(index), 'sourceGroupId': group,
                                      'mediaGroupId': str(getattr(event.raw_message, 'media_group_id')) if getattr(getattr(event, 'raw_message', None), 'media_group_id', None) is not None else None}),
                            position * 1000 + index, event.text or '', path))
        for index, path in enumerate(paths):
            try:
                if str(path).startswith(('http://', 'https://')):
                    item_key = key([files.owner, source, msg + ':' + str(index)])
                    with files.db() as db:
                        known = db.execute('SELECT artifact FROM items WHERE identity=?', (item_key,)).fetchone()
                    if not known or not known['artifact']:
                        mime = (getattr(event, 'media_types', []) or [''])[min(index, len(getattr(event, 'media_types', []) or ['']) - 1)]
                        path = await download_url(path, [source, msg, index], mime)
                        with files.db() as db:
                            db.execute('UPDATE items SET path=? WHERE identity=? AND artifact IS NULL', (str(path), item_key))
                refs.append(await asyncio.to_thread(files.ingest, source, msg + ':' + str(index), path,
                            position * 1000 + index, event.text or '', group))
            except Exception as error:
                failures.append(error)
        if failures:
            event.media_urls = []
            event.metadata['fileSetStatus'] = 'incomplete'
            raise FileError('INCOMPLETE_FILE_SET') from None
        event.metadata['_brai_artifacts'] = refs
        with files.db() as db:
            route = {'chat_type': getattr(event.source, 'chat_type', 'dm'), 'profile': getattr(event.source, 'profile', None)}
            for gid in {item['groupId'] for item in refs}:
                db.execute('INSERT OR REPLACE INTO routes VALUES (?,?)', (gid, canonical(route)))
    event.media_urls = [item['localPath'] for item in refs]
    if not admit:
        return True
    groups = list(dict.fromkeys(item['groupId'] for item in refs))
    accepted = [await asyncio.to_thread(files.admit, group, defer=True) for group in groups]
    if all(value['duplicate'] for value in accepted):
        event.media_urls = []
        return False
    items = [item for value in accepted for item in value['items']]
    lease = files.materialize([item['file'] for item in items], ['inbound', groups, str(uuid.uuid4())])
    copies = await asyncio.to_thread(lease.__enter__)
    event._brai_file_lease = lease
    event.media_urls = [value['localPath'] for value in copies]
    event.media_types = [value['mimeType'] for value in copies]
    ticket = files.prepare_admission(source_of(event), str(event.message_id), accepted)
    _prepared_inbound.set((source_of(event), str(event.message_id), ticket))
    event.metadata['fileSets'] = [{key: value for key, value in item.items() if not key.startswith('_')} for item in accepted]
    if any(value.get('supplement') for value in accepted):
        event.text = '[Дополнение к прежнему набору; ранее обработанные элементы не повторяются.]\n' + (event.text or '')
    event.text = (event.text or '') + '\n' + '\n'.join('[artifactId=' + item['file']['artifactId'] + '] ' + item['caption'] for item in items)
    return True


def commit_inbound(source, message_id, ticket=None):
    """Зафиксировать набор только непосредственно перед запуском агента."""
    holder = type('AdmissionEvent', (), {'source': source})()
    route = source_of(holder)
    try:
        return store().commit_admission(route, message_id, ticket=ticket)
    except FileError as error:
        if str(error) == 'FILE_SET_ADMISSION_CONFLICT':
            for loop, adapter in list(_recovery_targets.values()):
                if str(getattr(adapter.platform, 'value', adapter.platform)) == route['platform'] and not loop.is_closed():
                    loop.call_soon_threadsafe(schedule_recovery, adapter)
        raise


def reject_proxy_inbound(source, message_id):
    """Не пересылать пользовательские файлы через proxy без подтверждаемого протокола."""
    holder = type('AdmissionEvent', (), {'source': source})()
    pending = _prepared_inbound.get()
    if pending and pending[:2] == (source_of(holder), str(message_id)):
        raise FileError('FILES_PROXY_UNSUPPORTED')


@contextmanager
def inbound_handoff(source, message_id, *, inline_images=()):
    """Связать входящий набор с фактическим входом в обработчик агента."""
    holder = type('AdmissionEvent', (), {'source': source})()
    prepared = _prepared_inbound.get()
    ticket = prepared[2] if prepared and prepared[:2] == (source_of(holder), str(message_id)) else None
    token = _inbound.set((source, message_id, ticket))
    # Только внутреннее кодирование уже принятого набора; API не задаёт это разрешение.
    images_token = _inline_images.set(frozenset(inline_images) if ticket else frozenset())
    try:
        yield
    finally:
        _inline_images.reset(images_token)
        _inbound.reset(token)


def merge_events(existing, event):
    """Сохранить ID и подписи при объединении сообщений канала."""
    old = list((existing.metadata or {}).get('_brai_artifacts', []))
    new = list((event.metadata or {}).get('_brai_artifacts', []))
    existing.metadata = {**(existing.metadata or {}), '_brai_artifacts': old + new}
    existing._brai_capture_leases = (getattr(existing, '_brai_capture_leases', [])
                                    + getattr(event, '_brai_capture_leases', []))
    event._brai_capture_leases = []


def release_event(event):
    """Освободить входные копии после обработки и доставки."""
    lease = getattr(event, '_brai_file_lease', None)
    if lease:
        lease.__exit__(None, None, None)
        event._brai_file_lease = None
    for capture_lease in getattr(event, '_brai_capture_leases', []):
        capture_lease.__exit__(None, None, None)
    event._brai_capture_leases = []
    store().cleanup(['inbound', str(event.message_id)])


def local_path(value):
    """Сетевые URL сначала импортируются каналом в Artifacts."""
    value = str(value)
    if value.startswith('file://'):
        parsed = urlparse(value)
        if parsed.netloc not in {'', 'localhost'}:
            raise FileError('LOCAL_PATH_REQUIRED')
        return unquote(parsed.path)
    if '://' in value or not value:
        raise FileError('ARTIFACT_REQUIRED')
    return value


def input_text(value, operation):
    """Импортировать явные @file/@image входы CLI/API до чтения моделью."""
    if isinstance(value, str):
        def replace(match):
            path = match.group(2)
            result = (resolve_artifact(path.split(':', 1)[1].lstrip('/'), operation) if path.startswith('artifact:')
                      else resolve(local_path(path), ['input', operation, path]))
            return '@' + match.group(1) + ':' + result['localPath'] + '\n[artifactId=' + result['artifactId'] + ']'
        return re.sub(r'^@(file|image):([^\n]+)', replace, value, flags=re.M)
    if isinstance(value, list):
        result = []
        for item in value:
            item = dict(item) if isinstance(item, dict) else item
            if isinstance(item, dict) and item.get('type') == 'text':
                item['text'] = input_text(item.get('text', ''), operation)
            if isinstance(item, dict) and item.get('type') in {'image_url', 'file_url'}:
                field = item['type']
                url = item.get(field, {}).get('url', '')
                if url.startswith('file://') or url.startswith('/'):
                    fetched = resolve(local_path(url), ['input', operation, url])
                    item[field] = {**item[field], 'url': 'file://' + fetched['localPath']}
                elif url.startswith('artifact:'):
                    value = resolve_artifact(url.split(':', 1)[1].lstrip('/'), operation)
                    item[field] = {**item[field], 'url': 'file://' + value['localPath']}
                elif field == 'image_url' and url.startswith('data:image/') and url in _inline_images.get():
                    # Native gateway уже сохранил оригинал и закодировал временную копию для vision.
                    pass
                elif url:
                    raise FileError('ARTIFACT_REQUIRED')
            result.append(item)
        return result
    return value


@contextmanager
def conversation(agent, user_message, task_id=None):
    """Общая временная область CLI/API, gateway, cron и дочернего агента."""
    operation = str(getattr(agent, 'session_id', '') or task_id or uuid.uuid4()) + ':' + str(uuid.uuid4())
    token = _operation.set(operation)
    agent._brai_workspace = str(store().workspace(operation))
    task = str(task_id or getattr(agent, 'session_id', '') or operation)
    with store().db() as db:
        db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task, operation))
    try:
        prepared = input_text(user_message, operation)
        inbound = _inbound.get()
        if inbound is not None:
            commit_inbound(*inbound)
        yield prepared
    finally:
        _operation.reset(token)
        if not workspace_in_use(Path(agent._brai_workspace)):
            store().release_operation(operation)
        with store().db() as db:
            scopes = [row[0] for row in db.execute('SELECT scope FROM cleanup_scopes WHERE operation=?', (operation,))]
            db.execute('DELETE FROM cleanup_scopes WHERE operation=?', (operation,))
        for scope in scopes:
            if not workspace_in_use(store().work / key([store().owner, scope])):
                store().release_operation(scope)
                store().cleanup(scope)
        with store().db() as db:
            db.execute('DELETE FROM tasks WHERE identity=? AND operation=?', (task, operation))
        store().cleanup(operation, cache=False)


def before_tool(name, args, **ids):
    """Проверить чтения и направить изменения и terminal во временный cwd."""
    args = dict(args)
    operation = operation_for(ids)
    workspace = store().workspace(operation)
    if name == 'terminal':
        requested = Path(args.get('workdir') or workspace).absolute()
        if not requested.is_relative_to(store().work) and not any(requested.is_relative_to(p) for p in store().service_roots):
            raise FileError('TEMPORARY_WORKDIR_REQUIRED')
        args['workdir'] = str(requested)
        if isinstance(args.get('command'), str):
            args['command'] = 'export TMPDIR=' + shlex.quote(str(workspace)) + '; ' + args['command']
    for field in ('path', 'file_path', 'image_path', 'image_url', 'audio_path', 'video_path', 'input_path'):
        value = args.get(field)
        if not isinstance(value, str) or not value:
            continue
        if re.fullmatch(r'[0-9a-fA-F-]{36}', value):
            args[field] = resolve_artifact(value, operation)['localPath']
            continue
        path = Path(local_path(value)).expanduser()
        path = path if path.is_absolute() else workspace / path
        resolved = path.resolve()
        if any(resolved.is_relative_to(root) for root in store().service_roots):
            continue
        if name in {'write_file', 'patch'}:
            if not resolved.is_relative_to(store().work):
                raise FileError('TEMPORARY_OUTPUT_REQUIRED')
            args[field] = str(resolved)
        elif resolved.is_relative_to(store().work):
            args[field] = str(path)  # Промежуточные материалы не публикуются автоматически.
        elif path.is_file() or known_alias(path):
            with store().lock('cache'):
                result = store().resolve(path, ['read', operation, str(path)])
                store().pin_operation(result, operation)
                args[field] = result['localPath']
        elif path.is_dir() and not resolved.is_relative_to(store().work):
            raise FileError('ARTIFACT_DIRECTORY_REQUIRED')
        else:
            args[field] = str(path)
    return args


def after_tool(name, args, result, **ids):
    """Публиковать явные выходы генераторов, не сканируя промежуточные каталоги."""
    if not isinstance(result, str) or name not in {'image_generate', 'text_to_speech', 'video_generate', 'browser_screenshot', 'terminal', 'process'}:
        return result
    try:
        data = json.loads(result)
    except (ValueError, TypeError):
        return result
    if name == 'terminal':
        session = data.get('session_id') if isinstance(data, dict) else None
        if session and not isinstance(data.get('exit_code'), int):
            with store().db() as db:
                db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?)', (str(session), operation_for(ids)))
        return result
    if name == 'process':
        if isinstance(data, dict) and (isinstance(data.get('exit_code'), int) or data.get('status') in {'completed', 'done', 'exited', 'killed', 'terminated'}):
            with store().db() as db:
                row = db.execute('SELECT operation FROM jobs WHERE identity=?', (str(args.get('session_id', '')),)).fetchone()
            if row:
                with store().db() as db:
                    db.execute('INSERT OR IGNORE INTO cleanup_scopes VALUES (?,?)', (operation_for(ids), row[0]))
        return result
    operation = [operation_for(ids), ids.get('tool_call_id') or key([name, args])]
    def visit(value):
        if isinstance(value, dict):
            changed = {k: visit(v) for k, v in value.items()}
            for field in ('path', 'file_path', 'image_path', 'audio_path', 'video_path', 'output_path', 'image', 'host_image', 'agent_visible_image'):
                path = value.get(field)
                if isinstance(path, str) and Path(path).is_file():
                    published = resolve(path, ['output', operation, field, path])
                    changed[field] = published['localPath']
                    changed['artifactId'] = published['artifactId']
            return changed
        return [visit(item) for item in value] if isinstance(value, list) else value
    return canonical(visit(data)).replace("MEDIA:", r"MEDIA\u003a")


def presentation(file):
    """Различать типы Telegram; GIF и другие документы остаются файлами."""
    mime = file['mimeType']
    if mime in {'image/jpeg', 'image/png'}:
        return 'photo'
    if mime == 'video/mp4':
        return 'video'
    if mime in {'audio/mpeg', 'audio/mp4', 'audio/x-m4a'}:
        return 'audio'
    if mime in {'audio/ogg', 'audio/opus'}:
        return 'voice'
    if mime == 'image/gif':
        return 'animation'
    return 'document'


def active_sub(pattern, replace, text):
    """Не исполнять файловые директивы внутри Markdown примеров."""
    spans = [(match.start(), match.end()) for match in re.finditer(r'(?s)(?:\x60\x60\x60.*?\x60\x60\x60|\x60[^\x60\n]*\x60)', text)]
    def visit(match):
        return match.group(0) if any(start <= match.start() < end for start, end in spans) else replace(match)
    return pattern.sub(visit, text)


def paths_key(paths):
    """Parser может убрать повторный path; исходный порядок/повторы остаются в payload."""
    return canonical(sorted(set(paths)))


def final_text(text, operation):
    """Подготовить отдельные временные копии всего исходящего набора до выдачи."""
    if not isinstance(text, str):
        return text
    files, replacements, items = store(), [], []
    explicit = []
    active_sub(_SET, lambda match: explicit.append(match) or match.group(0), text)
    if len(explicit) > 1:
        raise FileError('ONE_FILE_SET_PER_MESSAGE')
    mode = 'files'
    if explicit:
        match = explicit[0]
        data = json.loads(match.group(1))
        if set(data) != {'mode', 'items'} or data['mode'] not in {'files', 'album'} or not data['items']:
            raise FileError('INVALID_FILE_SET')
        mode = data['mode']
        for item in data['items']:
            if set(item) - {'artifactId', 'caption', 'presentation'} or not isinstance(item.get('caption', ''), str):
                raise FileError('INVALID_FILE_SET')
            value = files.fetch(item['artifactId'])
            items.append({'file': files.checked(value), 'caption': item.get('caption', ''),
                          'presentation': item.get('presentation') or presentation(value)})
        replacements.append((match.start(), match.end(), list(range(len(items)))))
        masked = text[:match.start()] + ' ' * (match.end() - match.start()) + text[match.end():]
    else:
        masked = text
    def add(match, path, caption=''):
        if explicit:
            raise FileError('MIXED_FILE_SET_FORMAT')
        value = files.resolve(local_path(path), ['final', operation, path])
        index = len(items)
        items.append({'file': files.checked(value), 'caption': caption, 'presentation': presentation(value)})
        replacements.append((match.start(), match.end(), [index]))
        return match.group(0)
    active_sub(_MEDIA, lambda match: add(match, next(v for v in match.groups() if v is not None)), masked)
    def descriptor(match):
        path = match.group('angle') or match.group('plain')
        if not path.startswith('/') or any(Path(path).resolve().is_relative_to(root) for root in files.service_roots):
            return match.group(0)
        label = re.sub(r'\\(.)', r'\1', match.group('label'))
        return add(match, path, label)
    active_sub(_DESCRIPTOR, descriptor, masked)
    if not items:
        return text
    identity = key([operation, items])
    scope = ['egress', identity]
    workspace = files.cache / '.delivery' / identity
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    if workspace.resolve() != workspace:
        raise FileError('UNSAFE_DELIVERY_WORKSPACE')
    paths = []
    with files.materialize([item['file'] for item in items], scope) as values:
        for index, (item, value) in enumerate(zip(items, values)):
            suffix = Path(value['filename']).suffix
            suffix = suffix if re.fullmatch(r'\.[A-Za-z0-9]{1,16}', suffix) else '.bin'
            target = workspace / (str(index) + '-' + value['artifactId'] + suffix)
            if not target.exists():
                shutil.copyfile(value['localPath'], target)
                target.chmod(0o400)
            paths.append(str(target))
            with files.db() as db:
                db.execute('INSERT OR REPLACE INTO aliases VALUES (?,?,?)',
                           (str(target), value['artifactId'], canonical(item['file'])))
    with files.db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS output_sets (identity TEXT PRIMARY KEY, paths TEXT, payload TEXT)')
        db.execute('INSERT OR REPLACE INTO output_sets VALUES (?,?,?)',
                   (identity, paths_key(paths), canonical({'mode': mode, 'items': items, 'scope': scope})))
    for start, end, indexes in sorted(replacements, reverse=True):
        text = text[:start] + '\n'.join('MEDIA:' + json.dumps(paths[index], ensure_ascii=False) for index in indexes) + text[end:]
    return text


def output_items(paths, captions=None):
    """Найти конкретный ответ по отдельным temporary paths, сохранив подписи и повторы."""
    files = store()
    paths = [local_path(path) for path in paths]
    with files.db() as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='output_sets'").fetchone()
        row = db.execute('SELECT identity,payload FROM output_sets WHERE paths=?', (paths_key(paths),)).fetchone() if exists else None
    if row:
        data = json.loads(row['payload'])
        return [{**item, '_setId': row['identity']} for item in data['items']], data['mode']
    values = [files.resolve(path, ['delivery', _operation.get(), path]) for path in paths]
    return [{'file': files.checked(value), 'caption': (captions or [''] * len(paths))[index],
             'presentation': presentation(value)} for index, value in enumerate(values)], 'files'


def release_set(identity):
    """Освободить только копии данного ответа после потребителя или доставки."""
    with store().db() as db:
        row = db.execute('SELECT payload FROM output_sets WHERE identity=?', (identity,)).fetchone()
    if row:
        path = store().cache / '.delivery' / identity
        if path.exists():
            if path.resolve() != path:
                raise FileError('UNSAFE_DELIVERY_WORKSPACE')
            shutil.rmtree(path)
        store().cleanup(json.loads(row[0])['scope'])


async def telegram_sender(adapter, chat_id, metadata, kind, items, fallback):
    """Один Bot API вызов на группу; без retry/downgrade после неизвестного ответа."""
    from telegram import InputMediaPhoto, InputMediaVideo, InputMediaAudio, InputMediaDocument
    from contextlib import ExitStack
    bot, target = adapter._bot, {'chat_id': int(chat_id)}
    thread = (metadata or {}).get('thread_id') or (metadata or {}).get('message_thread_id')
    if thread is not None:
        target['message_thread_id'] = int(thread)
    if fallback:
        notice = await bot.send_message(**target, text='Этот набор нельзя отправить одним альбомом. Файлы идут отдельно в исходном порядке.')
        if not getattr(notice, 'message_id', None):
            raise FileError('DELIVERY_UNKNOWN')
    for item in items:
        caption = item.get('caption', '')
        if text_units(caption) > 1024:
            for chunk in text_chunks(caption, 4096):
                notice = await bot.send_message(**target, text=chunk, parse_mode=None)
                if not getattr(notice, 'message_id', None):
                    raise FileError('DELIVERY_UNKNOWN')
    classes = {'photo': InputMediaPhoto, 'video': InputMediaVideo, 'audio': InputMediaAudio, 'document': InputMediaDocument}
    with ExitStack() as stack:
        media = []
        for item in items:
            file = stack.enter_context(open(item['localPath'], 'rb'))
            caption = item.get('caption', '')
            if item['presentation'] in classes:
                media.append(classes[item['presentation']](media=file, caption=caption if text_units(caption) <= 1024 else None, parse_mode=None))
            else:
                from types import SimpleNamespace
                media.append(SimpleNamespace(media=file, caption=caption if text_units(caption) <= 1024 else None, parse_mode=None))
        if kind == 'album':
            result = await bot.send_media_group(**target, media=media)
        else:
            field = items[0]['presentation']
            result = [await getattr(bot, 'send_' + field)(**target, **{field: media[0].media}, caption=media[0].caption, parse_mode=None)]
    return [getattr(message, 'message_id', None) for message in result]


async def send_set(adapter, chat_id, items, mode, metadata=None, identity=None):
    """Проверить весь набор и сохранить квитанции для каждого элемента."""
    from gateway.platforms.base import SendResult
    platform = str(getattr(adapter.platform, 'value', adapter.platform))
    set_ids = {item['_setId'] for item in items if '_setId' in item}
    items = [{key: value for key, value in item.items() if key != '_setId'} for item in items]
    explicit = identity or (metadata or {}).get('brai_delivery_id')
    fingerprint = key([store().owner, platform, str(chat_id), metadata or {}, items, mode]) if not explicit else None
    announced = False
    async def sender(kind, prepared, fallback):
        nonlocal announced
        explain = (fallback or platform != 'telegram' and kind == 'album') and not announced
        announced = announced or explain
        if platform == 'telegram':
            return await telegram_sender(adapter, chat_id, metadata, kind, prepared, explain)
        if explain:
            notice = await adapter.send(chat_id, 'Файлы набора будут отправлены отдельно в исходном порядке.', metadata=metadata)
            if not notice.success:
                raise FileError('DELIVERY_UNKNOWN')
        receipt, token = [], _sending.set(True)
        try:
            for item in prepared:
                method, field = {'photo': ('send_image_file', 'image_path'), 'video': ('send_video', 'video_path'),
                                 'audio': ('send_voice', 'audio_path'), 'voice': ('send_voice', 'audio_path'), 'animation': ('send_animation', 'animation_url'), 'document': ('send_document', 'file_path')}[item['presentation']]
                target = getattr(adapter, method)
                arguments = {'chat_id': chat_id, field: item['localPath'], 'metadata': metadata}
                if 'caption' in inspect.signature(target).parameters:
                    arguments['caption'] = item.get('caption') or None
                elif item.get('caption'):
                    text_result = await adapter.send(chat_id, item['caption'], metadata=metadata)
                    if not text_result.success:
                        raise FileError('DELIVERY_UNKNOWN')
                result = await target(**arguments)
                if not result.success or not getattr(result, 'message_id', None):
                    raise FileError('DELIVERY_UNKNOWN')
                receipt.append(result.message_id)
            return receipt
        finally:
            _sending.reset(token)
    if platform == 'telegram':
        validate_telegram(items)
    guard = store().lock(['direct-delivery', fingerprint], blocking=False) if fingerprint else nullcontext()
    with guard:
        identity = str(explicit) if explicit else store().direct_delivery_identity(fingerprint)
        result = await deliver(store(), identity, items, sender, mode, supports_album=platform == 'telegram')
    result['deliveryId'] = identity
    if result['state'] == 'sent':
        for set_id in set_ids:
            release_set(set_id)
        store().cleanup(str(identity))
    return SendResult(success=result['state'] == 'sent', message_id=result['receipts'][-1]['messageId'] if result['receipts'] else None,
                      error=None if result['state'] == 'sent' else 'FILE_DELIVERY_' + result['state'].upper(), raw_response=result)


async def deliver_attachments(adapter, event, media_files, local_files, metadata, record_delivery, force_document=False, images=()):
    """Проверить весь набор до первого вложения, сохраняя порядок фото и видео."""
    paths = [path for path, _ in media_files] + [path for path, _ in images] + list(local_files)
    if not paths:
        return
    items, mode = await asyncio.to_thread(output_items, paths)
    if force_document:
        items = [{**item, 'presentation': 'document'} for item in items]
    public_items = [{key: value for key, value in item.items() if key != '_setId'} for item in items]
    identity = key([source_of(event), str(getattr(event, 'ledger_message_id', None) or event.message_id), public_items, mode])
    record_delivery(await send_set(adapter, event.source.chat_id, items, mode, metadata, identity))


def install_adapter(adapter):
    """Охватить прямые отправки cron/send_message вне final response."""
    for name, field in [('send_image_file', 'image_path'), ('send_image', 'image_url'), ('send_video', 'video_path'),
                        ('send_document', 'file_path'), ('send_voice', 'audio_path'), ('send_animation', 'animation_url'),
                        ('send_multiple_images', 'images')]:
        original = getattr(adapter, name, None)
        if original is None:
            continue
        def wrap(original, field):
            async def wrapped(*args, **kwargs):
                if _sending.get():
                    return await original(*args, **kwargs)
                bound = inspect.signature(original).bind(*args, **kwargs)
                bound.apply_defaults()
                data = bound.arguments
                if field == 'images':
                    paths, captions = zip(*data[field]) if data[field] else ([], [])
                else:
                    paths, captions = [data[field]], [data.get('caption') or '']
                items, mode = await asyncio.to_thread(output_items, paths, captions)
                if field == 'images':
                    mode = 'album'
                if field == 'file_path':
                    items = [{**item, 'presentation': 'document'} for item in items]
                return await send_set(adapter, data['chat_id'], items, mode, data.get('metadata'))
            return wrapped
        setattr(adapter, name, wrap(original, field))


async def live_send(adapter, chat_id, message, media_files, thread_id=None, metadata=None, force_document=False):
    """Отправить явный набор send_message через ту же общую доставку."""
    items, mode = await asyncio.to_thread(output_items, [item[0] for item in media_files])
    if force_document:
        items = [{**item, 'presentation': 'document'} for item in items]
    if message and items:
        items[0] = {**items[0], 'caption': message + ('\n' + items[0]['caption'] if items[0].get('caption') else '')}
    result = await send_set(adapter, chat_id, items, mode, {**(metadata or {}), 'thread_id': thread_id} if thread_id else metadata)
    return {'success': result.success, 'message_id': result.message_id, 'error': result.error, 'files': result.raw_response}


async def standalone_telegram(pconfig, chat_id, message, media_files, thread_id, force_document):
    """CLI и cron используют Bot API с теми же receipts и без legacy fallback."""
    from telegram import Bot
    from types import SimpleNamespace
    async with Bot(pconfig.token) as bot:
        adapter = SimpleNamespace(platform='telegram', _bot=bot)
        return await live_send(adapter, chat_id, message, media_files, thread_id, None, force_document)


def operation_for(ids):
    """Найти файловую область worker без зависимости от копирования ContextVar."""
    if _operation.get():
        return _operation.get()
    task = str(ids.get('task_id') or ids.get('session_id') or '')
    with store().db() as db:
        row = db.execute('SELECT operation FROM tasks WHERE identity=?', (task,)).fetchone()
    return row[0] if row else task or 'standalone'


def resolve(path, identity):
    """Проверить и закрепить копию до передачи обработчику."""
    with store().lock('cache'):
        result = store().resolve(path, identity)
        if _operation.get():
            store().pin_operation(result, _operation.get())
        return result


def resolve_artifact(artifact_id, operation):
    """Получить ID без повторной публикации и закрепить для worker."""
    with store().lock('cache'):
        result = store().fetch(artifact_id)
        store().pin_operation(result, operation)
        return result


async def recover(adapter):
    """Восстановить принятые, ещё не переданные наборы после запуска gateway."""
    from gateway.config import Platform
    from gateway.session import SessionSource
    from gateway.platforms.event import MessageEvent, MessageType
    import logging
    await asyncio.sleep(0)
    files = store()
    try:
        await asyncio.to_thread(files.resume_publications)
        with files.db() as db:
            groups = db.execute('SELECT g.identity,g.admitted,r.route FROM groups g LEFT JOIN routes r ON r.group_key=g.identity').fetchall()
        for group in groups:
            with files.db() as db:
                rows = db.execute('SELECT * FROM items WHERE group_key=? ORDER BY position,identity', (group['identity'],)).fetchall()
            previous = json.loads(group['admitted']) if group['admitted'] else []
            if not rows or all(row['identity'] in previous for row in rows) or any(not row['artifact'] for row in rows):
                continue
            origin = json.loads(rows[0]['source'])
            if origin['platform'] != str(getattr(adapter.platform, 'value', adapter.platform)):
                continue
            route = json.loads(group['route']) if group['route'] else {}
            source = SessionSource(platform=Platform(origin['platform']), chat_id=origin['chat'],
                                   thread_id=origin['thread'] or None, user_id=origin['sender'] or None,
                                   chat_type=route.get('chat_type', 'dm'), profile=route.get('profile'))
            refs = []
            for row in rows:
                value = await asyncio.to_thread(files.fetch, row['artifact'])
                refs.append({'groupId': group['identity'], 'itemId': row['identity'],
                             'file': json.loads(row['ref']), 'localPath': value['localPath']})
            event = MessageEvent(text=rows[0]['caption'], message_type=MessageType.DOCUMENT, source=source,
                                 message_id=origin['itemId'].rsplit(':', 1)[0],
                                 media_urls=[item['localPath'] for item in refs],
                                 metadata={'_brai_artifacts': refs, 'recovered': True})
            await adapter.handle_message(event)
    except Exception:
        logging.getLogger(__name__).warning('BRAI_FILES_RECOVERY_INCOMPLETE')


def schedule_recovery(adapter):
    """Подключать восстановление и повторять его при гонке готовых версий."""
    loop = asyncio.get_running_loop()
    _recovery_targets[id(adapter)] = (loop, adapter)
    task = getattr(adapter, '_brai_recovery_task', None)
    if task is not None and not task.done():
        adapter._brai_recovery_again = True
        return
    adapter._brai_recovery_again = False
    task = adapter._brai_recovery_task = loop.create_task(recover(adapter))
    def finished(_):
        if getattr(adapter, '_brai_recovery_again', False):
            schedule_recovery(adapter)
    task.add_done_callback(finished)


def workspace_for(task_id):
    """Одинаковый cwd терминала, файловых инструментов и code execution."""
    return str(store().workspace(operation_for({'task_id': task_id})))


def known_alias(path):
    """Старый путь миграции остаётся разрешимым после удаления локальных байтов."""
    with store().db() as db:
        return db.execute('SELECT 1 FROM aliases WHERE path=?', (str(path),)).fetchone() is not None


def guard_write(path, task_id):
    """Закрыть также прямые вызовы write/patch в обход model_tools."""
    base = Path(workspace_for(task_id))
    value = Path(path).expanduser()
    value = value if value.is_absolute() else base / value
    resolved = value.resolve()
    if not resolved.is_relative_to(store().work) and not any(resolved.is_relative_to(p) for p in store().service_roots):
        raise FileError('TEMPORARY_OUTPUT_REQUIRED')
    return str(value)


def text_units(text):
    """Безопасно учитывать UTF-16 units для Telegram, сохраняя каждую Unicode букву."""
    return len(text.encode('utf-16-le')) // 2


def text_chunks(text, maximum):
    """Разбить длинный текст без усечения и разрыва Unicode code point."""
    chunk, size = [], 0
    for character in text:
        width = text_units(character)
        if size + width > maximum:
            yield ''.join(chunk)
            chunk, size = [], 0
        chunk.append(character)
        size += width
    if chunk:
        yield ''.join(chunk)


def validate_telegram(items):
    """Проверить совместимость ВСЕХ элементов с Bot API до первой отправки."""
    allowed = {'photo': {'image/jpeg', 'image/png'}, 'video': {'video/mp4'},
               'audio': {'audio/mpeg', 'audio/mp4', 'audio/x-m4a'},
               'voice': {'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp4'},
               'animation': {'image/gif', 'video/mp4'}, 'document': None}
    for item in items:
        kind, file = item.get('presentation') or presentation(item['file']), item['file']
        if kind not in allowed or allowed[kind] is not None and file['mimeType'] not in allowed[kind]:
            raise FileError('FILE_SET_INCOMPATIBLE')
        if file['sizeBytes'] > (10 if kind == 'photo' else 50) * 1024**2:
            raise FileError('CHANNEL_FILE_TOO_LARGE')
        if not isinstance(item.get('caption', ''), str):
            raise FileError('INVALID_CAPTION')


def result_envelope(result, agent=None):
    """CLI/API и дочерний агент получают стабильные IDs и состав, а не один временный path."""
    if not isinstance(result, dict):
        return result
    response = result.get('final_response', '')
    paths = []
    def found(match):
        paths.append(next(value for value in match.groups() if value is not None))
        return match.group(0)
    active_sub(_MEDIA, found, response)
    if paths:
        items, mode = output_items(paths)
        public_items = [{key: value for key, value in item.items() if key != '_setId'} for item in items]
        result = {**result, 'fileSets': [{'mode': mode, 'items': public_items}]}
        platform = str(getattr(agent, 'platform', '') or '').lower()
        if platform in {'', 'cli', 'local', 'api', 'http', 'acp'}:
            for path, item in zip(paths, items):
                result['final_response'] = result['final_response'].replace('MEDIA:' + json.dumps(path, ensure_ascii=False),
                    '[' + item['file']['filename'] + '](artifact:' + item['file']['artifactId'] + ')')
            for identity in {item['_setId'] for item in items if '_setId' in item}:
                release_set(identity)
    return result


async def download_url(url, identity, mime=''):
    """Другие каналы импортируют CDN-вложения через native SSRF/size guards до публикации."""
    from gateway.platforms.base import _cache_media_from_url
    extension = Path(urlparse(url).path).suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,10}', extension):
        extension = mimetypes.guess_extension(mime or '') or '.bin'
    destination = store().workspace(['remote-input', identity]) / ('attachment' + extension)
    def save(data, ext):
        destination.write_bytes(data)
        return str(destination)
    return await _cache_media_from_url(url, extension, 0, media_type='attachment',
                                       accept='*/*', cache_fn=save, log_label='Brai input')


async def capture_authorized(adapter, event):
    """Общая граница до native очередей сохраняет исходные IDs каждого канала."""
    if not getattr(event, 'media_urls', None) and not (getattr(event, 'metadata', None) or {}).get('_brai_artifacts'):
        return True
    runner = getattr(adapter, 'gateway_runner', None)
    if runner is None or not runner._is_user_authorized_for_source(event.source):
        return False
    if str(getattr(event.source.platform, 'value', event.source.platform)) == 'telegram':
        await capture(adapter, event)
    else:
        await accept_event(event, admit=False)
    return True
