# ABOUTME: Проверяет профиль и направляет его HTTP-трафик во внешнюю сеть.
# ABOUTME: Ключ провайдера и реестр доступны только доверенному процессу.
import argparse
import asyncio
import ipaddress
import hashlib
import json
import logging
import os
import pwd
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import struct
import time
import uuid
from urllib.parse import urlsplit

from . import network

HEADER_LIMIT = 32768
BODY_LIMIT = 8 * 1024 * 1024
IDLE_TIMEOUT = network.IDLE_TIMEOUT
DRAIN_TIMEOUT = network.DRAIN_TIMEOUT
CONNECT_TIMEOUT = 10
CREDENTIAL_TIMEOUT = 20
SEARCH_CONCURRENCY = 2
MAX_CONNECTIONS = network.MAX_CONNECTIONS
LOGGER = logging.getLogger(__name__)
TOKEN = re.compile(rb"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
MODEL_PATHS = {"/v1/chat/completions", "/v1/responses", "/v1/embeddings",
               "/v1/images/generations", "/v1/images/edits"}


class Rejected(Exception):
    """Запрос не соответствует границе доступа."""
    def __init__(self, status=400):
        self.status = status


def _protected_json(path):
    # AIDEV-NOTE: Проверка дескриптора исключает подмену файла между stat и чтением.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("unprotected configuration")
        data = stream.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("configuration too large")
    return json.loads(data)


def _public(address, denied):
    try:
        ip = ipaddress.ip_address(address)
        # AIDEV-NOTE: Переходные IPv6-префиксы могут скрывать внутренний IPv4.
        transition = ip.version == 6 and any(ip in ipaddress.ip_network(net) for net in (
            "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32"))
        return (not getattr(ip, "ipv4_mapped", None) and ip.is_global and not transition
                and not ip.is_multicast and str(ip) not in denied)
    except ValueError:
        return False


async def _dial(host, port, tls, denied):
    loop = asyncio.get_running_loop()
    answers = await asyncio.wait_for(loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), CONNECT_TIMEOUT)
    addresses = list(dict.fromkeys(item[4][0] for item in answers))
    # AIDEV-NOTE: Смешанный DNS-ответ отклоняется целиком, чтобы не зависеть от порядка адресов.
    if not addresses or any(not _public(address, denied) for address in addresses):
        raise Rejected(403)
    for address in addresses:
        try:
            return await asyncio.wait_for(asyncio.open_connection(
                address, port, ssl=ssl.create_default_context() if tls else None,
                server_hostname=host if tls else None), CONNECT_TIMEOUT)
        except (OSError, asyncio.TimeoutError):
            continue
    raise Rejected(502)


def _browser_denied(host, port, config, denied):
    """Разрешить только публичный HTTPS вход установки, сохранив запрет внутренних адресов."""
    origins = config.get("publicWebOrigins", [])
    if not isinstance(origins, list) or len(origins) > 8:
        raise Rejected(503)
    allowed = False
    for origin in origins:
        if not isinstance(origin, str):
            raise Rejected(503)
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname
                or parsed.netloc not in (parsed.hostname, parsed.hostname + ":443")
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise Rejected(503)
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            pass
        else:
            raise Rejected(503)
        allowed = allowed or (host == parsed.hostname and port == 443)
    # _dial всё равно отклоняет private/link-local/mixed DNS даже при этом разрешении.
    return set() if allowed else denied


def _authority(value, default_port=None):
    if not value or any(ord(c) <= 32 or ord(c) >= 127 for c in value) or any(c in value for c in "/@?#\\"):
        raise Rejected()
    try:
        parsed = urlsplit("//" + value)
        host = parsed.hostname
        port = parsed.port if parsed.port is not None else default_port
        if not host or not port or not 1 <= port <= 65535:
            raise ValueError()
        return host, port
    except ValueError:
        raise Rejected() from None


async def _read_request(reader):
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), CONNECT_TIMEOUT)
    except (asyncio.LimitOverrunError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        raise Rejected(431) from None
    if len(raw) > HEADER_LIMIT or b"\x00" in raw:
        raise Rejected(431)
    lines = raw[:-4].split(b"\r\n")
    try:
        method, target, version = lines[0].decode("ascii").split(" ")
    except (ValueError, UnicodeDecodeError):
        raise Rejected() from None
    if version not in ("HTTP/1.0", "HTTP/1.1") or not TOKEN.fullmatch(method.encode("ascii")):
        raise Rejected()
    headers = []
    for line in lines[1:]:
        name, sep, value = line.partition(b":")
        if not sep or not TOKEN.fullmatch(name) or any(c < 32 and c != 9 or c == 127 for c in value):
            raise Rejected()
        headers.append((name.lower(), value.strip()))
    lengths = [v for k, v in headers if k == b"content-length"]
    if len(lengths) > 1 or any(k in (b"transfer-encoding", b"expect", b"upgrade") for k, _ in headers):
        raise Rejected()
    if lengths and (not lengths[0].isdigit() or len(lengths[0]) > 9):
        raise Rejected()
    size = int(lengths[0]) if lengths else 0
    if size > BODY_LIMIT:
        raise Rejected(413)
    try:
        body = await asyncio.wait_for(reader.readexactly(size), CONNECT_TIMEOUT)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
        raise Rejected() from None
    return method, target, headers, body


async def _pipe(reader, writer):
    while True:
        data = await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT)
        if not data:
            try:
                writer.write_eof()
            except (OSError, RuntimeError, AttributeError):
                pass
            return
        writer.write(data)
        await asyncio.wait_for(writer.drain(), DRAIN_TIMEOUT)


async def _duplex(a_reader, a_writer, b_reader, b_writer):
    await network._duplex(a_reader, a_writer, b_reader, b_writer)


def _profile(registry, uid):
    if not isinstance(registry, dict) or registry.get("version") != 1:
        raise Rejected(403)
    profiles = registry.get("profiles")
    profile = profiles.get(str(uid)) if isinstance(profiles, dict) else None
    if (not isinstance(profile, dict) or profile.get("status") != "active"
            or not isinstance(profile.get("userId"), str) or not profile["userId"]
            or not isinstance(profile.get("profileId"), str) or not profile["profileId"]):
        raise Rejected(403)
    return profile


def _model_target(method, target, config, body):
    path = target[len("/model"):]
    if config.get("codexSubscription") and (method != "POST" or path != "/v1/responses"):
        raise Rejected(403)
    if not ((method == "GET" and path == "/v1/models") or
            (method == "POST" and path in MODEL_PATHS)):
        raise Rejected(403)
    if path == "/v1/responses":
        try:
            obj = json.loads(body)
            if not isinstance(obj, dict) or obj.get("store", False) is not False:
                raise ValueError()
            obj["store"] = False
            body = json.dumps(obj, separators=(",", ":")).encode()
        except (ValueError, UnicodeDecodeError):
            raise Rejected() from None
    provider = config.get("provider")
    if not isinstance(provider, dict) or not isinstance(provider.get("apiKey"), str):
        raise Rejected(503)
    key = provider["apiKey"]
    if not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise Rejected(503)
    try:
        base = urlsplit(provider["baseUrl"])
        if base.scheme != "https" or base.username or base.password or base.query or base.fragment:
            raise ValueError()
        host, port = _authority(base.netloc, 443)
        prefix = base.path.rstrip("/")
        if prefix.endswith("/v1"):
            prefix = prefix[:-3]
        if any(c in prefix for c in "\r\n?#"):
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise Rejected(503) from None
    return host, port, prefix + (path[3:] if config.get("codexSubscription") else path), body, key


async def _image_target(method, target, config, body, resolve_provider):
    """Сохранить native images/edits по подписке, не возвращая credential пользователю."""
    if method != 'POST' or target not in ('/image/images/generations', '/image/images/edits'):
        raise Rejected(403)
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise Rejected(400) from None
    editing = target.endswith('/edits')
    fields = {'prompt', 'model', 'n', 'quality', 'size', 'background'} | ({'images'} if editing else set())
    if (not isinstance(value, dict) or set(value) != fields or value.get('model') != 'gpt-image-2'
            or type(value.get('n')) is not int or value['n'] != 1 or value.get('background') != 'opaque'
            or value.get('quality') not in ('low', 'medium', 'high')
            or not isinstance(value.get('size'), str)
            or not re.fullmatch(r'(?:auto|[1-9][0-9]{2,4}x[1-9][0-9]{2,4})', value['size'])
            or not isinstance(value.get('prompt'), str) or not value['prompt'].strip()
            or len(value['prompt'].encode('utf-8')) > 65536):
        raise Rejected(403)
    if editing:
        images = value['images']
        if (not isinstance(images, list) or not 1 <= len(images) <= 16
                or any(not isinstance(image, dict) or set(image) != {'image_url'}
                    or not isinstance(image['image_url'], str)
                    or not re.fullmatch(r'data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+',
                                        image['image_url']) for image in images)):
            raise Rejected(403)
    resolved, account = await resolve_provider(config)
    key = (resolved.get('provider') or {}).get('apiKey')
    if not resolved.get('codexSubscription') or not isinstance(key, str) or not key:
        raise Rejected(503)
    path = '/backend-api/codex/' + target[len('/image/'):]
    return 'chatgpt.com', 443, path, body, key, account


def _gif_target(method, target, config, body):
    """Разрешить только принятый GIF-запрос; отдельный ключ остаётся в root gateway."""
    if method != 'POST' or target != '/gif/v1/images/generations':
        raise Rejected(403)
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise Rejected(400) from None
    fixed = {'model': 'gpt-image-2.6-flare', 'size': 'auto', 'quality': 'low',
             'complexity': 'low', 'n': 1, 'output_format': 'gif',
             'frame_count': 9, 'frame_duration_ms': 200}
    if (not isinstance(value, dict) or set(value) != set(fixed) | {'prompt'}
            or any(type(value[k]) is not type(v) or value[k] != v for k, v in fixed.items())
            or not isinstance(value['prompt'], str) or not value['prompt'].strip()
            or len(value['prompt'].encode('utf-8')) > 16384):
        raise Rejected(403)
    provider = config.get('gifProvider')
    if not isinstance(provider, dict) or set(provider) != {'credentialsFile'}:
        raise Rejected(503)
    try:
        path = Path(provider['credentialsFile'])
        _root_directory(path.parent)
        credentials = _protected_json(path)
        key = credentials.get('apiKey')
        if (set(credentials) != {'apiKey'} or not isinstance(key, str)
                or not 0 < len(key) <= 4096 or not key.isascii() or any(c.isspace() for c in key)):
            raise ValueError()
    except (OSError, ValueError, TypeError, AttributeError):
        raise Rejected(503) from None
    return _model_target('POST', '/model/v1/images/generations',
        {'provider': {'baseUrl': 'https://api.openai.com/v1', 'apiKey': key}}, body)


def _root_directory(path):
    """Проверить canonical Root каталог программы и всех его предков."""
    path = Path(path)
    if (not path.is_absolute() or os.path.normpath(str(path)) != str(path)
            or any(c in str(path) for c in " \t\r\n\\")):
        raise Rejected(503)
    for parent in (path, *path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Rejected(503)
    return path


def _root_file(path, expected=None, *, executable=False):
    """Прочитать bounded закреплённые данные или проверить Root программу без импорта."""
    path = Path(path)
    _root_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o6022 or executable and not info.st_mode & 0o111):
            raise Rejected(503)
        if expected is None:
            return None
        if not isinstance(expected, str) or not re.fullmatch("[a-f0-9]{64}", expected):
            raise Rejected(503)
        raw = stream.read(32 * 1024 * 1024 + 1)
        after, current = os.fstat(stream.fileno()), path.lstat()
    token = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    if (len(raw) > 32 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected
            or token(info) != token(after) or token(info) != token(current)):
        raise Rejected(503)
    return raw


def _codex_source(provider):
    """Сверить программы с принятой aggregate квитанцией без прежнего HOME."""
    reference = provider["providerSourceReceipt"]
    if not isinstance(reference, dict) or set(reference) != {"path", "sha256"}:
        raise Rejected(503)
    if any(not isinstance(provider.get(key), str) or not re.fullmatch("[a-f0-9]{64}", provider[key])
           for key in ("expectedProviderSourceProducerSha256", "helperSha256")):
        raise Rejected(503)
    closed = provider["closedConfig"]
    if not isinstance(closed, dict) or set(closed) != {"path", "sha256"}:
        raise Rejected(503)
    source = json.loads(_root_file(reference["path"], reference["sha256"]))
    paths = ("python", "sitePackages", "codex", "node", "ownerHome", "codexHome", "workerDir", "componentRoot")
    if (not isinstance(source, dict) or source.get("version") != 1 or source.get("kind") != "brai_identity_provider_source"
            or source.get("state") != "verified" or source.get("sourceSha") != provider["sourceSha"]
            or source.get("producerSha256") != provider["expectedProviderSourceProducerSha256"]
            or source.get("paths") != {key: provider[key] for key in paths}
            or source.get("closedConfig") != provider["closedConfig"]):
        raise Rejected(503)
    _root_file(source["producerPath"], provider["expectedProviderSourceProducerSha256"])
    helper = str(Path(provider["componentRoot"]) / "services/hermes/extensions/tools/codex_cli_owner.py")
    if provider["helperPath"] != helper:
        raise Rejected(503)
    _root_file(helper, provider["helperSha256"])
    for name in ("python", "codex", "node"):
        _root_file(provider[name], executable=True)
    _root_directory(provider["sitePackages"])
    _root_directory(provider["workerDir"])
    closed = provider["closedConfig"]
    _root_file(closed["path"], closed["sha256"])


def _codex_mounts(provider):
    """Проверить mounts owner каталогов и read-only закрытого Codex config."""
    with open("/proc/self/mountinfo", encoding="utf-8") as source:
        mounts = {re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), line.split()[4]): line.split()[5].split(",")
                  for line in source}
    home, codex_home = provider["ownerHome"], provider["codexHome"]
    target = codex_home + "/config.toml"
    if home not in mounts or codex_home not in mounts or "ro" not in mounts.get(target, []):
        raise Rejected(503)
    closed = provider["closedConfig"]
    descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        raw = stream.read(65537)
    if (info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o222
            or len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != closed["sha256"]):
        raise Rejected(503)


def _codex_parameters(provider):
    """Допустить только Root программы и отдельного владельца credential DATA."""
    try:
        paths = ("python", "sitePackages", "codex", "node", "ownerHome", "codexHome", "workerDir", "componentRoot", "helperPath")
        if (any(not isinstance(provider.get(k), str) or not os.path.isabs(provider[k])
                or os.path.normpath(provider[k]) != provider[k]
                or any(c in provider[k] for c in " \t\r\n\\") for k in paths)
                or not re.fullmatch("[a-f0-9]{40}", provider.get("sourceSha", ""))
                or any(key in provider for key in ("core", "runtime", "profileHome"))
                or provider["codexHome"] != provider["ownerHome"] + "/.codex"):
            raise Rejected(503)
        uid, gid = provider.get("uid"), provider.get("gid")
        if type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0 or pwd.getpwuid(uid).pw_gid != gid:
            raise Rejected(503)
        _root_directory(Path(provider["ownerHome"]).parent)
        for name in ("ownerHome", "codexHome"):
            info = Path(provider[name]).lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid
                    or stat.S_IMODE(info.st_mode) != 0o700):
                raise Rejected(503)
        _codex_source(provider)
        _codex_mounts(provider)
        return uid, gid
    except (OSError, KeyError, ValueError, TypeError):
        raise Rejected(503) from None


_CODEX_OWNER_PROGRAM = """import hashlib,importlib.util,json,sys
from pathlib import Path
p=json.loads(sys.argv[1]); helper=Path(p['helperPath'])
if hashlib.sha256(helper.read_bytes()).hexdigest()!=p['helperSha256'] or (helper.parent.parent/'.brai-runtime.json').exists():
    raise ValueError('CODEX_OWNER_SOURCE_REJECTED')
spec=importlib.util.spec_from_file_location('_brai_codex_owner',helper)
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
owner.HOME,owner.CODEX_HOME=owner.owner_paths(p['ownerHome'],p['codexHome'])
owner.BINARY=Path(p['codex']);owner.LOCK=owner.CODEX_HOME/'hermes-owner.lock'
v=owner.resolve();print(json.dumps({'access':v['api_key'],'account':v['account_id']}))
"""


async def _codex_credentials(provider):
    """Получить credential через принятый stdlib код и отдельное DATA хранилище."""
    uid, gid = _codex_parameters(provider)
    env = {"HOME": provider["ownerHome"], "CODEX_HOME": provider["codexHome"],
           "PATH": str(Path(provider["node"]).parent) + ":/usr/bin:/bin",
           "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    parameters = {key: provider[key] for key in ("helperPath", "helperSha256", "ownerHome", "codexHome", "codex")}
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            provider["python"], "-I", "-S", "-B", "-c", _CODEX_OWNER_PROGRAM, json.dumps(parameters),
            cwd=provider["workerDir"], env=env, user=uid, group=gid, extra_groups=[],
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=16384)
        raw = await asyncio.wait_for(process.stdout.readuntil(b"\n"), CREDENTIAL_TIMEOUT)
        status = await asyncio.wait_for(process.wait(), 1)
        if status != 0:
            raise Rejected(503)
        value = json.loads(raw)
        access, account = value["access"], value["account"]
        if (not isinstance(access, str) or not isinstance(account, str)
                or not access or not account or len(access) > 12000 or len(account) > 1024
                or any(ord(c) < 33 or ord(c) > 126 for c in access + account)):
            raise Rejected(503)
        return access, account
    except (OSError, ValueError, KeyError, TypeError, asyncio.TimeoutError,
            asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        raise Rejected(503) from None
    finally:
        if process is not None and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


async def _resolve_provider(config):
    """Разрешить ключ только в памяти процесса и закрепить endpoint подписки."""
    provider = config.get("provider")
    if not isinstance(provider, dict):
        raise Rejected(503)
    if provider.get("type") in (None, "static"):
        return config, None
    if provider.get("type") != "codex-cli":
        raise Rejected(503)
    access, account = await _codex_credentials(provider)
    return {**config, "codexSubscription": True,
            "provider": {"baseUrl": "https://chatgpt.com/backend-api/codex",
                         "apiKey": access}}, account


async def _stop_search(process):
    """Погасить всю группу; прочитать pipe, чтобы paused stdout не блокировал wait."""
    async def discard():
        try:
            while await process.stdout.read(65536):
                pass
        except (OSError, ValueError):
            pass
    draining = asyncio.create_task(discard())
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(process.wait(), 2)
    finally:
        draining.cancel()
        await asyncio.gather(draining, return_exceptions=True)


async def _shared_search(config, body):
    """Использовать существующие accepted provider paths без выдачи credential."""
    from .search import request, SEARCH_TIMEOUT, OUTPUT_LIMIT
    try:
        value = request(body)
    except (ValueError, TypeError, UnicodeError):
        raise Rejected(400) from None
    provider = config.get('provider')
    if not isinstance(provider, dict) or provider.get('type') != 'codex-cli':
        raise Rejected(503)
    uid, gid = _codex_parameters(provider)
    helper = str(Path(__file__).with_name('search.py'))
    _root_file(helper)
    parameters = {key: provider[key] for key in (
        'helperPath', 'helperSha256', 'ownerHome', 'codexHome', 'codex')}
    parameters['request'] = value
    env = {'HOME': provider['ownerHome'], 'CODEX_HOME': provider['codexHome'],
           'PATH': str(Path(provider['node']).parent) + ':/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt',
           'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            provider['python'], '-I', '-S', '-B', helper,
            cwd=provider['workerDir'], env=env, user=uid, group=gid, extra_groups=[],
            start_new_session=True, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=OUTPUT_LIMIT + 1)
        async def collect():
            process.stdin.write(json.dumps(parameters, ensure_ascii=False).encode() + b'\n')
            await process.stdin.drain()
            process.stdin.close()
            raw = await process.stdout.readuntil(b'\n')
            if len(raw) > OUTPUT_LIMIT:
                raise ValueError('Search output too large')
            status = await process.wait()
            result = json.loads(raw)
            if status != 0 or not isinstance(result, dict) or type(result.get('success')) is not bool:
                raise ValueError('Invalid search receipt')
            return result
        return await asyncio.wait_for(collect(), SEARCH_TIMEOUT + 2)
    except (OSError, ValueError, TypeError, UnicodeError, asyncio.TimeoutError,
            asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        raise Rejected(502) from None
    finally:
        if process is not None:
            cleanup = asyncio.create_task(_stop_search(process))
            interrupted = False
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    interrupted = True
            await cleanup
            if interrupted:
                raise asyncio.CancelledError


async def _search_response(reader, writer, uid, config, body, search):
    """Отмена клиента прерывает CLI; одна выдача не запускает повтор запроса."""
    operation = asyncio.create_task(search(uid, config, body))
    disconnected = asyncio.create_task(reader.read(1))
    try:
        done, _ = await asyncio.wait((operation, disconnected), return_when=asyncio.FIRST_COMPLETED)
        if disconnected in done:
            return
        result = await operation
        raw = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '
                     + str(len(raw)).encode() + b'\r\n\r\n' + raw)
        await writer.drain()
    finally:
        operation.cancel()
        disconnected.cancel()
        await asyncio.gather(operation, disconnected, return_exceptions=True)


async def _handle(reader, writer, registry_loader, config_loader, dial, resolve_provider, search, public_only=False):
    upstream = None
    response_started = False
    try:
        sock = writer.get_extra_info("socket")
        _, uid, _ = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        profile = _profile(registry_loader(), uid)
        config = config_loader()
        if not isinstance(config, dict):
            raise Rejected(503)
        denied = set(config.get("deniedAddresses", []))
        method, target, headers, body = await _read_request(reader)
        if not public_only and profile.get("role") == "guest" and not (target.startswith("/model/") or target.startswith("/image/") or target.startswith("/gif/") or target == "/search/v1/query"):
            raise Rejected(403)
        if method == "CONNECT":
            host, port = _authority(target)
            if port != 443 or body:
                raise Rejected(403)
            connect_denied = denied if public_only else _browser_denied(host, port, config, denied)
            source, upstream = await dial(host, port, False, connect_denied)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            response_started = True
            await _duplex(reader, writer, source, upstream)
            return
        parsed = urlsplit(target)
        if public_only:
            model_target = None
        elif target.startswith("/model/"):
            model_target = target
        elif parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and parsed.path.startswith("/model/"):
            model_target = parsed.path + (("?" + parsed.query) if parsed.query else "")
        else:
            model_target = None
        key = None
        account = None
        request_path = target if target.startswith('/') else (
            parsed.path + (('?' + parsed.query) if parsed.query else '')
            if parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost') else '')
        if public_only:
            request_path = ''
        if request_path.startswith('/search/'):
            if request_path != '/search/v1/query':
                raise Rejected(403)
            if method != 'POST':
                raise Rejected(405)
            await _search_response(reader, writer, uid, config, body, search)
            return
        if request_path.startswith('/gif/'):
            host, port, path, body, key = _gif_target(method, request_path, config, body)
            tls = True
        elif request_path.startswith('/image/'):
            host, port, path, body, key, account = await _image_target(
                method, request_path, config, body, resolve_provider)
            tls = True
        elif model_target is not None:
            provider = config.get("provider")
            if (isinstance(provider, dict) and provider.get("type") == "codex-cli"
                    and (method != "POST" or model_target != "/model/v1/responses")):
                raise Rejected(403)
            config, account = await resolve_provider(config)
            host, port, path, body, key = _model_target(method, model_target, config, body)
            tls = True
        else:
            if method not in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
                raise Rejected(405)
            if parsed.scheme != "http" or not parsed.netloc or parsed.fragment or parsed.username or parsed.password:
                raise Rejected(400)
            host, port = _authority(parsed.netloc, 80)
            path = (parsed.path or "/") + (("?" + parsed.query) if parsed.query else "")
            tls = False
        if any(ord(c) <= 32 or ord(c) >= 127 for c in path):
            raise Rejected()
        source, upstream = await dial(host, port, tls, denied)
        # Запрос обслуживается один раз; исключаем неоднозначное обрамление и hop-by-hop поля.
        connection_tokens = set()
        for name, value in headers:
            if name == b"connection":
                connection_tokens.update(part.strip().lower() for part in value.split(b","))
        excluded = {b"host", b"connection", b"proxy-connection", b"content-length",
                    b"proxy-authorization", b"keep-alive", b"te", b"trailer"} | connection_tokens
        if key is not None:
            excluded.add(b"authorization")
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if tls else 80):
            authority += f":{port}"
        head = f"{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nContent-Length: {len(body)}\r\n".encode("ascii")
        for name, value in headers:
            if name not in excluded and (key is None or name in {b"accept", b"content-type"}):
                head += name + b": " + value + b"\r\n"
        if request_path.startswith('/image/'):
            # Подписочный backend требует идентичность harness. Заголовки создаёт
            # trusted egress; личный процесс не задаёт account/residency.
            import base64
            import uuid
            head += b"User-Agent: HermesAgent/Brai\r\noriginator: hermes-agent\r\n"
            head += b"x-codex-image-turn-id: " + str(uuid.uuid4()).encode('ascii') + b"\r\n"
            try:
                encoded = key.split('.')[1]
                claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
                auth = claims.get('https://api.openai.com/auth', {})
                residency = auth.get('chatgpt_data_residency') or auth.get('chatgpt_compute_residency')
                if isinstance(residency, str) and residency.strip().isascii() and all(
                        32 < ord(char) < 127 for char in residency.strip()):
                    head += b"x-openai-internal-codex-residency: " + residency.strip().encode('ascii') + b"\r\n"
            except (ValueError, IndexError, TypeError, AttributeError):
                pass
        if key is not None:
            head += b"Authorization: Bearer " + key.encode("ascii") + b"\r\n"
            if account is not None:
                head += b"ChatGPT-Account-Id: " + account.encode("ascii") + b"\r\n"
        upstream.write(head + b"\r\n" + body)
        await asyncio.wait_for(upstream.drain(), CONNECT_TIMEOUT)
        response_started = True
        await _pipe(source, writer)
    except Rejected as error:
        if not response_started:
            writer.write(f"HTTP/1.1 {error.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode())
            await writer.drain()
    except (OSError, ValueError, TypeError, KeyError, asyncio.TimeoutError):
        if not response_started:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            try:
                await writer.drain()
            except OSError:
                pass
    finally:
        if upstream is not None:
            upstream.close()
        writer.close()


async def _authorize_socket(path, uid):
    """Спросить брокер Auth; ошибка или неожиданный ответ запрещает доступ."""
    reader, writer = await asyncio.open_unix_connection(path, limit=8192)
    try:
        request = {"jsonrpc": "2.0", "id": 1, "method": "authorize", "params": {"uid": uid}}
        writer.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
        await writer.drain()
        reply = json.loads(await reader.readuntil(b"\n"))
        return (isinstance(reply, dict) and reply.get("jsonrpc") == "2.0"
                and reply.get("id") == 1 and isinstance(reply.get("result"), dict)
                and reply["result"].get("allowed") is True and "error" not in reply)
    finally:
        writer.close()
        await writer.wait_closed()


async def _check_access(uid, registry_loader, authorize):
    """Вернуть True/False по правам либо None при недоступной проверке Auth."""
    try:
        _profile(registry_loader(), uid)
        return await asyncio.wait_for(authorize(uid), 0.4) is True
    except Rejected:
        return False
    except Exception:
        # AIDEV-NOTE: Доступ закрыт; недоступность Auth не означает неверные credentials.
        return None


async def _watch_access(uid, registry_loader, authorize):
    while True:
        await asyncio.sleep(0.4)
        if not await _check_access(uid, registry_loader, authorize):
            return


async def start_server(socket_path, registry_loader, config_loader, authorize, dial=_dial,
                       resolve_provider=None, *, public_only=False):
    """Открыть UDS; доступ к каждому потоку регулярно подтверждает Auth."""
    semaphore = asyncio.Semaphore(MAX_CONNECTIONS)
    active = set()
    searching = set()
    search_slots = asyncio.Semaphore(SEARCH_CONCURRENCY)
    async def search(uid, config, body):
        if uid in searching or search_slots.locked():
            raise Rejected(429)
        searching.add(uid)
        try:
            async with search_slots:
                return await _shared_search(config, body)
        finally:
            searching.discard(uid)
    if resolve_provider is None:
        resolve_provider = _resolve_provider

    async def handle(reader, writer):
        task = asyncio.current_task()
        active.add(task)
        connection_id = uuid.uuid4().hex
        started = time.monotonic()
        operation = watcher = None
        try:
            if semaphore.locked():
                return
            async with semaphore:
                sock = writer.get_extra_info("socket")
                _, uid, _ = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                allowed = await _check_access(uid, registry_loader, authorize)
                if allowed is not True:
                    status = 403 if allowed is False else 503
                    writer.write(f"HTTP/1.1 {status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode())
                    await writer.drain()
                    return
                operation = asyncio.create_task(_handle(reader, writer, registry_loader, config_loader, dial, resolve_provider, search, public_only=public_only))
                watcher = asyncio.create_task(_watch_access(uid, registry_loader, authorize))
                done, _ = await asyncio.wait((operation, watcher), return_when=asyncio.FIRST_COMPLETED)
                if watcher in done and operation not in done:
                    LOGGER.info('connection=%s stage=access elapsed=%.3f reason=revoke',
                                connection_id, time.monotonic() - started)
        except (OSError, ValueError, TypeError):
            pass
        finally:
            for child in (operation, watcher):
                if child is not None:
                    child.cancel()
            await asyncio.gather(*(child for child in (operation, watcher) if child is not None),
                                 return_exceptions=True)
            writer.close()
            active.discard(task)

    server = await asyncio.start_unix_server(handle, path=socket_path, limit=HEADER_LIMIT)
    os.chmod(socket_path, 0o666)
    server.active_connections = active
    return server


def _notify_ready():
    address = os.environ.get("NOTIFY_SOCKET")
    if address:
        if address.startswith("@"):
            address = "\0" + address[1:]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notifier:
            notifier.connect(address)
            notifier.sendall(b"READY=1")


async def _main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    config = _protected_json(args.config)
    registry = _protected_json(args.registry)
    if not isinstance(registry, dict) or registry.get("version") != 1 or not isinstance(registry.get("profiles"), dict):
        raise ValueError("invalid registry")
    if not isinstance(config, dict) or not isinstance(config.get("deniedAddresses", []), list):
        raise ValueError("invalid configuration")
    provider = config.get("provider")
    if isinstance(provider, dict) and provider.get("type") == "codex-cli":
        _codex_parameters(provider)
    elif isinstance(provider, dict) and provider.get("type") in (None, "static"):
        _model_target("GET", "/model/v1/models", config, b"")
    else:
        raise ValueError("invalid provider type")
    authorization_socket = config.get("authorizationSocket")
    if not isinstance(authorization_socket, str) or not os.path.isabs(authorization_socket):
        raise ValueError("invalid authorizationSocket")
    # AIDEV-NOTE: Готовность означает, что защищённая конфигурация читается и брокер доступен.
    _, probe = await asyncio.wait_for(asyncio.open_unix_connection(authorization_socket), 0.4)
    probe.close()
    await probe.wait_closed()

    async def authorize(uid):
        current = _protected_json(args.config).get("authorizationSocket")
        if not isinstance(current, str) or not os.path.isabs(current):
            return False
        return await _authorize_socket(current, uid)

    servers = []
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    try:
        servers.append(await start_server(args.socket, lambda: _protected_json(args.registry),
                                          lambda: _protected_json(args.config), authorize))
        servers.append(await start_server(args.socket + '.browser', lambda: _protected_json(args.registry),
                                          lambda: _protected_json(args.config), authorize, public_only=True))
        _notify_ready()
        await stopped.wait()
    finally:
        for server in servers:
            server.close()
        for server in servers:
            await server.wait_closed()
        tasks = [task for server in servers for task in server.active_connections]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(_main())
