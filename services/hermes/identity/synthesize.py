# ABOUTME: Подключает native command TTS к owner-bound синтезу Local AI.
# ABOUTME: Не читает ключи, не повторяет генерацию и проверяет полученные байты.
"""Одинаковый голосовой маршрут для native Hermes и короткого инструмента Brai."""
import argparse
import hashlib
import os
from pathlib import Path
import stat
import sys
import time

from .tool_client import broker_call


def synthesize_file(input_path, output_path, *, call=broker_call, timeout=180):
    """Выполнить один синтез и создать новый OGG результат за общий срок до 180 секунд."""
    source, target = Path(input_path), Path(output_path)
    if not source.is_absolute() or not target.is_absolute() or not 0 < timeout <= 180:
        raise ValueError('INVALID_ARGUMENT')
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 65536:
        raise ValueError('INVALID_TEXT')
    text = source.read_text(encoding='utf-8').strip()
    if not text or len(text) > 900:
        raise ValueError('INVALID_TEXT')
    if target.exists() or target.is_symlink():
        raise ValueError('OUTPUT_EXISTS')
    started = time.monotonic()
    def invoke(method, params):
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError('DEADLINE_EXCEEDED')
        return call(method, params, timeout=remaining)
    result = invoke('tools.call', {'name': 'local_ai_invoke_synthesize', 'args': {'text': text}})
    if not isinstance(result, dict) or not isinstance(result.get('audioArtifactId'), str):
        raise ValueError('INVALID_SYNTHESIS_RESULT')
    aid = result['audioArtifactId']
    artifact = invoke('files.fetch', {'artifactId': aid})
    if (not isinstance(artifact, dict) or artifact.get('artifactId') != aid
            or artifact.get('mimeType') not in ('audio/ogg', 'audio/opus')):
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    audio = Path(artifact['localPath'])
    info = audio.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 50 * 1024 * 1024:
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    raw = audio.read_bytes()
    if (len(raw) != artifact.get('sizeBytes') or not raw.startswith(b'OggS')
            or hashlib.sha256(raw).hexdigest() != artifact.get('sha256')):
        raise ValueError('INVALID_AUDIO_ARTIFACT')
    if time.monotonic() - started >= timeout:
        raise TimeoutError('DEADLINE_EXCEEDED')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)


def main():
    """Принять пути command provider; не выводить текст, аудио или исходные ошибки."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        synthesize_file(args.input, args.output)
    except Exception:
        print('HERMES_IDENTITY_SYNTHESIS_FAILED', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
