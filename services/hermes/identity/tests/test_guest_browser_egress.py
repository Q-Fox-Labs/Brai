# ABOUTME: Проверяет публичный маршрут через настоящий egress и Unix-сокет.
# ABOUTME: Внешние DNS и подключения заменены тестовыми двойниками.
import asyncio
import os
import socket
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from identity import egress


class PublicEgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'browser.sock')
        self.allowed = True
        self.calls = []
        self.registry = {'version': 1, 'profiles': {str(os.getuid()): {
            'status': 'active', 'userId': 'u', 'profileId': 'p', 'role': 'guest'}}}
        self.config = {'deniedAddresses': ['8.8.4.4'],
                       'publicWebOrigins': ['https://site.example']}
        self.resolve = AsyncMock(side_effect=AssertionError('provider used'))
        self.search = patch.object(egress, '_shared_search', new_callable=AsyncMock)
        self.search_mock = self.search.start()
        self.remote = await asyncio.start_server(self.upstream, '127.0.0.1', 0)
        self.server = await egress.start_server(self.path, lambda: self.registry,
            lambda: self.config, self.authorize, self.dial, self.resolve, public_only=True)

    async def asyncTearDown(self):
        self.server.close()
        self.remote.close()
        await self.server.wait_closed()
        await self.remote.wait_closed()
        for task in list(self.server.active_connections):
            task.cancel()
        await asyncio.gather(*self.server.active_connections, return_exceptions=True)
        self.search.stop()
        self.tmp.cleanup()

    async def authorize(self, uid):
        return self.allowed

    async def dial(self, host, port, tls, denied):
        self.calls.append((host, port, tls, denied))
        if host in ('localhost', '127.0.0.1'):
            raise egress.Rejected(403)
        return await asyncio.open_connection('127.0.0.1', self.remote.sockets[0].getsockname()[1])

    async def upstream(self, reader, writer):
        try:
            data = await reader.read(65536)
            if data.startswith(b'GET '):
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
            else:
                writer.write(data)
            await writer.drain()
        finally:
            writer.close()

    async def request(self, payload):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(payload)
        await writer.drain()
        return reader, writer

    async def test_public_http_and_connect(self):
        reader, writer = await self.request(b'GET http://site.example/a HTTP/1.1\r\nHost: x\r\n\r\n')
        self.assertIn(b'200 OK', await reader.read())
        writer.close()
        reader, writer = await self.request(b'CONNECT site.example:443 HTTP/1.1\r\nHost: x\r\n\r\n')
        self.assertIn(b'200 Connection Established', await reader.readuntil(b'\r\n\r\n'))
        writer.write(b'tunnel-data')
        await writer.drain()
        self.assertEqual(await reader.readexactly(11), b'tunnel-data')
        writer.close()
        self.assertEqual(self.calls, [('site.example', 80, False, {'8.8.4.4'}),
                                      ('site.example', 443, False, {'8.8.4.4'})])

    async def test_typed_paths_never_invoke_trusted_routes(self):
        for path in ('/model/v1/models', '/image/images/generations', '/gif/x', '/search/v1/query'):
            for target in (path, 'http://localhost' + path, 'http://127.0.0.1' + path):
                reader, writer = await self.request(('POST ' + target + ' HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n').encode())
                self.assertNotIn(b'200 OK', await reader.read(), target)
                writer.close()
        self.resolve.assert_not_called()
        self.search_mock.assert_not_called()

    async def test_reject_bad_ports_and_upgrade(self):
        for request in (b'CONNECT site.example:80 HTTP/1.1\r\n\r\n',
                        b'GET http://site.example:0/ HTTP/1.1\r\n\r\n',
                        b'GET http://site.example:65536/ HTTP/1.1\r\n\r\n',
                        b'GET http://site.example/ HTTP/1.1\r\nUpgrade: websocket\r\n\r\n'):
            reader, writer = await self.request(request)
            self.assertNotIn(b'200', await reader.read())
            writer.close()
        self.assertEqual(self.calls, [])

    async def test_revoke_closes_tunnel(self):
        reader, writer = await self.request(b'CONNECT site.example:443 HTTP/1.1\r\n\r\n')
        await reader.readuntil(b'\r\n\r\n')
        self.allowed = False
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b'')
        writer.close()

    async def test_guest_search_on_trusted_lane(self):
        path = os.path.join(self.tmp.name, 'trusted.sock')
        self.search_mock.return_value = {'success': True}
        server = await egress.start_server(path, lambda: self.registry,
            lambda: self.config, self.authorize, self.dial, self.resolve)
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write(b'POST /search/v1/query HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}')
            await writer.drain()
            self.assertIn(b'200 OK', await reader.read())
            writer.close()
            self.search_mock.assert_awaited_once()
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write(b'GET http://site.example/ HTTP/1.1\r\n\r\n')
            await writer.drain()
            self.assertIn(b'403', await reader.read())
            writer.close()
        finally:
            server.close()
            await server.wait_closed()


class DialTests(unittest.IsolatedAsyncioTestCase):
    async def test_dns_is_checked_before_numeric_connection(self):
        loop = asyncio.get_running_loop()
        connect = AsyncMock(return_value=('reader', 'writer'))
        for addresses, allowed in [(['8.8.8.8'], True), (['127.0.0.1'], False),
                                   (['8.8.4.4'], False), (['8.8.8.8', '10.0.0.1'], False)]:
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443)) for ip in addresses]
            with self.subTest(addresses=addresses), patch.object(loop, 'getaddrinfo', new=AsyncMock(return_value=answers)), patch.object(asyncio, 'open_connection', connect):
                connect.reset_mock()
                if allowed:
                    await egress._dial('site.example', 443, False, {'8.8.4.4'})
                    self.assertEqual(connect.await_args.args[:2], ('8.8.8.8', 443))
                else:
                    with self.assertRaises(egress.Rejected):
                        await egress._dial('site.example', 443, False, {'8.8.4.4'})
                    connect.assert_not_called()
