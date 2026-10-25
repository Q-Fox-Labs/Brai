#!/usr/bin/python3
# ABOUTME: Перенаправляет только медиапути /downloads в каталог Hermes PROD и запускает yt-dlp.
# ABOUTME: Не использует shell, Docker или пользовательский конфигурационный файл.
import os
import sys

DOWNLOAD_ROOT = os.environ.get(
    'HERMES_MEDIA_DOWNLOAD_ROOT',
    '/var/lib/brai/hermes/media/downloads',
)
YTDLP = os.path.join(os.environ['HOME'], 'media-venv/bin/yt-dlp')


def rewrite(value):
    """Перенаправить только абсолютный путь с префиксом /downloads."""
    if value == '/downloads':
        return DOWNLOAD_ROOT
    if value.startswith('/downloads/'):
        return DOWNLOAD_ROOT + value[len('/downloads'):]
    if value.startswith('--output=/downloads/'):
        return '--output=' + DOWNLOAD_ROOT + value[len('--output=/downloads'):]
    return value


if not os.path.isabs(DOWNLOAD_ROOT):
    raise SystemExit('HERMES_MEDIA_DOWNLOAD_ROOT must be absolute')
os.environ['HERMES_MEDIA_DOWNLOAD_ROOT'] = DOWNLOAD_ROOT
os.execv(YTDLP, [YTDLP, '--ignore-config', '--no-js-runtimes', '--js-runtimes',
                  'node:/usr/local/bin/node', *(rewrite(value) for value in sys.argv[1:])])
