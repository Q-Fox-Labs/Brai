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


def restrict_exclusive_plugins(product):
    """Привязать независимые loader-ы к bundled коду до загрузки пользовательских модулей."""
    import importlib
    from plugins import plugin_loader
    import providers
    original_user = plugin_loader.user_plugins_dir
    plugin_loader.user_plugins_dir = lambda: original_user() if active_configuration() else None
    for name in ('_user_plugins_dir', '_installed_plugins_dir'):
        original = getattr(providers, name)
        setattr(providers, name, lambda original=original: original() if active_configuration() else None)
    original_entrypoints = providers._discover_entry_point_providers
    providers._discover_entry_point_providers = lambda: original_entrypoints() if active_configuration() else None
    for group, iterator_name in (('memory', '_iter_provider_dirs'), ('context_engine', '_iter_engine_dirs'),
                                 ('cron_providers', '_iter_provider_dirs'), ('computer_use', '_iter_provider_dirs')):
        module = importlib.import_module('plugins.' + group)
        bundled = Path(module.__file__).resolve().parent
        original = getattr(module, iterator_name)
        def directories(original=original, bundled=bundled, group=group):
            if active_configuration():
                return original()
            # Вернуть canonical readonly путь: HOME symlink не должен пережить проверку.
            rows = [(name, Path(path).resolve()) for name, path in original()
                    if Path(path).resolve().is_relative_to(bundled)]
            if group == 'memory':
                rows.append(('memos-rest', product / 'extensions/plugins/memos-rest'))
            return rows
        setattr(module, iterator_name, directories)
        if group == 'memory':
            original_alias, original_points = module._get_user_plugins_dir, module._iter_entry_points
            original_find = module.find_provider_dir
            module._get_user_plugins_dir = lambda: original_alias() if active_configuration() else None
            module._iter_entry_points = lambda: original_points() if active_configuration() else []
            def find(name, original_find=original_find, directories=directories):
                if active_configuration():
                    return original_find(name)
                return next((path for candidate, path in directories() if candidate == name), None)
            module.find_provider_dir = find


def execution_grant(name):
    """Одна проверка фактического native/inline имени до любого пользовательского hook."""
    try:
        if not isinstance(name, str):
            return None
        grant = broker_call('native.authorize', {'name': name})
        before = principal()
        if grant.get('allowed') is True and all(grant.get(key) == before.get(key) for key in ('role', 'generation')):
            return before
    except Exception:
        pass
    return None


def grant_current(before):
    """Не выдавать результат после смены роли, поколения или отказа Auth."""
    try:
        return principal() == before
    except Exception:
        return False


def install_executor_guard():
    """Закрыть общий executor и direct API, включая inline/delegation до Registry."""
    from agent import tool_executor, agent_runtime_helpers
    common = tool_executor._dispatch_authorized_once
    invoke = agent_runtime_helpers.invoke_tool
    denied = json.dumps({'error': 'Это действие недоступно для вашей роли.'}, ensure_ascii=False)
    changed = json.dumps({'error': 'Права доступа изменились. Результат не выдан.'}, ensure_ascii=False)
    def guarded_common(agent, state, ref, *, execute, scope_block, display_index,
                       begin_execution, authorization_gate):
        before = execution_grant(ref.name)
        if before is None:
            state.blocked = True
            if begin_execution is not None:
                begin_execution()
            # Native blocked helper вызывает plugin post hook; здесь код hooks не разрешён.
            return denied
        result = common(agent, state, ref, execute=execute, scope_block=scope_block,
                        display_index=display_index, begin_execution=begin_execution,
                        authorization_gate=authorization_gate)
        return result if grant_current(before) else changed
    def guarded_invoke(agent, function_name, function_args, *args, **kwargs):
        before = execution_grant(function_name)
        if before is None:
            return denied
        result = invoke(agent, function_name, function_args, *args, **kwargs)
        return result if grant_current(before) else changed
    guarded_common.__wrapped__ = common
    guarded_invoke.__wrapped__ = invoke
    tool_executor._dispatch_authorized_once = guarded_common
    agent_runtime_helpers.invoke_tool = guarded_invoke


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
    _suspended = _guest or state.get('backgroundsSuspended') is True
    if _guest or state.get('staged') is True:
        product = Path(__file__).resolve().parents[1]
        restrict_exclusive_plugins(product)
        import hermes_cli.config as config
        accepted = protected_config('/opt/brai-profile/profile-config.json')
        # AIDEV-NOTE: Не читаем прежний личный config: он мог сохранить hooks, MCP и исполняемые плагины.
        original_load, original_read = config.load_config, config.load_config_readonly
        config.load_config = lambda *args, **kwargs: deepcopy(accepted) if not active_configuration() else original_load(*args, **kwargs)
        config.load_config_readonly = lambda *args, **kwargs: deepcopy(accepted) if not active_configuration() else original_read(*args, **kwargs)
        # Gateway turn/startup readers имеют отдельные raw YAML/legacy пути.
        from hermes_cli import config_effective
        from gateway import config_loader
        original_effective = config_effective.load_user_config_effective
        original_yaml = config_loader.read_yaml_layers
        original_legacy = config_loader.load_legacy_gateway_json
        config_effective.load_user_config_effective = lambda *args, **kwargs: (
            original_effective(*args, **kwargs) if active_configuration() else deepcopy(accepted))
        config_loader.read_yaml_layers = lambda *args, **kwargs: (
            original_yaml(*args, **kwargs) if active_configuration() else deepcopy(accepted))
        config_loader.load_legacy_gateway_json = lambda *args, **kwargs: (
            original_legacy(*args, **kwargs) if active_configuration() else {})
        import sys
        tools_config = sys.modules.get('hermes_cli.tools_config')
        if tools_config is not None:
            tools_config.load_config = config.load_config
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
    install_executor_guard()
    _installed = True
    if _suspended or state.get('staged') is True:
        from gateway.run import GatewayRunner
        recovery = GatewayRunner._start_recover_previous_run
        finish = GatewayRunner._start_finish_wiring
        watchers = GatewayRunner._start_spawn_background_watchers
        def defer(runner, callback, *args):
            pending = getattr(runner, '_brai_deferred_startup', None)
            if pending is None:
                pending = runner._brai_deferred_startup = []
            pending.append((callback, args))
        async def prepared_recovery(self):
            if not _suspended and active_configuration():
                return await recovery(self)
            # Только trusted discovery нужен admission health/human bridge.
            from hermes_cli.plugins import get_plugin_manager
            get_plugin_manager().discover_and_load()
            if not _suspended:
                defer(self, recovery)
        async def prepared_finish(self, connected_count):
            if not _suspended and active_configuration():
                return await finish(self, connected_count)
            self._startup_restore_in_progress = False
            if not _suspended:
                defer(self, finish, connected_count)
        def prepared_watchers(self):
            if not _suspended and active_configuration():
                return watchers(self)
            if _suspended:
                self._spawn_reconnect_watcher()
            else:
                defer(self, watchers)
        GatewayRunner._start_recover_previous_run = prepared_recovery
        GatewayRunner._start_finish_wiring = prepared_finish
        GatewayRunner._start_spawn_background_watchers = prepared_watchers


def prepared_principal():
    """Ожидаемая личность, чьи trusted assets прошли bootstrap этого процесса."""
    return {'role': _role, 'generation': (_startup_state or {}).get('generation')}


def has_deferred_startup(runner):
    """Health готовит каталог; исполнение старых работ отдельно ждёт Auth active."""
    return bool(getattr(runner, '_brai_deferred_startup', ()))


async def activate_deferred_startup(runner, adapter, check):
    """Однократно вернуть ordinary user startup после fresh active generation."""
    from hermes_cli.plugins import get_plugin_manager
    import inspect
    import sys
    await check()
    pending = getattr(runner, '_brai_deferred_startup', [])
    if not pending:
        return
    runner._brai_deferred_startup = []
    manager = get_plugin_manager()
    # Sync import не оставляет неотменяемый discovery thread после stop_runtime.
    manager.discover_and_load(force=True)
    await check()
    runner._subscribe_plugin_rewire(manager)
    runner._rewire_plugin_handlers()
    human = sys.modules.get('_brai_identity_human')
    attach = getattr(human, 'attach', None)
    if not callable(attach):
        raise PermissionError('Worker human plugin unavailable')
    await attach(adapter)
    await check()
    runner._startup_restore_in_progress = True
    try:
        for callback, args in pending:
            await check()
            result = callback(runner, *args)
            if inspect.isawaitable(result):
                await result
            await check()
    finally:
        runner._startup_restore_in_progress = False


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
    if _guest or _suspended:
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
    return _guest or not active_configuration()
