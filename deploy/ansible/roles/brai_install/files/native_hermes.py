#!/usr/bin/python3
# ABOUTME: Устанавливает отдельный native Hermes и защищённый профиль PROD.
# ABOUTME: Принимает явные software inputs; не копирует OAuth, память и переписку.
"""Native Hermes lifecycle shared by the standalone installer and host operations."""
import argparse
import copy
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

CORE = '517b5e10febd619ce30bb22580e29b160266eb43'
CUSTOM = 'e0b72f2a982b0f87dded09b11533bffada7ed07d'
MEMOS = 'a7367d07e55db61099f7b4e2c1108bc5831a24f3'
OVERLAYS = [
    {'revision': '9b1bcd4ab4901d263ff6056dd2133f8309bbddc9', 'path': 'patches/telegram-stream-delivery.patch',
     'sha256': '693ab4056c99bf00f5268ff1d964d07f6be8f2d5c1ceb14a75dfa1be1b77adcc'},
    {'revision': '2f0d6684bd234e7a2a7168bc7d803f2dc9914bea', 'path': 'patches/telegram-media-display.patch',
     'sha256': 'ba7b6e72b540edea7ac5b0408db7d041ddd59b26565ba73747aa54735c3ad4e0'}]
CORE_OVERLAY_HASHES = {
    'gateway/platforms/base.py': '2dade0db5911b4894df40e2188c234d044b42279468b3e1294a21bb97e7f96b5',
    'plugins/platforms/telegram/adapter.py': '46a6fd3270cbc0634600c61d07eea47fa72b46e157f8b1c9842d911f97ffd8d6',
    'gateway/run_turn.py': 'd531f9a14525e06725df526989f4ce650c30ee471af011e2900fbe036946a1fd'}
PROFILE = Path('/var/lib/brai/hermes')
CONFIG = Path('/etc/brai/hermes')
RUNTIME = Path('/opt/brai-codeworks/prod-hermes')
PORTS = {'memos': 19371, 'bridge': 19372, 'embedding': 19373, 'browser': 19374}


def require(value, code='HERMES_PRODUCTION_REJECTED'):
    """Остановить операцию без вывода значений закрытой конфигурации."""
    if not value:
        raise ValueError(code)


def run(argv, *, data=None, env=None, account=None, cwd=None, optional=False, timeout=600):
    """Исполнить одну bounded операцию; вывод дочернего процесса остаётся закрытым."""
    identity = {} if account is None else {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []}
    result = subprocess.run(argv, input=data, env=env, cwd=cwd, text=True,
                            capture_output=True, timeout=timeout, **identity)
    require(optional or result.returncode == 0, 'HERMES_PRODUCTION_COMMAND_FAILED')
    return result


def encoded(value):
    """Канонические байты квитанции и конфигурации."""
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def private(path, uid=0, gid=0):
    """Прочитать единственный root/owner0600 файл без symlink и hardlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and item.st_uid == uid
                and item.st_gid == gid and stat.S_IMODE(item.st_mode) == 0o600
                and item.st_size <= 16 * 1024 * 1024, 'HERMES_PRODUCTION_PRIVATE_METADATA')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            return source.read()
    finally:
        os.close(fd)


def put(path, raw, account=None, mode=0o600):
    """Создать файл один раз или сверить его точные байты и владельца."""
    path = Path(path)
    uid, gid = (0, 0) if account is None else (account.pw_uid, account.pw_gid)
    if path.exists() or path.is_symlink():
        item = path.lstat()
        require(stat.S_ISREG(item.st_mode) and item.st_uid == uid and item.st_gid == gid
                and item.st_nlink == 1 and stat.S_IMODE(item.st_mode) == mode and path.read_bytes() == raw,
                'HERMES_PRODUCTION_EXISTING_FILE_CHANGED')
        return False
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    os.fchown(fd, uid, gid)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'wb') as destination:
        destination.write(raw)
        destination.flush()
        os.fsync(destination.fileno())
    return True


def directory(path, account=None, mode=0o700):
    """Создать свой каталог; не менять права уже существующего каталога."""
    path = Path(path)
    uid, gid = (0, 0) if account is None else (account.pw_uid, account.pw_gid)
    require(not any(parent.is_symlink() for parent in [path, *path.parents]), 'HERMES_PRODUCTION_DIRECTORY_SYMLINK')
    if path.exists():
        item = path.lstat()
        require(stat.S_ISDIR(item.st_mode) and (item.st_uid, item.st_gid) == (uid, gid)
                and stat.S_IMODE(item.st_mode) == mode, 'HERMES_PRODUCTION_DIRECTORY_METADATA')
    else:
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        os.chmod(path, mode)


def descriptor(shared=False):
    """Вернуть публичное описание native runtime без серверных credentials."""
    home = '/var/lib/brai-dev/hermes-owner' if shared else '/var/lib/brai/hermes-owner'
    core = '/var/lib/brai-dev/hermes/hermes-agent' if shared else str(PROFILE / 'hermes-agent')
    custom = str(PROFILE / 'usercustom/hermescustom')
    return {'format': 'brai-hermes-native-v1', 'environment': 'prod',
            'owner': 'brai-hermes-dev' if shared else 'brai-hermes-production', 'home': home,
            'profile': str(PROFILE), 'config': str(CONFIG), 'runtime': str(RUNTIME),
            'ports': dict(PORTS), 'coreRevision': CORE, 'customRevision': CUSTOM,
            'memosRevision': MEMOS, 'codexVersion': '0.161.0',
            'coreOverlays': copy.deepcopy(OVERLAYS), 'coreOverlayHashes': dict(CORE_OVERLAY_HASHES),
            'coreRepository': 'https://github.com/NousResearch/hermes-agent.git',
            'customRepository': 'https://github.com/Q-Fox-Labs/hermescustom.git',
            'memosRepository': 'https://github.com/MemTensor/MemOS.git',
            'software': {'mode': 'shared-host' if shared else 'install', 'core': core, 'custom': custom},
            'tokenEnvironmentFile': ('/srv/projects/brai/.secrets/hermes_production_telegram.env' if shared
                                     else str(CONFIG / 'telegram-token.env')),
            'databaseNetwork': 'brai_database_private', 'filesNetwork': 'brai_files',
            'gatewayHost': '172.23.0.1', 'chrome': ('/opt/agent-browser-tools/chrome/154.0.8037.92/chrome-linux64/chrome'
                                                    if shared else '/opt/brai-hermes-browser/chrome-linux64/chrome'),
            'memosImage': 'brai-hermes-production-memos:' + MEMOS}


def validate(spec):
    """Проверить фиксированные production roots и явную host dependency."""
    require(spec.get('format') == 'brai-hermes-native-v1' and spec.get('environment') == 'prod'
            and spec.get('profile') == str(PROFILE) and spec.get('config') == str(CONFIG)
            and spec.get('runtime') == str(RUNTIME) and spec.get('ports') == PORTS
            and spec.get('coreRevision') == CORE and spec.get('customRevision') == CUSTOM
            and spec.get('memosRevision') == MEMOS and spec.get('coreOverlays') == OVERLAYS
            and spec.get('coreOverlayHashes') == CORE_OVERLAY_HASHES, 'HERMES_PRODUCTION_DESCRIPTOR_INVALID')
    shared = spec.get('software', {}).get('mode') == 'shared-host'
    expected = descriptor(shared)
    require(spec.get('software') == expected['software'] and spec.get('owner') == expected['owner']
            and spec.get('home') == expected['home']
            and spec.get('tokenEnvironmentFile') == expected['tokenEnvironmentFile'],
            'HERMES_PRODUCTION_SOFTWARE_INVALID')
    try:
        gateway = ipaddress.IPv4Address(spec.get('gatewayHost'))
    except (ValueError, TypeError):
        raise ValueError('HERMES_PRODUCTION_NETWORK_INVALID') from None
    require(gateway.is_private and not gateway.is_loopback and str(gateway) != '192.168.16.1'
            and spec.get('databaseNetwork') == 'brai_database_private'
            and re.fullmatch(r'[A-Za-z0-9_.-]+', spec.get('filesNetwork', '')),
            'HERMES_PRODUCTION_NETWORK_INVALID')
    require(all(isinstance(spec.get(key), str) and spec[key].startswith('/')
                and not any(char.isspace() for char in spec[key]) for key in ['chrome']),
            'HERMES_PRODUCTION_EXECUTABLE_INVALID')
    return spec


def payload():
    """Сверить каждый файл установленной immutable OCI поставки Hermes."""
    root = RUNTIME.resolve(strict=True)
    require(root.parent == Path('/opt/brai-components/hermes') and re.fullmatch('[0-9a-f]{64}', root.name),
            'HERMES_PRODUCTION_IMMUTABLE_PAYLOAD_REQUIRED')
    manifest = json.loads((root / 'artifact-manifest.json').read_text())
    require(manifest.get('format') == 'brai-component-runtime-v1' and manifest.get('componentId') == 'hermes',
            'HERMES_PRODUCTION_PAYLOAD_MANIFEST')
    required = {'services/hermes/tools.mjs', 'services/hermes/trusted.mjs', 'services/hermes/transcribe.mjs',
                'services/hermes/voice.mjs', 'services/agent/dist/publisher-mcp.js',
                'docs/user-agent/instructions/context.md'}
    files = manifest['files']
    require(required <= {item['path'] for item in files}, 'HERMES_PRODUCTION_PAYLOAD_INCOMPLETE')
    for item in files:
        name = Path(item['path'])
        require(not name.is_absolute() and '..' not in name.parts, 'HERMES_PRODUCTION_PAYLOAD_PATH')
        path = root / name
        require(not any(p.is_symlink() for p in path.parents if p != root and root in p.parents),
                'HERMES_PRODUCTION_PAYLOAD_PARENT')
        metadata = path.lstat()
        require(metadata.st_uid == 0 and not metadata.st_mode & 0o022, 'HERMES_PRODUCTION_PAYLOAD_WRITABLE')
        if item.get('symlink') is not None:
            require(path.is_symlink() and os.readlink(path) == item['symlink'], 'HERMES_PRODUCTION_PAYLOAD_SYMLINK')
        else:
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_size == item['size']
                    and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'],
                    'HERMES_PRODUCTION_PAYLOAD_HASH')
    return root, manifest


def environment(spec):
    """Передать native CLI тот же canonical Codex HOME и отдельный HERMES_HOME."""
    return dict(os.environ, HOME=spec['home'], CODEX_HOME=spec['home'] + '/.codex',
                HERMES_HOME=str(PROFILE), HERMES_ROOT=spec['software']['core'],
                HERMESCUSTOM_ROOT=spec['software']['custom'], GATEWAY_MULTIPLEX_PROFILES='false',
                PATH=str(PROFILE / 'bin') + ':' + spec['home'] + '/.local/bin:' + spec['home'] + '/media-venv/bin:/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')


def native_config(spec, settings, root):
    """Создать новый профиль из source-only defaults и принятых продуктовых инструкций."""
    values = json.loads((Path(spec['software']['custom']) / 'config/server-defaults.json').read_text())
    require(set(settings) <= {'model', 'auth', 'image_gen'}, 'HERMES_PRODUCTION_SETTINGS_ALLOWLIST')
    values.update(copy.deepcopy(settings))
    require(values['model'].get('provider') == 'openai-codex' and not values['model'].get('api_key'),
            'HERMES_PRODUCTION_CANONICAL_AUTH_REQUIRED')
    values['auth'].update(adopt_external_logins=False, codex_credential_owner='codex-cli')
    values['image_gen'] = {'provider': 'openai-codex'}
    values['updates']['check'] = False
    values['terminal']['cwd'] = str(PROFILE / 'workspace')
    values['gateway'].update(profile_routes=[], multiplex_profiles=False, auto_multiplex_migration=False,
                             media_delivery_allow_dirs=[str(PROFILE / 'results'), str(PROFILE / 'workspace'),
                                                       str(PROFILE / 'media/downloads')])
    values['skills']['create_dir'] = str(PROFILE / 'usercustom/userdata/skills')
    values['mcp_servers'] = {'brai': {'command': '/usr/local/bin/node', 'args': [str(RUNTIME / 'services/hermes/tools.mjs')],
        'env': {'BRAI_HERMES_CONFIG': str(CONFIG / 'tools.json')}}}
    values['agent']['system_prompt'] = ('Ты работаешь в Brai PROD. Используй только настроенные инструменты Brai.\n'
                                       + (root / 'docs/user-agent/instructions/context.md').read_text())
    for name in ['brai_telegram', 'mcp-brai']:
        if name not in values['platform_toolsets']['telegram']:
            values['platform_toolsets']['telegram'].append(name)
    values['plugins']['enabled'] = list(dict.fromkeys([*values['plugins']['enabled'], 'brai-telegram']))
    values['plugins']['entries']['brai-telegram'] = {'allow_gateway_injection': True}
    values['display'].setdefault('platforms', {})['telegram'] = {'streaming': True, 'interim_assistant_messages': True}
    values['tts']['providers']['silero']['command'] = '/usr/local/bin/node ' + str(RUNTIME / 'services/hermes/voice.mjs') + ' --input {input_path} --output {output_path} --voice {voice}'
    values['stt'] = {'enabled': True, 'language': 'ru', 'provider': 'brai_local_ai', 'providers': {'brai_local_ai': {
        'type': 'command', 'command': '/usr/local/bin/node ' + str(RUNTIME / 'services/hermes/transcribe.mjs') + ' --input {input_path} --output {output_path}',
        'output_format': 'txt', 'normalize': False, 'timeout': 200}}}
    return values


def units(spec, python):
    """Описать отдельные native units; gateway не включается при prepare."""
    base = ('[Service]\nUser=' + spec['owner'] + '\nGroup=' + spec['owner'] + '\n'
            'Environment=HOME=' + spec['home'] + '\nEnvironment=CODEX_HOME=' + spec['home'] + '/.codex\n'
            'Environment=HERMES_HOME=' + str(PROFILE) + '\nEnvironment=HERMES_ROOT=' + spec['software']['core'] + '\n'
            'Environment=HERMESCUSTOM_ROOT=' + spec['software']['custom'] + '\n'
            'Environment=GATEWAY_MULTIPLEX_PROFILES=false\n'
            'Environment=PATH=' + str(PROFILE / 'bin') + ':' + spec['home'] + '/.local/bin:' + spec['home'] + '/media-venv/bin:/usr/local/bin:/usr/bin:/bin\n'
            'Environment=BRAI_HERMES_CONFIG=' + str(CONFIG / 'tools.json') + '\n'
            'EnvironmentFile=' + str(CONFIG / 'runtime.env') + '\n'
            'UMask=0077\nNoNewPrivileges=true\nProtectHome=true\nPrivateTmp=true\n'
            'Restart=on-failure\nRestartSec=5\n')
    gateway = ('[Unit]\nDescription=Brai production Hermes\nAfter=network-online.target brai-hermes-production-memos.service brai-hermes-production-browser.service\n'
               'Requires=brai-hermes-production-memos.service\n' + base +
               'WorkingDirectory=' + str(PROFILE / 'workspace') + '\nEnvironment=TERMINAL_CWD=' + str(PROFILE / 'workspace') + '\n'
               'Environment=BRAI_HERMES_TRUSTED_ENTRY=' + str(RUNTIME / 'services/hermes/trusted.mjs') + '\n'
               'Environment=BRAI_HERMES_NODE_EXECUTABLE=/usr/local/bin/node\n'
               'Environment=BRAI_TELEGRAM_STATE_DIR=' + str(PROFILE / 'brai-telegram') + '\n'
               'Environment=BRAI_TELEGRAM_RESULT_ROOT=' + str(PROFILE / 'results') + '\n'
               'Environment=HERMES_MEDIA_DOWNLOAD_ROOT=' + str(PROFILE / 'media/downloads') + '\n'
               'Environment=GROQ_VOICE_SECRET_FILE=' + str(CONFIG / 'secrets/groq.env') + '\n'
               'Environment=BROWSER_CDP_URL=http://127.0.0.1:19374\nEnvironment=BU_CDP_URL=http://127.0.0.1:19374\n'
               'EnvironmentFile=' + str(CONFIG / 'telegram.env') + '\n'
               'EnvironmentFile=' + spec['tokenEnvironmentFile'] + '\n'
               'ExecStart=/usr/bin/python3 ' + str(CONFIG / 'gateway.py') + '\nKillMode=mixed\nTimeoutStopSec=70\n[Install]\nWantedBy=multi-user.target\n')
    bridge = ('[Unit]\nDescription=Brai production MemOS Codex bridge\nAfter=network-online.target\n' + base +
              'WorkingDirectory=' + str(RUNTIME / 'services/hermes/memos/bridge') + '\n'
              'Environment=MEMOS_CODEX_EXECUTABLE=' + spec['home'] + '/.local/bin/codex\n'
              'Environment=MEMOS_CODEX_WORKER_DIR=' + str(PROFILE / 'memos/worker') + '\n'
              'EnvironmentFile=' + str(CONFIG / 'memos/codex-bridge.env') + '\n'
              'ExecStart=' + str(PROFILE / 'memos/bridge-venv/bin/python') + ' ' + str(CONFIG / 'bridge.py') + '\n[Install]\nWantedBy=multi-user.target\n')
    embedding = ('[Unit]\nDescription=Brai production MemOS embeddings\nAfter=network-online.target\n' + base +
                 'WorkingDirectory=' + str(PROFILE / 'workspace') + '\n'
                 'ExecStart=/usr/local/bin/node ' + str(RUNTIME / 'services/hermes/memos/embedding/adapter.mjs') + '\n[Install]\nWantedBy=multi-user.target\n')
    browser = ('[Unit]\nDescription=Brai production isolated browser\nAfter=network.target\n' + base +
               'Environment=HOME=' + str(PROFILE / 'browser') + '\nEnvironment=XDG_CACHE_HOME=' + str(PROFILE / 'browser/.cache') + '\n'
               'ExecStart=' + spec['chrome'] + ' --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=19374 --user-data-dir=' + str(PROFILE / 'browser') + ' --no-first-run --no-default-browser-check about:blank\n'
               'ProtectSystem=strict\nReadWritePaths=' + str(PROFILE / 'browser') + '\nPrivateDevices=true\nCapabilityBoundingSet=\n[Install]\nWantedBy=multi-user.target\n')
    memos = ('[Unit]\nDescription=Brai production MemOS\nAfter=docker.service brai-hermes-production-codex-bridge.service brai-hermes-production-embeddings.service\n'
             'Requires=docker.service brai-hermes-production-codex-bridge.service brai-hermes-production-embeddings.service\n'
             '[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/docker compose -f ' + str(CONFIG / 'memos/compose.json') + ' up -d --pull never\n'
             'ExecStop=/usr/bin/docker compose -f ' + str(CONFIG / 'memos/compose.json') + ' stop\nTimeoutStartSec=180\n[Install]\nWantedBy=multi-user.target\n')
    intake = ('[Unit]\nDescription=Brai production owner-only secret intake\nAfter=network-online.target\n' + base +
              'WorkingDirectory=' + str(PROFILE / 'intake') + '\n'
              'EnvironmentFile=' + spec['tokenEnvironmentFile'] + '\n'
              'ExecStart=/usr/bin/python3 -B /usr/local/lib/brai-hermes/hermes_intake.py --config=' + str(CONFIG / 'intake.json') + '\n'
              'ProtectSystem=strict\nReadWritePaths=' + str(CONFIG / 'secrets') + '\n'
              'PrivateDevices=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\n'
              'RestrictSUIDSGID=true\nLockPersonality=true\nRestrictRealtime=true\n'
              'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nCapabilityBoundingSet=\nLimitCORE=0\n'
              'TasksMax=64\nMemoryMax=128M\nStandardOutput=null\nStandardError=journal\n[Install]\nWantedBy=multi-user.target\n')
    return {'brai-hermes-production.service': gateway, 'brai-hermes-production-codex-bridge.service': bridge,
            'brai-hermes-production-embeddings.service': embedding, 'brai-hermes-production-browser.service': browser,
            'brai-hermes-production-memos.service': memos, 'brai-hermes-production-intake.service': intake}


def bridge_launcher(spec):
    """Сохранить общий flock canonical auth для всего времени жизни memory CLI."""
    return ('# ABOUTME: Сериализует memory CLI с canonical Codex owner.\n'
            '# ABOUTME: Слушает только loopback и явный Docker gateway PROD.\n'
            'import importlib.util,socket,sys,uvicorn\n'
            'sys.path.insert(0,' + repr(str(RUNTIME / 'services/hermes/memos/bridge')) + ')\n'
            'import codex_bridge\n'
            's=importlib.util.spec_from_file_location("codex_cli_owner",' + repr(spec['software']['core'] + '/hermes_cli/codex_cli_owner.py') + ')\n'
            'owner=importlib.util.module_from_spec(s);s.loader.exec_module(owner)\n'
            'original=codex_bridge.run_codex\n'
            'async def locked(*args,**kwargs):\n'
            '    try:\n'
            '        async with owner.owner_lock_async(timeout=180):\n'
            '            return await original(*args,**kwargs)\n'
            '    except owner.OwnerError:\n'
            '        raise codex_bridge.HTTPException(503,"Codex credential owner unavailable") from None\n'
            'codex_bridge.run_codex=locked\n'
            'listeners=[]\n'
            'try:\n'
            '    for host in ("127.0.0.1",' + repr(spec['gatewayHost']) + '):\n'
            '        listener=socket.socket();listeners.append(listener)\n'
            '        listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n'
            '        listener.bind((host,19372));listener.listen(128)\n'
            '    uvicorn.Server(uvicorn.Config(codex_bridge.app,access_log=False)).run(sockets=listeners)\n'
            'finally:\n'
            '    for listener in listeners:listener.close()\n').encode()


def gateway_launcher(spec):
    """Нормализовать token только в окружении дочернего native gateway, без записи."""
    return ('# ABOUTME: Подключает новый production bot к native gateway.\n'
            '# ABOUTME: Токен поступает только через systemd EnvironmentFile и не сохраняется.\n'
            'import os,sys\n'
            'keys=("TELEGRAM_BOT_TOKEN","BRAI_AI_BOT_TOKEN","BRAI_TELEGRAM_BOT_TOKEN","BOT_TOKEN")\n'
            'tokens={os.environ[k] for k in keys if os.environ.get(k)}\n'
            'if len(tokens)!=1:sys.exit("HERMES_PRODUCTION_BOT_TOKEN_REQUIRED")\n'
            'os.environ["TELEGRAM_BOT_TOKEN"]=tokens.pop()\n'
            'binary=' + repr(spec['home'] + '/.local/bin/hermes') + '\n'
            'os.execve(binary,[binary,"gateway","run"],os.environ)\n').encode()


def memory(spec):
    """Загрузить общий PROD MemOS lifecycle с explicit canonical auth owner."""
    path = Path(__file__).with_name('hermes_memos.py')
    module_spec = importlib.util.spec_from_file_location('native_hermes_memos', path)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    module.OWNER_HOME = Path(spec['home'])
    module.CUSTOM_REVISION = spec['customRevision']
    module.account = lambda: pwd.getpwnam(spec['owner'])
    module.ROUTING_DEFAULTS = Path(spec['software']['custom']) / 'plugins/memos-rest/routing.defaults.json'
    return module


def python_runtime(spec):
    """Найти native Python Hermes без изменения installed software."""
    identity = pwd.getpwnam(spec['owner'])
    source = Path('/var/lib/brai-dev/hermes') if spec['software']['mode'] == 'shared-host' else PROFILE
    for interpreter in sorted((source / 'installs').glob('*/environments/*/venv/bin/python')):
        env = dict(environment(spec), PYTHONPATH=spec['software']['core'])
        result = run([str(interpreter), '-c', 'import agent.memory_manager,plugins.memory'],
                     account=identity, env=env, optional=True, timeout=30)
        if result.returncode == 0:
            return str(interpreter)
    raise ValueError('HERMES_PRODUCTION_NATIVE_PYTHON_REQUIRED')


def validate_inputs(spec, inputs):
    """Проверить production owner и endpoints без раскрытия bearer/NATS паролей."""
    require(set(inputs) == {'ownerId', 'tools', 'publisher', 'settings', 'telegram', 'intake'},
            'HERMES_PRODUCTION_INPUT_SHAPE')
    owner = inputs['ownerId']
    tools, publisher = inputs['tools'], inputs['publisher']
    require(isinstance(owner, str) and 1 <= len(owner) <= 128 and not any(c.isspace() for c in owner)
            and tools.get('ownerId') == publisher.get('ownerId') == owner
            and tools.get('gameCore') == {'url': 'http://127.0.0.1:19346/mcp', 'ownerId': owner},
            'HERMES_PRODUCTION_OWNER_BINDING')
    require(tools.get('nats', {}).get('servers') == ['nats://127.0.0.1:4222']
            and tools['nats'].get('user') == 'hermes'
            and publisher.get('artifacts', {}).get('nats', {}).get('servers') == ['nats://127.0.0.1:4222']
            and publisher['artifacts']['nats'].get('user') == 'hermes_publisher',
            'HERMES_PRODUCTION_BROKER_BINDING')
    require(tools.get('publisher') == {'configPath': str(CONFIG / 'publisher.json')}
            and publisher.get('resultRoot') == str(PROFILE / 'results')
            and publisher.get('allowedReadRoots') == [str(PROFILE / p) for p in ['workspace', 'media/downloads', 'cache/generated/images']],
            'HERMES_PRODUCTION_PUBLISHER_ROOTS')
    embedding = tools.get('embedding', {})
    require(embedding.get('port') == PORTS['embedding'] and embedding.get('host') == spec['gatewayHost']
            and isinstance(embedding.get('apiKey'), str) and len(embedding['apiKey']) >= 32,
            'HERMES_PRODUCTION_EMBEDDING_INPUT')
    raw = encoded({'tools': tools, 'publisher': publisher}).decode()
    require(not any(v in raw for v in ['/srv/projects/brai-dev', '/etc/brai-dev', 'dev.brai.one', ':4223', ':1935']),
            'HERMES_PRODUCTION_DEV_DATA_DEPENDENCY')
    telegram = inputs['telegram']
    require(set(telegram) == {'ownerId', 'chatId'}
            and re.fullmatch('[1-9][0-9]*', str(telegram['ownerId']))
            and re.fullmatch('-?[1-9][0-9]*', str(telegram['chatId']))
            and (str(telegram['chatId']).startswith('-') or str(telegram['chatId']) == str(telegram['ownerId'])),
            'HERMES_PRODUCTION_TELEGRAM_ROUTE')
    intake = inputs['intake']
    require(set(intake) == {'bind', 'port', 'origin'} and intake.get('bind') == spec['gatewayHost']
            and intake.get('port') == 19379 and isinstance(intake.get('origin'), str)
            and re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?', intake['origin'])
            and 'dev.brai.one' not in intake['origin'], 'HERMES_PRODUCTION_INTAKE_INPUT')


def intake_config(inputs):
    """Описать только новый listener и owner-private каталог секретов."""
    return dict(inputs['intake'], owner_id=int(inputs['telegram']['ownerId']), secret_dir=str(CONFIG / 'secrets'))


def verify_intake(inputs):
    """Проверить реальные assets и отказ неавторизованной формы без Telegram/Groq."""
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base='http://'+inputs['intake']['bind']+':'+str(inputs['intake']['port'])+'/connect/groq/'
    try:
        with opener.open(base,timeout=5) as response:
            expected=Path(__file__).with_name('hermes_intake_assets').joinpath('index.html').read_bytes()
            require(response.status==200 and response.read(len(expected)+1)==expected
                    and response.headers.get('Cache-Control')=='no-store, max-age=0',
                    'HERMES_PRODUCTION_INTAKE_HEALTH')
        request=urllib.request.Request(base+'authorize',data=b'{"init_data":""}',method='POST',
            headers={'Content-Type':'application/json','Origin':inputs['intake']['origin']})
        try:
            opener.open(request,timeout=5).close()
        except urllib.error.HTTPError as error:
            code=error.code;error.close()
            require(code==403,'HERMES_PRODUCTION_INTAKE_AUTH_GUARD')
        else:raise ValueError('HERMES_PRODUCTION_INTAKE_AUTH_GUARD')
    except (OSError,urllib.error.URLError):
        raise ValueError('HERMES_PRODUCTION_INTAKE_HEALTH') from None


def validate_client_access(inputs):
    """Требовать собственные client credentials; exported shared-owner bundle их не содержит."""
    import base64
    auth = inputs.get('native_hermes_auth', {}).get('content')
    token = inputs.get('native_hermes_token_environment')
    require(isinstance(auth, str) and bool(auth) and isinstance(token, str) and bool(token),
            'HERMES_PRODUCTION_CLIENT_AUTH_AND_BOT_INPUT_REQUIRED')
    try:
        value = json.loads(base64.b64decode(auth, validate=True))
        tokens = value['tokens']
        require(all(isinstance(tokens.get(key), str) and bool(tokens[key])
                    for key in ['access_token', 'refresh_token', 'account_id']),
                'HERMES_PRODUCTION_CLIENT_CANONICAL_AUTH_INVALID')
    except (ValueError, KeyError, TypeError):
        raise ValueError('HERMES_PRODUCTION_CLIENT_CANONICAL_AUTH_INVALID') from None
    require('\x00' not in token and len(token) <= 65536,
            'HERMES_PRODUCTION_CLIENT_BOT_INPUT_INVALID')


def source_state(spec):
    """Проверить pinned source kit и core HEAD, не читая OAuth state."""
    identity = pwd.getpwnam(spec['owner'])
    for path, revision in [(spec['software']['core'], CORE), (spec['software']['custom'], CUSTOM)]:
        actual = run(['/usr/bin/git', '-c', 'safe.directory=' + path, '-C', path, 'rev-parse', 'HEAD']).stdout.strip()
        require(actual == revision, 'HERMES_PRODUCTION_SOURCE_PIN')
    for name, expected in CORE_OVERLAY_HASHES.items():
        require(hashlib.sha256((Path(spec['software']['core']) / name).read_bytes()).hexdigest() == expected,
                'HERMES_PRODUCTION_NATIVE_OVERLAY_DRIFT')
    media = Path(spec['home']) / 'media-venv/bin/python'
    versions = run([str(media), '-c', 'import importlib.metadata as m,json;print(json.dumps({k:m.version(k) for k in ["yt-dlp","instaloader"]}))'],
                   account=identity, env=environment(spec)).stdout
    require(json.loads(versions) == {'yt-dlp': '2026.8.19', 'instaloader': '4.15.3'},
            'HERMES_PRODUCTION_MEDIA_SOFTWARE_DRIFT')
    run(['/usr/bin/python3', spec['software']['custom'] + '/tools/connect.py', '--profile-dir', str(PROFILE), '--check'],
        env=environment(spec), account=identity, timeout=60)
    for path in [Path(spec['home']), Path(spec['home']) / '.codex']:
        metadata = path.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == identity.pw_uid
                and metadata.st_gid == identity.pw_gid and stat.S_IMODE(metadata.st_mode) == 0o700,
                'HERMES_PRODUCTION_CANONICAL_HOME')
    # AIDEV-NOTE: Проверяется только metadata. Ни OAuth bytes, ни refresh здесь не читаются.
    auth = Path(spec['home']) / '.codex/auth.json'
    if auth.exists() or auth.is_symlink():
        metadata = auth.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and metadata.st_uid == identity.pw_uid and metadata.st_gid == identity.pw_gid
                and stat.S_IMODE(metadata.st_mode) == 0o600, 'HERMES_PRODUCTION_CANONICAL_AUTH_METADATA')


def compose_document(spec, identity):
    """Описать MemOS с отдельным state и существующей PROD database/files сетью."""
    source = ('/var/lib/brai-dev/hermes/memos/source' if spec['software']['mode'] == 'shared-host'
              else str(PROFILE / 'memos/source'))
    image = ('brai-hermes-dev-memos:' + MEMOS if spec['software']['mode'] == 'shared-host' else spec['memosImage'])
    return {'name': 'brai-hermes-production-memos', 'services': {'api': {
        'image': image, 'pull_policy': 'never', 'container_name': 'brai-hermes-production-memos',
        'restart': 'unless-stopped', 'user': f'{identity.pw_uid}:{identity.pw_gid}',
        'env_file': [str(CONFIG / 'memos/runtime.env')],
        'environment': {'PYTHONPATH': '/app/src', 'MEMOS_BASE_PATH': '/var/lib/memos',
                        'FILE_LOCAL_PATH': '/var/lib/memos/downloads', 'HOME': '/var/lib/memos'},
        'command': ['uvicorn', 'memos.api.server_api:app', '--host', '0.0.0.0', '--port', '8000', '--workers', '1'],
        'ports': ['127.0.0.1:19371:8000'],
        'volumes': [source + '/src:/app/src:ro', str(PROFILE / 'memos/data') + ':/var/lib/memos'],
        'networks': ['database', 'files'], 'security_opt': ['no-new-privileges:true'],
        'cap_drop': ['ALL'], 'pids_limit': 256, 'mem_limit': '2g',
        'healthcheck': {'test': ['CMD', 'python', '-c', "import urllib.request; urllib.request.urlopen('http://localhost:8000/health',timeout=5)"],
                        'interval': '30s', 'timeout': '10s', 'retries': 5, 'start_period': '120s'},
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}},
        'networks': {'database': {'external': True, 'name': spec['databaseNetwork']},
                     'files': {'external': True, 'name': spec['filesNetwork']}}}


def install_instructions(root, identity):
    """Подключить полный принятый набор продукта к свежему профилю."""
    docs = root / 'docs/user-agent/instructions/hermes'
    require((docs / 'INDEX.md').is_file() and (docs / 'BASE.md').is_file(),
            'HERMES_PRODUCTION_INSTRUCTIONS_REQUIRED')
    soul = PROFILE / 'SOUL.md'
    text = soul.read_text()
    begin, end = '<!-- docshermes:begin -->', '<!-- docshermes:end -->'
    require(text.count(begin) == text.count(end) == 1, 'HERMES_PRODUCTION_SOUL_ROUTE_SHAPE')
    before, rest = text.split(begin, 1)
    _, after = rest.split(end, 1)
    router = PROFILE / 'usercustom/userdata/instructions/ROUTING.md'
    route = (begin + '\n## Обязательное чтение\n\nПри каждом новом запуске/сессии до первого ответа или действия '
             'полностью прочитай инструментом или terminal, по порядку:\n'
             f'1. [INDEX.md]({docs / "INDEX.md"})\n2. [BASE.md]({docs / "BASE.md"})\n'
             f'3. [ROUTING.md]({router})\n\nЧитай до конца; если вывод обрезан, дочитай оставшиеся части. '
             'Пустой ROUTING.md допустим. Ссылка, пересказ или снимок прошлой сессии чтение не заменяют. '
             'Затем читай только обязательные и подходящие задаче маршруты. При недоступном файле сообщи '
             'владельцу и останови зависимую работу. AGENTS.md/INSTALL.md предназначены внешнему установщику.\n' + end)
    soul.write_text(before + route + after)
    source = root / 'docs/user-agent/instructions/skills/brai-task-workflows'
    target = PROFILE / 'skills/brai-task-workflows'
    require(source.is_dir(), 'HERMES_PRODUCTION_WORKFLOW_SKILL_REQUIRED')
    if target.exists() or target.is_symlink():
        require(target.is_symlink() and target.resolve() == source, 'HERMES_PRODUCTION_WORKFLOW_SKILL_REQUIRED')
    else:
        target.symlink_to(source)
    return hashlib.sha256(soul.read_bytes()).hexdigest()


def wait_dependencies(timeout=180):
    """Дождаться реальной готовности нового MemOS перед native acceptance."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = run(['/usr/bin/docker', 'inspect', 'brai-hermes-production-memos'], optional=True)
        if result.returncode == 0:
            state = json.loads(result.stdout)[0]['State']
            if state.get('Running') and state.get('Health', {}).get('Status') == 'healthy':
                return
        time.sleep(2)
    raise ValueError('HERMES_PRODUCTION_MEMOS_UNHEALTHY')


def prepare(spec, inputs):
    """Создать новый PROD профиль; законченный повтор выполняет только сверку."""
    marker = CONFIG / 'installed.json'
    if marker.exists() or marker.is_symlink():
        verify(spec, inputs)
        return False
    identity = pwd.getpwnam(spec['owner'])
    source_state(spec)
    root, manifest = payload()
    for host in ['127.0.0.1', spec['gatewayHost']]:
        for port in [*PORTS.values(), 19379]:
            with socket.socket() as probe:
                require(probe.connect_ex((host, port)) != 0, 'HERMES_PRODUCTION_PORT_IN_USE')
    directory(PROFILE, identity)
    for relative in ['workspace', 'results', 'brai-telegram', 'browser', 'bin', 'cache', 'cache/generated',
                     'cache/generated/images', 'media', 'media/downloads', 'usercustom', 'memos', 'memos/worker', 'intake']:
        directory(PROFILE / relative, identity)
    directory(CONFIG, type('Account', (), {'pw_uid': 0, 'pw_gid': identity.pw_gid})(), 0o750)
    put(CONFIG / 'codeworks-instance.json', encoded(spec))
    put(CONFIG / 'native-inputs.json', encoded(inputs))
    directory(CONFIG / 'secrets', identity)
    put(CONFIG / 'intake.json', encoded(intake_config(inputs)), identity)
    put(CONFIG / 'tools.json', encoded(inputs['tools']), identity)
    put(CONFIG / 'publisher.json', encoded(inputs['publisher']), identity)
    put(CONFIG / 'runtime.env', ('BRAI_HERMES_OWNER_ID=' + inputs['ownerId'] + '\n').encode(), identity)
    route = inputs['telegram']
    telegram = {'TELEGRAM_ALLOWED_CHATS': str(route['chatId']), 'TELEGRAM_ALLOWED_USERS': str(route['ownerId']),
                'TELEGRAM_GROUP_ALLOWED_USERS': str(route['ownerId']), 'BRAI_TELEGRAM_CHAT_ID': str(route['chatId']),
                'BRAI_TELEGRAM_OWNER_ID': str(route['ownerId'])}
    put(CONFIG / 'telegram.env', ''.join(k + '=' + v + '\n' for k, v in telegram.items()).encode(), identity)
    connect = ['/usr/bin/python3', spec['software']['custom'] + '/tools/connect.py', '--profile-dir', str(PROFILE),
               '--owner-name', 'Владелец Brai', '--apply']
    if spec['software']['mode'] == 'install':
        connect.append('--overwrite')
    run(connect, env=environment(spec), account=identity, timeout=120)
    for target, source in [(PROFILE / 'hermes-agent', Path(spec['software']['core'])),
                           (PROFILE / 'usercustom/hermescustom', Path(spec['software']['custom']))]:
        if target != source:
            if target.exists() or target.is_symlink():
                require(target.is_symlink() and target.resolve() == source, 'HERMES_PRODUCTION_SOFTWARE_LINK_EXISTS')
            else:
                target.symlink_to(source)
    # Плагин читается из принятого payload; runtime state хранится только в новом профиле.
    plugin = PROFILE / 'plugins/brai-telegram'
    if plugin.exists() or plugin.is_symlink():
        require(plugin.is_symlink() and plugin.resolve() == root / 'services/hermes/telegram',
                'HERMES_PRODUCTION_TELEGRAM_PLUGIN_EXISTS')
    else:
        plugin.symlink_to(root / 'services/hermes/telegram')
    config = native_config(spec, inputs['settings'], root)
    config['mcp_servers']['brai']['env']['BRAI_HERMES_OWNER_ID'] = inputs['ownerId']
    put(PROFILE / 'config.yaml', encoded(config), identity)
    run(['/usr/bin/python3', spec['software']['custom'] + '/tools/prepare_user_data.py',
         '--profile-dir', str(PROFILE)], env=environment(spec), account=identity)
    soul_hash = install_instructions(root, identity)
    py = python_runtime(spec)
    put(CONFIG / 'bridge.py', bridge_launcher(spec), mode=0o644)
    put(CONFIG / 'gateway.py', gateway_launcher(spec), mode=0o644)
    wrapper = Path(__file__).with_name('hermes_ytdlp.py').read_bytes()
    put(PROFILE / 'bin/yt-dlp', wrapper, identity, 0o750)
    video = PROFILE / 'skills/media/youtube-content/scripts/video_workflow.py'
    require(video.is_file() and not video.is_symlink(), 'HERMES_PRODUCTION_VIDEO_SKILL_REQUIRED')
    video.write_bytes(Path(__file__).with_name('hermes_video_workflow.py').read_bytes())
    memos = memory(spec)
    memos.prepare(spec['gatewayHost'], identity.pw_uid, identity.pw_gid)
    bridge_venv = PROFILE / 'memos/bridge-venv'
    run(['/usr/bin/python3', '-m', 'venv', str(bridge_venv)], account=identity, env=environment(spec))
    run([str(bridge_venv / 'bin/pip'), 'install', '-r', str(root / 'services/hermes/memos/bridge/requirements.txt')],
        account=identity, env=environment(spec), timeout=900)
    directory(PROFILE / 'memos/data/downloads', identity)
    put(CONFIG / 'memos/compose.json', encoded(compose_document(spec, identity)))
    for unit, content in units(spec, py).items():
        put(Path('/etc/systemd/system') / unit, content.encode(), mode=0o644)
    run(['/usr/bin/systemctl', 'daemon-reload'])
    put(marker, encoded({'format': 'brai-hermes-production-v1', 'descriptor': spec,
                        'inputsSha256': hashlib.sha256(encoded(inputs)).hexdigest(),
                        'payloadHash': manifest['payloadHash'], 'nativePython': py, 'soulSha256': soul_hash}))
    verify(spec, inputs)
    return True


def verify(spec, inputs, *, running=False, activation=False):
    """Сверить software/config, изоляцию БД и доказательства реального native handoff."""
    source_state(spec)
    root, manifest = payload()
    identity = pwd.getpwnam(spec['owner'])
    installed = json.loads(private(CONFIG / 'installed.json'))
    require(installed.get('format') == 'brai-hermes-production-v1' and installed.get('descriptor') == spec
            and installed.get('inputsSha256') == hashlib.sha256(encoded(inputs)).hexdigest(),
            'HERMES_PRODUCTION_INSTALLED_INPUTS_CHANGED')
    require(json.loads(private(CONFIG / 'tools.json', identity.pw_uid, identity.pw_gid)) == inputs['tools']
            and json.loads(private(CONFIG / 'publisher.json', identity.pw_uid, identity.pw_gid)) == inputs['publisher'],
            'HERMES_PRODUCTION_RUNTIME_INPUTS_CHANGED')
    require(json.loads(private(CONFIG / 'intake.json', identity.pw_uid, identity.pw_gid)) == intake_config(inputs),
            'HERMES_PRODUCTION_INTAKE_INPUTS_CHANGED')
    secret_metadata=(CONFIG / 'secrets').lstat()
    require(stat.S_ISDIR(secret_metadata.st_mode) and secret_metadata.st_uid == identity.pw_uid
            and secret_metadata.st_gid == identity.pw_gid and stat.S_IMODE(secret_metadata.st_mode) == 0o700,
            'HERMES_PRODUCTION_INTAKE_SECRET_METADATA')
    import yaml
    config = yaml.safe_load(private(PROFILE / 'config.yaml', identity.pw_uid, identity.pw_gid))
    require(config == (native_config(spec, inputs['settings'], root) | {
        'mcp_servers': {'brai': {'command': '/usr/local/bin/node', 'args': [str(RUNTIME / 'services/hermes/tools.mjs')],
        'env': {'BRAI_HERMES_CONFIG': str(CONFIG / 'tools.json'), 'BRAI_HERMES_OWNER_ID': inputs['ownerId']}}}}),
        'HERMES_PRODUCTION_NATIVE_CONFIG_CHANGED')
    require(not (PROFILE / 'auth.json').exists() and not (PROFILE / '.codex').exists(),
            'HERMES_PRODUCTION_SECOND_AUTH_STORE')
    require(hashlib.sha256((PROFILE / 'SOUL.md').read_bytes()).hexdigest() == installed['soulSha256']
            and (PROFILE / 'skills/brai-task-workflows').resolve() == root / 'docs/user-agent/instructions/skills/brai-task-workflows',
            'HERMES_PRODUCTION_INSTRUCTIONS_CHANGED')
    for unit, content in units(spec, installed['nativePython']).items():
        # Codeworks owns only the separate WorkingDirectory drop-in, never this unit.
        require((Path('/etc/systemd/system') / unit).read_text() == content, 'HERMES_PRODUCTION_UNIT_CHANGED')
    memos = memory(spec)
    memos.verify(spec['gatewayHost'])
    if activation:
        config = memos.profile_state(identity.pw_uid, identity.pw_gid)
        memos.native_handoff(config, identity.pw_uid, identity.pw_gid)
        memos.acceptance(config['user_id'], config['memory_epoch'])
        require(config.get('enabled') is True and config.get('frozen') is False,
                'HERMES_PRODUCTION_MEMORY_NOT_ACTIVATED')
    if running:
        for name in ['codex-bridge', 'embeddings', 'memos', 'browser', 'intake']:
            run(['/usr/bin/systemctl', 'is-active', '--quiet', 'brai-hermes-production-' + name + '.service'])
        state = json.loads(run(['/usr/bin/docker', 'inspect', 'brai-hermes-production-memos']).stdout)[0]
        require(state['State']['Running'] and state['State'].get('Health', {}).get('Status') == 'healthy',
                'HERMES_PRODUCTION_MEMOS_UNHEALTHY')
        verify_intake(inputs)
    return True


def install_software(spec, inputs, *, askpass=None, install_root=None):
    """Создать независимый runtime из закреплённых Git sources; существующий не обновлять."""
    validate(spec)
    require(spec['software']['mode'] == 'install', 'HERMES_PRODUCTION_INSTALL_MODE_REQUIRED')
    identity = pwd.getpwnam(spec['owner'])
    home = Path(spec['home'])
    for path in [home, home / '.local', home / '.local/bin', home / '.codex', PROFILE, PROFILE / 'usercustom', PROFILE / 'memos']:
        directory(path, identity)
    repositories = [(Path(spec['software']['core']), spec['coreRepository'], CORE),
                    (Path(spec['software']['custom']), spec['customRepository'], CUSTOM),
                    (PROFILE / 'memos/source', spec['memosRepository'], MEMOS)]
    git_env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    if askpass:
        git_env.update(GIT_ASKPASS=str(askpass), BRAI_INSTALL_ROOT=str(install_root))
    for target, origin, revision in repositories:
        if not target.exists():
            run(['/usr/bin/git', 'clone', '--no-checkout', origin, str(target)], env=git_env, timeout=900)
            run(['/usr/bin/git', '-C', str(target), 'checkout', '--detach', revision], env=git_env, timeout=900)
            run(['/usr/bin/chown', '-hR', spec['owner'] + ':' + spec['owner'], str(target)])
        actual = run(['/usr/bin/git', '-c', 'safe.directory=' + str(target), '-C', str(target), 'rev-parse', 'HEAD']).stdout.strip()
        remote = run(['/usr/bin/git', '-c', 'safe.directory=' + str(target), '-C', str(target), 'remote', 'get-url', 'origin']).stdout.strip()
        require(actual == revision and remote == origin, 'HERMES_PRODUCTION_SOURCE_PIN')
    env = environment(spec)
    custom, core = Path(spec['software']['custom']), Path(spec['software']['core'])
    marker = PROFILE / '.native-software.json'
    patch = custom / 'patches/hermes-core.patch'
    expected = {'core': CORE, 'custom': CUSTOM, 'memos': MEMOS,
                'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(), 'codexVersion': spec['codexVersion']}
    if marker.exists():
        require(json.loads(private(marker, identity.pw_uid, identity.pw_gid)) == expected,
                'HERMES_PRODUCTION_SOFTWARE_RECEIPT_CHANGED')
        source_state(spec)
        return False
    run(['/usr/bin/python3', str(custom / 'tools/connect.py'), '--profile-dir', str(PROFILE), '--check'],
        env=env, account=identity)
    run(['/usr/bin/python3', str(custom / 'tools/apply_patch.py'), str(core), str(patch)], env=env, account=identity)
    for overlay in OVERLAYS:
        raw = run(['/usr/bin/git', '-c', 'safe.directory=' + str(custom), '-C', str(custom),
                   'show', overlay['revision'] + ':' + overlay['path']]).stdout.encode()
        require(hashlib.sha256(raw).hexdigest() == overlay['sha256'], 'HERMES_PRODUCTION_OVERLAY_SOURCE_HASH')
        target = PROFILE / ('native-overlay-' + overlay['sha256'] + '.patch')
        put(target, raw, identity)
        run(['/usr/bin/python3', str(custom / 'tools/apply_patch.py'), str(core), str(target)], env=env, account=identity)
    root, _ = payload()
    config = native_config(spec, inputs['settings'], root)
    config['mcp_servers']['brai']['env']['BRAI_HERMES_OWNER_ID'] = inputs['ownerId']
    put(PROFILE / 'config.yaml', encoded(config), identity)
    # AIDEV-NOTE: Обобщение меняет только новый engine клиента; shared DEV engine никогда не патчится.
    helper = core / 'hermes_cli/codex_cli_owner.py'
    original = helper.read_text()
    needle = "HOME = Path('/var/lib/brai-dev/hermes-owner')"
    require(original.count(needle) == 1, 'HERMES_PRODUCTION_OWNER_ADAPTER_SHAPE')
    helper.write_text(original.replace(needle, "HOME = Path(os.environ['HOME'])"))
    for stage in ['prerequisites', 'venv', 'python-deps', 'config', 'products', 'complete']:
        if stage == 'config':
            # Runtime configuration is prepared from the product contract after infrastructure setup.
            continue
        run(['/bin/bash', str(core / 'scripts/install.sh'), '--dir', str(core), '--hermes-home', str(PROFILE),
             '--stage', stage, '--non-interactive'], env=env, account=identity, cwd=core, timeout=3600)
    binary = home / '.local/bin/hermes'
    run([str(binary), 'pm', 'install', '--extra', 'telegram'], env=env, account=identity, cwd=home, timeout=3600)
    run(['/usr/local/bin/npm', 'install', '--prefix', str(home / '.local'), '--no-audit', '--no-fund',
         '@openai/codex@' + spec['codexVersion']], env=env, account=identity, cwd=home, timeout=900)
    codex = home / '.local/bin/codex'
    if not codex.exists():
        codex.symlink_to(home / '.local/node_modules/.bin/codex')
    media = home / 'media-venv'
    run(['/usr/bin/python3', '-m', 'venv', str(media)], env=env, account=identity)
    run([str(media / 'bin/pip'), 'install', '--constraint', str(Path(__file__).with_name('hermes-media-constraints.txt')),
         'yt-dlp[default,curl-cffi] @ https://files.pythonhosted.org/packages/69/b2/8cd1613f56eed7ceb64fbd4df3f1c01246bfb098e6f398228bafda22b80b/yt_dlp-2026.8.19-py3-none-any.whl#sha256=1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf'],
        env=env, account=identity, timeout=900)
    run([str(media / 'bin/pip'), 'install', '--require-hashes', '-r',
         str(Path(__file__).with_name('hermes-instaloader-requirements.txt'))], env=env, account=identity, timeout=900)
    memos_source = PROFILE / 'memos/source'
    memos_patch = Path(__file__).with_name('hermes-memos-postgres.patch')
    run(['/usr/bin/git', '-C', str(memos_source), 'apply', '--check', str(memos_patch)], account=identity)
    run(['/usr/bin/git', '-C', str(memos_source), 'apply', str(memos_patch)], account=identity)
    run(['/usr/bin/docker', 'build', '--tag', spec['memosImage'], '--file', str(memos_source / 'docker/Dockerfile'),
         str(memos_source)], timeout=3600)
    put(marker, encoded(expected), identity)
    return True


def operate(action, spec, inputs, *, running=False, start=False, activated=False):
    """Исполнить единственный lifecycle этап; gateway стартует только через activate."""
    validate_inputs(spec, inputs)
    if action == 'prepare':
        changed = prepare(spec, inputs)
        if start:
            for name in ['codex-bridge', 'embeddings', 'memos', 'browser', 'intake']:
                run(['/usr/bin/systemctl', 'enable', '--now', 'brai-hermes-production-' + name + '.service'])
            changed = True
        return {'changed': changed, 'prepared': True, 'functionalAcceptance': False}
    verify(spec, inputs, running=running or action != 'verify', activation=activated)
    if action == 'verify':
        return {'changed': False, 'prepared': True, 'dependenciesRunning': running}
    if action == 'accept-memory':
        import hermes_memory_acceptance
        return hermes_memory_acceptance.accept(spec)
    memos = memory(spec)
    memos.activate()
    verify(spec, inputs, running=True, activation=True)
    if action == 'activate-memory':
        return {'changed': True, 'memoryAccepted': True, 'gatewayStarted': False}
    # AIDEV-NOTE: Один явный вход разрешает включение только PROD unit.
    run(['/usr/bin/systemctl', 'enable', '--now', 'brai-hermes-production.service'])
    run(['/usr/bin/systemctl', 'is-active', '--quiet', 'brai-hermes-production.service'])
    return {'changed': True, 'gatewayActive': True, 'memoryAccepted': True}


def main():
    """Вызвать prepare, read-only verify или отдельную активацию готового профиля."""
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'verify', 'activate-memory', 'activate', 'accept-memory'])
    parser.add_argument('--descriptor', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--running', action='store_true')
    parser.add_argument('--start-dependencies', action='store_true')
    parser.add_argument('--activated', action='store_true')
    args = parser.parse_args()
    spec = validate(json.loads(private(args.descriptor)))
    inputs = json.loads(private(args.inputs))
    result = operate(args.action, spec, inputs, running=args.running, start=args.start_dependencies, activated=args.activated)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        safe = str(error)
        print(safe if re.fullmatch(r'HERMES_[A-Z_]+', safe) else 'HERMES_PRODUCTION_OPERATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
