# ABOUTME: Принимает owner-only Groq key отдельного native Hermes PROD через Telegram Mini App.
# ABOUTME: Использует только stdlib, получает токен только из systemd EnvironmentFile и не меняет настройки Hermes.
"""Single-service Telegram WebApp Groq intake. Python stdlib only."""
import hashlib
import hmac
import json
from urllib.parse import parse_qsl
import secrets
import threading
import time


class OperationTokens:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.items = {}

    def issue(self, uid):
        with self.lock:
            now = self.clock()
            self.items = {k: v for k, v in self.items.items() if v[3] > now}
            if len(self.items) >= 128:
                raise Denied()
            token = secrets.token_urlsafe(32)
            self.items[token] = (uid, 'groq', 'create', now + 600)
            return token

    def consume(self, token, uid):
        if not isinstance(token, str):
            return False
        with self.lock:
            value = self.items.get(token)
            if value is None or value[:3] != (uid, 'groq', 'create'):
                return False
            del self.items[token]
            return value[3] > self.clock()

import os
import re
from contextlib import contextmanager


def valid_key(key):
    return isinstance(key, str) and re.fullmatch(r'gsk_[A-Za-z0-9_-]{32,124}', key) is not None


class SecretStore:
    def __init__(self, path):
        self.path = path

    @contextmanager
    def directory(self):
        fd = None
        try:
            if not os.path.isabs(self.path) or '..' in self.path.split('/'):
                raise Denied()
            parts = [p for p in self.path.split('/') if p]
            if not parts:
                raise Denied()
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            fd = os.open('/', flags)
            for i, part in enumerate(parts):
                if i == len(parts) - 1:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            if os.fstat(fd).st_uid != os.geteuid():
                raise Denied()
            os.fchmod(fd, 0o700)
            yield fd
        except OSError:
            raise Denied() from None
        finally:
            if fd is not None:
                os.close(fd)

    @staticmethod
    def assert_absent(fd):
        try:
            os.stat('groq.env', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise Denied()

    def check_absent(self):
        with self.directory() as fd:
            self.assert_absent(fd)

    def save(self, key):
        if not valid_key(key):
            raise Denied()
        with self.directory() as fd:
            self.assert_absent(fd)
            temp = '.groq-' + secrets.token_hex(16)
            created = False
            try:
                out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
                created = True
                with os.fdopen(out, 'wb') as f:
                    os.fchmod(f.fileno(), 0o600)
                    f.write(('GROQ_API_KEY=' + key + '\n').encode('ascii'))
                    f.flush()
                    os.fsync(f.fileno())
                # link() is an atomic non-overwriting publication; rename() is not.
                os.link(temp, 'groq.env', src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                os.fsync(fd)
            except OSError:
                raise Denied() from None
            finally:
                if created:
                    os.unlink(temp, dir_fd=fd)
                    os.fsync(fd)


class Denied(Exception):
    """Deliberately contains no request, credential or upstream details."""


def validate_init_data(raw, bot_token, owner_id, now):
    try:
        if not isinstance(raw, str) or not raw or len(raw) > 16384:
            raise Denied()
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
        data = dict(pairs)
        if len(data) != len(pairs):
            raise Denied()
        signature = data.pop('hash')
        check = '\n'.join(f'{k}={v}' for k, v in sorted(data.items()))
        secret = hmac.new(b'WebAppData', bot_token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise Denied()
        date = int(data['auth_date'])
        if date > now or now - date > 600:
            raise Denied()
        user = json.loads(data['user'])
        uid = user['id']
        if type(uid) is not int or uid != owner_id:
            raise Denied()
        return uid
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
        raise Denied() from None


from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import ssl
import urllib.request

BASE = '/connect/groq/'

MAX_BODY = 24576
ASSETS = Path(__file__).resolve().parent / 'hermes_intake_assets'
CSP = ("default-src 'none'; script-src 'self' https://telegram.org; "
       "style-src 'self'; connect-src 'self'; img-src 'self' data:; "
       "base-uri 'none'; object-src 'none'; form-action 'none'; "
       "frame-ancestors https://web.telegram.org https://*.telegram.org")
MESSAGES = {
    'authorized': 'Авторизация подтверждена. Форма действует 10 минут.',
    'saved': 'Ключ Groq проверен и сохранён. Настройки Hermes не изменены.',
    'unauthorized': 'Авторизация или одноразовая форма недействительна либо истекла. Откройте приложение заново из Telegram.',
    'bad_request': 'Некорректный запрос или формат ключа. Откройте форму заново.',
    'too_large': 'Запрос слишком большой.',
    'conflict': 'Ключ уже существует или безопасная запись недоступна. Перезапись запрещена.',
    'upstream_failed': 'Groq не подтвердил ключ или временно недоступен. Ключ не сохранён. Для повторной попытки откройте форму заново.',
    'not_found': 'Страница не найдена.',
    'unavailable': 'Сервис временно недоступен. Откройте форму заново.',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_groq_key(key):
    """Only fixed HTTPS endpoint, no redirects/proxies, no upstream body logging."""
    if not valid_key(key):
        return False
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request('https://api.groq.com/openai/v1/models',
        headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json',
                 'User-Agent': 'Hermes-Groq-Intake/1.0'}, method='GET')
    try:
        with opener.open(request, timeout=10) as response:
            if response.status != 200:
                return False
            body = response.read(65537)
            if len(body) > 65536:
                return False
            data = json.loads(body)
            return isinstance(data, dict) and isinstance(data.get('data'), list)
    except Exception as error:
        # HTTPError can contain a credential-bearing request. Do not stringify it.
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        return False


class IntakeApplication:
    def __init__(self, bot_token, owner_id, secret_dir, origin=None, validator=validate_groq_key,
                 wall_clock=time.time, token_clock=time.monotonic):
        """Bind one owner, secret directory and allowed public HTTPS origin."""
        if not isinstance(bot_token, str) or not bot_token or type(owner_id) is not int or owner_id <= 0:
            raise Denied()
        self.bot_token = bot_token
        self.owner_id = owner_id
        self.origin = origin
        self.store = SecretStore(secret_dir)
        self.validator = validator
        self.wall_clock = wall_clock
        self.tokens = OperationTokens(clock=token_clock)

    def post(self, path, data):
        expected = {'init_data'} if path == BASE + 'authorize' else {'init_data', 'operation_token', 'api_key'}
        if not isinstance(data, dict) or set(data) != expected:
            return 400, 'bad_request', {}
        try:
            uid = validate_init_data(data['init_data'], self.bot_token, self.owner_id, self.wall_clock())
        except Denied:
            return 403, 'unauthorized', {}
        if path == BASE + 'authorize':
            try:
                token = self.tokens.issue(uid)
            except Denied:
                return 503, 'unavailable', {}
            return 200, 'authorized', {'operation_token': token, 'expires_in': 600}
        # Consume before any validation, network or disk work. All outcomes consume it.
        if not self.tokens.consume(data['operation_token'], uid):
            return 403, 'unauthorized', {}
        key = data['api_key']
        if not valid_key(key):
            return 400, 'bad_request', {}
        try:
            self.store.check_absent()
        except Denied:
            return 409, 'conflict', {}
        try:
            valid = self.validator(key)
        except Exception:
            valid = False
        if valid is not True:
            return 502, 'upstream_failed', {}
        try:
            self.store.save(key)
        except Denied:
            return 409, 'conflict', {}
        return 200, 'saved', {}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'SecretIntake'
    sys_version = ''
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        # Suppress request lines, URLs, headers and bodies, including parser errors.
        pass

    def reply(self, code, status, extra=None):
        body = json.dumps({'status': status, 'message': MESSAGES[status], **(extra or {})}, ensure_ascii=False).encode()
        self.respond(code, body, 'application/json; charset=utf-8')

    def respond(self, code, body, content_type):
        self.close_connection = True
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        # Never reflect parser errors or client-controlled methods/URLs.
        self.reply(code, 'bad_request')

    def do_GET(self):
        files = {BASE: ('index.html', 'text/html; charset=utf-8'),
                 BASE+'app.js': ('app.js', 'text/javascript; charset=utf-8'),
                 BASE+'style.css': ('style.css', 'text/css; charset=utf-8')}
        asset = files.get(self.path)
        if asset is None:
            self.reply(404, 'not_found')
            return
        try:
            self.respond(200, (ASSETS / asset[0]).read_bytes(), asset[1])
        except OSError:
            self.reply(503, 'unavailable')

    def do_POST(self):
        try:
            self.post_request()
        except Exception:
            # No traceback or exception interpolation: frames may carry the key.
            self.reply(503, 'unavailable')

    def post_request(self):
        if self.path not in (BASE+'authorize', BASE+'submit'):
            self.reply(404, 'not_found')
            return
        if self.headers.get_all('Origin', []) != [self.server.app.origin]:
            self.reply(403, 'unauthorized')
            return
        if self.headers.get_all('Transfer-Encoding', []) or len(self.headers.get_all('Content-Length', [])) != 1:
            self.reply(400, 'bad_request')
            return
        length_text = self.headers.get('Content-Length', '')
        if not re.fullmatch(r'[0-9]{1,8}', length_text):
            self.reply(400, 'bad_request')
            return
        length = int(length_text)
        if length > MAX_BODY:
            self.reply(413, 'too_large')
            return
        if length == 0 or self.headers.get_all('Content-Type', []) != ['application/json']:
            self.reply(400, 'bad_request')
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError()
            data = json.loads(body.decode('utf-8'), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError, RecursionError):
            self.reply(400, 'bad_request')
            return
        code, status, extra = self.server.app.post(self.path, data)
        self.reply(code, status, extra)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = True
    request_queue_size = 32

    def __init__(self, address, app):
        self.app = app
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            self.shutdown_request(request)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # socketserver defaults print a traceback, possibly exposing request data.
        pass


def make_server(app, bind='172.23.0.1', port=19379):
    return Server((bind, port), app)


def read_regular(path, limit):
    import stat
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        metadata=os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid()
                or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise Denied()
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            body = stream.read(limit + 1)
        if len(body) > limit:
            raise Denied()
        return body.decode('utf-8')
    except (OSError, UnicodeError):
        raise Denied() from None
    finally:
        if fd is not None:
            os.close(fd)


def load_config(path='/etc/brai/hermes/intake.json'):
    """Load only the explicit protected PROD listener, owner and HTTPS origin."""
    try:
        config = json.loads(read_regular(path, 65536), object_pairs_hook=unique_object)
        if not isinstance(config, dict) or set(config) != {'owner_id', 'secret_dir', 'bind', 'port', 'origin'}:
            raise Denied()
        if type(config['owner_id']) is not int or config['owner_id'] <= 0:
            raise Denied()
        import ipaddress
        gateway=ipaddress.IPv4Address(config['bind'])
        if not gateway.is_private or gateway.is_loopback or str(gateway)=='192.168.16.1' or config['port'] != 19379:
            raise Denied()
        if config['secret_dir'] != '/etc/brai/hermes/secrets':
            raise Denied()
        from urllib.parse import urlsplit
        origin = config['origin']
        parsed = urlsplit(origin)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
                or origin != 'https://' + parsed.netloc or any(c.isspace() for c in origin)):
            raise Denied()
        return config
    except (ValueError, TypeError, RecursionError):
        raise Denied() from None


def environment_bot_token():
    """Use the systemd-injected token without opening or copying a dotenv file."""
    keys = ('TELEGRAM_BOT_TOKEN', 'BRAI_AI_BOT_TOKEN', 'BRAI_TELEGRAM_BOT_TOKEN', 'BOT_TOKEN')
    values = {os.environ[key] for key in keys if os.environ.get(key)}
    if len(values) != 1:
        raise Denied()
    token = values.pop()
    if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise Denied()
    return token


def main():
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='Groq owner-only Telegram WebApp intake')
    parser.add_argument('--config', default='/etc/brai/hermes/intake.json')
    args = parser.parse_args()
    try:
        os.umask(0o077)
        config = load_config(args.config)
        app = IntakeApplication(environment_bot_token(), config['owner_id'],
                                config['secret_dir'], config['origin'])
        with make_server(app, config['bind'], config['port']) as server:
            server.serve_forever()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Never include an exception, config value, request or credential here.
        sys.stderr.write('Secret intake startup or runtime failure. Check nonsecret configuration and file permissions.\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
