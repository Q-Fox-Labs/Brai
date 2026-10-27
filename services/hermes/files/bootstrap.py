# ABOUTME: Загружает обязательную файловую границу в общий закреплённый движок Hermes.
# ABOUTME: Конфигурация экземпляра поступает из root-owned файла или private bootstrap.
import importlib.util
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace

if '_brai_codeworks_gateway' in sys.modules:
    port = sys.modules.get('_brai_hermes_file_port')
    if port is None:
        raise RuntimeError('FILES_PORT_NOT_READY')
    config = port.call('files.configuration', {}, 30)
else:
    path = Path('__BRAI_FILES_CONFIG__')
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode):
        raise RuntimeError('UNTRUSTED_FILES_CONFIG')
    config = json.loads(path.read_text())
package = Path(config['moduleRoot'])
spec = importlib.util.spec_from_file_location('_brai_files', package / '__init__.py', submodule_search_locations=[str(package)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from _brai_files import native
from _brai_files.bridge import Bridge
native.configure(config, Bridge(SimpleNamespace(node=config['node'], entry=config['entry'],
    environment={'BRAI_HERMES_CONFIG': config['toolsConfig'], 'BRAI_HERMES_OWNER_ID': config['ownerId']})))


def __getattr__(name):
    """Предоставить один обязательный интерфейс всем каналам и режимам агента."""
    return getattr(native, name)
