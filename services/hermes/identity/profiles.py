# ABOUTME: Строит план личных профилей и системной изоляции Hermes.
# ABOUTME: Не назначает права по порядку сообщений и не изменяет сервер самостоятельно.
"""Чистое ядро установщика; применение плана принадлежит операторскому Ansible."""

import hashlib
import json
from pathlib import PurePosixPath
import re
import uuid

CUBES = ['main', 'life_work', 'life_society', 'life_systems', 'life_body',
         'life_vividness', 'life_relationships', 'life_intellect', 'life_comfort',
         'life_mission', 'life_capital', 'life_time', 'life_meaning', 'user', 'infra']


def _path(value):
    if (not isinstance(value, str) or not value.startswith('/') or
            any(c.isspace() or ord(c) in (0, 34, 37, 92) for c in value) or '..' in PurePosixPath(value).parts
            or str(PurePosixPath(value)) != value):
        raise ValueError('Invalid operator path')
    return value


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('Invalid identity')
    return value


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def plan_users(owner_telegram_id, owner_user_id, users, *, profile_root, existing=None):
    """Закрепить исходного владельца и детерминированные личные профили миграции."""
    root = _path(profile_root)
    owner = str(owner_telegram_id)
    if not owner.isascii() or not owner.isdecimal() or str(int(owner)) != owner or int(owner) <= 0:
        raise ValueError('Original Telegram owner is required')
    canonical_owner = _identifier(owner_user_id)
    if not isinstance(users, list) or not users:
        raise ValueError('Current users are required')
    known = existing or {}
    entries, telegram_ids, user_ids, profiles = [], set(), set(), set()
    for entry in users:
        if not isinstance(entry, dict) or set(entry) - {'telegramId', 'name'}:
            raise ValueError('Invalid current user')
        telegram = str(entry.get('telegramId', ''))
        if (not telegram.isascii() or not telegram.isdecimal() or str(int(telegram)) != telegram
                or int(telegram) <= 0 or telegram in telegram_ids):
            raise ValueError('Duplicate or invalid Telegram identity')
        telegram_ids.add(telegram)
        supplied = known.get(telegram) or {}
        user_id = supplied.get('userId') or (canonical_owner if telegram == owner else
                    str(uuid.uuid5(uuid.NAMESPACE_URL, 'brai:telegram:' + telegram)))
        user_id = _identifier(user_id)
        if telegram == owner and user_id != canonical_owner:
            raise ValueError('Original owner binding changed')
        profile_id = supplied.get('profileId') or str(uuid.uuid5(uuid.NAMESPACE_URL, 'brai:profile:' + user_id))
        if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', profile_id):
            raise ValueError('Invalid profile identity')
        if user_id in user_ids or profile_id in profiles:
            raise ValueError('Conflicting user/profile mapping')
        user_ids.add(user_id)
        profiles.add(profile_id)
        home = root + '/' + profile_id
        epoch = supplied.get('memoryEpoch') or _digest(['brai-user-memory-v1', user_id, profile_id])
        name = entry.get('name') or 'Пользователь'
        if not isinstance(name, str) or len(name) > 120 or any(ord(c) < 32 for c in name):
            raise ValueError('Invalid display name')
        entries.append({'telegramId': telegram, 'userId': user_id, 'profileId': profile_id,
                        'name': name, 'role': 'admin' if telegram == owner else 'user',
                        'username': 'braiu-' + _digest(user_id)[:20], 'home': home,
                        'homeScope': _digest(home), 'memoryEpoch': epoch, 'authorId': telegram,
                        'cubes': list(CUBES), 'status': 'provisioning'})
    if owner not in telegram_ids:
        raise ValueError('Original owner is absent from current users')
    entries.sort(key=lambda e: (e['telegramId'] != owner, int(e['telegramId'])))
    return {'version': 1, 'ownerTelegramId': owner, 'ownerUserId': canonical_owner,
            'profiles': entries, 'mappingHash': _digest(entries)}


def registry(plan, accounts, *, active=False):
    """Собрать root-owned реестр только после проверки реальных системных аккаунтов."""
    result, uids = {}, set()
    for profile in plan['profiles']:
        account = accounts.get(profile['username'])
        if (not isinstance(account, dict) or type(account.get('uid')) is not int
                or account['uid'] <= 0 or account['uid'] in uids
                or type(account.get('gid')) is not int or account['gid'] <= 0):
            raise ValueError('Missing or conflicting operating-system account')
        uid = account['uid']
        uids.add(uid)
        fields = ('userId', 'profileId', 'telegramId', 'username', 'home',
                  'homeScope', 'memoryEpoch', 'authorId', 'cubes')
        result[str(uid)] = {key: profile[key] for key in fields}
        result[str(uid)].update(status='active' if active else 'provisioning',
                                workerSocket=profile['home'] + '/control/worker.sock')
    return {'version': 1, 'profiles': result}


def native_profile(profile, *, relay_port=18080, instructions_root, model):
    """Создать нейтральную конфигурацию без bot token и общих credentials."""
    _path(instructions_root)
    if not isinstance(model, str) or not model or len(model) > 200 or any(ord(c) < 32 for c in model):
        raise ValueError('Explicit operator model is required')
    home = profile['home']
    return {
        'model': {'provider': 'brai-model', 'default': model},
        'providers': {'brai-model': {
            'base_url': 'http://127.0.0.1:' + str(relay_port) + '/model/v1',
            'transport': 'codex_responses'}},
        'browser': {'backend': 'browser-use'},
        'terminal': {'cwd': home + '/workspace'},
        'gateway': {'multiplex_profiles': False, 'profile_routes': [],
                    'auto_multiplex_migration': False,
                    'media_delivery_allow_dirs': [home + '/workspace', home + '/results', home + '/media/downloads']},
        'updates': {'check': False},
        'mcp_servers': {'brai': {'command': '/usr/bin/python3',
                               'args': [instructions_root + '/services/hermes/identity/tool_client.py']}},
        'memory': {'provider': 'memos-rest'},
        'plugins': {'enabled': ['memos-rest']},
        'agent': {'system_prompt': 'Ты — Brai, личный помощник пользователя. '
                                  'Работай только в разрешённой области своего профиля.'},
    }


def profile_for_user(user, *, profile_root):
    """Подготовить один профиль приглашения; назначение роли остаётся в Auth."""
    if not isinstance(user, dict) or user.get('status') != 'provisioning':
        raise ValueError('Provisioning user required')
    user_id = _identifier(user.get('id'))
    profile_id = user.get('profileId')
    if not isinstance(profile_id, str) or str(uuid.UUID(profile_id)) != profile_id:
        raise ValueError('Invalid profile identity')
    telegram = str(user.get('telegramId', ''))
    if not telegram.isascii() or not telegram.isdecimal() or str(int(telegram)) != telegram or int(telegram) <= 0:
        raise ValueError('Invalid Telegram identity')
    home = _path(profile_root) + '/' + profile_id
    return {'userId': user_id, 'profileId': profile_id, 'telegramId': telegram,
            'username': 'braiu-' + _digest(user_id)[:20], 'home': home,
            'homeScope': _digest(home),
            'memoryEpoch': _digest(['brai-user-memory-v1', user_id, profile_id]),
            'authorId': telegram, 'cubes': list(CUBES), 'status': 'provisioning'}


def worker_unit(profile, *, engine_root, runtime_root, python, ingress_uid,
                broker_socket, egress_socket, memory_socket, instance='dev',
                site_packages=None, instructions_root=None):
    """Задать отдельные UID и сеть, открыв лишь личный home и read-only software."""
    for value in (profile['home'], engine_root, runtime_root, python,
                  broker_socket, egress_socket, memory_socket):
        _path(value)
    if site_packages is not None:
        _path(site_packages)
    if instructions_root is not None:
        _path(instructions_root)
    if type(ingress_uid) is not int or ingress_uid < 0:
        raise ValueError('Invalid ingress UID')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', instance):
        raise ValueError('Invalid instance')
    _identifier(profile['userId'])
    home, user = profile['home'], profile['username']
    pm_key = hashlib.sha256(b'/opt/brai-profile/engine').hexdigest()[:16]
    pm_environment = '/opt/brai-profile/pm/installs/' + pm_key + '/environments/accepted/venv'
    software_root = str(PurePosixPath(runtime_root).parent)
    if not re.fullmatch(r'braiu-[0-9a-f]{20}', user):
        raise ValueError('Invalid profile account')
    prefix = 'brai-hermes-' + instance + '-identity-'
    python_root = str(PurePosixPath(python).parent.parent)
    python_name = PurePosixPath(python).name
    # AIDEV-NOTE: SDK telegram должен разрешаться раньше локального каталога адаптера telegram.
    paths = ['/opt/brai-profile/site-packages'] if site_packages else []
    paths.extend(['/opt/brai-profile/engine', '/opt/brai-profile/runtime/services/hermes'])
    lines = [
        '[Unit]', 'Description=Brai personal Hermes ' + profile['profileId'],
        'After=' + ' '.join(prefix + name + '.service' for name in ('broker', 'memory', 'egress')),
        'Requires=' + ' '.join(prefix + name + '.service' for name in ('broker', 'memory', 'egress')),
        'Wants=brai-hermes-' + instance + '-browser-' + profile['profileId'] + '.service',
        '[Service]', 'Type=simple', 'User=' + user, 'Group=' + user,
        'WorkingDirectory=' + home + '/workspace',
        'Environment=HOME=' + home, 'Environment=HERMES_HOME=' + home,
        'Environment=HERMES_ROOT=/opt/brai-profile/engine',
        'Environment=PYTHONPATH=' + ':'.join(paths),
        'Environment=PYTHONDONTWRITEBYTECODE=1', 'Environment=PYTHONUNBUFFERED=1',
        'Environment=PATH=/opt/brai-profile/python/bin:/usr/local/bin:/usr/bin:/bin',
        'Environment=OPENAI_API_KEY=profile-proxy-not-a-secret',
        'Environment=OPENAI_BASE_URL=http://127.0.0.1:18080/model/v1',
        'Environment=HTTP_PROXY=http://127.0.0.1:18080',
        'Environment=HTTPS_PROXY=http://127.0.0.1:18080',
        'Environment=BU_CDP_URL=http://127.0.0.1:19364',
        'Environment=http_proxy=http://127.0.0.1:18080',
        'Environment=https_proxy=http://127.0.0.1:18080',
        'Environment=NO_PROXY=127.0.0.1,localhost',
        'Environment=BRAI_IDENTITY_BROKER=/run/brai-profile/control.sock',
        'Environment=BRAI_IDENTITY_MEMORY=/run/brai-profile/memory.sock',
        'Environment=BRAI_IDENTITY_EGRESS=/run/brai-profile/egress.sock',
        'Environment=BRAI_IDENTITY_INGRESS_UID=' + str(ingress_uid),
        'Environment=BRAI_IDENTITY_USER_ID=' + profile['userId'],
        'Environment=BRAI_IDENTITY_TELEGRAM_ID=' + profile['telegramId'],
        'Environment=BRAI_IDENTITY_PROFILE_ID=' + profile['profileId'],
        'ExecStart=/opt/brai-profile/python/bin/' + python_name + ' -P -B -m identity.worker --config ' + home + '/worker.json',
        'UMask=0077', 'Restart=on-failure', 'RestartSec=3',
        'PrivateNetwork=yes', 'PrivateTmp=yes', 'PrivateDevices=yes',
        'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
        'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes',
        'ProtectControlGroups=yes', 'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes',
        'LockPersonality=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        'TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro',
        'TemporaryFileSystem=/tmp:rw,nosuid,nodev',
        'InaccessiblePaths=-/srv -/etc/brai -/etc/brai-dev -/etc/ansible -/mnt -/media',
        'BindPaths=' + home,
        'BindPaths=' + home + '/pm:/opt/brai-profile/pm',
        'BindReadOnlyPaths=' + software_root + '/venv:' + pm_environment,
        'ReadWritePaths=' + home,
        'BindReadOnlyPaths=' + engine_root + ':/opt/brai-profile/engine',
        'BindReadOnlyPaths=' + python_root + ':/opt/brai-profile/python',
        'BindReadOnlyPaths=' + runtime_root + ':/opt/brai-profile/runtime',
        'BindReadOnlyPaths=' + broker_socket + ':/run/brai-profile/control.sock',
        'BindReadOnlyPaths=' + memory_socket + ':/run/brai-profile/memory.sock',
        'BindReadOnlyPaths=' + egress_socket + ':/run/brai-profile/egress.sock',
        'KillMode=control-group', 'TimeoutStopSec=70', 'LimitNOFILE=4096',
        'TasksMax=256', 'MemoryHigh=2G', 'MemoryMax=4G',
    ]
    if site_packages:
        lines.append('BindReadOnlyPaths=' + site_packages + ':/opt/brai-profile/site-packages')
    if instructions_root:
        lines.extend(['Environment=HERMESCUSTOM_ROOT=/opt/brai-profile/instructions',
                      'BindReadOnlyPaths=' + instructions_root + ':/opt/brai-profile/instructions'])
    return '\n'.join(lines + ['[Install]', 'WantedBy=multi-user.target', ''])
