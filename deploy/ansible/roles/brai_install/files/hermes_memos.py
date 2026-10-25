# ABOUTME: Готовит и проверяет отдельную PROD-БД MemOS и профиль памяти Hermes.
# ABOUTME: Не читает Supabase .env и не переносит прежние credentials или память.
"""Подготовить, проверить или явно активировать защищённый MemOS runtime."""
import argparse
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import secrets
import stat
import subprocess
import sys

def file_mode(target):
    """Проверить обычные private permissions без разрешений ACL."""
    item = os.fstat(target) if isinstance(target, int) else os.lstat(target)
    try:
        raw = os.getxattr(target, "system.posix_acl_access")
    except OSError as error:
        import errno
        if error.errno not in (errno.ENODATA, errno.ENOTSUP):
            raise
    else:
        if raw:
            return -1
    return stat.S_IMODE(item.st_mode)

DATABASE = 'brai_memos'
OWNER = 'brai_memos_owner'
APP = 'brai_memos_app'
CONTAINER = 'supabase-db'
MEMOS_REVISION = 'a7367d07e55db61099f7b4e2c1108bc5831a24f3'
CUSTOM_REVISION = 'e0b72f2a982b0f87dded09b11533bffada7ed07d'
SCOPE_PROFILE = 'hermes-production'
EMBEDDING_MODEL = 'embeddinggemma-2-q8'
DEFAULT_GATEWAY = '192.168.16.1'
CONFIG_PARENT = Path('/etc/brai/hermes')
CONFIG_DIR = CONFIG_PARENT / 'memos'
RUNTIME = CONFIG_DIR / 'runtime.env'
BRIDGE_ENV = CONFIG_DIR / 'codex-bridge.env'
ROUTER_ENV = CONFIG_PARENT / 'memos-router.env'
CREDENTIALS = CONFIG_DIR / 'postgres-credentials.env'
MARKER = CONFIG_DIR / 'provision_complete'
HBA_BASELINE = CONFIG_DIR / 'postgres_hba_before_memos.conf'
ACCEPTANCE = CONFIG_DIR / 'accepted.json'
PROFILE = Path('/var/lib/brai/hermes')
PROFILE_CONFIG = PROFILE / 'memos-rest.json'
OWNER_HOME = Path(os.environ.get('BRAI_HERMES_NATIVE_HOME', '/var/lib/brai/hermes-owner'))
WORKER_DIR = PROFILE / 'memos/worker'
STATE_DIR = PROFILE / 'memos/data'
OUTBOX = PROFILE / 'memos-rest'
PENDING = OUTBOX / 'pending'
RECEIPTS = OUTBOX / 'receipts'
TOOLS = CONFIG_PARENT / 'tools.json'
SETTINGS = Path(__file__).with_name('hermes_memos_settings.json')
ROUTING_DEFAULTS = PROFILE / 'usercustom/hermescustom/plugins/memos-rest/routing.defaults.json'
HBA_START = '# BEGIN BRAI PROD MEMOS ROLE ISOLATION\n'
HBA_END = '# END BRAI PROD MEMOS ROLE ISOLATION\n'
LOG_GUARD = ("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; "
             "SET LOCAL log_min_duration_statement=-1; SET LOCAL log_min_duration_sample=-1; "
             "SET LOCAL log_statement_sample_rate=0; SET LOCAL log_transaction_sample_rate=0; "
             "SET LOCAL log_parameter_max_length=0; SET LOCAL log_parameter_max_length_on_error=0; "
             "SET LOCAL password_encryption='scram-sha-256'; ")


def require(condition, reason='HERMES_MEMOS_OPERATION_FAILED'):
    """Остановить операцию фиксированной ошибкой без входных значений."""
    if not condition:
        raise RuntimeError(reason)


def run(args, data=None, success=True):
    """Запустить локальный Docker вызов; не показывать stdin или stderr."""
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=90)
    if success:
        require(result.returncode == 0, 'HERMES_MEMOS_COMMAND_FAILED')
    return result


def sql(statement, database='postgres'):
    """Передать SQL через локальный socket административного контейнера."""
    return run([
        '/usr/bin/docker', 'exec', '-i', '--user', 'postgres', CONTAINER,
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin',
        '-d', database, '-At',
    ], statement).stdout.strip()


def connect(role, password, database, statement, success=True):
    """Проверить login по TCP, передав пароль через stdin."""
    command = [
        '/usr/bin/docker', 'exec', '-i', '--user', 'postgres', CONTAINER, 'sh', '-c',
        'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2" -At',
        'memos-check', role, database,
    ]
    return run(command, password + '\n' + statement, success=success)


def protected_file(path, uid=0, gid=0, mode=0o600, limit=65536):
    """Прочитать обычный защищённый файл без symlink и без печати содержимого."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == uid and metadata.st_gid == gid and file_mode(descriptor) == mode, 'HERMES_MEMOS_INPUT_METADATA_INVALID')
        with os.fdopen(descriptor) as source:
            descriptor = -1
            value = source.read(limit + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    require(len(value) <= limit, 'HERMES_MEMOS_INPUT_TOO_LARGE')
    return value


def protected_json(path, uid=0, gid=0, mode=0o600):
    """Загрузить JSON из заранее разрешённого protected input без его вывода."""
    value = json.loads(protected_file(path, uid, gid, mode))
    require(isinstance(value, dict), 'HERMES_MEMOS_JSON_INPUT_INVALID')
    return value


def protected_env(path, expected=None):
    """Разобрать root-only env и проверить ключи, если набор известен."""
    values = {}
    if path == ROUTER_ENV:
        identity = account()
        text = protected_file(path, identity.pw_uid, identity.pw_gid)
    else:
        text = protected_file(path)
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator and key not in values and key.replace('_', '').isalnum(), 'HERMES_MEMOS_INPUT_FORMAT_INVALID')
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1].replace(r"\'", "'")
        values[key] = value
    if expected is not None:
        require(set(values) == set(expected), 'HERMES_MEMOS_INPUT_KEYS_INVALID')
    return values


def write_once(path, value, uid=0, gid=0, mode=0o600):
    """Создать новый файл с заданными правами без перезаписи или symlink."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    os.fchown(descriptor, uid, gid)
    os.fchmod(descriptor, mode)
    with os.fdopen(descriptor, 'w') as destination:
        destination.write(value)
        destination.flush()
        os.fsync(destination.fileno())


def write_profile(path, value, owner_uid, owner_gid):
    """Атомарно заменить только профильный JSON, сохранив его owner и mode."""
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == owner_uid and metadata.st_gid == owner_gid and stat.S_IMODE(metadata.st_mode) == 0o600, 'HERMES_MEMOS_PROFILE_METADATA_INVALID')
    temporary = path.with_name(path.name + '.memos-new')
    require(not temporary.exists() and not temporary.is_symlink(), 'HERMES_MEMOS_PROFILE_TEMP_CONFLICT')
    write_once(temporary, json.dumps(value, ensure_ascii=False, indent=2) + '\n', owner_uid, owner_gid, 0o600)
    os.replace(temporary, path)


def ensure_directory(path, owner_uid=0, owner_gid=0, mode=0o700):
    """Создать или проверить один protected каталог, отказываясь от symlink."""
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == owner_uid and metadata.st_gid == owner_gid and stat.S_IMODE(metadata.st_mode) == mode, 'HERMES_MEMOS_DIRECTORY_METADATA_INVALID')
    else:
        path.mkdir(mode=mode)
        os.chown(path, owner_uid, owner_gid)
        os.chmod(path, mode)


def replace_file(path, value, metadata):
    """Атомарно заменить только HBA, сохранив исходные владельца и режим."""
    temporary = path.with_name(path.name + '.memos-new')
    require(not temporary.exists() and not temporary.is_symlink(), 'HERMES_MEMOS_HBA_TEMP_CONFLICT')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(metadata.st_mode))
    os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
    os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
    with os.fdopen(descriptor, 'w') as destination:
        destination.write(value)
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, path)


def hba_rules():
    """Вернуть allow-then-deny HBA только для MemOS ролей."""
    roles = OWNER + ',' + APP
    return HBA_START + ''.join((
        f'local {DATABASE} {roles} scram-sha-256\n',
        f'host {DATABASE} {roles} 0.0.0.0/0 scram-sha-256\n',
        f'host {DATABASE} {roles} ::/0 scram-sha-256\n',
        f'local all {roles} reject\n',
        f'host all {roles} 0.0.0.0/0 reject\n',
        f'host all {roles} ::/0 reject\n',
    )) + HBA_END


def hba_host_path(container_path, mounts):
    """Разрешить host HBA путь только через соответствующий writable mount."""
    target = PurePosixPath(container_path)
    require(target.is_absolute(), 'HERMES_MEMOS_HBA_PATH_INVALID')
    matches = []
    for mount in mounts:
        destination = PurePosixPath(mount.get('Destination', ''))
        try:
            relative = target.relative_to(destination)
        except ValueError:
            continue
        matches.append((len(destination.parts), mount, relative))
    require(matches, 'HERMES_MEMOS_HBA_MOUNT_NOT_FOUND')
    _, mount, relative = max(matches, key=lambda item: item[0])
    require(mount.get('RW') is True and mount.get('Source'), 'HERMES_MEMOS_HBA_MOUNT_READ_ONLY')
    return Path(mount['Source']).joinpath(*relative.parts)


def hba_live():
    """Разрешить HBA host path из docker inspect и сверить его с container."""
    container_path = sql('SHOW hba_file;')
    mounted = run(['/usr/bin/docker', 'inspect', CONTAINER, '--format', '{{json .Mounts}}'])
    host = hba_host_path(container_path, json.loads(mounted.stdout))
    container_content = run(['/usr/bin/docker', 'exec', '--user', 'postgres', CONTAINER, 'cat', container_path]).stdout
    require(host.is_file() and not host.is_symlink() and host.read_text() == container_content, 'HERMES_MEMOS_HBA_HOST_MISMATCH')
    return host, container_content


def update_hba():
    """Вставить HBA block перед прежними правилами и перезагрузить parser."""
    host, current = hba_live()
    rules = hba_rules()
    require(HBA_START not in current and HBA_END not in current, 'HERMES_MEMOS_HBA_PARTIAL_STATE')
    write_once(HBA_BASELINE, current)
    metadata = host.stat()
    replace_file(host, rules + current, metadata)
    if sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;') != '0':
        replace_file(host, current, host.stat())
        sql('SELECT pg_reload_conf();')
        raise RuntimeError('HERMES_MEMOS_HBA_PARSE_FAILED')
    require(sql('SELECT pg_reload_conf();') == 't', 'HERMES_MEMOS_HBA_RELOAD_FAILED')


def env_text(values):
    """Записать Compose-compatible quoted env без подстановки секретов."""
    require(all('\n' not in str(value) and '\r' not in str(value) for value in values.values()), 'HERMES_MEMOS_RUNTIME_VALUE_INVALID')
    return ''.join(f"{key}='{str(value).replace(chr(39), chr(92) + chr(39))}'\n" for key, value in values.items())


def runtime_inputs(gateway, app_password, embedding_key, bridge_key):
    """Собрать MemOS env из kit defaults и свежих изолированных inputs."""
    settings = json.loads(SETTINGS.read_text())
    require(settings.get('GRAPH_DB_BACKEND') == 'postgres' and settings.get('MEMOS_SCHEMA') == 'memos', 'HERMES_MEMOS_SETTINGS_MISMATCH')
    values = {key: str(value) for key, value in settings.items()}
    values.update({
        'POSTGRES_HOST': CONTAINER, 'POSTGRES_PORT': '5432',
        'POSTGRES_DB': DATABASE, 'POSTGRES_USER': APP, 'POSTGRES_PASSWORD': app_password,
        'MEMOS_USER_NAME': 'hermes-production',
        'OPENAI_API_BASE': f'http://{gateway}:19372/v1', 'OPENAI_API_KEY': bridge_key,
        'MEMRADER_API_BASE': f'http://{gateway}:19372/v1', 'MEMRADER_API_KEY': bridge_key,
        'MOS_EMBEDDER_API_BASE': f'http://{gateway}:19373/v1', 'MOS_EMBEDDER_API_KEY': embedding_key,
        'MOS_EMBEDDER_MODEL': EMBEDDING_MODEL,
    })
    return values


def bridge_inputs(bridge_key):
    """Собрать отдельный Codex bridge env без PostgreSQL credentials."""
    return {
        'MEMOS_BRIDGE_TOKEN': bridge_key,
        'MEMOS_CODEX_TIMEOUT': '180',
        'MEMOS_CODEX_EXECUTABLE': str(OWNER_HOME / '.local/bin/codex'),
        'MEMOS_CODEX_WORKER_DIR': str(WORKER_DIR),
        'HOME': str(OWNER_HOME),
        'CODEX_HOME': str(OWNER_HOME / '.codex'),
    }


def router_inputs(bridge_key):
    """Сформировать единственный секрет, читаемый MemOS app account."""
    return {'MEMOS_BRIDGE_TOKEN': bridge_key}


def profile_defaults(owner_id, memory_epoch):
    """Собрать новый, выключенный профиль MemOS без root/main identity."""
    config = json.loads(ROUTING_DEFAULTS.read_text())
    require(isinstance(config.get('router'), dict), 'HERMES_MEMOS_PROFILE_DEFAULTS_INVALID')
    config.update({
        'base_url': 'http://127.0.0.1:19371',
        'user_id': owner_id,
        'cube_id': 'hermes-production',
        'scope_profile': SCOPE_PROFILE,
        'memory_epoch': memory_epoch,
        'deployment_phase': 'setup',
        'enabled': False,
        'frozen': True,
        'bulk_clear_locked': True,
    })
    config['router'].update({
        'base_url': 'http://127.0.0.1:19372',
        'env_file': str(ROUTER_ENV),
        'api_key_env': 'MEMOS_BRIDGE_TOKEN',
    })
    return config


def role_state():
    """Вернуть только имена/ограничения ролей и владельца базы."""
    return sql("SELECT rolname || ':' || rolcanlogin::text || ':' || (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)::text || ':' || rolinherit::text FROM pg_roles WHERE rolname IN ('brai_memos_owner','brai_memos_app') ORDER BY CASE rolname WHEN 'brai_memos_owner' THEN 1 ELSE 2 END; SELECT datname || ':' || pg_get_userbyid(datdba) FROM pg_database WHERE datname='brai_memos';")


def capability():
    """Проверить административные права локального Supabase подключения."""
    require(sql("SELECT current_user || ':' || rolsuper::text || ':' || rolcreatedb::text || ':' || rolcreaterole::text FROM pg_roles WHERE rolname=current_user;") == 'supabase_admin:true:true:true', 'HERMES_MEMOS_ADMIN_CAPABILITY_REQUIRED')


def target_state():
    """Вернуть только metadata о наличии двух ролей и базы."""
    state = role_state().splitlines()
    roles = [line for line in state if line.startswith(OWNER + ':') or line.startswith(APP + ':')]
    dbs = [line for line in state if line.startswith(DATABASE + ':')]
    return roles, dbs


def account():
    """Вернуть обязательную системную identity Hermes PROD."""
    try:
        return pwd.getpwnam(os.environ.get('BRAI_HERMES_NATIVE_USER', 'brai-hermes-production'))
    except KeyError:
        raise RuntimeError('HERMES_MEMOS_OWNER_ACCOUNT_REQUIRED') from None


def ensure_hba_absent():
    """Отказаться до первой записи при чужом или частичном HBA block."""
    _, live = hba_live()
    require(HBA_START not in live and HBA_END not in live, 'HERMES_MEMOS_HBA_PARTIAL_STATE')


def prepare(gateway, owner_uid, owner_gid):
    """Создать MemOS inputs и отдельную БД; завершённый повтор только проверяет."""
    if MARKER.exists():
        verify(gateway)
        return False
    try:
        ipaddress.IPv4Address(gateway)
    except (ipaddress.AddressValueError, TypeError):
        require(False, 'HERMES_MEMOS_GATEWAY_INVALID')
    for path in (RUNTIME, BRIDGE_ENV, ROUTER_ENV, CREDENTIALS, MARKER, HBA_BASELINE, PROFILE_CONFIG, OUTBOX):
        require(not path.exists() and not path.is_symlink(), 'HERMES_MEMOS_PARTIAL_STATE_REQUIRES_REPAIR')
    for directory in (CONFIG_PARENT, PROFILE.parent, STATE_DIR.parent):
        current = directory
        while current != current.parent:
            if current.exists() or current.is_symlink():
                metadata = current.lstat()
                require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), 'HERMES_MEMOS_DIRECTORY_PATH_INVALID')
            current = current.parent
    ensure_hba_absent()
    owner_tools = protected_json(TOOLS, owner_uid, owner_gid)
    owner_id = owner_tools.get('ownerId')
    embedding_key = owner_tools.get('embedding', {}).get('apiKey') if isinstance(owner_tools.get('embedding'), dict) else None
    require(isinstance(owner_id, str) and owner_id and len(owner_id) <= 128 and not any(ch.isspace() for ch in owner_id), 'HERMES_MEMOS_OWNER_ID_INVALID')
    require(isinstance(embedding_key, str) and len(embedding_key) >= 32 and not any(ch.isspace() for ch in embedding_key), 'HERMES_MEMOS_EMBEDDING_INPUT_REQUIRED')
    capability()
    roles, dbs = target_state()
    require(not roles and not dbs, 'HERMES_MEMOS_DATABASE_PARTIAL_STATE')
    require(sql("SELECT count(*) FROM pg_available_extensions WHERE name='vector';") == '1', 'HERMES_MEMOS_PGVECTOR_REQUIRED')
    app_password = secrets.token_urlsafe(32)
    owner_password = secrets.token_urlsafe(32)
    bridge_key = secrets.token_urlsafe(32)
    runtime = runtime_inputs(gateway, app_password, embedding_key, bridge_key)
    bridge = bridge_inputs(bridge_key)
    router = router_inputs(bridge_key)
    profile = profile_defaults(owner_id, 'setup-' + secrets.token_hex(16))

    ensure_directory(CONFIG_PARENT, 0, owner_gid, 0o750)
    ensure_directory(CONFIG_DIR, 0, 0, 0o700)
    ensure_directory(PROFILE / 'memos', owner_uid, owner_gid, 0o700)
    write_once(RUNTIME, env_text(runtime))
    write_once(BRIDGE_ENV, env_text(bridge))
    write_once(ROUTER_ENV, env_text(router), owner_uid, owner_gid, 0o600)
    write_once(CREDENTIALS, env_text({OWNER: owner_password, APP: app_password}))
    STATE_DIR.mkdir(mode=0o700)
    os.chown(STATE_DIR, owner_uid, owner_gid)
    os.chmod(STATE_DIR, 0o700)
    for path in (OUTBOX, PENDING, RECEIPTS):
        ensure_directory(path, owner_uid, owner_gid)
    write_once(PROFILE_CONFIG, json.dumps(profile, ensure_ascii=False, indent=2) + '\n', owner_uid, owner_gid)

    roles_sql = ''.join(
        f"CREATE ROLE {role} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;"
        for role, password in {OWNER: owner_password, APP: app_password}.items()
    )
    sql(LOG_GUARD + roles_sql + 'COMMIT;')
    sql(f'CREATE DATABASE {DATABASE} OWNER {OWNER};')
    sql(f'REVOKE ALL ON DATABASE {DATABASE} FROM PUBLIC; REVOKE ALL ON DATABASE {DATABASE} FROM {OWNER},{APP}; GRANT CONNECT ON DATABASE {DATABASE} TO {OWNER},{APP};')
    sql(f'CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION supabase_admin; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions; CREATE SCHEMA memos AUTHORIZATION {OWNER}; REVOKE ALL ON SCHEMA public FROM PUBLIC,{OWNER},{APP}; GRANT USAGE ON SCHEMA public TO {OWNER},{APP}; GRANT USAGE,CREATE ON SCHEMA memos TO {APP}; GRANT USAGE ON SCHEMA extensions TO {OWNER},{APP}; ALTER ROLE {OWNER} IN DATABASE {DATABASE} SET search_path TO memos,extensions,public; ALTER ROLE {APP} IN DATABASE {DATABASE} SET search_path TO memos,extensions,public;', DATABASE)
    update_hba()
    write_once(MARKER, '1\n')
    verify(gateway)
    return True


def acceptance(owner_id, memory_epoch):
    """Проверить точную protected квитанцию фактической functional acceptance."""
    evidence = protected_json(ACCEPTANCE)
    require(set(evidence) == {'ownerId', 'memoryEpoch', 'memosRevision', 'customRevision', 'passed'}, 'HERMES_MEMOS_ACCEPTANCE_SHAPE_INVALID')
    require(evidence['ownerId'] == owner_id and evidence['memoryEpoch'] == memory_epoch and evidence['memosRevision'] == MEMOS_REVISION and evidence['customRevision'] == CUSTOM_REVISION and evidence['passed'] is True, 'HERMES_MEMOS_ACCEPTANCE_MISMATCH')


def profile_state(owner_uid, owner_gid):
    """Прочитать только собственный обычный profile file с ожидаемыми правами."""
    return protected_json(PROFILE_CONFIG, owner_uid, owner_gid)


def verify(gateway=DEFAULT_GATEWAY, *, expected_embedding_model=EMBEDDING_MODEL):
    """Проверить DB/HBA/profile; legacy selector допустим только внутреннему repair preflight."""
    require(expected_embedding_model in (EMBEDDING_MODEL, 'google/embeddinggemma-2'), 'HERMES_MEMOS_EMBEDDING_MODEL_INVALID')
    require(MARKER.is_file() and not MARKER.is_symlink(), 'HERMES_MEMOS_NOT_PREPARED')
    require(protected_file(MARKER).strip() == '1', 'HERMES_MEMOS_MARKER_INVALID')
    identity = account()
    owner_uid, owner_gid = identity.pw_uid, identity.pw_gid
    tools = protected_json(TOOLS, owner_uid, owner_gid)
    owner_id = tools.get('ownerId')
    embedding_key = tools.get('embedding', {}).get('apiKey') if isinstance(tools.get('embedding'), dict) else None
    require(isinstance(owner_id, str) and owner_id and isinstance(embedding_key, str), 'HERMES_MEMOS_OWNER_ID_INVALID')
    runtime = protected_env(RUNTIME)
    bridge = protected_env(BRIDGE_ENV)
    router_env = protected_env(ROUTER_ENV, ('MEMOS_BRIDGE_TOKEN',))
    credentials = protected_env(CREDENTIALS, (OWNER, APP))
    require(runtime.get('POSTGRES_HOST') == CONTAINER and runtime.get('POSTGRES_PORT') == '5432' and runtime.get('POSTGRES_DB') == DATABASE and runtime.get('POSTGRES_USER') == APP and runtime.get('MEMOS_SCHEMA') == 'memos', 'HERMES_MEMOS_RUNTIME_DRIFT')
    require(runtime.get('OPENAI_API_KEY') == bridge.get('MEMOS_BRIDGE_TOKEN') == runtime.get('MEMRADER_API_KEY') == router_env.get('MEMOS_BRIDGE_TOKEN'), 'HERMES_MEMOS_BRIDGE_TOKEN_DRIFT')
    require(runtime.get('MOS_EMBEDDER_API_KEY') == embedding_key, 'HERMES_MEMOS_EMBEDDING_KEY_DRIFT')
    require(runtime.get('MOS_EMBEDDER_MODEL') == expected_embedding_model, 'HERMES_MEMOS_EMBEDDING_MODEL_DRIFT')
    require(runtime.get('OPENAI_API_BASE') == runtime.get('MEMRADER_API_BASE') and runtime.get('MOS_EMBEDDER_API_BASE'), 'HERMES_MEMOS_BRIDGE_ENDPOINT_DRIFT')
    if gateway is not None:
        try:
            ipaddress.IPv4Address(gateway)
        except (ipaddress.AddressValueError, TypeError):
            require(False, 'HERMES_MEMOS_GATEWAY_INVALID')
        require(runtime.get('OPENAI_API_BASE') == f'http://{gateway}:19372/v1' and runtime.get('MOS_EMBEDDER_API_BASE') == f'http://{gateway}:19373/v1', 'HERMES_MEMOS_GATEWAY_DRIFT')
    for path in (RUNTIME, BRIDGE_ENV, CREDENTIALS, HBA_BASELINE):
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 0 and stat.S_IMODE(metadata.st_mode) == 0o600, 'HERMES_MEMOS_RUNTIME_METADATA_INVALID')
    router_metadata = ROUTER_ENV.lstat()
    require(stat.S_ISREG(router_metadata.st_mode) and router_metadata.st_uid == owner_uid and router_metadata.st_gid == owner_gid and stat.S_IMODE(router_metadata.st_mode) == 0o600, 'HERMES_MEMOS_ROUTER_ENV_METADATA_INVALID')
    profile = profile_state(owner_uid, owner_gid)
    verify_profile(profile, owner_id, owner_uid, owner_gid)
    roles, dbs = target_state()
    require(roles == [f'{OWNER}:true:false:false', f'{APP}:true:false:false'] and dbs == [DATABASE + ':' + OWNER], 'HERMES_MEMOS_ROLE_OR_DATABASE_DRIFT')
    require(sql(f"SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('{OWNER}','{APP}'));", DATABASE) == '0', 'HERMES_MEMOS_ROLE_MEMBERSHIP_FOUND')
    require(sql(f"SELECT has_database_privilege('{APP}','{DATABASE}','CONNECT')::text || ':' || has_database_privilege('{APP}','{DATABASE}','CREATE')::text || ':' || has_database_privilege('{APP}','{DATABASE}','TEMP')::text;") == 'true:false:false', 'HERMES_MEMOS_DATABASE_PRIVILEGE_DRIFT')
    require(sql("SELECT count(*) FROM pg_extension WHERE extname='vector' AND extnamespace=(SELECT oid FROM pg_namespace WHERE nspname='extensions');", DATABASE) == '1', 'HERMES_MEMOS_PGVECTOR_DRIFT')
    require(sql("SELECT pg_get_userbyid(nspowner) || ':' || has_schema_privilege('brai_memos_app','memos','USAGE')::text || ':' || has_schema_privilege('brai_memos_app','memos','CREATE')::text || ':' || has_schema_privilege('brai_memos_app','public','CREATE')::text FROM pg_namespace WHERE nspname='memos';", DATABASE) == OWNER + ':true:true:false', 'HERMES_MEMOS_SCHEMA_PRIVILEGE_DRIFT')
    for role, password in credentials.items():
        require(connect(role, password, DATABASE, 'SELECT current_database();').stdout.strip() == DATABASE, 'HERMES_MEMOS_TARGET_CONNECT_FAILED')
        require(connect(role, password, 'postgres', 'SELECT 1;', success=False).returncode != 0, 'HERMES_MEMOS_CROSS_DATABASE_CONNECT_ALLOWED')
    _, live = hba_live()
    require(live.count(HBA_START) == 1 and live.count(HBA_END) == 1, 'HERMES_MEMOS_HBA_BLOCK_MISSING_OR_DUPLICATED')
    start = live.index(HBA_START)
    end = live.index(HBA_END) + len(HBA_END)
    require(live[start:end] == hba_rules(), 'HERMES_MEMOS_HBA_DRIFT')
    require(sql(f"SELECT count(*) FROM pg_hba_file_rules WHERE user_name && ARRAY['{OWNER}','{APP}'];") == '6', 'HERMES_MEMOS_HBA_ROLE_RULE_DRIFT')
    block_line = live[:start].count('\n') + 1
    require(sql(f"SELECT count(*) FROM pg_hba_file_rules WHERE line_number < {block_line} AND database && ARRAY['all','{DATABASE}'] AND user_name && ARRAY['all','{OWNER}','{APP}'];") == '0', 'HERMES_MEMOS_HBA_PRECEDENCE_DRIFT')
    require(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;') == '0', 'HERMES_MEMOS_HBA_PARSE_FAILED')
    paths = (STATE_DIR, OUTBOX, PENDING, RECEIPTS)
    for path in paths:
        metadata = path.lstat()
        require(stat.S_ISDIR(metadata.st_mode) and file_mode(path) == 0o700
                and (metadata.st_uid, metadata.st_gid) == (owner_uid, owner_gid),
                'HERMES_MEMOS_STATE_METADATA_INVALID')


def native_cubes():
    """Прочитать актуальный Catalog установленного plugin без provider/model lifecycle."""
    import importlib
    import types
    package = '_brai_memos_native_catalog'
    if package not in sys.modules:
        namespace = types.ModuleType(package)
        namespace.__path__ = [str(PROFILE / 'plugins/memos-rest')]
        sys.modules[package] = namespace
    return importlib.import_module(package + '.router').Catalog(PROFILE).cubes


def native_handoff(profile, owner_uid, owner_gid):
    """Проверить настоящую native квитанцию production, не создавать её."""
    state = protected_json(OUTBOX / 'admin-state.json', owner_uid, owner_gid)
    cubes = native_cubes()
    require(state.get('status') == 'complete' and state.get('phase') == 'production'
            and state.get('empty_only') is True and state.get('profile') == SCOPE_PROFILE
            and state.get('user_id') == profile.get('user_id')
            and state.get('new_epoch') == profile.get('memory_epoch')
            and isinstance(state.get('started_at'), (int, float)) and state['started_at'] > 0
            and state.get('generation') == profile.get('generation')
            and state.get('cubes') == cubes, 'HERMES_MEMOS_NATIVE_HANDOFF_REQUIRED')
    fence = protected_json(OUTBOX / 'session-fence.json', owner_uid, owner_gid)
    require(fence.get('cutoff') == state.get('started_at') and isinstance(fence.get('revoked'), list)
            and isinstance(fence.get('sessions'), dict), 'HERMES_MEMOS_NATIVE_FENCE_REQUIRED')


def verify_profile(profile, owner_id, owner_uid, owner_gid):
    """Разрешить frozen setup либо настоящий production; active требует proof."""
    require(profile.get('base_url') == 'http://127.0.0.1:19371'
            and profile.get('user_id') == owner_id and profile.get('cube_id') == 'hermes-production'
            and profile.get('scope_profile') == SCOPE_PROFILE, 'HERMES_MEMOS_PROFILE_IDENTITY_DRIFT')
    epoch = profile.get('memory_epoch')
    phase = profile.get('deployment_phase')
    require(profile.get('routing_enabled') is True and isinstance(epoch, str) and bool(epoch)
            and profile.get('bulk_clear_locked') is True
            and phase in ('setup', 'production'), 'HERMES_MEMOS_PROFILE_POLICY_DRIFT')
    require(profile.get('router', {}).get('base_url') == 'http://127.0.0.1:19372'
            and profile.get('router', {}).get('env_file') == str(ROUTER_ENV), 'HERMES_MEMOS_PROFILE_BRIDGE_DRIFT')
    frozen = profile.get('enabled') is False and profile.get('frozen') is True
    active = profile.get('enabled') is True and profile.get('frozen') is False and phase == 'production'
    require(frozen or active, 'HERMES_MEMOS_PROFILE_STATE_INVALID')
    if phase == 'setup':
        require(epoch.startswith('setup-'), 'HERMES_MEMOS_PROFILE_POLICY_DRIFT')
    else:
        native_handoff(profile, owner_uid, owner_gid)
    if active:
        acceptance(owner_id, epoch)


def activate():
    """Включить writer только по защищённой квитанции фактической приёмки."""
    verify()
    identity = account()
    profile = profile_state(identity.pw_uid, identity.pw_gid)
    require(profile.get('deployment_phase') == 'production', 'HERMES_MEMOS_NATIVE_HANDOFF_REQUIRED')
    native_handoff(profile, identity.pw_uid, identity.pw_gid)
    if profile.get('enabled') is True and profile.get('frozen') is False:
        acceptance(profile['user_id'], profile['memory_epoch'])
        return False
    acceptance(profile.get('user_id'), profile.get('memory_epoch'))
    profile['enabled'] = True
    profile['frozen'] = False
    profile['deployment_phase'] = 'production'
    write_profile(PROFILE_CONFIG, profile, identity.pw_uid, identity.pw_gid)
    return True


def main():
    """Разобрать интерфейс Ansible prepare, read-only verify и acceptance activate."""
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('prepare', 'verify', 'activate'))
    parser.add_argument('--gateway', '--bridge-host', dest='gateway')
    parser.add_argument('--owner-uid', type=int)
    parser.add_argument('--functional-acceptance')
    args = parser.parse_args()
    identity = account()
    owner_uid = identity.pw_uid if args.owner_uid is None else args.owner_uid
    require(owner_uid == identity.pw_uid, 'HERMES_MEMOS_OWNER_ACCOUNT_INVALID')
    if args.action == 'prepare':
        require(args.gateway, 'HERMES_MEMOS_GATEWAY_REQUIRED')
        require(args.functional_acceptance is None, 'HERMES_MEMOS_ARGUMENT_INVALID')
        changed = prepare(args.gateway, identity.pw_uid, identity.pw_gid)
    elif args.action == 'verify':
        require(args.functional_acceptance is None, 'HERMES_MEMOS_ARGUMENT_INVALID')
        verify(args.gateway or DEFAULT_GATEWAY)
        changed = False
    else:
        require(args.gateway is None and args.functional_acceptance == str(ACCEPTANCE), 'HERMES_MEMOS_ACTIVATION_ARGUMENT_INVALID')
        changed = activate()
    print(json.dumps({'changed': changed}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'changed': False, 'error': 'HERMES_MEMOS_OPERATION_FAILED'}, separators=(',', ':')))
        sys.exit(1)
