# ABOUTME: Строит план личных профилей и системной изоляции Hermes.
# ABOUTME: Не назначает права по порядку сообщений и не изменяет сервер самостоятельно.
"""Чистое ядро установщика; применение плана принадлежит операторскому Ansible."""

import hashlib
import json
from pathlib import PurePosixPath
import re
import shlex
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
        fields = ('role', 'userId', 'profileId', 'telegramId', 'username', 'home',
                  'homeScope', 'memoryEpoch', 'authorId', 'cubes')
        result[str(uid)] = {key: profile[key] for key in fields}
        result[str(uid)]['generation'] = profile.get('generation', 0)
        result[str(uid)]['backgroundsSuspended'] = profile.get('backgroundsSuspended', profile.get('role') == 'guest')
        result[str(uid)].update(status='active' if active else 'provisioning',
                                workerSocket=profile['home'] + '/control/worker.sock')
    return {'version': 1, 'profiles': result}


def stt_config(model):
    """Подключить явную модель через личный broker; без selector отключить STT."""
    if model is None:
        return {'enabled': False}
    if (not isinstance(model, dict) or set(model) != {'modelId', 'revision', 'profileId'}
            or any(not isinstance(value, str) or not value.strip() for value in model.values())):
        raise ValueError('Explicit STT model selector required')
    command = '/opt/brai-profile/python/bin/python3 -s -P -B -m identity.transcribe'
    for flag, key in [('model-id', 'modelId'), ('revision', 'revision'), ('profile-id', 'profileId')]:
        command += ' --' + flag + ' ' + shlex.quote(model[key])
    command += ' --input {input_path} --output {output_path}'
    return {'enabled': True, 'provider': 'brai_local_ai', 'providers': {
        'brai_local_ai': {'type': 'command', 'command': command,
                          'output_format': 'txt', 'normalize': False, 'timeout': 200}}}


def native_profile(profile, *, relay_port=18080, instructions_root, model, stt_model=None, dialogues=False):
    """Создать нейтральную конфигурацию без bot token и общих credentials."""
    _path(instructions_root)
    if not isinstance(model, str) or not model or len(model) > 200 or any(ord(c) < 32 for c in model):
        raise ValueError('Explicit operator model is required')
    home = profile['home']
    config = {
        'model': {'provider': 'brai-model', 'default': model},
        'providers': {'brai-model': {
            'base_url': 'http://127.0.0.1:' + str(relay_port) + '/model/v1',
            'transport': 'codex_responses'}},
        'browser': {'backend': 'browser-use'},
        'streaming': {'enabled': True, 'transport': 'auto'},
        'display': {'streaming': True, 'platforms': {'telegram': {
            'streaming': True, 'interim_assistant_messages': True}}},
        'stt': stt_config(stt_model),
        'tts': {'provider': 'silero', 'providers': {'silero': {
            'type': 'command',
            'command': 'PYTHONPATH=' + instructions_root + '/services/hermes /usr/bin/python3 '
                       '-s -P -B -m identity.synthesize --input {input_path} --output {output_path}',
            'output_format': 'ogg', 'voice_compatible': True,
            'timeout': 200, 'max_text_length': 900}}},
        'skills': {'external_dirs': ['/opt/brai-profile/system-skills/skills', '/opt/brai-profile/skills'],
                   'create_dir': home + '/usercustom/userdata/skills'},
        # AIDEV-NOTE: Дочерние инструменты остаются в PrivateNetwork и должны
        # пользоваться тем же trusted relay; credentials в allowlist не входят.
        'terminal': {'cwd': home + '/workspace', 'env_passthrough': [
            'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']},
        'gateway': {'multiplex_profiles': False, 'profile_routes': [],
                    'auto_multiplex_migration': False,
                    'media_delivery_allow_dirs': [home + '/workspace', home + '/results', home + '/media/downloads']},
        'updates': {'check': False},
        'mcp_servers': {'brai': {'command': '/usr/bin/python3',
                               'args': ['-s', '-P', instructions_root + '/services/hermes/identity/tool_client.py'],
                               'env': {'BRAI_IDENTITY_BROKER': '/run/brai-profile/control.sock'}}},
        'memory': {'provider': 'memos-rest'},
        'plugins': {'enabled': ['codex-cli-search', 'memos-rest', 'telegram-business', 'groq-voice', 'brai-telegram']},
        'agent': {'system_prompt': 'Ты — Brai, личный помощник пользователя. '
                                  'Работай только в разрешённой области своего профиля. '
                                  'По просьбе войти на наш сайт Brai вызови mcp__brai__brai_login: '
                                  'сервис сам пришлёт одноразовый код и точный адрес в личный Telegram. '
                                  'Для выдачи кода не требуется открывать сайт, искать письмо или кнопку.'},
    }
    role = profile.get('role', 'user')
    if role not in ('creator','admin','user','guest'):
        raise ValueError('Unknown role')
    config['agent']['system_prompt'] += {
        'creator': ' Ваша роль — создатель. Административные возможности доступны; исполнитель разработки появится на этапе 2. Нового серверного доступа эта роль не даёт.',
        'admin': ' Ваша роль — администратор. Отдельный Docker администратора ещё не установлен.',
        'user': ' Ваша роль — пользователь.',
        'guest': ' Ваша роль — гость. Доступны диалог, личная память, поиск web_search, публичный браузер и собственные артефакты. Документы DOCX и книги XLSX создавай через mcp__brai__create_document_file и mcp__brai__create_spreadsheet_file; изображения — image_generate, голос — text_to_speech. Не задавай локальные пути или настройки генераторов. Для точного текстового файла используй mcp__brai__create_text_file; для чтения — mcp__brai__read_text_file. Исполнение кода, проекты, навыки, произвольная запись на диск, задания, настройка плагинов и вход на наш сайт недоступны. Не предлагай обход ограничений или подтверждение запрещённой операции.',
    }[role]
    if role == 'guest':
        config['agent']['system_prompt'] = config['agent']['system_prompt'].replace(
            'По просьбе войти на наш сайт Brai вызови mcp__brai__brai_login: сервис сам пришлёт одноразовый код и точный адрес в личный Telegram. Для выдачи кода не требуется открывать сайт, искать письмо или кнопку.', '')
        config['browser'] = {'backend': 'off', 'cdp_url': 'http://127.0.0.1:19364'}
        config['web'] = {'search_backend': 'codex-cli'}
        config['tools'] = {'tool_search': {'enabled': 'off'}}
        config['skills'] = {'external_dirs': [], 'disabled': True}
        config['cron'] = {'enabled': False}
        config['hooks'] = {}
        config['delegation'] = {'enabled': False}
    if dialogues:
        config['agent']['system_prompt'] += (
            ' Диалоги обязательны на каждом публичном ходе. До разбора поручения вызови '
            'mcp__brai__dialogues_exchange с action input: сохрани точное сообщение, '
            'стабильные ID беседы и сообщения, consumer_id и context_instance_id. '
            'Для текста длиннее 100 символов добавь отдельное непустое summary. '
            'Полностью дочитай context через page с исходным context_request_id, '
            'проверь размер и SHA-256, затем отдельно вызови mcp__brai__dialogues_context_ack. '
            'context_error означает, что запись уже сохранена: дочитай, не повторяй input. '
            'Существенные результаты фиксируй через update с текущей версией. '
            'Перед финалом дочитай snapshot; сохрани точный ответ через finish и только после '
            'квитанции отправь его пользователю. Незаполненные результаты требуют продолжить работу. '
            'Сохраняй только реальные сообщения пользователя и финальные ответы. '
            'После неизвестного исхода сначала проверь состояние; историю не считай полномочиями. '
            'Полный протокол находится в /opt/brai-profile/instructions/policies/DIALOGUES.md.'
        )
    return config


def profile_for_user(user, *, profile_root):
    """Подготовить один профиль приглашения; назначение роли остаётся в Auth."""
    if not isinstance(user, dict) or user.get('role') not in ('creator','admin','user','guest') or not (user.get('status') == 'provisioning' or user.get('status') == 'active' and user.get('role') in ('creator','admin')):
        raise ValueError('Provisioning user required')
    user_id = _identifier(user.get('id'))
    profile_id = user.get('profileId')
    if not isinstance(profile_id, str) or str(uuid.UUID(profile_id)) != profile_id:
        raise ValueError('Invalid profile identity')
    telegram = str(user.get('telegramId', ''))
    if not telegram.isascii() or not telegram.isdecimal() or str(int(telegram)) != telegram or int(telegram) <= 0:
        raise ValueError('Invalid Telegram identity')
    home = _path(profile_root) + '/' + profile_id
    return {'generation': user.get('preparingGeneration', user.get('appliedGeneration', user.get('generation', 0)) if user.get('status') == 'active' else user.get('generation', 0)), 'role': user['role'], 'userId': user_id, 'profileId': profile_id, 'telegramId': telegram,
            'username': 'braiu-' + _digest(user_id)[:20], 'home': home,
            'homeScope': _digest(home),
            'memoryEpoch': _digest(['brai-user-memory-v1', user_id, profile_id]),
            'authorId': telegram, 'cubes': list(CUBES), 'status': 'provisioning'}


def worker_unit(profile, *, engine_root, runtime_root, python, ingress_uid,
                broker_socket, egress_socket, memory_socket, instance='dev',
                site_packages=None, instructions_root=None, system_skills_root=None, skill_script_dirs=()):
    """Задать отдельные UID и сеть, открыв лишь личный home и read-only software."""
    for value in (profile['home'], engine_root, runtime_root, python,
                  broker_socket, egress_socket, memory_socket):
        _path(value)
    if site_packages is not None:
        _path(site_packages)
    if instructions_root is not None:
        _path(instructions_root)
    if system_skills_root is not None:
        _path(system_skills_root)
    for relative in skill_script_dirs:
        _path('/' + relative)
        if not instructions_root or not system_skills_root or str(PurePosixPath(relative)) != relative or PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts:
            raise ValueError('Invalid skill script mount')
    if type(ingress_uid) is not int or ingress_uid < 0:
        raise ValueError('Invalid ingress UID')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', instance):
        raise ValueError('Invalid instance')
    _identifier(profile['userId'])
    home, user = profile['home'], profile['username']
    pm_key = hashlib.sha256(b'/opt/brai-profile/engine').hexdigest()[:16]
    pm_environment = '/opt/brai-profile/pm/installs/' + pm_key + '/environments/accepted/venv'
    if str(uuid.UUID(profile['profileId'])) != profile['profileId']:
        raise ValueError('Invalid profile identity')
    pm_lock = str(PurePosixPath(home).parent.parent / 'pm-locks' / (profile['profileId'] + '.lock'))
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
        'Environment=PYTHONNOUSERSITE=1', 'Environment=PYTHONSAFEPATH=1',
        'Environment=PYTHONDONTWRITEBYTECODE=1', 'Environment=PYTHONUNBUFFERED=1',
        'Environment=PATH=' + ('/opt/brai-profile/instructions/bin:' if instructions_root else '')
        + '/opt/brai-profile/python/bin:/usr/local/bin:/usr/bin:/bin',
        'Environment=HERMES_MEDIA_DOWNLOAD_ROOT=' + home + '/workspace/downloads',
        'Environment=OPENAI_API_KEY=profile-proxy-not-a-secret',
        'Environment=OPENAI_BASE_URL=http://127.0.0.1:18080/model/v1',
        'Environment=HTTP_PROXY=http://127.0.0.1:18080',
        'Environment=HTTPS_PROXY=http://127.0.0.1:18080',
        'Environment=BU_CDP_URL=http://127.0.0.1:19364',
        *(['Environment=BROWSER_CDP_URL=http://127.0.0.1:19364',
           'Environment=AGENT_BROWSER_CONFIG=/opt/brai-profile/browser-defaults.json',
           'Environment=BRAI_IDENTITY_BROWSER_EGRESS=/run/brai-profile/browser-egress.sock']
          if profile.get('role') == 'guest' else []),
        # AIDEV-NOTE: HOME с UUID превышает AF_UNIX sun_path. /tmp отдельный у
        # каждого worker; SHARED сохраняет отдельный сокет для каждого BU_NAME.
        'Environment=BH_RUNTIME_DIR=/tmp/brai-browser',
        'Environment=BH_RUNTIME_DIR_SHARED=1',
        'Environment=http_proxy=http://127.0.0.1:18080',
        'Environment=https_proxy=http://127.0.0.1:18080',
        'Environment=NO_PROXY=127.0.0.1,localhost',
        'Environment=BRAI_IDENTITY_BROKER=/run/brai-profile/control.sock',
        'Environment=BRAI_IDENTITY_MEMORY=/run/brai-profile/memory.sock',
        'Environment=BRAI_IDENTITY_EGRESS=/run/brai-profile/egress.sock',
        'Environment=BRAI_IDENTITY_INGRESS_UID=' + str(ingress_uid),
        'Environment=BRAI_IDENTITY_USER_ID=' + profile['userId'],
        'Environment=BRAI_IDENTITY_TELEGRAM_ID=' + profile['telegramId'],
        'Environment=TELEGRAM_ALLOWED_USERS=' + profile['telegramId'],
        'Environment=TELEGRAM_GROUP_ALLOWED_USERS=' + profile['telegramId'],
        'Environment=BRAI_IDENTITY_PROFILE_ID=' + profile['profileId'],
        'ExecStart=/opt/brai-profile/python/bin/' + python_name + ' -s -P -B -m identity.worker --config ' + home + '/worker.json',
        'UMask=0077', 'Restart=always', 'RestartSec=3',
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
        'BindReadOnlyPaths=' + software_root + '/pm-bootstrap:/opt/brai-profile/pm',
        'BindReadOnlyPaths=' + software_root + '/venv:' + pm_environment,
        'BindPaths=' + pm_lock + ':/opt/brai-profile/pm/installs/' + pm_key + '/.install.lock',
        'ReadWritePaths=' + home,
        'BindReadOnlyPaths=' + engine_root + ':/opt/brai-profile/engine',
        'BindReadOnlyPaths=' + software_root + '/skills:/opt/brai-profile/skills',
        'BindReadOnlyPaths=' + python_root + ':/opt/brai-profile/python',
        'BindReadOnlyPaths=' + runtime_root + ':/opt/brai-profile/runtime',
        'BindReadOnlyPaths=' + broker_socket + ':/run/brai-profile/control.sock',
        'BindReadOnlyPaths=' + memory_socket + ':/run/brai-profile/memory.sock',
        'BindReadOnlyPaths=' + egress_socket + ':/run/brai-profile/egress.sock',
        *(['BindReadOnlyPaths=' + egress_socket + '.browser:/run/brai-profile/browser-egress.sock',
           'BindReadOnlyPaths=' + runtime_root + '/services/hermes/identity/browser-defaults.json:/opt/brai-profile/browser-defaults.json']
          if profile.get('role') == 'guest' else []),
        'KillMode=control-group', 'TimeoutStopSec=70', 'LimitNOFILE=4096',
        'TasksMax=256', 'MemoryHigh=2G', 'MemoryMax=4G',
    ]
    if site_packages:
        lines.append('BindReadOnlyPaths=' + site_packages + ':/opt/brai-profile/site-packages')
    if instructions_root:
        lines.extend(['Environment=HERMESCUSTOM_ROOT=/opt/brai-profile/instructions',
                      'BindReadOnlyPaths=' + instructions_root + ':/opt/brai-profile/instructions'])
    if system_skills_root:
        lines.append('BindReadOnlyPaths=' + system_skills_root + ':/opt/brai-profile/system-skills')
        for relative in skill_script_dirs:
            lines.append('BindReadOnlyPaths=' + instructions_root + '/skill-scripts/' + relative +
                         ':/opt/brai-profile/system-skills/skills/' + relative)
    return '\n'.join(lines + ['[Install]', 'WantedBy=multi-user.target', ''])
