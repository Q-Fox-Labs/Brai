# ABOUTME: Ограничивает native каталог и фактический dispatch по актуальному Auth.
# ABOUTME: Гостевой config и плагины берутся только из неизменяемой поставки.
"""Политика устанавливается до импорта GatewayRunner и plugin discovery."""
from copy import deepcopy
import json
import os
from pathlib import Path
import stat

from .tool_client import broker_call

_installed = False
_guest = False
_role = None
_suspended = False
_startup_state = None


def guest_mode():
    """Вернуть режим, подтверждённый Auth при запуске этого процесса."""
    return _guest


def backgrounds_suspended():
    """Не возобновлять старые задания после обратного повышения роли."""
    return _suspended


def role_state():
    """Вернуть подтверждённую при bootstrap роль для health."""
    return _role


def principal():
    """Перепроверить текущую роль; ошибка Auth не даёт прежние разрешения."""
    value = broker_call('permissions.get', {})
    if not isinstance(value, dict) or value.get('role') not in ('creator','admin','user','guest'):
        raise PermissionError('Доступ не подтверждён')
    return value


def permitted(name):
    """Проверить точное native/MCP имя до вызова обработчика."""
    try:
        return broker_call('native.authorize', {'name': name}).get('allowed') is True
    except Exception:
        return False


def protected_config(path):
    """Прочитать root-owned конфигурацию из закреплённого readonly mount."""
    path = Path(path)
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise PermissionError('Недоверенная конфигурация')
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise PermissionError('Недоверенная конфигурация')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise PermissionError('Недоверенная конфигурация')
    return value


def install():
    """Закрепить гостевой startup и общий guard registry до обнаружения инструментов."""
    global _installed, _guest, _role, _suspended, _startup_state
    state = broker_call('permissions.bootstrap', {})
    if _installed:
        if state.get('role') != _role:
            raise PermissionError('Runtime role changed')
        _startup_state = state
        return
    _startup_state = state
    if state.get('role') not in ('creator','admin','user','guest'):
        raise PermissionError('Доступ не подтверждён')
    _role = state['role']
    _guest = _role == 'guest'
    _suspended = _guest or state.get('staged') is True or state.get('backgroundsSuspended') is True
    if _guest or state.get('staged') is True:
        import hermes_cli.config as config
        accepted = protected_config('/opt/brai-profile/profile-config.json')
        # AIDEV-NOTE: Не читаем прежний личный config: он мог сохранить hooks, MCP и исполняемые плагины.
        original_load, original_read = config.load_config, config.load_config_readonly
        config.load_config = lambda *args, **kwargs: deepcopy(accepted) if not active_configuration() else original_load(*args, **kwargs)
        config.load_config_readonly = lambda *args, **kwargs: deepcopy(accepted) if not active_configuration() else original_read(*args, **kwargs)
        import hermes_cli.plugins as plugins
        from hermes_cli.plugins_discovery import scan_directory
        product = Path(__file__).resolve().parents[1]
        bundled = plugins.get_bundled_plugins_dir()
        original_manifests, original_entrypoints = plugins.PluginManager._collect_directory_manifests, plugins.PluginManager._scan_entry_points
        def manifests(self):
            if active_configuration():
                return original_manifests(self)
            return (scan_directory(product / 'extensions/plugins', 'bundled')
                    + scan_directory(product, 'bundled')
                    + scan_directory(bundled, 'bundled', skip_names={
                        'memory','context_engine','model-providers','cron_providers','computer_use'}))
        plugins.PluginManager._collect_directory_manifests = manifests
        plugins.PluginManager._scan_entry_points = lambda self: original_entrypoints(self) if active_configuration() else []
    from tools.registry import ToolRegistry
    definitions, dispatch = ToolRegistry.get_definitions, ToolRegistry.dispatch
    def guarded_definitions(self, tool_names, quiet=False):
        return definitions(self, {name for name in tool_names if catalog_permitted(name)}, quiet=quiet)
    def guarded_dispatch(self, name, args, **kwargs):
        grant = broker_call('native.authorize', {'name': name})
        before = principal()
        if grant.get('allowed') is not True or any(grant.get(key) != before.get(key) for key in ('role','generation')):
            return json.dumps({'error': 'Это действие недоступно для вашей роли.'}, ensure_ascii=False)
        result = dispatch(self, name, args, **kwargs)
        if principal() != before:
            return json.dumps({'error': 'Права доступа изменились. Результат не выдан.'}, ensure_ascii=False)
        return result
    ToolRegistry.get_definitions, ToolRegistry.dispatch = guarded_definitions, guarded_dispatch
    _installed = True
    if _suspended:
        from gateway.run import GatewayRunner
        async def without_recovery(self):
            self._start_register_plugins_relay_hooks()
        async def without_restore(self, connected_count):
            self._startup_restore_in_progress = False
        def without_watchers(self):
            self._spawn_reconnect_watcher()
        GatewayRunner._start_recover_previous_run = without_recovery
        GatewayRunner._start_finish_wiring = without_restore
        GatewayRunner._start_spawn_background_watchers = without_watchers


def revalidate_startup():
    """Закрыть восстановление, если роль/поколение изменились во время plugin discovery."""
    if broker_call('permissions.bootstrap', {}) != _startup_state:
        raise PermissionError('Runtime preparation changed')


def catalog_permitted(name):
    """Разрешить только discovery подготовленного каталога; это не grant исполнения."""
    try:
        return broker_call('native.catalog', {'name': name}).get('allowed') is True
    except Exception:
        return False


def active_configuration():
    """Личный конфиг user/admin читается только после подтверждённого применения."""
    if _guest:
        return False
    try:
        return principal().get('role') == _role
    except Exception:
        return False


def scheduler_permitted():
    """Не запускать задания до active и при отказе Auth; гостю они закрыты."""
    try:
        return principal().get('role') in ('creator', 'admin', 'user')
    except Exception:
        return False


def staging_mode():
    """Не читать прежний dotenv во время подтверждаемой подготовки."""
    return _guest or bool((_startup_state or {}).get('staged'))
