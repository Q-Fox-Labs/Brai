# ABOUTME: Готовит локальные видеосообщения из проверенного голосового артефакта.
# ABOUTME: Не отправляет сообщения и возвращает ссылки после публикации каждого видео.
"""Локальная обработка аудио для штатной файловой доставки Telegram."""
from pathlib import Path
import json
import re
import subprocess
import tempfile
import wave

from .store import FileError


def _audio_parts(source, directory):
    """Разделить звук на паузах, сохранив все аудиосэмплы и порядок частей."""
    decoded = directory / 'decoded.wav'
    subprocess.run(['/usr/bin/ffmpeg', '-v', 'error', '-i', source, '-map', '0:a:0',
                    '-vn', '-ac', '1', '-c:a', 'pcm_s16le', str(decoded)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    analysis = subprocess.run(['/usr/bin/ffmpeg', '-hide_banner', '-i', str(decoded), '-af',
                               'silencedetect=noise=-35dB:d=0.15', '-f', 'null', '-'],
                              check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    pauses = [(float(start) + float(end)) / 2 for start, end in re.findall(
        r'silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)', analysis.stderr, re.S)]
    parts = []
    with wave.open(str(decoded), 'rb') as reader:
        rate, total = reader.getframerate(), reader.getnframes()
        boundaries = [int(time * rate) for time in pauses]
        position = 0
        while position < total:
            # Запас до минуты покрывает округление кадров и кодеков Telegram.
            end = min(total, position + 59 * rate)
            if end < total:
                end = max((boundary for boundary in boundaries if position < boundary <= end), default=end)
            part = directory / f'audio-{len(parts):06d}.wav'
            with wave.open(str(part), 'wb') as writer:
                writer.setparams(reader.getparams())
                remaining = end - position
                while remaining:
                    chunk = min(remaining, rate)
                    writer.writeframes(reader.readframes(chunk))
                    remaining -= chunk
            parts.append(part)
            position = end
    return parts


def render_video_notes(files, audio, operation, *, python='/usr/bin/python3'):
    """Вернуть упорядоченные метаданные MP4 для полного аудиоартефакта."""
    if not audio['mimeType'].startswith('audio/'):
        raise FileError('VIDEO_NOTE_AUDIO_REQUIRED')
    renderer = Path(__file__).resolve().parent.parent / 'identity' / 'avatar' / 'talking_orange.py'
    asset = renderer.with_name('orange.png')
    try:
        with files.materialize([files.checked(audio)], ['video-note', operation]) as sources:
            with tempfile.TemporaryDirectory(prefix='video-note-', dir=files.work) as directory:
                directory = Path(directory)
                parts = _audio_parts(sources[0]['localPath'], directory)
                if not parts:
                    raise FileError('VIDEO_NOTE_EMPTY_AUDIO')
                videos = []
                for index, part in enumerate(parts):
                    output = directory / f'video-{index:06d}.mp4'
                    subprocess.run([python, '-B', str(renderer), str(part), '--image', str(asset),
                                    '--ffmpeg', '/usr/bin/ffmpeg',
                                    '--output', str(output)], check=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    probe = subprocess.run(['/usr/bin/ffprobe', '-v', 'error', '-show_entries',
                                            'format=duration:stream=codec_type,codec_name,width,height',
                                            '-of', 'json', str(output)], check=True,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    metadata = json.loads(probe.stdout)
                    duration = float(metadata['format']['duration'])
                    streams = metadata['streams']
                    video = next(stream for stream in streams if stream['codec_type'] == 'video')
                    audio_stream = next(stream for stream in streams if stream['codec_type'] == 'audio')
                    if (not 0 < duration <= 60 or video['codec_name'] != 'h264'
                            or video['width'] <= 0 or video['width'] != video['height']
                            or audio_stream['codec_name'] != 'aac'):
                        raise FileError('VIDEO_NOTE_INVALID_OUTPUT')
                    with files.lock('cache'):
                        videos.append(files.resolve(str(output), ['video-note', operation,
                                                                  audio['artifactId'], index]))
                return videos
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError, StopIteration, TypeError, wave.Error) as error:
        raise FileError('VIDEO_NOTE_RENDER_FAILED') from error
