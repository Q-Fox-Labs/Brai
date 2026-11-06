# ABOUTME: Проверяет ограниченный spool большого архива и полный upstream trailer.
# ABOUTME: Использует только синтетический HTTP и временный Unix-сокет.
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
PADDING = 'x' * (1024 * 1024)


class Upstream(BaseHTTPRequestHandler):
    count = 1
    outcome = 'ok'
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
            metadata = {'user_id':'other' if self.outcome == 'foreign' else 'user-a',
                        'info':{'hermes_home_scope':'home-a', 'hermes_memory_epoch':'epoch-a',
                                'hermes_author_id':'author-a', 'hermes_cube':'profile-a__main',
                                'hermes_memberships':['profile-a__main'], 'padding':PADDING}}
            emit({'type':'memory', 'memory':{'id':str(index), 'memory':'synthetic', 'metadata':metadata}})
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
        Upstream.allow = [True]
        self.boundary = Boundary('unused', 'http://127.0.0.1:' + str(self.upstream.server_port),
            authorize=lambda user, profile: Upstream.allow[0], cursor_key=b'x'*32,
            registry_loader=lambda path: {os.getuid():PROFILE})

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
