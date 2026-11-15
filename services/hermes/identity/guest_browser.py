# ABOUTME: Закрепляет гостевой browser client за принятым PM и личным CDP.
# ABOUTME: Не устанавливает программы и не читает пользовательскую конфигурацию браузера.
"""Устанавливается только для подтверждённого гостевого worker до вызовов browser tools."""
import json
import os
from pathlib import Path
import stat

CDP_URL = 'http://127.0.0.1:19364'
CONFIG = '/opt/brai-profile/browser-defaults.json'
PM_ROOT = Path('/opt/brai-profile/pm')


def accepted_binary(*, validate=True):
    """Вернуть только принятый PM binary из readonly дерева или завершиться ошибкой."""
    import pm
    installed = pm.installed_package('agent-browser')
    if installed is None or installed.binary is None:
        raise FileNotFoundError('Accepted agent-browser is unavailable')
    binary = Path(installed.binary)
    try:
        if not binary.is_absolute() or not binary.is_relative_to(PM_ROOT):
            raise ValueError('outside accepted PM')
        for path in (binary, *binary.parents):
            info = path.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
                raise ValueError('untrusted PM path')
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError('not executable')
    except (OSError, ValueError) as error:
        raise FileNotFoundError('Accepted agent-browser is unavailable') from error
    return str(binary)


def command_env(socket_dir):
    """Оставить только управляющий сокет и неизменяемый config для agent-browser."""
    from pm import env_for
    env = env_for('agent-browser', base_env={'PATH': '/usr/bin:/bin', 'HOME': os.environ['HOME'],
                                              'TMPDIR': '/tmp'})
    env = {key: value for key, value in env.items() if not key.startswith('AGENT_BROWSER_')}
    env['AGENT_BROWSER_CONFIG'] = CONFIG
    env['AGENT_BROWSER_SOCKET_DIR'] = socket_dir
    return env


def guarded_spawn(original, argv, env, socket_dir, tag, stdin_payload=None):
    """Не исполнять клиент без единственного fixed CDP даже после ошибки или retry SDK."""
    binary = accepted_binary()
    try:
        boundary = argv.index('--json')
        options = argv[1:boundary]
        if (argv[0] != binary or options.count('--cdp') != 1
                or options[options.index('--cdp') + 1] != CDP_URL
                or argv.count('--cdp') != 1
                or any(option in ('--engine', '--headed') or
                       option.startswith(('--cdp=', '--engine=', '--headed=')) for option in argv[1:])):
            raise ValueError('unsafe browser command')
    except (IndexError, ValueError) as error:
        raise PermissionError('Unsafe guest browser command') from error
    return original(argv, command_env(socket_dir), socket_dir, tag, stdin_payload)



def data_arguments(original, argv0, command, args):
    """Передавать введённый текст как JSON-данные, не как глобальные флаги CLI."""
    if command in ('fill','type'):
        # agent-browser 0.26 batch не перечитывает global Flags из отдельных JSON-команд.
        return 'batch', [], json.dumps([[command,*args]],ensure_ascii=False).encode('utf-8')
    return original(argv0,command,args)


def public_url(url):
    """Worker не имеет DNS; все адреса проверяет Root public egress перед connect."""
    from .guest_tools import validate
    return validate('browser_navigate', {'url': url})


def install():
    """Закрыть fallback и подмену окружения до использования native browser tools."""
    from tools import (browser_tool, browser_tool_cdp, browser_tool_install, browser_tool_session,
                       browser_tool_lightpanda_fallback, browser_tool_real_profile)
    for key in list(os.environ):
        if key.startswith('AGENT_BROWSER_'):
            del os.environ[key]
    os.environ['AGENT_BROWSER_CONFIG'] = CONFIG
    os.environ['BROWSER_CDP_URL'] = CDP_URL
    browser_tool_cdp._get_cdp_override_raw = lambda: CDP_URL
    # Синтаксис/literal IP проверяются здесь, DNS/redirect/private network — на Root proxy.
    browser_tool._is_safe_url = public_url
    browser_tool_install._find_agent_browser = accepted_binary
    browser_tool_session._agent_browser_command_env = command_env
    original_arguments = browser_tool_session._shim_safe_args
    browser_tool_session._shim_safe_args = lambda argv0, command, args: (
        data_arguments(original_arguments,argv0,command,args))

    browser_tool_session._create_session_for_key = lambda task_id, force_local: (
        browser_tool_session._create_cdp_session(task_id, CDP_URL))
    browser_tool_session._browser_command_preflight = lambda: {'browser_cmd': accepted_binary()}
    browser_tool_lightpanda_fallback._lightpanda_fallback_reason = lambda *args: None
    def refuse(*args, **kwargs):
        raise PermissionError('Guest browser requires fixed CDP')
    browser_tool_real_profile._launch_real_profile_chrome = refuse
    browser_tool_real_profile._capture_agent_browser_cli = refuse
    original_dispatch = browser_tool_session._dispatch_browser_command
    def dispatch(task_id, session_info, browser_cmd, command, args, timeout, _engine_override):
        session = {**session_info, 'cdp_url': CDP_URL, 'bb_session_id': None,
                   'features': {'cdp_override': True}}
        return original_dispatch(task_id, session, browser_cmd, command, args, timeout, 'auto')
    browser_tool_session._dispatch_browser_command = dispatch
    original_spawn = browser_tool_session._popen_agent_browser
    def spawn(argv, env, socket_dir, tag, stdin_payload=None):
        return guarded_spawn(original_spawn, argv, env, socket_dir, tag, stdin_payload)
    browser_tool_session._popen_agent_browser = spawn
