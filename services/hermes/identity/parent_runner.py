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
    # Пакет SDK должен иметь приоритет над одноимённым каталогом Brai plugin.
    site_packages = Path('/opt/brai-profile/site-packages')
    sys.path.insert(0, str(site_packages))
    import telegram
    import telegram.ext
    sdk_path = Path(telegram.__file__).resolve()
    if not sdk_path.is_relative_to(site_packages.resolve()):
        raise RuntimeError('Trusted Telegram SDK unavailable')
    # Discovery по старому HOME запрещён до первого импорта native engine.
    os.environ['HERMES_SAFE_MODE'] = '1'
    from hermes_cli.plugins import get_plugin_manager, parse_manifest_file
    manager = get_plugin_manager()
    manager.discover_and_load()
    for path, kind in (
        (engine / 'plugins/platforms/telegram', 'platforms'),
        (Path('/opt/brai-profile/runtime/services/hermes/telegram'), ''),
    ):
        manifest = parse_manifest_file(path / 'plugin.yaml', path, 'bundled', kind)
        if manifest is None:
            raise RuntimeError('Trusted Telegram manifest unavailable')
        manager._load_plugin(manifest)
    plugins = manager.list_plugins()
    if ({p['key'] for p in plugins} != {'platforms/telegram', 'brai-telegram'}
            or any(not p['enabled'] or p['error'] for p in plugins)):
        raise RuntimeError('Trusted Telegram plugins unavailable')
    factories = manager.get_telegram_handler_factories()
    if len(factories) != 1 or factories[0][1] != 'brai-telegram':
        raise RuntimeError('Trusted Telegram handler unavailable')
    import asyncio
    from gateway.run import start_gateway
    if not asyncio.run(start_gateway(force=True)):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
