# ABOUTME: Ограничивает native каталог и фактический dispatch по актуальному Auth.
# ABOUTME: Гостевой config и плагины берутся только из неизменяемой поставки.
"""Политика устанавливается до импорта GatewayRunner и plugin discovery."""
from copy import deepcopy
from contextvars import ContextVar
import json
import os
from pathlib import Path
import stat

from .tool_client import broker_call

_installed = False
_managed_stt = False
_guest = False
_role = None
_suspended = False
_startup_state = None
_execution_state = ContextVar('brai_native_invocation', default=None)
_tool_invocation = ContextVar('brai_native_tool', default=None)


def worker_loop_tick_socket_path(home=None, pid=None):
    """Короткий AF_UNIX путь в существующем PrivateTmp личного worker."""
    pid = int(pid if pid is not None else os.getpid())
    return Path('/tmp/brai-loop-tick') / f'gateway.loop-tick.{pid}.sock'


def install_worker_watchdog():
    """Настроить native reader до импорта GatewayRunner в этом процессе."""
    if os.environ.get('BRAI_IDENTITY_MODE') != 'worker':
        return
    from gateway import shutdown_watchdog
    shutdown_watchdog.get_loop_tick_socket_path = worker_loop_tick_socket_path


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


def install_managed_stt(path):
    """Select the admitted command provider and report whether it enabled STT."""
    if not path.is_file():
        return False
    stt = protected_config(path).get('stt', {})
    provider = stt.get('providers', {}).get('brai_local_ai', {})
    if (stt.get('enabled') is True and stt.get('provider') == 'brai_local_ai'
            and provider.get('type') == 'command'):
        from tools import transcription_tools
        from .audio_parts import PREPARE_TIMEOUT
        managed = deepcopy(stt)
        # AIDEV-NOTE: Внешний idle timeout должен покрывать декодирование
        # Дневника. Каждая часть по-прежнему имеет собственный срок invoke.
        managed['providers']['brai_local_ai']['timeout'] = PREPARE_TIMEOUT + 20
        transcription_tools._load_stt_config = lambda: deepcopy(managed)
        # AIDEV-NOTE: Native voice пробует локальный Whisper после отказа command.
        # У управляемого профиля модель выбирает сервис; отказ не меняет маршрут.
        transcription_tools.transcribe_audio_local_fallback = lambda *_args, **_kwargs: {
            'success': False, 'error': 'TRANSCRIPTION_UNAVAILABLE',
        }
        return True
    return False


def install_telegram_audio_input(runner, telegram_platform):
    """Направить Telegram audio и аудиодокументы в штатный STT личного worker."""
    classify = runner._classify_inbound_media
    pending_paths = runner._pending_event_audio_paths

    def from_telegram(event):
        return getattr(getattr(event, 'source', None), 'platform', None) == telegram_platform

    def classify_media(event, prepared):
        images, voice, audio, videos = classify(event, prepared)
        if not from_telegram(event):
            return images, voice, audio, videos
        original_audio = getattr(event, '_brai_audio_paths', set())
        candidates = set(voice) | set(audio) | original_audio
        selected = [path for path in (event.media_urls or []) if path in candidates] if not prepared else []
        return images, selected, [], [path for path in videos if path not in original_audio]

    def pending_media(event):
        if from_telegram(event):
            return classify_media(event, False)[1]
        return pending_paths(event)

    # AIDEV-NOTE: Native foreground классифицирует AUDIO/DOCUMENT как файлы,
    # а очередь использует другой helper. Оба пути должны выбрать один STT.
    runner._classify_inbound_media = classify_media
    runner._pending_event_audio_paths = pending_media


def protect_config_readers(config, accepted):
    """Закрепить обычные и raw readers SDK за одним доверенным guest/staged config."""
    for name in ('load_config', 'load_config_readonly', 'read_raw_config',
                 'read_raw_config_readonly', 'read_user_config_raw'):
        original = getattr(config, name, None)
        if original is not None:
            def reader(*args, original=original, **kwargs):
                return original(*args, **kwargs) if active_configuration() else deepcopy(accepted)
            setattr(config, name, reader)


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


def pin_telegram_plugin():
    """Подключить Telegram-плагин из загруженного принятого runtime."""
    from hermes_cli.plugins import PluginManager, parse_manifest_file
    from hermes_cli.plugins_manifest import manifest_key

    path = Path('/opt/brai-profile/runtime/services/hermes/telegram')
    name = 'brai-telegram'
    manifest = parse_manifest_file(path / 'plugin.yaml', path, 'bundled', '')
    if manifest is None or manifest.name != name or manifest_key(manifest) != name:
        raise RuntimeError('Trusted Telegram plugin unavailable')
    original = PluginManager._collect_directory_manifests
    # Native loader maps hyphens to underscores in the module name.
    module_slug = name.replace('-', '_')

    def collect(self):
        other_plugins = [item for item in original(self)
                         if item.name != name and manifest_key(item) not in (name, module_slug)]
        return [*other_plugins, manifest]

    PluginManager._collect_directory_manifests = collect


def execution_grant(name):
    """Одна проверка фактического native/inline имени до любого пользовательского hook."""
    try:
        if not isinstance(name, str):
            return None
        grant = broker_call('native.authorize', {'name': name})
        before = principal()
        expected = _execution_state.get()
        if ((expected is None or expected == before) and grant.get('allowed') is True
                and all(grant.get(key) == before.get(key) for key in ('role', 'generation'))):
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



def current_tool():
    """Фактический разрешённый producer в текущем потоке исполнения."""
    return _tool_invocation.get()


def arguments_permitted(name, args, state):
    """Проверить реальные аргументы перед эффектом."""
    if state.get('role') != 'guest':
        return True
    from .guest_tools import validate
    return validate(name,args)


def dialogues_result(content):
    """Извлечь поля квитанции из обычного или обёрнутого ответа native MCP."""
    try:
        if isinstance(content, str):
            if content.startswith('<untrusted_tool_result source="mcp__brai__dialogues_exchange">'):
                content = content[content.index('\n{') + 1:content.rindex('\n</untrusted_tool_result>')]
            content = json.loads(content)
        if isinstance(content, dict):
            value = content.get('structuredContent', content.get('result', content))
            if not isinstance(value, dict):
                return {}
            error = value.get('error')
            if isinstance(error, str) and error.startswith('{'):
                rejected = json.loads(error)
                if isinstance(rejected, dict) and isinstance(rejected.get('code'), str) and rejected.get('applied') is False:
                    return rejected
            return value
    except (TypeError, ValueError):
        pass
    return {}


def install_dialogues_result_budget(tool_executor):
    """Передать компактный индекс целиком в пределах штатного бюджета хода."""
    persist = tool_executor.maybe_persist_tool_result
    def preserve_context(content, tool_name, tool_use_id, env=None, config=None):
        if tool_name == 'mcp__brai__dialogues_exchange' and config is not None:
            result = dialogues_result(content)
            archive = ('messages' in result and 'continuation_cursor' in result or
                       'dialogues' in result and 'topic_id' in result or
                       'items' in result and str(result.get('dialogue_id', '')).startswith('D'))
            if isinstance(result.get('context'), str) or archive:
                return persist(content, tool_name, tool_use_id, env=env, config=config, threshold=config.turn_budget)
        options = {} if config is None else {'config': config}
        return persist(content, tool_name, tool_use_id, env=env, **options)
    tool_executor.maybe_persist_tool_result = preserve_context


def install_executor_guard():
    """Закрыть общий executor и direct API, включая inline/delegation до Registry."""
    from agent import tool_executor, agent_runtime_helpers, inline_tool_executors
    if os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1':
        install_dialogues_result_budget(tool_executor)
    invocation = _execution_state
    resolve_inline = inline_tool_executors.resolve_invoke_tool_executor
    class RevokedInvocation(Exception):
        pass
    common = tool_executor._dispatch_authorized_once
    invoke = agent_runtime_helpers.invoke_tool
    repair = agent_runtime_helpers.repair_tool_call
    denied = json.dumps({'error': 'Это действие недоступно для вашей роли.'}, ensure_ascii=False)
    changed = json.dumps({'error': 'Права доступа изменились. Результат не выдан.'}, ensure_ascii=False)
    def dispatch(agent, name, args, send):
        if name == 'mcp__brai__dialogues_exchange' and isinstance(args, dict) and args.get('action') == 'finish':
            from files.native import dialogues_finish
            def can_retry(result):
                receipt = dialogues_result(result)
                return receipt.get('applied') is False or receipt.get('status') == 'rejected'
            return dialogues_finish(agent, send, can_retry)
        return send()
    def guarded_common(agent, state, ref, *, execute, scope_block, display_index,
                       begin_execution, authorization_gate):
        before = execution_grant(ref.name)
        if before is None or not arguments_permitted(ref.name,getattr(ref,'args',{}),before):
            state.blocked = True
            if begin_execution is not None:
                begin_execution()
            # Native blocked helper вызывает plugin post hook; здесь код hooks не разрешён.
            return denied
        def guarded_execute(*args, **kwargs):
            # Hooks, approval и middleware могли ожидать после первоначального grant.
            if execution_grant(ref.name) != before or not arguments_permitted(
                    ref.name, args[0] if args else getattr(ref,'args',{}), before):
                state.blocked = True
                raise RevokedInvocation()
            tool_token = _tool_invocation.set(ref.name)
            try:
                result = dispatch(agent, ref.name, args[0] if args else getattr(ref, 'args', {}), lambda: execute(*args, **kwargs))
            finally:
                _tool_invocation.reset(tool_token)
            if not grant_current(before):
                state.blocked = True
                raise RevokedInvocation()
            return result
        token = invocation.set(before)
        try:
            result = common(agent, state, ref, execute=guarded_execute, scope_block=scope_block,
                            display_index=display_index, begin_execution=begin_execution,
                            authorization_gate=authorization_gate)
        except RevokedInvocation:
            state.blocked = True
            return changed
        finally:
            invocation.reset(token)
        if not grant_current(before):
            state.blocked = True
            return changed
        return result
    def guarded_invoke(agent, function_name, function_args, *args, **kwargs):
        before = execution_grant(function_name)
        if before is None or not arguments_permitted(function_name,function_args,before):
            return denied
        token = invocation.set(before)
        try:
            result = dispatch(agent, function_name, function_args, lambda: invoke(agent, function_name, function_args, *args, **kwargs))
            return result if grant_current(before) else changed
        except RevokedInvocation:
            return changed
        finally:
            invocation.reset(token)
    def guarded_resolve(agent, name):
        before = invocation.get()
        if before is None or execution_grant(name) != before:
            raise RevokedInvocation()
        execute = resolve_inline(agent, name)
        if execute is None:
            return None
        def guarded_inline(*args, **kwargs):
            if (before is None or execution_grant(name) != before or not arguments_permitted(
                    name,args[1] if len(args)>1 else kwargs.get('function_args',{}),before)):
                # Не возвращать строку в SDK: иначе он вызовет post hooks после отзыва.
                raise RevokedInvocation()
            tool_token = _tool_invocation.set(name)
            try:
                result = dispatch(agent, name, args[1] if len(args)>1 else kwargs.get('function_args', {}), lambda: execute(*args, **kwargs))
            finally:
                _tool_invocation.reset(tool_token)
            if not grant_current(before):
                raise RevokedInvocation()
            return result
        return guarded_inline
    inline_tool_executors.resolve_invoke_tool_executor = guarded_resolve
    # Не превращать неизвестный/запрещённый guest вызов в похожую разрешённую операцию.
    agent_runtime_helpers.repair_tool_call = lambda agent, name: None if guest_mode() else repair(agent, name)
    guarded_common.__wrapped__ = common
    guarded_invoke.__wrapped__ = invoke
    tool_executor._dispatch_authorized_once = guarded_common
    agent_runtime_helpers.invoke_tool = guarded_invoke


def install(*, cold_start=False):
    """Закрепить гостевой startup и общий guard registry до обнаружения инструментов."""
    global _installed, _guest, _role, _suspended, _startup_state, _managed_stt
    state = broker_call('permissions.bootstrap', {})
    if _installed:
        if state.get('role') != _role:
            raise PermissionError('Runtime role changed')
        _startup_state = state
        return _managed_stt
    _startup_state = state
    if state.get('role') not in ('creator','admin','user','guest'):
        raise PermissionError('Доступ не подтверждён')
    _role = state['role']
    _guest = _role == 'guest'
    _suspended = _guest or state.get('backgroundsSuspended') is True
    install_worker_watchdog()
    identity_worker = os.environ.get('BRAI_IDENTITY_MODE') == 'worker'
    if identity_worker:
        _managed_stt = install_managed_stt(Path('/opt/brai-profile/profile-config.json'))
    if _guest or state.get('staged') is True:
        product = Path(__file__).resolve().parents[1]
        restrict_exclusive_plugins(product)
        import hermes_cli.config as config
        accepted = protected_config('/opt/brai-profile/profile-config.json')
        # AIDEV-NOTE: Не читаем прежний личный config: он мог сохранить hooks, MCP и исполняемые плагины.
        protect_config_readers(config, accepted)
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
    if identity_worker:
        pin_telegram_plugin()
    if _guest:
        # Config/provider discovery уже закреплены до импорта браузера и producer-модулей.
        from .guest_browser import install as install_browser
        install_browser()
    from tools.registry import ToolRegistry
    definitions, dispatch = ToolRegistry.get_definitions, ToolRegistry.dispatch
    def guarded_definitions(self, tool_names, quiet=False):
        rows = definitions(self, {name for name in tool_names if catalog_permitted(name)}, quiet=quiet)
        if guest_mode():
            from .guest_tools import definitions as guest_definitions
            return guest_definitions(rows)
        return rows
    def guarded_dispatch(self, name, args, **kwargs):
        grant = broker_call('native.authorize', {'name': name})
        before = principal()
        expected = _execution_state.get()
        if ((expected is not None and expected != before) or grant.get('allowed') is not True
                or any(grant.get(key) != before.get(key) for key in ('role','generation'))
                or not arguments_permitted(name,args,before)):
            return json.dumps({'error': 'Это действие недоступно для вашей роли.'}, ensure_ascii=False)
        token = _tool_invocation.set(name)
        try:
            result = dispatch(self,name,args,**kwargs)
        finally:
            _tool_invocation.reset(token)
        if principal() != before:
            return json.dumps({'error': 'Права доступа изменились. Результат не выдан.'}, ensure_ascii=False)
        return result
    ToolRegistry.get_definitions, ToolRegistry.dispatch = guarded_definitions, guarded_dispatch
    install_executor_guard()
    if _guest:
        import brai_files
        from .guest_generation import install as install_generation, trusted_silero
        install_generation(role=lambda: _role, allowed=lambda name: current_tool() == name,
            operation=lambda: brai_files.operation_for({}), broker_call=broker_call,
            resolve_artifact=brai_files.resolve_artifact,
            trusted_tts=trusted_silero('/opt/brai-profile/runtime'))

    _installed = True
    if _suspended or state.get('staged') is True or cold_start:
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
            if not _suspended and active_configuration() and not getattr(self, '_brai_release_cold', False):
                return await recovery(self)
            # Только trusted discovery нужен admission health/human bridge.
            from hermes_cli.plugins import get_plugin_manager
            get_plugin_manager().discover_and_load()
            if not _suspended:
                defer(self, recovery)
        async def prepared_finish(self, connected_count):
            if not _suspended and active_configuration() and not getattr(self, '_brai_release_cold', False):
                return await finish(self, connected_count)
            self._startup_restore_in_progress = False
            if not _suspended:
                defer(self, finish, connected_count)
        def prepared_watchers(self):
            if not _suspended and active_configuration() and not getattr(self, '_brai_release_cold', False):
                return watchers(self)
            if _suspended:
                self._spawn_reconnect_watcher()
            else:
                defer(self, watchers)
        GatewayRunner._start_recover_previous_run = prepared_recovery
        GatewayRunner._start_finish_wiring = prepared_finish
        GatewayRunner._start_spawn_background_watchers = prepared_watchers
    return _managed_stt


def prepared_principal():
    """Ожидаемая личность, чьи trusted assets прошли bootstrap этого процесса."""
    return {'role': _role, 'generation': (_startup_state or {}).get('generation')}


def has_deferred_startup(runner):
    """Health готовит каталог; исполнение старых работ отдельно ждёт Auth active."""
    return bool(getattr(runner, '_brai_deferred_startup', ()))


async def activate_deferred_startup(runner, adapter, check, *, release_open=None):
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
    async def restore():
        if release_open is not None:
            await release_open.wait()
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

    if release_open is not None:
        # Auth and attachment are settled; source recovery remains held and durable.
        import asyncio
        return asyncio.create_task(restore())
    await restore()



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
