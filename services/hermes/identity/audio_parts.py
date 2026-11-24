# ABOUTME: Нормализует входящее аудио и делит PCM по границам Дневника.
# ABOUTME: Соблюдает порядок кадров и не изменяет исходные байты.
from array import array
import json
import math
import subprocess
import sys
import wave

RATE = 16_000
SAMPLE_BYTES = 2
MAX_AUDIO_SECONDS = 18_000
PART_SECONDS = 170
PREPARE_TIMEOUT = 900
GIGAAM_CONTAINERS = frozenset({'wav', 'flac', 'ogg'})
ESTIMATED_CONTAINERS = frozenset({'mp3', 'aac'})
AUDIO_CONTAINERS = ','.join(sorted(GIGAAM_CONTAINERS | ESTIMATED_CONTAINERS | {
    'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'caf',
}))
MEDIA_ARGS = ['-protocol_whitelist', 'file', '-format_whitelist', AUDIO_CONTAINERS]


def audio_info(source):
    """Проверить контейнер, аудиодорожку и длительность через локальный ffprobe."""
    try:
        proof = subprocess.run(
            ['/usr/bin/ffprobe', '-v', 'error', *MEDIA_ARGS, '-show_entries',
             'format=duration,format_name:stream=codec_type', '-of', 'json', str(source)],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=15)
        metadata = json.loads(proof.stdout)
        names = set(metadata['format']['format_name'].split(','))
        raw_duration = metadata['format'].get('duration')
        duration = None
        if raw_duration not in (None, 'N/A') and not names & ESTIMATED_CONTAINERS:
            duration = float(raw_duration)
        streams = metadata['streams']
        audio_count = sum(stream['codec_type'] == 'audio' for stream in streams)
        if not names or not names <= set(AUDIO_CONTAINERS.split(',')) or audio_count != 1:
            raise ValueError('AUDIO_INVALID')
    except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError) as error:
        raise ValueError('AUDIO_INVALID') from error
    if duration is not None and (not math.isfinite(duration) or duration <= 0):
        raise ValueError('AUDIO_INVALID')
    if duration is not None and duration > MAX_AUDIO_SECONDS:
        raise ValueError('AUDIO_TOO_LONG')
    return duration, duration is not None and len(streams) == 1 and names <= GIGAAM_CONTAINERS


def _cut_frames(raw, final):
    """В последних 15 секундах части выбрать тихое окно по алгоритму Дневника."""
    if final:
        return len(raw) // SAMPLE_BYTES
    samples = array('h', raw)
    if sys.byteorder == 'big':
        samples.byteswap()
    width = RATE // 5
    upper = len(samples)
    selected, quietest = upper, 200 * width
    for start in range(upper - 15 * RATE, upper - width + 1, width):
        level = sum(map(abs, samples[start:start + width]))
        if level <= quietest:
            selected, quietest = start + width // 2, level
    return selected


def audio_parts(source, directory, duration):
    """Декодировать один раз и выдавать один WAV за раз, удаляя его после вызова."""
    normalized = directory / 'normalized.wav'
    byte_budget = (MAX_AUDIO_SECONDS + 1) * RATE * SAMPLE_BYTES + 1_048_576
    try:
        subprocess.run(
            ['/usr/bin/ffmpeg', '-nostdin', '-v', 'error', '-xerror', *MEDIA_ARGS,
             '-i', str(source), '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
             '-ac', '1', '-ar', str(RATE), '-c:a', 'pcm_s16le', '-fs', str(byte_budget),
             '-f', 'wav', '-n', str(normalized)],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=PREPARE_TIMEOUT)
        with wave.open(str(normalized), 'rb') as pcm:
            total = pcm.getnframes()
            if (pcm.getnchannels(), pcm.getsampwidth(), pcm.getframerate()) != (1, SAMPLE_BYTES, RATE):
                raise ValueError('AUDIO_INVALID')
            if total > MAX_AUDIO_SECONDS * RATE:
                raise ValueError('AUDIO_TOO_LONG')
            if total < 1 or (duration is not None and abs(total / RATE - duration) > 1):
                raise ValueError('AUDIO_INCOMPLETE')
            offset = 0
            index = 0
            while offset < total:
                frame_count = min(PART_SECONDS * RATE, total - offset)
                raw = pcm.readframes(frame_count)
                if len(raw) != frame_count * SAMPLE_BYTES:
                    raise ValueError('AUDIO_INCOMPLETE')
                count = _cut_frames(raw, offset + frame_count == total)
                part = directory / f'audio-part-{index + 1}.wav'
                with wave.open(str(part), 'wb') as output:
                    output.setparams((1, SAMPLE_BYTES, RATE, 0, 'NONE', 'not compressed'))
                    output.writeframes(raw[:count * SAMPLE_BYTES])
                try:
                    yield part
                finally:
                    part.unlink()
                offset += count
                index += 1
                pcm.setpos(offset)
    except (OSError, subprocess.SubprocessError, wave.Error, EOFError) as error:
        raise ValueError('AUDIO_PREPARATION_FAILED') from error
    finally:
        normalized.unlink(missing_ok=True)
