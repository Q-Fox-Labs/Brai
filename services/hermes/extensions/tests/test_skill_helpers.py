# ABOUTME: Проверяет standalone helper CLI личного профиля без внешних сервисов.
# ABOUTME: Использует синтетический Unix HTTP и отдельный native yt-dlp module fixture.
import hashlib
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

EXT = Path(__file__).resolve().parents[1]
MEMORY = EXT / 'skill-scripts/note-taking/memos-memory/scripts/memos_client.py'
VIDEO = EXT / 'skill-scripts/media/youtube-content/scripts/video_workflow.py'
SDK = EXT / 'plugins/memos-rest/client.py'


def load(path, name='helper'):
    """Импортировать только код fixture; не загружать настоящий профиль."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VideoNamespaceTests(unittest.TestCase):
    def test_standalone_native_downloads_stay_in_private_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'profile'
            home.mkdir()
            (root / 'yt_dlp.py').write_text('''import json, pathlib, sys
if '--dump-single-json' in sys.argv:
    print(json.dumps({'id':'abcdefghijk','title':'Synthetic fixture','live_status':'not_live'}))
else:
    template=sys.argv[sys.argv.index('-o')+1]
    output=pathlib.Path(template.replace('%(id)s','abcdefghijk').replace('%(ext)s','mp4'))
    output.write_bytes(b'synthetic native module output')
''')
            wrapper = root / 'yt-dlp'
            wrapper.write_text('#!' + sys.executable + '\nimport os, sys\n'
                + 'os.execve(sys.executable, [sys.executable, "-m", "yt_dlp", *sys.argv[1:]], '
                + 'dict(os.environ, PYTHONPATH=' + repr(str(root)) + '))\n')
            wrapper.chmod(0o700)
            env = dict(os.environ, BRAI_IDENTITY_MODE='worker', HERMES_HOME=str(home),
                       PYTHONDONTWRITEBYTECODE='1')
            env.pop('PYTHONPATH', None)
            bootstrap = f'''import importlib.util, sys
spec=importlib.util.spec_from_file_location('helper',{str(VIDEO)!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.PRIVATE_YTDLP={str(wrapper)!r}
sys.exit(m.main())
'''
            result = subprocess.run([sys.executable, '-B', '-c', bootstrap, 'fetch',
                'https://youtu.be/abcdefghijk', '--kind', 'video'], env=env,
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(Path(value['job_dir']).parent, home / 'workspace/downloads')
            self.assertEqual(Path(value['files'][0]).read_bytes(), b'synthetic native module output')
            self.assertEqual(stat.S_IMODE(Path(value['job_dir']).stat().st_mode), 0o700)
            helper = load(VIDEO)
            with patch.dict(os.environ, env):
                self.assertEqual(helper.ytdlp_base()[0], '/opt/brai-profile/instructions/bin/yt-dlp')
                for flag in ('--ignore-config', '--no-exec', '--no-playlist'):
                    self.assertIn(flag, helper.ytdlp_base())

    def test_private_root_rejects_missing_home_and_symlink_workspace(self):
        helper = load(VIDEO)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home, other = root / 'home', root / 'other'
            home.mkdir(); other.mkdir()
            (home / 'workspace').symlink_to(other, target_is_directory=True)
            for value in ('', 'relative', str(home)):
                with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker', 'HERMES_HOME': value}):
                    with self.assertRaises(ValueError):
                        helper.download_root()
            self.assertEqual(list(other.iterdir()), [])


class MemoryConfigTests(unittest.TestCase):
    def setUp(self):
        self.helper = load(MEMORY)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = {'socket_path': '/run/brai-profile/memory.sock', 'base_url': 'http://localhost',
            'user_id': 'owner', 'cube_id': 'main', 'memory_epoch': 'epoch',
            'routing_enabled': True, 'enabled': True, 'frozen': False, 'suspended': False}
        self.path = self.home / 'memos-rest.json'
        self.path.write_text(json.dumps(self.config)); self.path.chmod(0o640)
        self.env = patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker',
            'HERMES_HOME': str(self.home), 'BRAI_IDENTITY_USER_ID': 'owner'})
        self.env.start(); self.addCleanup(self.env.stop)

    def protected(self, **fields):
        info = self.path.stat()
        return NS(st_uid=0, st_nlink=1, st_mode=stat.S_IFREG | 0o640, st_size=info.st_size, **fields)

    def test_config_requires_root_regular_nonwritable_owner_bound_bytes(self):
        info = self.protected()
        with patch.object(self.helper.os, 'fstat', return_value=info):
            self.assertEqual(self.helper.worker_config()['user_id'], 'owner')
        for field, value in [('st_uid', 1234), ('st_nlink', 2),
                             ('st_mode', stat.S_IFREG | 0o660), ('st_mode', stat.S_IFIFO | 0o640)]:
            values = vars(self.protected()) | {field: value}
            with patch.object(self.helper.os, 'fstat', return_value=NS(**values)):
                with self.assertRaises(ValueError): self.helper.worker_config()
        for fields in ({'user_id': 'foreign'}, {'socket_path': '/tmp/foreign'}, {'routing_enabled': False},
                       {'memory_epoch': ''}, {'enabled': False}, {'suspended': True}):
            self.path.write_text(json.dumps(self.config | fields))
            with patch.object(self.helper.os, 'fstat', return_value=self.protected()):
                with self.assertRaises(ValueError): self.helper.worker_config()

    def test_config_symlink_and_unprotected_sdk_never_execute(self):
        other = self.home / 'other.json'
        self.path.rename(other); self.path.symlink_to(other)
        with self.assertRaises(OSError): self.helper.worker_config()
        sdk = self.home / 'client.py'
        sdk.write_text("raise AssertionError('untrusted SDK executed')")
        with patch.object(self.helper, 'PRIVATE_CLIENT', sdk):
            info = sdk.stat()
            with patch.object(Path, 'lstat', return_value=NS(st_uid=1234, st_nlink=1, st_mode=info.st_mode)):
                with self.assertRaises(ValueError): self.helper.worker_client(self.config)


class MemoryStandaloneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.requests, self.foreign, self.redirect = [], False, False
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                outer.requests.append(('GET', self.path, None))
                if outer.redirect:
                    self.send_response(302); self.send_header('Location', 'http://127.0.0.1:1/private-secret')
                    self.end_headers(); return
                if self.path.startswith('/product/scheduler/status?'):
                    self.reply({'code':200,'message':'Memory get status successfully','data':[{'task_id':'task-own','status':'completed'}]})
                    return
                self.reply({'code': 200, 'data': {'memory_stream': 1, 'recall_index': 1}})
            def reply(self, value, kind='application/json'):
                self.send_response(200); self.send_header('Content-Type', kind); self.end_headers()
                self.wfile.write(value if isinstance(value, bytes) else json.dumps(value).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append(('POST', self.path, body))
                user = 'foreign' if outer.foreign else 'owner'
                rows = [{'id': name, 'memory': 'synthetic personal ' + name,
                         'metadata': {'user_id': user, 'info': {}}, '_cube_id': body.get('mem_cube_id', 'main')}
                        for name in ('one', 'two')]
                if self.path == '/product/get_memory_stream':
                    rows = [row for row in rows if not body.get('filter', {}).get('id') or row['id'] == body['filter']['id']]
                    frames = [{'type': 'header', 'version': 1, 'cube_id': body['mem_cube_id'], 'user_id': body['user_id']}]
                    frames += [{'type': 'memory', 'memory': row} for row in rows]
                    frames += [{'type': 'end', 'count': len(rows)}]
                    self.reply(b''.join(json.dumps(frame).encode()+b'\n' for frame in frames), 'application/x-ndjson')
                elif self.path == '/product/recall_index':
                    self.reply({'code': 200, 'data': {'version': 1, 'complete': True,
                        'physical_count': 2, 'logical_count': 2, 'matched_count': 2, 'memories': rows}})
                else:
                    self.reply({'code': 200, 'data': [{'cube_id': 'main', 'memory_id': 'new'}]})
        self.socket_path = str(self.root / 'memory.sock')
        self.server = socketserver.UnixStreamServer(self.socket_path, Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.cleanup_server)
        self.config = {'socket_path': '/run/brai-profile/memory.sock', 'user_id': 'owner', 'cube_id': 'main',
                       'memory_epoch': 'epoch', 'frozen': False, 'enabled': True, 'routing_enabled': True}

    def cleanup_server(self):
        self.server.shutdown(); self.thread.join(); self.server.server_close()

    def cli(self, *args, config=None, worker=True):
        # AIDEV-NOTE: Проверка root-owned файла тестируется отдельно; здесь заменён только
        # уже проверенный конфиг/путь сокета, а настоящий SDK работает в новом процессе.
        bootstrap = f'''import importlib.util, json, os, sys
spec=importlib.util.spec_from_file_location('helper',{str(MEMORY)!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
spec=importlib.util.spec_from_file_location('sdk',{str(SDK)!r})
sdk=importlib.util.module_from_spec(spec);spec.loader.exec_module(sdk)
m.worker_config=lambda:json.loads(os.environ['FIXTURE_CONFIG'])
m.worker_client=lambda config:sdk.Client(dict(config,socket_path={self.socket_path!r}))
sys.exit(m.main())
'''
        env = dict(os.environ, BRAI_IDENTITY_MODE='worker' if worker else 'legacy',
            HERMES_HOME=str(self.root), BRAI_IDENTITY_USER_ID='owner', BRAI_IDENTITY_TELEGRAM_ID='42',
            FIXTURE_CONFIG=json.dumps(config or self.config), HTTP_PROXY='http://127.0.0.1:1',
            HTTPS_PROXY='http://127.0.0.1:1', PYTHONDONTWRITEBYTECODE='1')
        return subprocess.run([sys.executable, '-B', '-c', bootstrap, *args], env=env,
            capture_output=True, text=True, timeout=10)

    def success(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_standalone_health_index_and_stream_reads_use_only_scoped_unix_sdk(self):
        self.success('health')
        result = self.success('search', '--query', 'synthetic', '--top-k', '1')
        self.assertEqual(result['data']['returned_count'], 1)
        self.assertTrue(result['data']['truncated'])
        body = next(body for _, path, body in self.requests if path == '/product/recall_index')
        expected_scope = hashlib.sha256(json.dumps(str(self.root), separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(body['scope'], {'hermes_home_scope': expected_scope, 'hermes_memory_epoch': 'epoch'})
        self.assertEqual(body['author_id'], '42'); self.assertEqual(body['user_id'], 'owner')
        result = self.success('list', '--page', '2', '--page-size', '1')
        self.assertEqual(result['total'], 2)
        self.assertEqual(result['data']['text_mem'][0]['memories'][0]['id'], 'two')
        result = self.success('get', '--id', 'one')
        self.assertEqual(result['data']['text_mem'][0]['memories'][0]['id'], 'one')
        self.assertNotIn('/product/search', [path for _, path, _ in self.requests])

    def test_add_delete_keep_owner_scope_and_never_accept_unsafe_write_defaults(self):
        self.success('add', '--text', 'synthetic fact', '--session', 'session')
        body = self.requests[-1][2]
        self.assertEqual(body['user_id'], 'owner'); self.assertEqual(body['writable_cube_ids'], ['main'])
        self.assertNotIn('custom_tags', body)
        before = len(self.requests)
        self.assertNotEqual(self.cli('delete', '--id', 'one').returncode, 0)
        self.assertEqual(len(self.requests), before)
        self.success('delete', '--id', 'one', '--confirm-delete')
        self.assertEqual(self.requests[-1][2]['memory_ids'], ['one'])
        self.assertFalse(self.requests[-1][2]['auto_cleanup_working'])
        self.assertNotEqual(self.cli('add', '--text', 'secret', '--session', 's', config=self.config | {'frozen': True}).returncode, 0)

    def test_status_uses_the_real_scoped_unix_sdk(self):
        result=self.success('status','--task-id','task-own')
        self.assertEqual(result['data'],[{'task_id':'task-own','status':'completed'}])
        self.assertEqual(self.requests,[('GET','/product/scheduler/status?user_id=owner&task_id=task-own',None)])
        self.assertNotEqual(self.cli('--user','foreign','status').returncode,0)
        self.assertEqual(len(self.requests),1)

    def test_explicit_owner_endpoint_and_unsupported_operations_fail_before_io(self):
        for args in [('--user', 'root', 'health'), ('--base-url', 'http://localhost', 'health'),
                     ('feedback', '--text', 'secret', '--id', 'one', '--session', 's')]:
            with self.subTest(args=args):
                before = len(self.requests)
                result = self.cli(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.requests), before)
                self.assertNotIn('secret', result.stderr)
        self.assertIn('UNSUPPORTED', self.cli('feedback','--text','secret','--id','one','--session','s').stderr)

    def test_foreign_rows_and_redirects_fail_without_content_or_network_fallback(self):
        self.foreign = True
        for args in [('search', '--query', 'x'), ('get', '--id', 'one')]:
            result = self.cli(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('synthetic personal', result.stderr)
        self.foreign, self.redirect = False, True
        result = self.cli('health')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('private-secret', result.stderr)
        self.assertEqual(self.requests[-1][1], '/health')


class MemoryLegacyTests(unittest.TestCase):
    def test_standalone_legacy_keeps_old_endpoint_owner_cube_and_search_payload(self):
        bootstrap = f"""import importlib.util, io, json, sys
spec=importlib.util.spec_from_file_location('helper',{str(MEMORY)!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.urllib.request.urlopen=lambda req,timeout:io.StringIO(json.dumps({{'code':200,'url':req.full_url,'payload':json.loads(req.data)}}))
sys.exit(m.main())
"""
        env = dict(os.environ, BRAI_IDENTITY_MODE='legacy', PYTHONDONTWRITEBYTECODE='1')
        result = subprocess.run([sys.executable, '-B', '-c', bootstrap, 'search', '--query', 'synthetic'],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['url'], 'http://127.0.0.1:8001/product/search')
        self.assertEqual(value['payload']['user_id'], 'root')
        self.assertEqual(value['payload']['readable_cube_ids'], ['main'])
        self.assertEqual(value['payload']['mode'], 'fast')


if __name__ == '__main__':
    unittest.main()
