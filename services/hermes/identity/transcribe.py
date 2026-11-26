# ABOUTME: Направляет command STT личного Hermes в сервис Transcription через broker.
# ABOUTME: Публикует только собственное аудио и получает результат по квитанции сервиса.
"""Голосовой вход с владельцем из SO_PEERCRED, без общего Transcription bearer."""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import sqlite3
import sys
import tempfile
import time
import uuid

from .audio_parts import PART_SECONDS, audio_info, audio_parts
from .tool_client import broker_call
from .ipc import safe_failure

logger = logging.getLogger(__name__)

AUDIO_TYPES = {'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mpeg'}
MAX_TRANSCRIPT_BYTES = 1_048_576
SINGLE_TIMEOUT = 180
PART_TIMEOUT = 900
TERMINAL_CODES = {'DEADLINE_EXCEEDED', 'DEPENDENCY_UNAVAILABLE', 'MODEL_UNAVAILABLE',
                  'MODEL_CATALOG_UNAVAILABLE', 'ARTIFACT_OWNER_MISMATCH', 'ARTIFACT_NOT_READY'}


def _transcribe_part(source, model, call, timeout, *, allow_silence=False, progress=None, index=None):
    if (not source.is_absolute()
            or not isinstance(model, dict) or set(model) != {'modelId', 'revision', 'profileId'}
            or any(not isinstance(v, str) or not v.strip() for v in model.values())
            or not 0 < timeout <= PART_TIMEOUT):
        raise ValueError('INVALID_ARGUMENT')
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or not info.st_size:
        raise ValueError('INVALID_AUDIO')
    started = time.monotonic()
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=timeout)).isoformat()
    request_key = None
    request_id = None
    saved = None
    if progress is not None:
        progress.execute('INSERT OR IGNORE INTO parts (part,key,deadline) VALUES(?,?,?)',
                         (index, str(uuid.uuid4()), deadline))
        saved = progress.execute('SELECT key,deadline,artifact,request,text FROM parts WHERE part=?',
                                 (index,)).fetchone()
        if saved['text'] is not None:
            return saved['text']
        request_key, deadline, request_id = saved['key'], saved['deadline'], saved['request']

    def log_failure(reason, stage, method, error_type):
        logger.warning('identity_stt_failed %s', json.dumps({
            'clientIdempotencyKey': request_key, 'requestId': request_id, 'method': method,
            'elapsedMs': max(0, int((time.monotonic() - started) * 1000)),
            'errorType': error_type, 'reason': reason, 'stage': stage,
        }, sort_keys=True))

    def seconds_left():
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError('DEADLINE_EXCEEDED')
        return remaining

    def invoke(method, params):
        remaining = seconds_left()
        try:
            return call(method, params, timeout=remaining)
        except Exception as error:
            data = getattr(error, 'diagnostic', None)
            diagnostic = (safe_failure(**{k: data.get(k) for k in ('reason', 'stage')})
                if isinstance(data, dict) else safe_failure(
                    reason='FORBIDDEN' if isinstance(error, PermissionError) else
                    'DEADLINE_EXCEEDED' if isinstance(error, TimeoutError) else 'INTERNAL'))
            log_failure(diagnostic['reason'], diagnostic['stage'], method, type(error).__name__)
            raise

    # AIDEV-NOTE: Артефакт может быть явно запрошен повторно после утраты
    # результата. Идентификатор файла сам по себе не является ID задания.
    request_key = request_key or str(uuid.uuid4())
    aid = saved['artifact'] if saved is not None else None
    if aid is None:
        aid = _publish_audio_input(source, invoke, request_key)
        if progress is not None:
            progress.execute('UPDATE parts SET artifact=? WHERE part=?', (aid, index))

    def transcription(action, args):
        result = invoke('tools.call', {'name': 'transcription_' + action, 'args': args})
        if not isinstance(result, dict):
            raise ValueError('INVALID_TRANSCRIPTION_RESULT')
        return result

    submission = {'clientIdempotencyKey': request_key, 'audioArtifactId': aid,
                  'requestedModel': {'route': 'local', 'selection': 'required', 'modelId': model['modelId']},
                  'deadlineAt': deadline}
    status = (transcription('request_get', {'requestId': request_id}) if request_id is not None else
              transcription('request_submit', submission))
    while True:
        record = status.get('request')
        if not isinstance(record, dict) or record.get('requestedModel') != submission['requestedModel']:
            raise ValueError('INVALID_TRANSCRIPTION_REQUEST')
        current_id = record.get('requestId')
        if (not isinstance(current_id, str) or str(uuid.UUID(current_id)) != current_id
                or request_id is not None and current_id != request_id):
            raise ValueError('INVALID_TRANSCRIPTION_REQUEST')
        request_id = current_id
        if progress is not None and saved['request'] is None:
            progress.execute('UPDATE parts SET request=? WHERE part=?', (request_id, index))
            saved = {'request': request_id}
        state = record.get('taskState')
        if state == 'succeeded':
            break
        if state not in ('accepted', 'dispatching', 'running'):
            reason = {'failed': 'TRANSCRIPTION_FAILED', 'outcome_unknown': 'OUTCOME_UNKNOWN',
                      'cancelled': 'CANCELLED'}.get(state, 'INVALID_UPSTREAM_RESPONSE')
            code = record.get('errorCode')
            if state == 'failed' and isinstance(code, str) and code in TERMINAL_CODES:
                reason = code
            log_failure(reason, 'transcription', 'request.get', 'TerminalRequest')
            raise ValueError('TRANSCRIPTION_REQUEST_NOT_COMPLETED')
        if record.get('actualModel') is not None and record['actualModel'] != model:
            raise ValueError('TRANSCRIPTION_MODEL_MISMATCH')
        time.sleep(min(1, seconds_left()))
        status = transcription('request_get', {'requestId': request_id})
    delivery = transcription('result_get', {'requestId': request_id})
    result = delivery.get('result')
    if delivery.get('state') in ('lost', 'expired', 'not_ready', 'delivery_unknown'):
        log_failure('RESULT_' + delivery['state'].upper(), 'transcription', 'result.get', 'UnavailableResult')
    if (delivery.get('state') != 'available' or not isinstance(result, dict)
            or result.get('requestId') != request_id or result.get('actualModel') != model
            or not isinstance(result.get('text'), str)):
        raise ValueError('INVALID_TRANSCRIPTION_RESULT')
    text = result['text']
    if (not allow_silence and not text.strip()) or len(text.encode('utf-8')) > MAX_TRANSCRIPT_BYTES:
        raise ValueError('INVALID_TRANSCRIPT')
    if time.monotonic() - started >= timeout:
        raise TimeoutError('DEADLINE_EXCEEDED')
    if progress is not None:
        progress.execute('UPDATE parts SET text=? WHERE part=?', (text, index))
    return text


def _publish_audio_input(source, invoke, request_key):
    cached_id = source.parent.name
    try:
        cached = (str(uuid.UUID(cached_id)) == cached_id and
                  source.parent.parent == Path(os.environ.get('HERMES_HOME', '')) / 'results')
    except ValueError:
        cached = False
    # Native ingest уже опубликовал голосовое. Локальный путь сам не подтверждает владение.
    published = (invoke('files.fetch', {'artifactId': cached_id}) if cached else
                 invoke('files.publish', {'path': str(source), 'requestId': 'hermes-stt:' + request_key}))
    aid = published.get('artifactId')
    if (not isinstance(aid, str) or str(uuid.UUID(aid)) != aid or published.get('mimeType') not in AUDIO_TYPES
            or cached and (aid != cached_id or published.get('localPath') != str(source))):
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    return aid


def _source_stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextmanager
def _audio_progress(home, source, output, model, operation_id, call):
    """Pin one invocation and its completed segments across process and service restarts."""
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        original = _source_stamp(os.fstat(stream.fileno()))
        content = hashlib.file_digest(stream, 'sha256').hexdigest()
        if original != _source_stamp(os.fstat(stream.fileno())):
            raise ValueError('TRANSCRIPTION_SOURCE_CHANGED')
    path_binding = None if operation_id is not None else str(source.resolve())
    folder = home / 'workspace' / '.stt-progress'
    folder.mkdir(mode=0o700, exist_ok=True)
    meta = folder.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
        raise PermissionError('INVALID_TRANSCRIPTION_PROGRESS')
    scope = ['ingress', operation_id] if operation_id is not None else ['output', str(output.resolve())]
    path = folder / (hashlib.sha256(json.dumps(scope).encode()).hexdigest() + '.sqlite3')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_nlink != 1 or meta.st_mode & 0o077:
            raise PermissionError('INVALID_TRANSCRIPTION_PROGRESS')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with closing(sqlite3.connect(path, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE IF NOT EXISTS job (fingerprint TEXT NOT NULL, result TEXT, model TEXT)')
            use_default = model is None
            if use_default and 'model' not in {column['name'] for column in db.execute('PRAGMA table_info(job)')}:
                db.execute('ALTER TABLE job ADD COLUMN model TEXT')
            job = db.execute('SELECT * FROM job').fetchone()
            if use_default:
                if job is not None and job['model'] is not None:
                    model = json.loads(job['model'])
                else:
                    response = call('tools.call', {'name': 'transcription_settings_get', 'args': {}})
                    model = response['settings']['defaultLocalModel']
                    if model is None:
                        raise ValueError('MODEL_UNAVAILABLE')
            binding = json.dumps([path_binding, content, model], sort_keys=True).encode()
            fingerprint = hashlib.sha256(binding).hexdigest()
            if job is None:
                if use_default:
                    db.execute('INSERT INTO job (fingerprint,model) VALUES(?,?)', (fingerprint, json.dumps(model)))
                else:
                    db.execute('INSERT INTO job (fingerprint) VALUES(?)', (fingerprint,))
            elif job['fingerprint'] != fingerprint:
                raise ValueError('TRANSCRIPTION_OUTPUT_BOUND_TO_ANOTHER_INPUT')
            elif use_default and job['model'] is None:
                db.execute('UPDATE job SET model=?', (json.dumps(model),))
            db.execute('''CREATE TABLE IF NOT EXISTS parts (
                part INTEGER PRIMARY KEY, key TEXT NOT NULL, deadline TEXT NOT NULL,
                artifact TEXT, request TEXT, text TEXT)''')
            yield db, path, original, model
    finally:
        os.close(fd)


def _write_output(output, text):
    # File link publishes complete bytes without replacing a prior output or symlink.
    fd, scratch = tempfile.mkstemp(prefix='.stt-result-', dir=output.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(scratch, output)
    finally:
        Path(scratch).unlink()


def _checked_output(output_path):
    output = Path(output_path)
    if not output.is_absolute():
        raise ValueError('INVALID_ARGUMENT')
    if output.exists() or output.is_symlink():
        raise ValueError('OUTPUT_EXISTS')
    return output


def transcribe_file(input_path, output_path, model, *, call=broker_call, timeout=SINGLE_TIMEOUT):
    """Создать новый UTF-8 output после одной попытки распознавания."""
    output = _checked_output(output_path)
    _write_output(output, _transcribe_part(Path(input_path), model, call, timeout))


def _transcribe_segments(home, source, duration, original, model, call, progress):
    # AIDEV-NOTE: PrivateTmp worker недоступен broker. Workspace доступен
    # только владельцу, а broker публикует собственную копию каждой части.
    transcripts, size = [], 0
    with tempfile.TemporaryDirectory(prefix='.stt-', dir=home / 'workspace') as folder:
        with closing(audio_parts(source, Path(folder), duration)) as parts:
            for index, part in enumerate(parts, start=1):
                if index == 1 and original != _source_stamp(source.lstat()):
                    raise ValueError('TRANSCRIPTION_SOURCE_CHANGED')
                # Native command provider ждёт прогресс; речь и пути не пишутся.
                print(f'HERMES_IDENTITY_STT_PART {index}', flush=True)
                text = _transcribe_part(part, model, call, PART_TIMEOUT, allow_silence=True,
                                        progress=progress, index=index).strip()
                if not text:
                    continue
                size += len(text.encode('utf-8')) + bool(transcripts)
                if size > MAX_TRANSCRIPT_BYTES:
                    raise ValueError('INVALID_TRANSCRIPT')
                transcripts.append(text)
    if not transcripts:
        raise ValueError('INVALID_TRANSCRIPT')
    return '\n'.join(transcripts)


def transcribe_audio(input_path, output_path, model, *, call=broker_call, operation_id=None):
    """Распознать один аудиофайл и передать результат лишь после всех частей."""
    output = _checked_output(output_path)
    source = Path(input_path)
    if not source.is_absolute() or not stat.S_ISREG(source.lstat().st_mode):
        raise ValueError('INVALID_AUDIO')
    if operation_id is not None and (not isinstance(operation_id, str) or not re.fullmatch('[a-f0-9]{64}', operation_id)):
        raise ValueError('INVALID_TRANSCRIPTION_OPERATION')
    duration, directly_supported = audio_info(source)
    short = directly_supported and duration <= PART_SECONDS
    if short and operation_id is None and model is not None:
        transcribe_file(source, output, model, call=call)
        return
    home = Path(os.environ['HERMES_HOME'])
    if not home.is_absolute():
        raise ValueError('INVALID_ARGUMENT')
    with _audio_progress(home, source, output, model, operation_id, call) as (progress, checkpoint, original, model):
        _checked_output(output)
        text = progress.execute('SELECT result FROM job').fetchone()['result']
        if text is None:
            if short:
                if original != _source_stamp(source.lstat()):
                    raise ValueError('TRANSCRIPTION_SOURCE_CHANGED')
                text = _transcribe_part(source, model, call, SINGLE_TIMEOUT, progress=progress, index=1)
            else:
                text = _transcribe_segments(home, source, duration, original, model, call, progress)
            progress.execute('BEGIN')
            progress.execute('UPDATE job SET result=?', (text,))
            progress.execute('DELETE FROM parts')
            progress.execute('COMMIT')
        _write_output(output, text)
        if operation_id is None:
            checkpoint.unlink()


def main():
    """Use the admitted selector or the owner’s Transcription default."""
    parser = argparse.ArgumentParser()
    for name in ('input', 'output'):
        parser.add_argument('--' + name, required=True)
    for name in ('model-id', 'revision', 'profile-id'):
        parser.add_argument('--' + name)
    parser.add_argument('--operation-id')
    args = parser.parse_args()
    supplied = args.model_id, args.revision, args.profile_id
    if any(value is not None for value in supplied) and not all(supplied):
        parser.error('--model-id, --revision and --profile-id must be provided together')
    try:
        model = dict(zip(('modelId', 'revision', 'profileId'), supplied)) if args.model_id is not None else None
        transcribe_audio(args.input, args.output, model, operation_id=args.operation_id)
    except Exception:
        print('HERMES_IDENTITY_TRANSCRIPTION_FAILED', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
