# ABOUTME: Запускает только штатный Telegram transport из проверенной личной поставки.
# ABOUTME: Общий UID ingress не получает разрешения исполнять пользовательского агента.
"""Fixed parent entrypoint; polling guard belongs to identity/native.patch."""
import os
from pathlib import Path
import sys


def main():
    """Проверить identity binding до загрузки pinned native CLI и polling."""
    if (os.geteuid() == 0 or os.environ.get('BRAI_IDENTITY_MODE') != 'telegram'
            or os.environ.get('HERMES_ROOT') != '/opt/brai-profile/engine'
            or os.environ.get('HERMESCUSTOM_ROOT') != '/opt/brai-profile/instructions'
            or os.environ.get('BRAI_IDENTITY_INGRESS_UID') != str(os.geteuid())
            or not os.environ.get('BRAI_IDENTITY_BROKER', '').startswith('/run/')):
        raise PermissionError('Identity parent binding unavailable')
    engine = Path('/opt/brai-profile/engine')
    if not (engine / 'brai_files_transport.py').is_file():
        raise RuntimeError('Native identity transport unavailable')
    sys.path.insert(0, str(engine))
    from hermes_cli.main import main as native_main
    sys.argv = ['hermes', 'gateway', 'run']
    native_main()


if __name__ == '__main__':
    main()
