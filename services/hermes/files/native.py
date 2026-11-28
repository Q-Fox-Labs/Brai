# ABOUTME: Подключает Artifacts к обязательным границам движка Hermes для всех каналов.
# ABOUTME: Сохраняет состав наборов и квитанции; локальные байты используются временно.
from __future__ import annotations
import asyncio
from contextlib import ExitStack, contextmanager, nullcontext
from contextvars import ContextVar
from functools import wraps
import inspect
import logging
import shutil
import shlex
import json
import os
import mimetypes
from pathlib import Path
import re
import uuid
import time
import tempfile
from urllib.parse import unquote, urlparse
from .store import FileStore, FileError, FileMaterializationError, canonical, key, deliver, workspace_in_use

_store = None
_telegram_observer = None
_recovery_targets = {}
_operation = ContextVar('brai_file_operation', default=None)
_sending = ContextVar('brai_file_sending', default=False)
_inbound = ContextVar('brai_file_inbound', default=None)
_conversation_source = ContextVar('brai_file_conversation_source', default=None)
_reply_mode_candidate = ContextVar('brai_reply_mode_candidate', default=None)
_prepared_inbound = ContextVar('brai_file_prepared_inbound', default=None)
_inbound_attachments = ContextVar('brai_file_inbound_attachments', default=())
_VOICE_RETRY_ADMISSION = object()
_VOICE_REPLY_SECONDS = 180
_inline_images = ContextVar('brai_file_inline_images', default=frozenset())
_event_cleanup = ContextVar('brai_file_event_cleanup', default=None)
_MEDIA = re.compile(r'MEDIA:\s*(?:"([^"\n]+)"|\x27([^\x27\n]+)\x27|([^\s<>]+))')
_VIDEO_NOTE = re.compile(r'\[\[audio_as_video_note\]\][ \t]*\n[ \t]*' + _MEDIA.pattern)
_VIDEO_NOTE_MARKER = re.compile(r'\[\[audio_as_video_note\]\]')
_REPLY_MODE = re.compile(r'\[\[brai_reply_mode:(voice|video_note|off)\]\]')
_REPLY_ONCE = re.compile(r'\[\[brai_reply_once:(voice|video_note)\]\]')
_VOICE_MARKER = re.compile(r'\[\[audio_as_voice\]\]')
_VOICE_ONLY_OPEN = '[[brai_voice_only_text]]'
_VOICE_ONLY_CLOSE = '[[/brai_voice_only_text]]'
_VOICE_ONLY_TEXT = re.compile(re.escape(_VOICE_ONLY_OPEN) + r'(.*?)' + re.escape(_VOICE_ONLY_CLOSE), re.S)
_VOICE_BLOCK = re.compile(r'\[\[audio_as_voice\]\][ \t]*\n(?P<files>(?:[ \t]*MEDIA:[^\n]+(?:\n|$))+)')
_VOICE_LINE = re.compile(r'\[\[audio_as_voice\]\][ \t]*\n[ \t]*' + _MEDIA.pattern)
_DESCRIPTOR = re.compile(r'!?\[(?P<label>(?:\\.|[^\]\\\n])*)\]\((?:<(?P<angle>[^>\n]+)>|(?P<plain>[^)\n]+))\)')
_SET = re.compile(r'^BRAI_FILES:(\{[^\n]+\})\s*$', re.M)
_ATTACHMENT_FAILURE_NOTE = 'Не удалось приложить файлы. Номер в журнале: '
_MUTATION_FOOTER = re.compile(
    r'(?m)^⚠️?\s*(?:Проверка изменений файлов:|File-mutation verifier:)[^\n]*'
    r'(?:\n[ \t]+•[^\n]*)*\s*\Z'
)

_TECHNICAL_FAILURE = re.compile(
    r'(?im)(?:\[TOOL_ERROR\]|^\s*Traceback \(most recent call last\):|'
    r'\bError executing [\w.-]+:|\b(?:TEMPORARY_OUTPUT_REQUIRED|'
    r'TEMPORARY_WORKDIR_REQUIRED|ARTIFACT_DIRECTORY_REQUIRED|FILE_SCOPE_DENIED)\b|'
    r'\b(?:exit[_ ]code|код выхода)\s*[:=—-]?\s*[1-9]\d*\b)'
)


def _filtered_reply_stream(callback):
    """Не выводить служебные маркеры даже при разделении между потоковыми фрагментами."""
    markers = ('[[brai_reply_mode:voice]]', '[[brai_reply_mode:video_note]]',
               '[[brai_reply_mode:off]]', '[[brai_reply_once:voice]]',
               '[[brai_reply_once:video_note]]', '[[audio_as_video_note]]', '[[audio_as_voice]]')
    open_marker, close_marker = _VOICE_ONLY_OPEN, _VOICE_ONLY_CLOSE
    pattern = re.compile('|'.join(map(re.escape, (*markers, open_marker, close_marker))))
    pending = ''
    hidden = False

    def send(fragment):
        nonlocal pending, hidden
        if fragment is None:
            if not hidden and pending in ('[', '[['):
                callback(pending)
            pending = ''
            hidden = False
            return callback(None)
        text = pending + fragment
        visible = []
        start = 0
        for match in pattern.finditer(text):
            if not hidden:
                visible.append(text[start:match.start()])
            if match.group(0) == open_marker:
                hidden = True
            elif match.group(0) == close_marker:
                hidden = False
            start = match.end()
        tail = text[start:]
        length = max((size for marker in (*markers, open_marker, close_marker) for size in range(1, len(marker))
                      if tail.endswith(marker[:size])), default=0)
        pending = tail[-length:] if length else ''
        if not hidden:
            visible.append(tail[:-length] if length else tail)
        output = ''.join(visible)
        if output:
            return callback(output)

    return send


def register_telegram_observer(observer):
    """Подключить наблюдателя Telegram к общей файловой границе текущего gateway."""
    global _telegram_observer
    _telegram_observer = observer


async def _notify_observer(method, *args, **kwargs):
    if _telegram_observer is None:
        return
    try:
        await getattr(_telegram_observer, method)(*args, **kwargs)
    except Exception:
        logging.getLogger(__name__).warning('BRAI_TELEGRAM_OBSERVER_WRITE_FAILED')


async def observe_queued_delivery(identity, payload, state):
    """Отразить подтверждение или ошибку существующей очереди доставки Telegram."""
    from types import SimpleNamespace
    route = payload.get('route') or {}
    artifact = payload.get('artifact')
    refs = [{key: artifact[key] for key in ('artifactId', 'filename', 'mimeType', 'sizeBytes') if key in artifact}] if isinstance(artifact, dict) and artifact.get('artifactId') else []
    result = SimpleNamespace(success=state.get('status') == 'sent', message_id=state.get('message_id'), raw_response=state)
    await _notify_observer('observe_send', route.get('chat_id'), route,
        payload.get('content') or payload.get('caption') or '', result, refs, str(identity))


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


def _voice_experiment():
    return (os.environ.get('BRAI_IDENTITY_MODE') == 'worker'
            and os.environ.get('BRAI_VOICE_REPLY_EXPERIMENT') == '1')


def _effective_reply_mode(route):
    experiment = _voice_experiment()
    saved = store().reply_mode(route, experiment=experiment)
    return saved if saved is not None else 'video_note' if experiment else None


def reply_mode_for_event(event):
    """Look up the human's format without changing the native workspace identity."""
    route = source_of(event)
    if route['platform'] != 'telegram':
        return None
    route['sender'] = str(getattr(event.source, '_brai_actor_id', None) or route['sender'])
    return _effective_reply_mode(route)


def commit_reply_mode(result, event):
    """Commit only the completed worker result bound to the authenticated source."""
    candidate = result.pop('_brai_reply_mode', None) if isinstance(result, dict) else None
    if not isinstance(candidate, dict) or set(candidate) != {'source', 'mode'}:
        return
    route = source_of(event)
    route['sender'] = str(getattr(event.source, '_brai_actor_id', None) or route['sender'])
    if route['platform'] == 'telegram' and candidate['source'] == route:
        store().set_reply_mode(route, candidate['mode'], experiment=_voice_experiment())


def batch_key(event, group):
    """Устойчивый ключ штатного окна сборки."""
    return key([source_of(event), str(group)])


async def capture(adapter, event):
    """Опубликовать вход; при ошибке не оставлять финал в ожидании файла."""
    try:
        return await _capture(adapter, event)
    except BaseException:
        reserved = getattr(event, '_brai_preparation', None)
        if reserved is not None:
            reserved[2].set()
        raise


async def _capture(adapter, event):
    """Отдельный готовый файл уточняет ход сразу; настоящий альбом сохраняет сборку."""
    runner = getattr(adapter, 'gateway_runner', None)
    raw = getattr(event, 'raw_message', None)
    if (runner is None or not runner._is_user_authorized_for_source(event.source)
            or not getattr(event.source, 'user_id', None) or getattr(event.source, 'is_bot', False)
            or getattr(raw, 'sender_chat', None) or getattr(raw, 'business_connection_id', None)):
        raise FileError('FILES_NOT_AUTHORIZED')
    reservation = reserve_steer_input(runner, event)
    try:
        await accept_event(event, admit=False)
    except BaseException:
        if reservation is not None:
            reservation.set()
        await _notify_observer('observe_files', event, 'failed')
        raise
    await _notify_observer('observe_files', event, 'ready')
    if not getattr(event, '_brai_capture_leases', None) and event.metadata.get('_brai_artifacts'):
        refs = [item['file'] for item in event.metadata['_brai_artifacts']]
        lease = store().materialize(refs, ['capture', source_of(event), str(event.message_id)])
        await asyncio.to_thread(lease.__enter__)
        event._brai_capture_leases = [lease]
    key_for_source = getattr(runner, '_session_key_for_source', None)
    # Настоящий альбом сохраняет media_group_id и передаётся целым набором после сборки.
    if (callable(key_for_source) and not getattr(runner, '_draining', False)
            and not getattr(raw, 'media_group_id', None)):
        if await steer_active_input(runner, event, key_for_source(event.source)):
            event.metadata['_brai_steered'] = True
            accept = getattr(adapter, '_accept_update', None)
            if callable(accept):
                accept()
            return True
    return False


async def accept_event(event, admit=True):
    """Сохранить весь принятый состав и допустить только новые готовые элементы."""
    if not hasattr(event, '_brai_original_text'):
        event._brai_original_text = event.text or ''
    if admit:
        track_inbound(event)
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
    inputs = getattr(event, '_brai_identity_inputs', None)
    source = source_of(event)
    media_types = getattr(event, 'media_types', []) or []
    generation = getattr(event, '_brai_chat_generation', None)

    def audio_mime(index):
        mime = media_types[index] if index < len(media_types) else ''
        return mime if mime.startswith('audio/') else ''

    if refs is None and inputs:
        # AIDEV-NOTE: Ingress сохранил исходные message/attachment IDs до native album merge.
        # Прежние fixed-owner aliases и artifact metadata через эту границу не принимаются.
        if (not isinstance(inputs, list) or len(inputs) != len(paths)
                or any(not isinstance(item, dict) or item.get('path') != path
                       or not isinstance(item.get('itemId'), str) or not item['itemId']
                       for item, path in zip(inputs, paths))):
            raise FileError('INVALID_SOURCE')
        refs = []
        for position, item in enumerate(inputs):
            message_id, _, attachment_id = item['itemId'].rpartition(':')
            if message_id.isdecimal() and attachment_id.isdecimal():
                position = int(message_id) * 1000 + int(attachment_id)
            refs.append(await asyncio.to_thread(files.ingest, source, item['itemId'], item['path'],
                position, item.get('caption') or '', item.get('groupId') or str(event.message_id),
                audio_mime=audio_mime(len(refs)), chat_generation=generation))
        event.metadata['_brai_artifacts'] = refs
        with files.db() as db:
            route = {'chat_type': getattr(event.source, 'chat_type', 'dm'), 'profile': getattr(event.source, 'profile', None)}
            for gid in {item['groupId'] for item in refs}:
                db.execute('INSERT OR REPLACE INTO routes VALUES (?,?)', (gid, canonical(route)))
    if refs is None:
        msg = str(event.message_id or '')
        if not msg:
            raise FileError('SOURCE_MESSAGE_REQUIRED')
        group = str(getattr(getattr(event, 'raw_message', None), 'media_group_id', None) or event.metadata.get('_brai_photo_group') or msg)
        position = int(msg) if msg.isdecimal() else 0
        refs, failures, item_groups = [], [], []
        with files.db() as db:
            for index, path in enumerate(paths):
                identity = key([files.owner, source, msg + ':' + str(index)])
                known = db.execute('SELECT source FROM items WHERE identity=?', (identity,)).fetchone()
                item_group = str(json.loads(known['source']).get('sourceGroupId') or group) if known else group
                item_groups.append(item_group)
                gid = key([files.owner, source, item_group])
                db.execute('INSERT OR IGNORE INTO groups(identity) VALUES (?)', (gid,))
                db.execute('INSERT OR IGNORE INTO items VALUES (?,?,?,?,?,?,NULL,NULL)',
                           (identity, gid, canonical({**source, 'itemId': msg + ':' + str(index), 'messageId': msg,
                                      'attachmentId': str(index), 'sourceGroupId': item_group,
                                      'mediaGroupId': str(getattr(event.raw_message, 'media_group_id')) if getattr(getattr(event, 'raw_message', None), 'media_group_id', None) is not None else None}),
                            position * 1000 + index, event.text or '', path))
        if '_brai_photo_group' in event.metadata and len(set(item_groups)) == 1:
            event.metadata['_brai_photo_group'] = item_groups[0]
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
                            position * 1000 + index, event.text or '', item_groups[index],
                            audio_mime=audio_mime(index)))
            except Exception as error:
                failures.append(error)
        if failures:
            await _notify_observer('observe_files', event, 'failed', refs)
            event.media_urls = []
            event.metadata['fileSetStatus'] = 'incomplete'
            raise FileError('INCOMPLETE_FILE_SET') from None
        event.metadata['_brai_artifacts'] = refs
        with files.db() as db:
            route = {'chat_type': getattr(event.source, 'chat_type', 'dm'), 'profile': getattr(event.source, 'profile', None)}
            for gid in {item['groupId'] for item in refs}:
                db.execute('INSERT OR REPLACE INTO routes VALUES (?,?)', (gid, canonical(route)))
    retry = getattr(event, '_brai_input_delivery_id', None) if getattr(event, '_brai_voice_retry', False) else None
    prefix = ['voice-retry', retry] if retry else ['voice-file']
    event._brai_voice_operations = {item['localPath']: key([*prefix, item['itemId'], item['file']['artifactId']])
                                    for item in refs}
    event.media_urls = [item['localPath'] for item in refs]
    event._brai_audio_paths = {item['localPath'] for index, item in enumerate(refs)
                              if audio_mime(index) or item['file']['mimeType'].startswith('audio/')}
    if not admit:
        return True
    groups = list(dict.fromkeys(item['groupId'] for item in refs))
    accepted = [await asyncio.to_thread(files.admit, group, defer=True) for group in groups]
    repeat_admission = all(value['duplicate'] for value in accepted)
    if repeat_admission:
        if not getattr(event, '_brai_voice_retry', False):
            event.media_urls = []
            return False
        if not inputs or len(refs) != 1 or len(groups) != 1:
            raise FileError('INVALID_VOICE_RETRY')
        # AIDEV-NOTE: Только доверенный ingress разрешает новую обработку
        # уже принятого voice. Публикация и запись прежнего набора сохраняются.
        items = [{'file': refs[0]['file'], 'caption': inputs[0].get('caption') or '',
                  'source': {**source, 'itemId': inputs[0]['itemId'], 'audioMime': audio_mime(0)}}]
        event._brai_voice_retry = False
    else:
        items = [item for value in accepted for item in value['items']]
    lease = files.materialize([item['file'] for item in items], ['inbound', groups, str(uuid.uuid4())])
    copies = await asyncio.to_thread(lease.__enter__)
    previous_lease = getattr(event, '_brai_file_lease', None)
    event._brai_file_lease = lease
    if previous_lease is not None:
        previous_lease.__exit__(None, None, None)
    event._brai_voice_operations = {}
    for item, value in zip(items, copies):
        origin = item['source']
        identity = key([files.owner, {name: origin[name] for name in source}, origin['itemId']])
        event._brai_voice_operations[value['localPath']] = key([*prefix, identity, value['artifactId']])
    # Artifacts keeps its own detected MIME. A verified incoming audio label
    # survives FileStore recovery, including when the detected MIME is opaque.
    event._brai_audio_paths = {value['localPath'] for item, value in zip(items, copies)
                               if item['source'].get('audioMime') or value['mimeType'].startswith('audio/')}
    event.media_urls = [value['localPath'] for value in copies]
    event.media_types = [value['mimeType'] for value in copies]
    ticket = (_VOICE_RETRY_ADMISSION if repeat_admission
              else files.prepare_admission(source_of(event), str(event.message_id), accepted))
    attachments = [{'artifactId': item['file']['artifactId']} for item in items]
    _prepared_inbound.set((source_of(event), str(event.message_id), ticket, attachments))
    event.metadata['fileSets'] = [{key: value for key, value in item.items() if not key.startswith('_')} for item in accepted]
    if any(value.get('supplement') for value in accepted):
        event.text = '[Дополнение к прежнему набору; ранее обработанные элементы не повторяются.]\n' + (event.text or '')
    event.text = (event.text or '') + '\n' + '\n'.join('[artifactId=' + item['file']['artifactId'] + '] ' + item['caption'] for item in items)
    return True


class SteerText(str):
    """Нести проверенные inline-изображения вместе со строкой штатного steer."""

    def __new__(cls, text, images=(), admission=None):
        """Связать строку с проверенными изображениями и однократной фиксацией допуска."""
        value = super().__new__(cls, text)
        value.images, value.admission = tuple(images), admission
        return value

    def strip(self, chars=None):
        """Сохранить вложения при штатной нормализации steer."""
        return SteerText(super().strip(chars), self.images, self.admission)

    def __add__(self, other):
        """Не терять изображения при объединении последовательных уточнений."""
        if not isinstance(other, str):
            return NotImplemented
        return SteerText(str(self) + str(other), self.images + getattr(other, 'images', ()))

    def __radd__(self, other):
        """Поддержать добавление обычного текстового префикса к steer."""
        if not isinstance(other, str):
            return NotImplemented
        return SteerText(str(other) + str(self), getattr(other, 'images', ()) + self.images)


def steer_content(text, formatted):
    """Вернуть штатный маркер с изображениями только из проверенного файлового входа."""
    images = getattr(text, 'images', ())
    return [{'type': 'text', 'text': formatted}, *images] if images else formatted


def admit_steer(agent, text):
    """Под lock штатного steer согласовать приём с атомарной границей финала."""
    if getattr(agent, '_brai_steer_closed', False):
        return False
    admission = getattr(text, 'admission', None)
    if admission is not None:
        admission()
        text.admission = None
    return True


def dialogues_finish(agent, send, can_retry):
    """Отделить входы открытого хода от новых входов до записи финала в Диалоги."""
    turn = getattr(agent, '_brai_steer_turn', None)
    if turn is None:
        return send()
    with _steer_lock(turn), agent._pending_steer_lock:
        if agent._pending_steer or any(not ready.is_set() for ready in getattr(turn, '_brai_preparing_inputs', {}).values()):
            return json.dumps({'code': 'STEER_PENDING', 'applied': False,
                               'next_action': 'Обработай дополнение и снова запиши финал.'}, ensure_ascii=False)
        was_closed = getattr(agent, '_brai_steer_closed', False)
        agent._brai_steer_closed = True
    if was_closed:
        return send()
    may_reopen = False
    try:
        result = send()
        may_reopen = can_retry(result)
        return result
    finally:
        if may_reopen:
            with agent._pending_steer_lock:
                agent._brai_steer_closed = False


def continue_final_steer(agent, messages):
    """Учесть принятый до фиксации финала steer в том же цикле, не публикуя черновик."""
    if getattr(agent, '_brai_steer_turn', None) is None:
        return False
    turn = agent._brai_steer_turn
    while True:
        with agent._pending_steer_lock:
            if turn._brai_steer_generation is not agent._brai_steer_generation:
                return False
            preparing = tuple(getattr(turn, '_brai_preparing_inputs', {}).values())
            waiting = [item for item in preparing if not item.is_set()]
            if not waiting:
                turn._brai_preparing_inputs = {}
                pending = agent._pending_steer
                if not pending:
                    agent._brai_steer_closed = True
                    return False
                agent._pending_steer = None
                break
        if getattr(agent, '_interrupt_requested', False):
            return False
        # Ждём только уже принятый файловый вход этого хода, не завершая ответ раньше него.
        waiting[0].wait(0.2)
    from agent.prompt_builder import steer_user_row
    from agent.message_metadata import append_message
    append_message(messages, steer_user_row(pending))
    return True


def _steer_identity(source, message_id):
    return (str(getattr(source.platform, 'value', source.platform)), str(source.chat_id),
            str(source.thread_id or ''), str(source.user_id or ''), str(message_id))


def dialogues_input_text(ident, original, attachments=()):
    """Передать оригинал и подтверждённые ссылки для сохранения в Диалогах."""
    message = {'id': ident, 'text': original}
    if attachments:
        message['source'] = {'kind': 'telegram', 'attachments': list(attachments)}
    return 'Точное сообщение для записи в Диалоги (JSON):\n' + json.dumps(message, ensure_ascii=False)


def _steer_revision(event):
    """Сравнить последнюю редакцию без временных путей скачанных файлов."""
    refs = (getattr(event, 'metadata', None) or {}).get('_brai_artifacts', [])
    if getattr(event, 'media_urls', None) and not refs:
        # До публикации идентичность файла проверяет существующий FileStore.
        return None
    return canonical([event.text or '', [ref.get('file', ref)['artifactId'] for ref in refs]])


def _steer_lock(turn):
    import threading
    if not hasattr(turn, '_brai_steer_lock'):
        turn._brai_steer_lock = threading.RLock()
        turn._brai_steer_generation = object()
    return turn._brai_steer_lock


def active_steer_turn(runner, session_key):
    """Включить подготовку входа под guard адаптера в тот же пользовательский ход."""
    state = runner._peek_session_state(session_key)
    if state is None:
        return None
    turn = state.turn
    if turn.started_ts:
        return turn
    admission = getattr(turn, '_brai_adapter_admission', None)
    if admission is not None:
        adapter, guard = admission
        if getattr(adapter, '_active_sessions', {}).get(session_key) is guard:
            return turn
    return None


def reserve_steer_input(runner, event):
    """Удержать финал, пока уже принятый файл публикуется или собирается настоящий альбом."""
    import threading
    key_for_source = getattr(runner, '_session_key_for_source', None)
    if not callable(key_for_source) or not runner._is_user_authorized_for_source(event.source):
        return None
    turn = active_steer_turn(runner, key_for_source(event.source))
    if turn is None:
        return None
    with _steer_lock(turn):
        agent = getattr(turn, '_brai_steer_agent', None)
        with agent._pending_steer_lock if agent is not None else nullcontext():
            if agent is not None and getattr(agent, '_brai_steer_closed', False):
                return None
            group = getattr(getattr(event, 'raw_message', None), 'media_group_id', None)
            identity = (source_of(event)['sender'], str(group or event.message_id))
            preparing = getattr(turn, '_brai_preparing_inputs', {})
            ready = preparing.get(identity)
            if ready is None or ready.is_set():
                ready = threading.Event()
                preparing[identity] = ready
            turn._brai_preparing_inputs = preparing
            event._brai_preparation = (turn, turn._brai_steer_generation, ready)
            return ready


def finish_steer_preparation(event):
    """Снять ожидание файлового входа, отклонённого до передачи исполнителю."""
    reserved = getattr(event, '_brai_preparation', None)
    if reserved is not None:
        reserved[2].set()


def bind_steer_turn(agent, runner, ctx):
    """Связать ожидающие уточнения с исполнителем того же поколения хода."""
    if str(getattr(ctx.source.platform, 'value', ctx.source.platform)) != 'telegram':
        return
    state = runner._peek_session_state(ctx.session_key)
    generation = getattr(ctx, 'run_generation', None)
    if state is None or (generation is not None and not runner._is_session_run_current(ctx.session_key, generation)):
        return
    turn = state.turn
    with _steer_lock(turn):
        if turn.ctx is not None and turn.ctx is not ctx:
            clear_steer_turn(turn)
        # Native promotion публикует ctx лишь через polling; ранние входы принадлежат уже занятому ходу.
        turn.ctx, turn.agent = ctx, agent
        agent._brai_steer_closed = False
        agent._brai_steer_turn = turn
        agent._brai_steer_generation = turn._brai_steer_generation
        # Токены ещё не принятого финала не должны попадать в общий stream ledger.
        # Завершённые промежуточные сообщения сохраняют свой отдельный callback.
        agent.stream_delta_callback = None
        turn._brai_steer_agent = agent
        ids = getattr(turn, '_brai_input_ids', set())
        ids.add(_steer_identity(ctx.source, ctx.inbound_message_id))
        turn._brai_input_ids = ids
        revisions = getattr(turn, '_brai_steer_revisions', {})
        initial = getattr(turn, 'event', None) or getattr(turn, '_brai_adapter_event', None)
        if initial is not None:
            revision = _steer_revision(initial)
            if revision is not None:
                revisions.setdefault(_steer_identity(initial.source, initial.message_id), revision)
        turn._brai_steer_revisions = revisions
        pending, turn._brai_pending_steers = getattr(turn, '_brai_pending_steers', []), []
        for payload in pending:
            if not agent.steer(payload):
                raise FileError('STEER_INPUT_NOT_ACCEPTED')


def release_steer_inputs(agent):
    """Освободить временные копии уточнений после завершения текущего исполнителя."""
    turn = getattr(agent, '_brai_steer_turn', None)
    if turn is not None:
        with agent._pending_steer_lock:
            agent._brai_steer_closed = True
        with _steer_lock(turn):
            if getattr(turn, '_brai_steer_agent', None) is agent:
                events, turn._brai_steer_events = getattr(turn, '_brai_steer_events', []), []
                for event in events:
                    release_event(event)


def clear_steer_turn(turn):
    """Не переносить IDs и временные копии завершённого хода в следующий."""
    with _steer_lock(turn):
        for event in getattr(turn, '_brai_steer_events', []):
            release_event(event)
        for ready in getattr(turn, '_brai_preparing_inputs', {}).values():
            ready.set()
        turn._brai_preparing_inputs = {}
        turn._brai_steer_generation = object()
        turn._brai_steer_events = []
        turn._brai_pending_steers = []
        turn._brai_input_ids = set()
        turn._brai_steer_revisions = {}
        turn._brai_steer_agent = None
        turn._brai_adapter_admission = None
        turn._brai_adapter_event = None


_voice_transcription = ContextVar('brai_voice_transcription', default=None)


def is_managed_voice_provider(provider):
    return provider == 'brai_local_ai' and os.environ.get('BRAI_IDENTITY_MODE') == 'worker'


def voice_transcription_operation():
    return _voice_transcription.get()


async def transcribe_voice_once(event, path, transcribe, *providers):
    """Share one transcription of a clip throughout the life of its inbound event."""
    if event is None:
        return await transcribe(path, *providers)
    cache = getattr(event, '_brai_voice_transcription_tasks', None)
    if cache is None:
        cache = event._brai_voice_transcription_tasks = {}
    task = cache.get(path)
    if task is None:
        operation = getattr(event, '_brai_voice_operations', {}).get(path)
        token = _voice_transcription.set(operation)
        try:
            task = cache[path] = asyncio.create_task(transcribe(path, *providers))
        finally:
            _voice_transcription.reset(token)
    return await asyncio.shield(task)


async def steer_active_input(runner, event, session_key):
    """Передать авторизованный Telegram-вход текущему ходу вместо FIFO новых задач."""
    platform = str(getattr(event.source.platform, 'value', event.source.platform))
    if platform != 'telegram' or getattr(event, 'internal', False):
        return False
    if not runner._is_user_authorized_for_source(event.source):
        return False
    turn = active_steer_turn(runner, session_key)
    reserved = getattr(event, '_brai_preparation', None)
    if turn is None:
        if reserved is not None:
            finish_steer_preparation(event)
            release_event(event)
            return True  # Отменённая подготовка не создаёт новый ход после поздней публикации.
        return False
    with _steer_lock(turn):
        generation = turn._brai_steer_generation
        previous_agent = getattr(turn, '_brai_steer_agent', None)
    if reserved is not None and (reserved[0] is not turn or reserved[1] is not generation):
        reserved[2].set()
        release_event(event)
        return True  # Завершённый/остановленный ход не передаёт свой отложенный вход новому.
    identity, revision = _steer_identity(event.source, event.message_id), _steer_revision(event)
    with _steer_lock(turn):
        if revision is not None and getattr(turn, '_brai_steer_revisions', {}).get(identity) == revision:
            # Независимая защита от replay с потерянной/изменённой transport-квитанцией.
            event._gateway_accepted = True
            if reserved is not None:
                reserved[2].set()
            if not any(item is event for item in getattr(turn, '_brai_steer_events', [])):
                release_event(event)
            return True
    if not getattr(event, '_bot_loop_admitted', False):
        if not runner._admit_bot_message_for_source(event.source):
            finish_steer_preparation(event)
            release_event(event)
            return True
        event._bot_loop_admitted = True
    if not await accept_event(event):
        event._gateway_accepted = True
        release_event(event)
        if reserved is not None:
            reserved[2].set()
        return True  # Повтор уже принятого набора не становится новым поручением.
    text = event.text or ''
    original = getattr(event, '_brai_original_text', text)
    audio_paths = getattr(runner, '_pending_event_audio_paths', lambda _: [])(event)
    if audio_paths:
        text = await runner._prepare_busy_steer_text(event)
    images = []
    if event.media_urls:
        paths = [path for path, mime in zip(event.media_urls, event.media_types) if mime.startswith('image/')]
        if paths:
            from agent.image_routing import build_native_content_parts
            parts, skipped = build_native_content_parts('', paths)
            if skipped:
                raise FileError('NATIVE_IMAGE_INPUT_UNAVAILABLE')
            images = [part for part in parts if part.get('type') == 'image_url']
        # Документы остаются доступными модели по owner-bound artifactId.
    if not text.strip() and not images:
        return False
    if getattr(getattr(event, 'raw_message', None), 'edit_date', None):
        text = '[Правка сообщения ' + str(event.message_id) + ': новая редакция заменяет прежнюю.]\n' + text
    origin = runner._steer_text_with_origin(text or '[Изображения пользователя]', event)
    if os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1' and event.message_id is not None:
        header, separator, _ = origin.partition('\n\n')
        try:
            message_id = json.loads(header.split('\n', 2)[1])['message_id']
        except (IndexError, KeyError, TypeError, ValueError):
            message_id = event.message_id
        prepared = _prepared_inbound.get()
        attachments = (prepared[3] if prepared and prepared[:2] == (source_of(event), str(event.message_id))
                       and len(prepared)>3 else ())
        envelope = dialogues_input_text(str(message_id), original, attachments)
        origin = header + separator + envelope + ('\n\n' + text if text != original else '')
    prepared = _prepared_inbound.get()
    ticket = prepared[2] if prepared and prepared[:2] == (source_of(event), str(event.message_id)) else None
    payload = SteerText(origin, images, lambda: commit_inbound(event.source, event.message_id, ticket))
    with _steer_lock(turn):
        current = runner._peek_session_state(session_key)
        if current is None or current.turn is not turn or turn._brai_steer_generation is not generation:
            if audio_paths:
                finish_steer_preparation(event)
                event._brai_preparation = None
                route_current = getattr(runner, '_brai_consent_route_current', None)
                if not getattr(previous_agent, '_interrupt_requested', False) and (
                        route_current is None or route_current(event)):
                    # AIDEV-NOTE: Обычный финал прежнего хода передаёт тот же
                    # объект дальше. Native queue сохранит STT и lease входа.
                    return False
                event._gateway_accepted = True
            release_event(event)
            if reserved is not None:
                reserved[2].set()
            return True
        agent = getattr(turn, '_brai_steer_agent', None)
        if agent is not None:
            if not agent.steer(payload):
                finish_steer_preparation(event)
                event._brai_preparation = None
                return False  # Финал уже зафиксирован; это следующий пользовательский ход.
        else:
            pending = getattr(turn, '_brai_pending_steers', [])
            pending.append(payload)
            turn._brai_pending_steers = pending
        events = getattr(turn, '_brai_steer_events', [])
        events.append(event)
        turn._brai_steer_events = events
        ids = getattr(turn, '_brai_input_ids', set())
        ids.add(_steer_identity(event.source, event.message_id))
        turn._brai_input_ids = ids
        if revision is not None:
            revisions = getattr(turn, '_brai_steer_revisions', {})
            revisions[identity] = revision
            turn._brai_steer_revisions = revisions
        # AIDEV-NOTE: Worker подтверждает durable input по этому флагу. Без него
        # уже переданный steer объявлялся непринятым и повторялся supervisor.
        event._gateway_accepted = True
        if reserved is not None:
            reserved[2].set()
    return True


def active_telegram_edit(adapter, message):
    """Разрешить повторный dispatch правки только сообщения незавершённого хода."""
    runner = getattr(adapter, 'gateway_runner', None)
    if runner is None:
        return False
    from gateway.platforms.event import MessageType
    # AIDEV-NOTE: Auth source называет форум forum, native input — group; ключ обязан совпасть с dispatch.
    source = adapter._build_message_event(message, MessageType.TEXT).source
    turn = active_steer_turn(runner, runner._session_key_for_source(source))
    if turn is None:
        return False
    with _steer_lock(turn):
        agent = getattr(turn, '_brai_steer_agent', None)
        if agent is not None and getattr(agent, '_brai_steer_closed', False):
            return False
        identity = _steer_identity(source, message.message_id)
        initial = getattr(turn, 'event', None) or getattr(turn, '_brai_adapter_event', None)
        return (identity in getattr(turn, '_brai_input_ids', set()) or
                (initial is not None and identity == _steer_identity(initial.source, initial.message_id)))


def track_inbound(event):
    """Освободить также новый объект события после авторизованного plugin rewrite."""
    cleanup = _event_cleanup.get()
    if cleanup is not None and id(event) not in cleanup[1]:
        cleanup[1].add(id(event))
        cleanup[0].callback(release_event, event)


def commit_inbound(source, message_id, ticket=None):
    """Зафиксировать набор только непосредственно перед запуском агента."""
    if ticket is _VOICE_RETRY_ADMISSION:
        return False
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
    attachments_token = _inbound_attachments.set(prepared[3] if ticket and len(prepared)>3 else ())
    # Только внутреннее кодирование уже принятого набора; API не задаёт это разрешение.
    images_token = _inline_images.set(frozenset(inline_images) if ticket else frozenset())
    try:
        yield
    finally:
        _inline_images.reset(images_token)
        _inbound_attachments.reset(attachments_token)
        _inbound.reset(token)


async def wait_prior_media(adapter, event):
    """Дождаться более ранних файлов того же Telegram-маршрута перед текстом."""
    message_id = str(getattr(event, 'message_id', '') or '')
    if not message_id.isascii() or not message_id.isdecimal():
        return
    route = source_of(event)
    while True:
        prior = []
        for pending_name, task_name in (('_pending_photo_batches', '_pending_photo_batch_tasks'),
                                        ('_media_group_events', '_media_group_tasks')):
            pending = getattr(adapter, pending_name, {})
            tasks = getattr(adapter, task_name, {})
            for name, item in list(pending.items()):
                item_id = str(getattr(item, 'message_id', '') or '')
                if (item_id.isascii() and item_id.isdecimal() and int(item_id) < int(message_id)
                        and source_of(item) == route):
                    task = tasks.get(name)
                    if task is None:
                        raise FileError('PRIOR_MEDIA_UNAVAILABLE')
                    prior.append(task)
        if not prior:
            return
        try:
            await asyncio.shield(prior[0])
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise
            await asyncio.sleep(0)
        except Exception:
            raise FileError('PRIOR_MEDIA_UNAVAILABLE') from None


def prepare_photo_batch(adapter, event, message):
    """Связать одиночную фотографию с ещё открытым набором до сохранения файла."""
    batch = adapter._photo_batch_key(event, message)
    previous = adapter._pending_photo_batches.get(batch)
    event.metadata = dict(getattr(event, 'metadata', None) or {})
    event.metadata['_brai_photo_group'] = str((previous.metadata or {}).get('_brai_photo_group') or previous.message_id) if previous is not None else str(event.message_id)
    return batch


def merge_events(existing, event):
    """Сохранить ID и подписи при объединении сообщений канала."""
    old = list((existing.metadata or {}).get('_brai_artifacts', []))
    new = list((event.metadata or {}).get('_brai_artifacts', []))
    existing.metadata = {**(existing.metadata or {}), '_brai_artifacts': old + new}
    existing._brai_voice_operations = {**getattr(event, '_brai_voice_operations', {}),
                                        **getattr(existing, '_brai_voice_operations', {})}
    existing._brai_capture_leases = (getattr(existing, '_brai_capture_leases', [])
                                    + getattr(event, '_brai_capture_leases', []))
    event._brai_capture_leases = []


@contextmanager
def inbound_events(event):
    """Освободить исходное и переписанные plugin hook события при любом исходе хода."""
    if event is None:
        yield
        return
    with ExitStack() as cleanup:
        cleanup.callback(release_event, event)
        token = _event_cleanup.set((cleanup, {id(event)}))
        try:
            yield
        finally:
            _event_cleanup.reset(token)


def release_event(event):
    """Освободить входные копии после обработки и доставки."""
    lease = getattr(event, '_brai_file_lease', None)
    if (lease is None and not getattr(event, '_brai_capture_leases', [])
            and not getattr(event, 'media_urls', [])
            and not (getattr(event, 'metadata', None) or {}).get('_brai_artifacts')):
        return
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
    inbound = _inbound.get()
    session = str(getattr(agent, 'session_id', '') or '')
    source = inbound[0] if inbound is not None else _conversation_source.get()
    route = None
    if source is not None and session and getattr(source, 'user_id', None):
        # The gateway supplies this identity after authentication; model arguments cannot select it.
        event = type('ConversationSource', (), {'source': source})()
        route = source_of(event)
        store().bind_workspace(operation, ['conversation', route, session])
    try:
        agent._brai_workspace = str(store().workspace(operation))
        task = str(task_id or getattr(agent, 'session_id', '') or operation)
        with store().db() as db:
            db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task, operation))
    except BaseException:
        with store().db() as db:
            db.execute('DELETE FROM workspace_bindings WHERE operation=?', (operation,))
        raise
    token = _operation.set(operation)
    previous_candidate = _reply_mode_candidate.get()
    if previous_candidate is not getattr(agent, '_brai_reply_mode_candidate', None):
        previous_candidate = None
    candidate = None
    if inbound is not None and route and route['platform'] == 'telegram':
        actor = getattr(source, '_brai_actor_id', None) or route['sender']
        candidate = {'source': {**route, 'sender': str(actor)}, 'mode': None, 'previous': previous_candidate}
    if candidate is not None:
        agent._brai_reply_mode_candidate = candidate
    mode_token = _reply_mode_candidate.set(candidate)
    stream = getattr(agent, 'stream_delta_callback', None)
    interim = getattr(agent, 'interim_assistant_callback', None)
    filtered_stream = _filtered_reply_stream(stream) if candidate is not None and callable(stream) else None
    filtered_interim = None
    if candidate is not None and callable(interim):
        def filtered_interim(text, **kwargs):
            visible = _VIDEO_NOTE_MARKER.sub('', _REPLY_ONCE.sub('', _REPLY_MODE.sub('', text)))
            if visible.strip():
                return interim(visible, **kwargs)
        agent.interim_assistant_callback = filtered_interim
    if filtered_stream is not None:
        agent.stream_delta_callback = filtered_stream
    admission_token = source_token = None
    previous_prompt = getattr(agent, 'ephemeral_system_prompt', None)
    completed = False
    try:
        shared_context = ''
        effective_prompt = previous_prompt
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            from identity.instructions import system_context, without_legacy_dialogues
            shared_context = system_context()
            effective_prompt = without_legacy_dialogues(previous_prompt)
        # API-only context: keep the user's persisted text and the shared process environment unchanged.
        mode_prompt = ''
        if candidate is not None:
            mode = _effective_reply_mode(candidate['source'])
            candidate['current'] = mode
            descriptions = {'voice': 'обычное голосовое', 'off': 'только текст',
                            'video_note': ('текст и кружочек с апельсином'
                                           if _voice_experiment() else 'кружочек с апельсином')}
            current = descriptions.get(mode, 'определяется историей беседы')
            mode_prompt = (
                '\n\n[Формат ответа текущей беседы] Сейчас: ' + current + '. '
                'При явной просьбе изменить формат включи в итог отдельную строку '
                '[[brai_reply_mode:voice]], [[brai_reply_mode:video_note]] или '
                '[[brai_reply_mode:off]] для обычного голосового, кружочка или только текста. '
                'Для разового образца другого формата не меняй режим; добавь вместо неё '
                '[[brai_reply_once:voice]] или [[brai_reply_once:video_note]]. '
                'Без просьбы о смене режима или разовом образце не добавляй эти строки. '
                'Формат действует до следующей явной просьбы. '
                'Наличие текста определяй по правилам голосового режима и просьбе пользователя. '
                'Для кружочка используй [[audio_as_video_note]] перед MEDIA со звуком. '
                'Правила озвучки находятся в policies/LOCAL_VOICE.md из системного INDEX.md.\n')
            if _voice_experiment():
                mode_prompt += (
                    'Озвучивай короткий ответ целиком. Для ответа дольше 60 секунд в кружочке '
                    'или трёх минут в голосовом отправь полный текст и одну озвученную выжимку '
                    'даже в режиме только голоса. Выжимка для кружочка около 50–60 секунд. '
                    'Для короткого ответа в режиме только голоса оберни полный текст в '
                    '[[brai_voice_only_text]] и [[/brai_voice_only_text]] перед маркером аудио. '
                    'Текст из этого блока отправится, если озвучка недоступна. '
                    'При сбое озвучки всё равно отправь полный текст.\n')
        agent.ephemeral_system_prompt = shared_context + (effective_prompt or '') + mode_prompt + (
            '\n\n[Trusted file runtime for this turn] Your temporary working and output directory is '
            + agent._brai_workspace + '. Use relative output paths, or this exact directory. '
            'For terminal omit workdir or use this directory; TMPDIR is set there by the runtime. '
            'This turn-specific directory supersedes generic working/scratch paths in older context. '
            'Publish finished files through the file tools. Do not read another agent workspace.')
        prepared = input_text(user_message, operation)
        archive_input = getattr(source, '_brai_dialogues_input', None) if inbound is not None else None
        if archive_input is not None and os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1':
            ident, original = archive_input
            marker = dialogues_input_text(ident, original, _inbound_attachments.get())
            if isinstance(prepared, str):
                prepared = marker + ('\n\n' + prepared if prepared != original else '')
            elif isinstance(prepared, list):
                prepared = [{'type': 'text', 'text': marker}, *prepared]
        inbound = _inbound.get()
        if inbound is not None:
            commit_inbound(*inbound)
        # AIDEV-NOTE: Worker наследует владельца, но не право повторного приёма.
        admission_token = _inbound.set(None)
        source_token = _conversation_source.set(source)
        agent._brai_delegation_turn_started = time.time()
        yield prepared
        completed = True
    finally:
        agent.ephemeral_system_prompt = previous_prompt
        if filtered_stream is not None and getattr(agent, 'stream_delta_callback', None) is filtered_stream:
            agent.stream_delta_callback = stream
        if filtered_interim is not None and getattr(agent, 'interim_assistant_callback', None) is filtered_interim:
            agent.interim_assistant_callback = interim
        _reply_mode_candidate.reset(mode_token)
        if not completed and candidate is not None and getattr(agent, '_brai_reply_mode_candidate', None) is candidate:
            if candidate['previous'] is None:
                del agent._brai_reply_mode_candidate
            else:
                agent._brai_reply_mode_candidate = candidate['previous']
        if source_token is not None:
            _conversation_source.reset(source_token)
        if admission_token is not None:
            _inbound.reset(admission_token)
        release_steer_inputs(agent)
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
        with store().db() as db:
            if not db.execute('SELECT 1 FROM jobs WHERE operation=?', (operation,)).fetchone():
                db.execute('DELETE FROM workspace_bindings WHERE operation=?', (operation,))


def operator_assignment_requires_foreground():
    """Check the personal Hermes turn context at the tool execution boundary."""
    if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
        from identity.scope import operator_assignment
        return operator_assignment.get() is not None
    return False


def before_tool(name, args, **ids):
    """Проверить чтения и направить изменения и terminal во временный cwd."""
    args = dict(args)
    if operator_assignment_requires_foreground() and (
            name in {'cronjob_manage', 'delegate_task', 'process_manage', 'send_message'}
            or name == 'terminal' and any(args.get(key) for key in
                ('background', 'notify_on_complete', 'watch_patterns', 'heartbeat', 'persist_on_release'))):
        raise FileError('OPERATOR_ASSIGNMENT_REQUIRES_FOREGROUND_TOOLS')
    operation = operation_for(ids)
    workspace = store().workspace(operation)
    # Native skill resolvers own their package-relative paths and their write policy.
    # Anchoring file_path to the conversation workspace breaks linked references and edits.
    if name in {'skill_view', 'skill_manage'}:
        return args
    if name == 'terminal':
        requested = Path(args.get('workdir') or workspace).absolute()
        if not requested.resolve().is_relative_to(workspace) and not any(requested.resolve().is_relative_to(p) for p in store().service_roots):
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
        from .runtime_reads import source, snapshot
        selected = source(path)
        if selected is not None:
            if name in {'write_file', 'patch'}:
                raise FileError('TEMPORARY_OUTPUT_REQUIRED')
            if not path.is_dir():
                args[field] = snapshot(selected, workspace)
                continue
        if any(resolved.is_relative_to(root) for root in store().service_roots):
            continue
        if name in {'write_file', 'patch'}:
            if not resolved.is_relative_to(workspace):
                raise FileError('TEMPORARY_OUTPUT_REQUIRED')
            args[field] = str(resolved)
        elif resolved.is_relative_to(store().work):
            if not resolved.is_relative_to(workspace):
                raise FileError('FILE_SCOPE_DENIED')
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


def _publish_tool_output(name, path, identity, operation):
    """Перенести точный native выход в workspace, сохранив прежний RPC публикации."""
    source_path = Path(path)
    roots = {
        'image_generate': ('cache/generated/images',),
        'video_generate': ('cache/generated/videos',),
        'text_to_speech': ('cache/audio', 'audio_cache'),
        'browser_screenshot': ('cache/screenshots', 'browser_screenshots'),
        'browser_vision': ('cache/screenshots', 'browser_screenshots'),
        'computer_use': ('cache/images', 'image_cache'),
    }
    # Старые экземпляры уже разрешают эти каталоги; их маршрут сохраняется.
    if any(source_path.resolve().is_relative_to(root) for root in store().read_roots):
        return resolve(path, identity)
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home())
    root = next((home / part for part in roots.get(name, ()) if source_path.parent == home / part), None)
    if root is None:
        return resolve(path, identity)  # Обычный guard отклонит неизвестный источник.
    from .identity import copy_fd
    from .runtime_reads import open_source
    source = open_source(root, source_path, os.getuid())
    folder = None
    try:
        folder = Path(tempfile.mkdtemp(prefix='generated-', dir=store().workspace(operation)))
        staged = folder / source_path.name
        target = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            copy_fd(source, target)
        finally:
            os.close(target)
    except BaseException:
        if folder is not None:
            shutil.rmtree(folder)
        raise
    finally:
        os.close(source)
    # AIDEV-NOTE: При неизвестном исходе публикации snapshot нужен штатному recovery.
    published = resolve(str(staged), identity)
    try:
        shutil.rmtree(folder)
    except OSError:
        logging.getLogger(__name__).warning('BRAI_GENERATED_OUTPUT_CLEANUP_FAILED')
    return published


def after_tool(name, args, result, **ids):
    """Публиковать явные выходы генераторов, не сканируя промежуточные каталоги."""
    if not isinstance(result, (str, dict)) or name not in {'image_generate', 'text_to_speech', 'video_generate', 'browser_screenshot', 'browser_vision', 'computer_use', 'terminal', 'process'}:
        return result
    try:
        data = json.loads(result) if isinstance(result, str) else result
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
    outputs = {}

    def publish(path, field):
        if path not in outputs:
            outputs[path] = _publish_tool_output(name, path, ['output', operation, field, path], operation[0])
        return outputs[path]

    def visit(value):
        if isinstance(value, dict):
            changed = {k: visit(v) for k, v in value.items()}
            for field in ('path', 'file_path', 'image_path', 'audio_path', 'video_path', 'output_path', 'image', 'host_image', 'agent_visible_image', 'video', 'screenshot_path', 'image_url'):
                path = value.get(field)
                if isinstance(path, str) and (path in outputs or Path(path).is_file()):
                    published = publish(path, field)
                    changed[field] = published['localPath']
                    changed['artifactId'] = published['artifactId']
            paths = value.get('file_paths')
            if isinstance(paths, list):
                changed['file_paths'] = [publish(path, 'file_paths')['localPath']
                    if isinstance(path, str) and (path in outputs or Path(path).is_file()) else path for path in paths]
            return changed
        return [visit(item) for item in value] if isinstance(value, list) else value
    changed = visit(data)

    def references(value):
        if isinstance(value, dict):
            for field in (('media_tag', 'text_summary', 'summary', 'text') if name == 'computer_use' else ('media_tag', 'text_summary')):
                if isinstance(value.get(field), str):
                    for path, published in sorted(outputs.items(), key=lambda item: len(item[0]), reverse=True):
                        value[field] = value[field].replace(path, published['localPath'])
            for item in value.values():
                references(item)
        elif isinstance(value, list):
            for item in value:
                references(item)

    references(changed)
    return canonical(changed).replace("MEDIA:", r"MEDIA\u003a") if isinstance(result, str) else changed


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


def _public_response_text(text):
    """Сохранить последствия отказа без внутренних путей и технических кодов."""
    if not isinstance(text, str):
        return text
    # Runtime verifier keeps the failure visible without exposing local paths or tool diagnostics.
    text = _MUTATION_FOOTER.sub(
        'Некоторые попытки изменить файлы не удались. Проверьте нужный результат.', text)
    if _TECHNICAL_FAILURE.search(text):
        logging.getLogger(__name__).warning('BRAI_USER_RESPONSE_TECHNICAL_FAILURE')
        text = 'Не удалось полностью выполнить запрос. Попробуйте ещё раз.'
    return text


def final_text(text, operation):
    """Подготовить весь набор, сохранив ответ при ошибке вложения."""
    if not isinstance(text, str):
        return text
    text = _public_response_text(text)
    candidate = _reply_mode_candidate.get()
    limit_speech = candidate is not None and _voice_experiment()
    fallback = []
    if limit_speech:
        def preserve_text(match):
            fallback.append(match.group(1).strip())
            return ''
        text = active_sub(_VOICE_ONLY_TEXT, preserve_text, text)
    try:
        def select_mode(match):
            candidate = _reply_mode_candidate.get()
            if candidate is not None:
                mode = match.group(1)
                if candidate['mode'] is not None and candidate['mode'] != mode:
                    candidate['mode'] = None
                    raise FileError('CONFLICTING_REPLY_MODES')
                candidate['mode'] = mode
            return ''
        text = active_sub(_REPLY_MODE, select_mode, text)
        candidate = _reply_mode_candidate.get()
        once = []
        def select_once(match):
            once.append(match.group(1))
            return ''
        text = active_sub(_REPLY_ONCE, select_once, text)
        if len(set(once)) > 1 or (once and candidate is not None and candidate['mode'] is not None):
            if candidate is not None:
                candidate['mode'] = None
            raise FileError('CONFLICTING_REPLY_MODES')
        effective_mode = (once[0] if once else (candidate['mode'] or candidate.get('current'))
                          if candidate is not None else None)
        if effective_mode == 'video_note':
            if limit_speech:
                text = active_sub(_VOICE_LINE, lambda match: match.group(0).replace(
                    '[[audio_as_voice]]', '[[audio_as_video_note]]', 1), text)
            else:
                def as_video_notes(match):
                    return ''.join('[[audio_as_video_note]]\n' + line
                                   for line in match.group('files').splitlines(keepends=True))
                text = active_sub(_VOICE_BLOCK, as_video_notes, text)
        return _stage_final_text(text, operation, limit_speech=limit_speech, fallback=fallback)
    except (FileError, FileNotFoundError, json.JSONDecodeError) as error:
        reference = uuid.uuid4().hex[:16]
        logging.getLogger(__name__).warning('BRAI_ATTACHMENT_PREPARATION_FAILED reference=%s kind=%s',
                                            reference, type(error).__name__)
        if limit_speech and isinstance(error, FileError) and str(error).startswith(('REPLY_AUDIO_', 'VIDEO_NOTE_')):
            remaining = active_sub(_VOICE_LINE, lambda match: '', text)
            remaining = active_sub(_VIDEO_NOTE, lambda match: '', remaining)
            remaining = active_sub(_VIDEO_NOTE_MARKER, lambda match: '', remaining)
            try:
                prepared = _stage_final_text(remaining, operation, fallback=fallback)
                return prepared.rstrip() + f'\n\n{_ATTACHMENT_FAILURE_NOTE}{reference}'
            except (FileError, FileNotFoundError, json.JSONDecodeError):
                pass
        for pattern in (_SET, _VIDEO_NOTE, _VIDEO_NOTE_MARKER, _VOICE_MARKER, _REPLY_MODE, _REPLY_ONCE, _MEDIA):
            text = active_sub(pattern, lambda match: '', text)
        text = active_sub(_DESCRIPTOR, lambda match: match.group('label') if (
            match.group('angle') or match.group('plain')).startswith(('/', 'artifact:')) else match.group(0), text)
        if fallback:
            text = '\n\n'.join(filter(None, (*fallback, text.strip())))
        return text.rstrip() + f'\n\n{_ATTACHMENT_FAILURE_NOTE}{reference}'


def _stage_final_text(text, operation, *, limit_speech=False, fallback=()):
    """Создать отдельные временные копии для исходящего набора."""
    files, replacements, items = store(), [], []
    spoken_paths, spoken_items = set(), set()
    if limit_speech:
        video_count = 0
        def record_voice(match):
            spoken_paths.add(next(value for value in match.groups() if value is not None))
            return match.group(0)

        def count_video(match):
            nonlocal video_count
            video_count += 1
            return match.group(0)
        active_sub(_VOICE_LINE, record_voice, text)
        active_sub(_VIDEO_NOTE, count_video, text)
        if video_count > 1:
            raise FileError('REPLY_AUDIO_LIMIT')

    explicit = []
    active_sub(_SET, lambda match: explicit.append(match) or match.group(0), text)
    if len(explicit) > 1:
        raise FileError('ONE_FILE_SET_PER_MESSAGE')
    mode = 'files'
    if explicit:
        match = explicit[0]
        data = json.loads(match.group(1))
        if (not isinstance(data, dict) or set(data) != {'mode', 'items'}
                or data['mode'] not in ('files', 'album') or not isinstance(data['items'], list) or not data['items']):
            raise FileError('INVALID_FILE_SET')
        mode = data['mode']
        for item in data['items']:
            if (not isinstance(item, dict) or set(item) - {'artifactId', 'caption', 'presentation'}
                    or not isinstance(item.get('artifactId'), str) or not isinstance(item.get('caption', ''), str)
                    or ('presentation' in item and item['presentation'] not in
                        ('photo', 'video', 'audio', 'document', 'voice', 'animation'))):
                raise FileError('INVALID_FILE_SET')
            with files.lock('cache'):
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
        with files.lock('cache'):
            try:
                value = (files.fetch(path.split(':', 1)[1].lstrip('/')) if path.startswith('artifact:')
                         else files.resolve(local_path(path), ['final', operation, path]))
            except (FileError, FileNotFoundError, json.JSONDecodeError) as error:
                if path in spoken_paths:
                    raise FileError('REPLY_AUDIO_UNAVAILABLE') from error
                raise
            index = len(items)
            kind = presentation(value)
            if path in spoken_paths:
                if not value['mimeType'].startswith('audio/'):
                    raise FileError('REPLY_AUDIO_INVALID')
                spoken_items.add(index)
            items.append({'file': files.checked(value), 'caption': caption, 'presentation': kind})
        replacements.append((match.start(), match.end(), [index]))
        return match.group(0)
    def add_video_note(match):
        if explicit:
            raise FileError('MIXED_FILE_SET_FORMAT')
        from .video_note import render_video_notes
        path = next(value for value in match.groups() if value is not None)
        with files.lock('cache'):
            try:
                audio = (files.fetch(path.split(':', 1)[1].lstrip('/')) if path.startswith('artifact:')
                         else files.resolve(local_path(path), ['final', operation, path]))
            except (FileError, FileNotFoundError, json.JSONDecodeError) as error:
                if limit_speech:
                    raise FileError('REPLY_AUDIO_UNAVAILABLE') from error
                raise
        try:
            videos = (render_video_notes(files, audio, operation, single=True) if limit_speech
                      else render_video_notes(files, audio, operation))
        except FileMaterializationError as error:
            if limit_speech:
                raise FileError('REPLY_AUDIO_UNAVAILABLE') from error
            raise
        indexes = []
        for video in videos:
            indexes.append(len(items))
            if limit_speech:
                spoken_items.add(len(items))
            items.append({'file': files.checked(video), 'caption': '', 'presentation': 'video_note'})
        replacements.append((match.start(), match.end(), indexes))
        return ' ' * (match.end() - match.start())

    masked = active_sub(_VIDEO_NOTE, add_video_note, masked)
    def invalid_video_note(_match):
        raise FileError('VIDEO_NOTE_INVALID_MARKER')
    active_sub(_VIDEO_NOTE_MARKER, invalid_video_note, masked)
    active_sub(_MEDIA, lambda match: add(match, next(v for v in match.groups() if v is not None)), masked)
    def descriptor(match):
        path = match.group('angle') or match.group('plain')
        if not path.startswith('artifact:') and (not path.startswith('/') or any(Path(path).resolve().is_relative_to(root) for root in files.service_roots)):
            return match.group(0)
        if path.startswith('/'):
            from .runtime_reads import source
            if source(Path(path)) is not None:
                return match.group(0)
        label = re.sub(r'\\(.)', r'\1', match.group('label'))
        return add(match, path, label)
    active_sub(_DESCRIPTOR, descriptor, masked)
    if len(spoken_items) > 1:
        raise FileError('REPLY_AUDIO_LIMIT')
    if not items:
        return '\n\n'.join(filter(None, (*fallback, text.strip()))) if fallback else text
    order = [index for _, _, indexes in sorted(replacements) for index in indexes]
    positions = {old: new for new, old in enumerate(order)}
    items = [items[index] for index in order]
    replacements = [(start, end, [positions[index] for index in indexes])
                    for start, end, indexes in replacements]
    # Явный набор и обычный MEDIA могут содержать те же файлы в одном ходе,
    # но не должны перезаписывать правила доставки друг друга.
    identity = key([operation, items, 'explicit', mode]) if explicit else key([operation, items])
    scope = ['egress', identity]
    workspace = files.cache / '.delivery' / identity
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    if workspace.resolve() != workspace:
        raise FileError('UNSAFE_DELIVERY_WORKSPACE')
    paths = []
    with ExitStack() as leases:
        try:
            values = leases.enter_context(files.materialize([item['file'] for item in items], scope))
        except FileMaterializationError as error:
            if any(item['file']['artifactId'] == error.artifact_id and old_index in spoken_items
                   for item, old_index in zip(items, order)):
                raise FileError('REPLY_AUDIO_UNAVAILABLE') from error
            raise
        for index, (item, value) in enumerate(zip(items, values)):
            if order[index] in spoken_items and item['presentation'] != 'video_note':
                from identity.audio_parts import audio_info
                try:
                    seconds, _ = audio_info(Path(value['localPath']))
                except ValueError as error:
                    raise FileError('REPLY_AUDIO_INVALID') from error
                if seconds is None or seconds > _VOICE_REPLY_SECONDS:
                    raise FileError('REPLY_AUDIO_LIMIT')
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
                   (identity, paths_key(paths), canonical({'mode': mode, 'items': items, 'scope': scope,
                                                           'explicit': bool(explicit)})))
    for start, end, indexes in sorted(replacements, reverse=True):
        text = text[:start] + '\n'.join('MEDIA:' + json.dumps(paths[index], ensure_ascii=False) for index in indexes) + text[end:]
    if fallback and not spoken_items:
        return '\n\n'.join(filter(None, (*fallback, text.strip())))
    return text


def history_text(text):
    """В истории сохранять ID вложения вместо временной копии для доставки."""
    def stable(match):
        path = next(value for value in match.groups() if value is not None)
        files = store()
        if Path(path).parent.parent != files.cache / '.delivery':
            return match.group(0)
        ref = reference_metadata(path)
        return 'MEDIA:artifact:' + ref['artifactId'] if ref else match.group(0)

    return active_sub(_MEDIA, stable, text) if isinstance(text, str) else text


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
    with files.lock('cache'):
        values = [files.resolve(path, ['delivery', _operation.get(), path]) for path in paths]
        return [{'file': files.checked(value), 'caption': (captions or [''] * len(paths))[index],
                 'presentation': presentation(value)} for index, value in enumerate(values)], 'files'


def explicit_output_set(paths):
    """Сохранить mode и порядок явного набора; старые записи читаются совместимо."""
    paths = [local_path(path) for path in paths]
    with store().db() as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='output_sets'").fetchone()
        row = db.execute('SELECT payload FROM output_sets WHERE paths=?', (paths_key(paths),)).fetchone() if exists else None
    return bool(row and json.loads(row['payload']).get('explicit', True))


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


def telegram_format(adapter, text):
    """Форматировать подпись тем же Telegram adapter, который обслуживает обычный ответ."""
    formatter = getattr(adapter, 'format_message', None)
    if formatter is None:
        from plugins.platforms.telegram.adapter import TelegramAdapter
        formatter = lambda value: TelegramAdapter.format_message(adapter, value)
    return formatter(text)


def telegram_target(adapter, chat_id, reply_to, metadata, *, exact=False, require_reply=True):
    target = {'chat_id': int(chat_id)}
    routing = getattr(adapter, '_media_send_kwargs', None)
    if callable(routing):
        _, target = routing(chat_id, reply_to, metadata)
    else:
        thread = (metadata or {}).get('thread_id') or (metadata or {}).get('message_thread_id')
        if thread is not None:
            target['message_thread_id'] = int(thread)
        if reply_to:
            target['reply_to_message_id'] = int(reply_to)
    if exact:
        expected = (metadata or {}).get('thread_id') or (metadata or {}).get('message_thread_id') or (metadata or {}).get('direct_messages_topic_id')
        actual = target.get('message_thread_id') or target.get('direct_messages_topic_id')
        if not require_reply and str(chat_id).startswith('-') and str(expected) == '1':
            # Telegram represents the General forum topic by omitting its thread ID.
            expected = None
            if str(actual) == '1':
                actual = None
        if (str(target['chat_id']) != str(chat_id) or str(actual or '') != str(expected or '')
                or (require_reply and not reply_to)
                or (reply_to and str(target.get('reply_to_message_id')) != str(reply_to))):
            raise PermissionError('Operator assignment Telegram route changed')
        if reply_to:
            target['allow_sending_without_reply'] = False
    return target


def verify_telegram_target(message, target, *, general_forum=None):
    """Require the Bot API receipt to name the same chat and explicit topic."""
    chat_id = getattr(message, 'chat_id', None)
    topic = target.get('message_thread_id') or target.get('direct_messages_topic_id')
    actual = (getattr(message, 'message_thread_id', None)
              or getattr(getattr(message, 'direct_messages_topic', None), 'topic_id', None))
    if topic is None and actual == 1 and general_forum is not False:
        actual = None
    if chat_id != target['chat_id'] or actual != topic:
        raise FileError('DELIVERY_ROUTE_UNCONFIRMED')


async def telegram_sender(adapter, chat_id, metadata, kind, items, fallback, reply_to=None, *, strict=False,
                          before_send=None, before_retry=None, topic_anchor=None, require_reply=True):
    """Deliver media once, with an anchored retry after a confirmed topic refusal."""
    from telegram import InputMediaPhoto, InputMediaVideo, InputMediaAudio, InputMediaDocument
    from contextlib import ExitStack
    bot = adapter._bot
    target = telegram_target(adapter, chat_id, reply_to, metadata, exact=strict, require_reply=require_reply)
    retry = getattr(adapter, '_brai_send_with_private_topic_retry', None)
    private_topic = callable(retry) and adapter._brai_private_topic_route(metadata, target)
    anchored = (private_topic and before_retry is not None and topic_anchor is not None
                and str(target.get('reply_to_message_id') or '') == str(topic_anchor))

    async def send(wire, *, batch=False):
        if not private_topic:
            return await wire(target)
        if not anchored:
            return await retry(wire, metadata, target, None, batch=batch)
        trusted = {**metadata, 'telegram_reply_to_message_id': topic_anchor}
        return await retry(wire, trusted, target, topic_anchor, batch=batch, before_retry=before_retry)

    captions = []
    for item in items:
        caption = item.get('caption', '')
        formatted = telegram_format(adapter, caption) if caption else ''
        if text_units(formatted) > 1024:
            if strict:
                # The approval accompanies the attachment in the same API call.
                raise FileError('TELEGRAM_CAPTION_TOO_LONG')
            if text_units(formatted) <= 3500:
                async def send_caption(options):
                    return await bot.send_message(**options, text=formatted, parse_mode='MarkdownV2')

                notice = await send(send_caption)
                message_id = getattr(notice, 'message_id', None)
            else:
                formatter = getattr(adapter, '_rich_message_payload', None)
                if not callable(formatter):
                    raise FileError('RICH_MESSAGE_UNAVAILABLE')
                rich = formatter(caption, skip_entity_detection=True)
                content = rich.get('markdown', '')
                if not isinstance(content, str) or not content:
                    raise FileError('RICH_MESSAGE_UNAVAILABLE')
                if len(content) > 32768 or len(content.encode('utf-8')) > 128 * 1024:
                    sender = getattr(adapter, 'send_brai_long_document', None)
                    if not callable(sender):
                        raise FileError('RICH_MESSAGE_TOO_LONG')
                    receipt = await sender(int(chat_id), caption, None, metadata or {},
                                           'caption:' + key([str(chat_id), target, caption]))
                    message_id = receipt.get('message_id') if isinstance(receipt, dict) else None
                else:
                    async def send_rich_caption(options):
                        values = {**options, 'rich_message': rich}
                        anchor = values.pop('reply_to_message_id', None)
                        allow_missing = values.pop('allow_sending_without_reply', None)
                        if anchor is not None:
                            values['reply_parameters'] = {'message_id': anchor}
                            if allow_missing is not None:
                                values['reply_parameters']['allow_sending_without_reply'] = allow_missing
                        return await bot.do_api_request('sendRichMessage', api_kwargs=values)

                    response = await send(send_rich_caption)
                    message_id = (response.get('message_id') or (response.get('result') or {}).get('message_id')) if isinstance(response, dict) else getattr(response, 'message_id', None)
            if not message_id:
                raise FileError('DELIVERY_UNKNOWN')
            captions.append(None)
        else:
            captions.append(formatted or None)
    classes = {'photo': InputMediaPhoto, 'video': InputMediaVideo, 'audio': InputMediaAudio, 'document': InputMediaDocument}
    with ExitStack() as stack:
        sources = []
        for item in items:
            file = item.get('readHandle')
            if file is None:
                file = stack.enter_context(open(item['localPath'], 'rb'))
            sources.append(file)
        positions = [file.tell() for file in sources] if anchored else []
        album = kind == 'album'
        if any(item['presentation'] == 'video_note' for item in items):
            if album or len(items) != 1:
                raise FileError('VIDEO_NOTE_INVALID_OUTPUT')
            from .video_note import validate_video_note_stream
            await validate_video_note_stream(sources[0])

        deferred = []

        async def send_media(options):
            if options is not target:
                for file, position in zip(sources, positions):
                    file.seek(position)
            media = []
            for item, file, caption in zip(items, sources, captions):
                view = item['presentation']
                if view in classes:
                    media.append(classes[view](media=file, caption=caption, parse_mode='MarkdownV2' if caption else None))
                else:
                    from types import SimpleNamespace
                    media.append(SimpleNamespace(media=file, caption=caption, parse_mode='MarkdownV2' if caption else None))
            if options is target and before_send is not None:
                try:
                    await before_send()
                except Exception as error:
                    from identity.reply_outbox import DeliveryDeferred
                    if isinstance(error, DeliveryDeferred):
                        deferred.append(error)
                    raise
            if album:
                return await bot.send_media_group(**options, media=media)
            field = items[0]['presentation']
            if field == 'video_note':
                from .video_note import VIDEO_NOTE_SIZE
                return await bot.send_video_note(**options, video_note=media[0].media, length=VIDEO_NOTE_SIZE)
            return await getattr(bot, 'send_' + field)(**options, **{field: media[0].media},
                                                      caption=media[0].caption,
                                                      parse_mode='MarkdownV2' if media[0].caption else None)

        try:
            result = await send(send_media, batch=album)
        except Exception:
            if deferred:
                raise deferred[0]
            raise
        if not album:
            result = [result]
    if not album and items[0]['presentation'] == 'video_note' and not getattr(result[0], 'video_note', None):
        raise FileError('VIDEO_NOTE_DELIVERY_UNCONFIRMED')
    if strict:
        expected = (metadata or {}).get('thread_id') or (metadata or {}).get('message_thread_id') or (metadata or {}).get('direct_messages_topic_id')
        general_forum = (str(chat_id).startswith('-') and str(expected) == '1') if not require_reply else None
        for message in result:
            verify_telegram_target(message, target, general_forum=general_forum)
    return [getattr(message, 'message_id', None) for message in result]


async def send_set(adapter, chat_id, items, mode, metadata=None, identity=None):
    """Проверить весь набор и сохранить квитанции для каждого элемента."""
    from gateway.platforms.base import SendResult
    platform = str(getattr(adapter.platform, 'value', adapter.platform))
    set_ids = {item['_setId'] for item in items if '_setId' in item}
    items = [{key: value for key, value in item.items() if key != '_setId'} for item in items]
    explicit = identity or (metadata or {}).get('brai_delivery_id')
    fingerprint = key([store().owner, platform, str(chat_id), metadata or {}, items, mode]) if not explicit else None
    async def sender(kind, prepared, fallback):
        if platform == 'telegram':
            if getattr(adapter, 'file_delivery_via_ipc', False):
                return await adapter.send_file_set(chat_id, prepared, kind, fallback, metadata)
            return await telegram_sender(adapter, chat_id, metadata, kind, prepared, fallback)
        receipt, token = [], _sending.set(True)
        try:
            for item in prepared:
                method, field = {'photo': ('send_image_file', 'image_path'), 'video': ('send_video', 'video_path'),
                                 'video_note': ('send_video', 'video_path'),
                                 'audio': ('send_voice', 'audio_path'), 'voice': ('send_voice', 'audio_path'), 'animation': ('send_animation', 'animation_url'), 'document': ('send_document', 'file_path')}[item['presentation']]
                target = getattr(adapter, method)
                arguments = {'chat_id': chat_id, field: item['localPath'], 'metadata': metadata}
                if item['presentation'] == 'voice':
                    arguments['is_voice'] = True
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
    if platform == 'telegram' and _telegram_observer is not None:
        from types import SimpleNamespace
        receipts = result.get('receipts', [])
        remaining = list(enumerate(items))
        for receipt in receipts:
            match = next(((index, item) for index, item in remaining if item['file']['artifactId'] == receipt['artifactId']), None)
            if match is None:
                continue
            remaining.remove(match)
            index, item = match
            await _notify_observer('observe_send', chat_id, metadata, item.get('caption', ''),
                SimpleNamespace(success=True, message_id=receipt['messageId']), [item['file']], f'{identity}:{index}')
        if result['state'] != 'sent':
            for index, item in remaining:
                status = 'failed' if result['state'] == 'failed' else 'pending'
                await _notify_observer('observe_send', chat_id, metadata, item.get('caption', ''),
                    SimpleNamespace(success=False, message_id=None, raw_response={'status': status}), [item['file']], f'{identity}:{index}')
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
    """Связать ранний вход с ходом и охватить прямые отправки вне final response."""
    start = getattr(adapter, '_start_session_processing', None)
    release_guard = getattr(adapter, '_release_session_guard', None)
    if start is not None and release_guard is not None:
        @wraps(start)
        def start_admitted_turn(event, session_key, **kwargs):
            started = start(event, session_key, **kwargs)
            runner = getattr(adapter, 'gateway_runner', None)
            platform = str(getattr(event.source.platform, 'value', event.source.platform))
            if (started and runner is not None and platform == 'telegram'
                    and not getattr(event, 'internal', False) and not event.get_command()
                    and runner._is_user_authorized_for_source(event.source)):
                turn = runner._session_state(session_key).turn
                if not turn.started_ts:
                    # AIDEV-NOTE: Guard уже занят, а _hm_admit_event ещё может ждать файлы/плагины.
                    # Отметка ставится синхронно, до первого шага фоновой задачи.
                    clear_steer_turn(turn)
                    turn._brai_adapter_admission = (adapter, adapter._active_sessions[session_key])
                    turn._brai_adapter_event = event
            return started
        adapter._start_session_processing = start_admitted_turn

        @wraps(release_guard)
        def release_admitted_turn(session_key, **kwargs):
            guard = getattr(adapter, '_active_sessions', {}).get(session_key)
            release_guard(session_key, **kwargs)
            runner = getattr(adapter, 'gateway_runner', None)
            state = runner._peek_session_state(session_key) if runner is not None else None
            if (state is not None and not state.turn.started_ts
                    and getattr(state.turn, '_brai_adapter_admission', None) == (adapter, guard)
                    and getattr(adapter, '_active_sessions', {}).get(session_key) is not guard):
                clear_steer_turn(state.turn)
        adapter._release_session_guard = release_admitted_turn
    while_active = getattr(adapter, '_handle_message_while_active', None)
    if while_active is not None:
        @wraps(while_active)
        async def defer_recovered_input(event, session_key):
            if not (getattr(event, 'metadata', None) or {}).get('recovered'):
                return await while_active(event, session_key)
            # Keep restored files out of the pending slot holding new user text.
            task = getattr(adapter, '_session_tasks', {}).get(session_key)
            if task is not None:
                waiting = getattr(adapter, '_brai_recovery_waiting', None)
                if waiting is None:
                    waiting = adapter._brai_recovery_waiting = set()
                if task not in waiting:
                    waiting.add(task)
                    def finished(done):
                        waiting.discard(done)
                        schedule_recovery(adapter)
                    task.add_done_callback(finished)
            elif getattr(adapter, '_brai_recovery_delay', None) is None:
                def retry():
                    adapter._brai_recovery_delay = None
                    schedule_recovery(adapter)
                adapter._brai_recovery_delay = asyncio.get_running_loop().call_later(1, retry)
            await asyncio.to_thread(release_event, event)
            return None
        adapter._handle_message_while_active = defer_recovered_input
    notify_error = getattr(adapter, '_notify_turn_error', None)
    if notify_error is not None:
        @wraps(notify_error)
        async def notify_file_error(event, error):
            # A restored attachment belongs to its old turn, not the current text reply.
            if (getattr(event, 'metadata', None) or {}).get('recovered') and isinstance(error, FileError):
                code = str(error)
                logging.getLogger(__name__).warning('BRAI_FILES_RECOVERED_INPUT_FAILED code=%s',
                    code if re.fullmatch(r'[A-Z_]{1,80}', code) else 'FILE_OPERATION_FAILED')
                await _notify_observer('observe_files', event, 'failed',
                    (getattr(event, 'metadata', None) or {}).get('_brai_artifacts', []))
                return None
            if isinstance(error, FileError):
                from gateway.platforms.base import _thread_metadata_for_event
                metadata = _thread_metadata_for_event(event)
                code = str(error)
                logging.getLogger(__name__).warning('BRAI_FILE_DELIVERY_FAILED code=%s',
                    code if re.fullmatch(r'[A-Z_]{1,80}', code) else 'FILE_OPERATION_FAILED')
                try:
                    with adapter._media_delivery_scope(event.source):
                        content = adapter.warning_text('Не удалось отправить файл.', 'Не удалось отправить файл.',
                            logical_platform=event.source.platform, chat_id=event.source.chat_id, metadata=metadata)
                    if content is not None:
                        await adapter.send(chat_id=event.source.chat_id, content=content, metadata=metadata)
                except Exception:
                    logging.getLogger(__name__).warning('BRAI_FILE_ERROR_NOTICE_FAILED')
                return metadata
            return await notify_error(event, error)
        adapter._notify_turn_error = notify_file_error
    send = getattr(adapter, 'send', None)
    if send is not None:
        @wraps(send)
        async def observe_text(*args, **kwargs):
            bound = inspect.signature(send).bind(*args, **kwargs)
            bound.apply_defaults()
            result = await send(*args, **kwargs)
            if str(getattr(adapter.platform, 'value', adapter.platform)) == 'telegram' and _telegram_observer is not None:
                data = bound.arguments
                response = getattr(result, 'raw_response', None)
                identity = response.get('delivery_id') if isinstance(response, dict) else None
                await _notify_observer('observe_send', data.get('chat_id'), data.get('metadata'),
                    data.get('content') or '', result, identity=str(identity or uuid.uuid4()))
            return result
        adapter.send = observe_text
    # AIDEV-NOTE: Личный адаптер публикует файлы и передаёт descriptor в ingress.
    # Повторная Telegram-обёртка здесь потребовала бы отсутствующий bot/token.
    if getattr(adapter, 'file_delivery_via_ipc', False):
        return
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
                rows = [row for row in rows if not db.execute('SELECT 1 FROM legacy_recovery_review WHERE identity=?', (row['identity'],)).fetchone()]
            previous = json.loads(group['admitted']) if group['admitted'] else []
            pending = [row for row in rows if row['identity'] not in previous]
            if not pending or any(not row['artifact'] for row in rows):
                continue
            origins = [json.loads(row['source']) for row in pending]
            generation = origins[0].get('chatGeneration', 0)
            if any(item.get('chatGeneration', 0) != generation for item in origins):
                continue
            origin = origins[0]
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
            event = MessageEvent(text=pending[0]['caption'], message_type=MessageType.DOCUMENT, source=source,
                                 message_id=origin['itemId'].rsplit(':', 1)[0],
                                 media_urls=[item['localPath'] for item in refs],
                                 media_types=[json.loads(row['source']).get('audioMime') or item['file']['mimeType']
                                              for row, item in zip(rows, refs)],
                                 metadata={'_brai_artifacts': refs, 'recovered': True})
            event._brai_chat_generation = generation
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


def reference_metadata(reference):
    """Прочитать сохранённое проверенное имя; текущий доступ проверит fetch/read."""
    value = str(reference)
    identifier = value.split(':', 1)[1].lstrip('/') if value.startswith('artifact:') else value
    if re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', identifier):
        identifier = str(uuid.UUID(identifier))
        with store().db() as db:
            row = db.execute('SELECT artifact,ref FROM aliases WHERE artifact=? LIMIT 1', (identifier,)).fetchone()
    elif Path(value).is_absolute():
        with store().db() as db:
            row = db.execute('SELECT artifact,ref FROM aliases WHERE path=?', (value,)).fetchone()
    else:
        return None
    if row is None:
        return None
    result = json.loads(row['ref'])
    if (result.get('artifactId') != row['artifact']
            or not isinstance(result.get('filename'), str)
            or not result['filename'] or Path(result['filename']).name != result['filename']):
        raise FileError('INVALID_FILE_RESULT')
    return {key: result[key] for key in ('artifactId', 'filename', 'mimeType') if key in result}


def guard_write(path, task_id):
    """Закрыть также прямые вызовы write/patch в обход model_tools."""
    base = Path(workspace_for(task_id))
    value = Path(path).expanduser()
    value = value if value.is_absolute() else base / value
    from .runtime_reads import source
    if source(value) is not None:
        raise FileError('TEMPORARY_OUTPUT_REQUIRED')
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
    allowed = {'photo': {'image/jpeg', 'image/png'}, 'video': {'video/mp4'}, 'video_note': {'video/mp4'},
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
        if kind == 'video_note' and item.get('caption'):
            raise FileError('VIDEO_NOTE_CAPTION_UNSUPPORTED')


def result_envelope(result, agent=None):
    """CLI/API и дочерний агент получают стабильные IDs и состав, а не один временный path."""
    candidate = getattr(agent, '_brai_reply_mode_candidate', None)
    if candidate is not None:
        if candidate['previous'] is None:
            del agent._brai_reply_mode_candidate
        else:
            agent._brai_reply_mode_candidate = candidate['previous']
        guardrail = result.get('guardrail') if isinstance(result, dict) else None
        if (candidate['mode'] is not None and isinstance(result, dict)
                and isinstance(result.get('final_response'), str) and result['final_response'].strip()
                and (_voice_experiment() or not re.search(
                    r'(?m)^' + re.escape(_ATTACHMENT_FAILURE_NOTE) + r'[0-9a-f]{16}$', result['final_response']))
                and not any(result.get(name) for name in ('failed', 'partial', 'error', 'interrupted'))
                and result.get('completed') is not False
                and not (isinstance(guardrail, dict) and guardrail.get('code') == 'brai_review_unavailable')):
            if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
                result = {**result, '_brai_reply_mode': {'source': candidate['source'], 'mode': candidate['mode']}}
            else:
                store().set_reply_mode(candidate['source'], candidate['mode'])
    if not isinstance(result, dict):
        return result
    response = result.get('final_response', '')
    if not isinstance(response, str):
        return result
    # The engine appends its verifier footer after the earlier output transform.
    cleaned = _public_response_text(response)
    if cleaned != response:
        response = cleaned
        result = {**result, 'final_response': response}
    if re.search(r"(?m)^" + re.escape(_ATTACHMENT_FAILURE_NOTE) + r"[0-9a-f]{16}$", response):
        result = {**result, 'brai_attachment_preparation_failed': True}
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
    if (getattr(event, 'metadata', None) or {}).get('_brai_steered'):
        return False
    if not getattr(event, 'media_urls', None) and not (getattr(event, 'metadata', None) or {}).get('_brai_artifacts'):
        return True
    runner = getattr(adapter, 'gateway_runner', None)
    if runner is None or not runner._is_user_authorized_for_source(event.source):
        finish_steer_preparation(event)
        return False
    if (getattr(event, 'metadata', None) or {}).get('recovered'):
        recovery_allowed = getattr(runner, '_brai_identity_recovery_allowed', None)
        generation_current = getattr(runner, '_brai_consent_route_current', None)
        return ((recovery_allowed is None or recovery_allowed(event.source))
                and (generation_current is None or generation_current(event)))
    if str(getattr(event.source.platform, 'value', event.source.platform)) == 'telegram':
        admit = getattr(runner, '_admit_bot_message_for_source', None)
        if callable(admit) and not getattr(event, '_bot_loop_admitted', False):
            if not admit(event.source):
                finish_steer_preparation(event)
                return False
            event._bot_loop_admitted = True
        return not await capture(adapter, event)
    await accept_event(event, admit=False)
    return True
