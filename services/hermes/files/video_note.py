# ABOUTME: Готовит локальные видеосообщения из проверенного голосового артефакта.
# ABOUTME: Не отправляет сообщения и возвращает ссылки после публикации каждого видео.
"""Локальная обработка аудио для штатной файловой доставки Telegram."""
from pathlib import Path
import subprocess
import tempfile

from .store import FileError


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
                # Telegram ограничивает каждый кружочек минутой. Запас покрывает
                # округление длительности при преобразовании кадров и кодеков.
                subprocess.run(['ffmpeg', '-v', 'error', '-i', sources[0]['localPath'],
                                '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le',
                                '-f', 'segment', '-segment_time', '59',
                                str(directory / 'audio-%06d.wav')], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                parts = sorted(directory.glob('audio-*.wav'))
                if not parts:
                    raise FileError('VIDEO_NOTE_EMPTY_AUDIO')
                videos = []
                for index, part in enumerate(parts):
                    output = directory / f'video-{index:06d}.mp4'
                    subprocess.run([python, '-B', str(renderer), str(part), '--image', str(asset),
                                    '--output', str(output)], check=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    with files.lock('cache'):
                        videos.append(files.resolve(str(output), ['video-note', operation,
                                                                  audio['artifactId'], index]))
                return videos
    except (OSError, subprocess.CalledProcessError) as error:
        raise FileError('VIDEO_NOTE_RENDER_FAILED') from error
