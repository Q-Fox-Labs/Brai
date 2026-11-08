# ABOUTME: Подключает command STT личного Hermes к существующему Local AI через broker.
# ABOUTME: Публикует только собственное аудио; не получает credentials и не повторяет invoke.
"""Голосовой вход с владельцем из SO_PEERCRED, без общего Transcription bearer."""
import argparse
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import stat
import sys
import time
import uuid

from .tool_client import broker_call

AUDIO_TYPES = {'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mpeg'}


def transcribe_file(input_path, output_path, model, *, call=broker_call, timeout=180):
    """Создать новый UTF-8 результат одной owner-bound попытки за общий срок до 180 с."""
    source, output = Path(input_path), Path(output_path)
    if (not source.is_absolute() or not output.is_absolute()
            or not isinstance(model, dict) or set(model) != {'modelId', 'revision', 'profileId'}
            or any(not isinstance(v, str) or not v.strip() for v in model.values())
            or not 0 < timeout <= 180):
        raise ValueError('INVALID_ARGUMENT')
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or not info.st_size:
        raise ValueError('INVALID_AUDIO')
    if output.exists() or output.is_symlink():
        raise ValueError('OUTPUT_EXISTS')
    started = time.monotonic()
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=timeout)).isoformat()

    def invoke(method, params):
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError('DEADLINE_EXCEEDED')
        return call(method, params, timeout=remaining)

    cached_id = source.parent.name
    try:
        cached = (str(uuid.UUID(cached_id)) == cached_id and
                  source.parent.parent == Path(os.environ.get('HERMES_HOME', '')) / 'results')
    except ValueError:
        cached = False
    # AIDEV-NOTE: Native ingest уже опубликовал голосовое. Повторно проверяем owner
    # через fetch и используем прежний ID; локальный путь сам не подтверждает владение.
    published = (invoke('files.fetch', {'artifactId': cached_id}) if cached else
                 invoke('files.publish', {'path': str(source), 'requestId': 'hermes-stt:' + str(uuid.uuid4())}))
    if cached and (published.get('artifactId') != cached_id or published.get('localPath') != str(source)):
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    aid = published.get('artifactId')
    if (not isinstance(aid, str) or str(uuid.UUID(aid)) != aid
            or published.get('mimeType') not in AUDIO_TYPES):
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    request_id, operation_id = str(uuid.uuid4()), str(uuid.uuid4())
    result = invoke('tools.call', {'name': 'local_ai_invoke_transcribe', 'args': {
        'requestId': request_id, 'operationId': operation_id, 'model': model,
        'deadlineAt': deadline, 'audioArtifactId': aid}})
    if (not isinstance(result, dict) or result.get('requestId') != request_id
            or result.get('operationId') != operation_id or result.get('model') != model
            or not isinstance(result.get('text'), str)):
        raise ValueError('INVALID_TRANSCRIPTION_RESULT')
    text = result['text']
    if not text.strip() or len(text.encode('utf-8')) > 1_048_576:
        raise ValueError('INVALID_TRANSCRIPT')
    if time.monotonic() - started >= timeout:
        raise TimeoutError('DEADLINE_EXCEEDED')
    # AIDEV-NOTE: O_EXCL сохраняет чужой output и отклоняет подмену пути ссылкой.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(text)


def main():
    """Принять пути и явный selector модели; stdout не содержит транскрипцию."""
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'model-id', 'revision', 'profile-id'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        transcribe_file(args.input, args.output, {
            'modelId': args.model_id, 'revision': args.revision, 'profileId': args.profile_id})
    except Exception:
        print('HERMES_IDENTITY_TRANSCRIPTION_FAILED', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
