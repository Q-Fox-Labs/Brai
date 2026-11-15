# ABOUTME: Запускает закреплённые media-модули в личном namespace Hermes.
# ABOUTME: Использует текущий SDK и личные загрузки без старого venv или Docker.
"""CLI launcher общих media-возможностей; credentials остаются в личном HOME."""
import os
from pathlib import Path
import sys

MODULES = {'yt-dlp': 'yt_dlp', 'instaloader': 'instaloader'}


def command(tool, arguments, *, home, python):
    """Вернуть argv canonical SDK; переписать только прежний префикс /downloads."""
    if tool not in MODULES or not Path(home).is_absolute():
        raise ValueError('PERSONAL_MEDIA_ARGUMENT_INVALID')
    root = str(Path(home) / 'workspace/downloads')
    def rewrite(value):
        if value == '/downloads' or value.startswith('/downloads/'):
            return root + value[len('/downloads'):]
        if value.startswith('--output=/downloads/'):
            return '--output=' + root + value[len('--output=/downloads'):]
        return value
    flags = (['--ignore-config', '--no-js-runtimes', '--js-runtimes',
              'node:/usr/local/bin/node'] if tool == 'yt-dlp' else [])
    return [python, '-s', '-P', '-B', '-m', MODULES[tool], *flags, *(rewrite(x) for x in arguments)]


def main():
    """Заменить launcher модулем; не читать чужую конфигурацию и не повторять запросы."""
    if os.environ.get('BRAI_IDENTITY_MODE') != 'worker' or len(sys.argv) < 2:
        raise SystemExit('PERSONAL_MEDIA_WORKER_REQUIRED')
    argv = command(sys.argv[1], sys.argv[2:], home=os.environ.get('HERMES_HOME', ''),
                   python=sys.executable)
    os.execv(sys.executable, argv)


if __name__ == '__main__':
    main()
