# ABOUTME: Проверяет ограниченный spool большого архива и полный upstream trailer.
# ABOUTME: Использует только синтетический HTTP и временный Unix-сокет.
import base64
import hashlib
import hmac
import json
import os
import resource
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from services.hermes.identity.memory_gateway import Boundary, Server


PROFILE = {'userId':'user-a', 'profileId':'profile-a', 'homeScope':'home-a',
           'memoryEpoch':'epoch-a', 'authorId':'author-a', 'cubes':['main'], 'status':'active'}
PADDING = 'x' * (1024 * 1024 + 1024)


class Upstream(BaseHTTPRequestHandler):
    count = 1
    outcome = 'ok'
    large_text = False
    allow = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        data = b'{"code":200,"data":{"memory_stream":1,"recall_index":1}}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        def emit(value):
            self.wfile.write(json.dumps(value, separators=(',', ':')).encode() + b'\n')
        emit({'type':'header', 'version':1, 'cube_id':body['mem_cube_id'], 'user_id':body['user_id']})
        for index in range(self.count):
            metadata = {'user_id':'other' if self.outcome == 'foreign' or
                        (self.outcome == 'foreign-tail' and index == self.count - 1) else 'user-a',
                        'info':{'hermes_home_scope':'home-a', 'hermes_memory_epoch':'epoch-a',
                                'hermes_author_id':'author-a', 'hermes_cube':'profile-a__main',
                                'hermes_memberships':['profile-a__main'], 'padding':'' if self.large_text else PADDING}}
            emit({'type':'memory', 'memory':{'id':f'{self.count - index - 1:03}' if self.large_text else str(index),
                                              'memory': ('\x01' * 2048 if self.large_text == 'escapes' else PADDING) if self.large_text else 'synthetic', 'metadata':metadata}})
        if self.outcome == 'revoke':
            self.allow[0] = False
        if self.outcome != 'truncated':
            emit({'type':'end', 'count':self.count})


class SpoolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        cls.thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.thread.join()
        cls.upstream.server_close()

    def setUp(self):
        Upstream.count = 1
        Upstream.outcome = 'ok'
        Upstream.large_text = False
        Upstream.allow = [True]
        self.boundary = Boundary('unused', 'http://127.0.0.1:' + str(self.upstream.server_port),
            authorize=lambda user, profile: Upstream.allow[0], cursor_key=b'x'*32,
            registry_loader=lambda path: {os.getuid():PROFILE}, admin_uid=os.getuid())

    def test_large_archive_stays_bounded_and_complete(self):
        Upstream.count = 300
        before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        spool = self.boundary.spool_read(PROFILE, 'POST', '/product/get_memory_stream', {'mem_cube_id':'main'})
        try:
            self.assertGreater(spool.size, 300 * 1024 * 1024)
            count = 0
            for raw in spool.file:
                frame = json.loads(raw)
                if frame.get('type') == 'memory':
                    self.assertEqual(frame['memory']['id'], str(count))
                    count += 1
                elif frame.get('type') == 'end':
                    self.assertEqual(frame['count'], 300)
            self.assertEqual(count, 300)
            delta = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before
            self.assertLess(delta, 120 * 1024, 'Gateway accumulated the archive in RAM')
        finally:
            spool.close()

    def test_admin_pages_over_128mib_display_with_bounded_memory(self):
        Upstream.count = 132
        Upstream.large_text = True
        before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        def cursor(previous):
            data = ['user-a', 'profile-a', hashlib.sha256(b'').hexdigest(), ['main', previous]]
            encoded = base64.urlsafe_b64encode(json.dumps(data, separators=(',', ':')).encode()).decode().rstrip('=')
            return encoded + '.' + hmac.new(b'x'*32, encoded.encode(), hashlib.sha256).hexdigest()
        for previous, expected, has_more in ((None, '000', True), ('065', '066', True), ('130', '131', False)):
            request = {'userId':'user-a', 'limit':1}
            if previous is not None:
                request['cursor'] = cursor(previous)
            page = self.boundary.admin(os.getuid(), '/admin/list', request)
            self.assertEqual([row['id'] for row in page['items']], [expected])
            self.assertEqual(len(page['items'][0]['text']), 2048)
            self.assertTrue(page['items'][0]['textTruncated'])
            self.assertEqual(page['items'][0]['totalMemoryBytes'], len(PADDING))
            self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 850000)
            self.assertEqual(bool(page['nextCursor']), has_more)
        cursor_value, ids = None, []
        while True:
            page = self.boundary.admin(os.getuid(), '/admin/list',
                                       {'userId':'user-a', 'limit':100, 'cursor':cursor_value})
            self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 850000)
            ids.extend(row['id'] for row in page['items'])
            cursor_value = page['nextCursor']
            if not cursor_value:
                break
        self.assertEqual(ids, [f'{index:03}' for index in range(132)])
        delta = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before
        self.assertLess(delta, 120 * 1024, 'Admin accumulated the display archive in RAM')

    def test_admin_wire_budget_never_skips_entries(self):
        Upstream.count = 100
        Upstream.large_text = 'escapes'
        path = str(Path(os.environ['BRAI_MEMORY_GATEWAY_TMP']) / ('admin-pages-' + str(os.getpid()) + '.sock'))
        server = Server(path, self.boundary, admin=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            cursor, ids, sizes = None, [], []
            while True:
                body = json.dumps({'userId':'user-a', 'limit':100, 'cursor':cursor}).encode()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(20)
                    client.connect(path)
                    client.sendall(b'POST /admin/list HTTP/1.0\r\nContent-Length: ' +
                                   str(len(body)).encode() + b'\r\n\r\n' + body)
                    response = bytearray()
                    while chunk := client.recv(65536):
                        response.extend(chunk)
                headers, payload = response.split(b'\r\n\r\n', 1)
                self.assertIn(b' 200 ', headers.split(b'\r\n', 1)[0])
                self.assertLess(len(payload), 850000)
                sizes.append(len(payload))
                page = json.loads(payload)
                ids.extend(row['id'] for row in page['items'])
                self.assertTrue(all(not row['textTruncated'] for row in page['items']))
                cursor = page['nextCursor']
                if not cursor:
                    break
            self.assertGreater(len(sizes), 1)
            self.assertEqual(ids, [f'{index:03}' for index in range(100)])
            Upstream.count, Upstream.large_text = 1, True
            body = json.dumps({'userId':'user-a', 'limit':1}).encode()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(20)
                client.connect(path)
                client.sendall(b'POST /admin/list HTTP/1.0\r\nContent-Length: ' +
                               str(len(body)).encode() + b'\r\n\r\n' + body)
                response = bytearray()
                while chunk := client.recv(65536):
                    response.extend(chunk)
            headers, payload = response.split(b'\r\n\r\n', 1)
            self.assertIn(b' 200 ', headers.split(b'\r\n', 1)[0])
            self.assertLess(len(payload), 850000)
            entry = json.loads(payload)['items'][0]
            self.assertTrue(entry['textTruncated'])
            self.assertEqual(entry['totalMemoryBytes'], len(PADDING))
            self.assertEqual(len(entry['text'].encode()), 2048)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_admin_rejects_invalid_tail_before_response(self):
        path = str(Path(os.environ['BRAI_MEMORY_GATEWAY_TMP']) / ('admin-' + str(os.getpid()) + '.sock'))
        server = Server(path, self.boundary, admin=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            Upstream.count = 3
            for outcome in ('ok', 'truncated', 'foreign-tail'):
                Upstream.outcome = outcome
                body = json.dumps({'userId':'user-a', 'limit':1}).encode()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(10)
                    client.connect(path)
                    client.sendall(b'POST /admin/list HTTP/1.0\r\nContent-Length: ' +
                                   str(len(body)).encode() + b'\r\n\r\n' + body)
                    response = bytearray()
                    while chunk := client.recv(65536):
                        response.extend(chunk)
                if outcome == 'ok':
                    self.assertIn(b' 200 ', response.split(b'\r\n', 1)[0])
                    self.assertIn(b'synthetic', response)
                else:
                    self.assertNotIn(b' 200 ', response.split(b'\r\n', 1)[0])
                    self.assertNotIn(b'synthetic', response)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_bad_trailer_foreign_owner_and_revoke_send_no_memory(self):
        path = str(Path(os.environ['BRAI_MEMORY_GATEWAY_TMP']) / ('spool-' + str(os.getpid()) + '.sock'))
        server = Server(path, self.boundary)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for outcome in ('truncated', 'foreign', 'revoke'):
                Upstream.outcome = outcome
                Upstream.allow[0] = True
                body = json.dumps({'mem_cube_id':'main'}).encode()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(10)
                    client.connect(path)
                    client.sendall(b'POST /product/get_memory_stream HTTP/1.0\r\nContent-Length: ' +
                                   str(len(body)).encode() + b'\r\n\r\n' + body)
                    response = bytearray()
                    while chunk := client.recv(65536):
                        response.extend(chunk)
                self.assertNotIn(b' 200 ', response.split(b'\r\n', 1)[0])
                self.assertNotIn(b'synthetic', response)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


    def test_revocation_during_delivery_closes_stream(self):
        Upstream.count = 6
        path = str(Path(os.environ['BRAI_MEMORY_GATEWAY_TMP']) / ('delivery-' + str(os.getpid()) + '.sock'))
        server = Server(path, self.boundary)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            body = json.dumps({'mem_cube_id':'main'}).encode()
            received = bytearray()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(10)
                client.connect(path)
                client.sendall(b'POST /product/get_memory_stream HTTP/1.0\r\nContent-Length: ' +
                               str(len(body)).encode() + b'\r\n\r\n' + body)
                while chunk := client.recv(32768):
                    received.extend(chunk)
                    if len(received) > 65536:
                        Upstream.allow[0] = False
                    time.sleep(0.02)
            self.assertIn(b' 200 ', received.split(b'\r\n', 1)[0])
            self.assertNotIn(b'"type":"end"', received)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

if __name__ == '__main__':
    unittest.main(verbosity=2)
