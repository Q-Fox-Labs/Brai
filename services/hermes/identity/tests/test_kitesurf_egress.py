# ABOUTME: Проверяет отдельный публичный egress экспериментального браузера.
# ABOUTME: Сокет и обработчик настоящие, внешняя сеть и Auth заменены двойниками.
import asyncio
import os
import socket
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from identity import egress, kitesurf_egress


class KitesurfEgressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'browser.sock')
        self.browser_uid = os.getuid()
        if self.browser_uid == 0:
            self.skipTest('Run with an unprivileged UID')
        self.owner_uid = self.browser_uid + 100000
        self.profile = {'status': 'active', 'userId': 'user', 'profileId': 'profile'}
        self.registry = {'version': 1, 'profiles': {str(self.owner_uid): self.profile}}
        self.allowed = True
        self.auth_uids = []
        self.dials = []
        self.remote = await asyncio.start_server(self.upstream, '127.0.0.1', 0)
        self.server = await kitesurf_egress.start_server(
            self.path, lambda: self.registry, lambda: {'deniedAddresses': []}, self.authorize,
            browser_uid=self.browser_uid, owner_uid=self.owner_uid, user_id='user',
            profile_id='profile', dial=self.dial)

    async def asyncTearDown(self):
        if hasattr(self, 'server'):
            self.server.close()
            await self.server.wait_closed()
            tasks = list(self.server.active_connections)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        if hasattr(self, 'remote'):
            self.remote.close()
            await self.remote.wait_closed()
        self.tmp.cleanup()

    async def authorize(self, uid):
        self.auth_uids.append(uid)
        return self.allowed

    async def dial(self, host, port, tls, denied):
        self.dials.append((host, port))
        return await asyncio.open_connection('127.0.0.1', self.remote.sockets[0].getsockname()[1])

    async def upstream(self, reader, writer):
        try:
            await reader.readuntil(b'\r\n\r\n')
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
            await writer.drain()
        except asyncio.IncompleteReadError:
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    async def request(self, target):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(('GET ' + target + ' HTTP/1.1\r\nHost: x\r\n\r\n').encode())
        await writer.drain()
        try:
            result = await reader.read()
        except ConnectionResetError:
            result = b''
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionResetError:
            pass
        return result

    async def test_public_web_uses_owner_authorization(self):
        self.assertIn(b'200 OK', await self.request('http://public.example/'))
        self.assertEqual(self.dials, [('public.example', 80)])
        self.assertTrue(self.auth_uids)
        self.assertEqual(set(self.auth_uids), {self.owner_uid})

    async def test_trusted_routes_are_not_exposed(self):
        for path in ('/model/v1/models', '/search/v1/query', '/image/images/generations'):
            self.assertNotIn(b'200 OK', await self.request(path))
        self.assertEqual(self.dials, [])

    async def test_inactive_changed_or_colliding_identity_is_denied(self):
        for field, value in (('status', 'disabled'), ('userId', 'other'), ('profileId', 'other')):
            original = self.profile[field]
            self.profile[field] = value
            self.assertNotIn(b'200 OK', await self.request('http://public.example/'))
            self.profile[field] = original
        self.registry['profiles'][str(self.browser_uid)] = dict(self.profile)
        self.assertNotIn(b'200 OK', await self.request('http://public.example/'))
        self.assertEqual(self.dials, [])

    async def test_revoked_authorization_is_denied(self):
        self.allowed = False
        self.assertIn(b'403', await self.request('http://public.example/'))
        self.assertEqual(self.dials, [])

    async def test_revocation_closes_an_open_tunnel(self):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(b'CONNECT public.example:443 HTTP/1.1\r\n\r\n')
        await writer.drain()
        self.assertIn(b'200', await reader.readuntil(b'\r\n\r\n'))
        self.allowed = False
        self.assertEqual(b'', await asyncio.wait_for(reader.read(), 2))
        writer.close()
        await writer.wait_closed()

    async def test_dns_alias_to_loopback_is_blocked(self):
        self.server.close()
        await self.server.wait_closed()
        os.unlink(self.path)
        self.server = await kitesurf_egress.start_server(
            self.path, lambda: self.registry, lambda: {'deniedAddresses': []}, self.authorize,
            browser_uid=self.browser_uid, owner_uid=self.owner_uid, user_id='user',
            profile_id='profile')
        loop = asyncio.get_running_loop()
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]
        with patch.object(loop, 'getaddrinfo', new=AsyncMock(return_value=answers)), \
                patch.object(asyncio, 'open_connection', new=AsyncMock()) as connect:
            self.assertNotIn(b'200 OK', await self.request('http://synthetic.example/'))
            connect.assert_not_awaited()

    async def test_owner_reassigned_during_auth_is_denied(self):
        async def reassigned(uid):
            self.profile['profileId'] = 'other'
            return True
        self.server.close()
        await self.server.wait_closed()
        os.unlink(self.path)
        self.server = await kitesurf_egress.start_server(
            self.path, lambda: self.registry, lambda: {'deniedAddresses': []}, reassigned,
            browser_uid=self.browser_uid, owner_uid=self.owner_uid, user_id='user',
            profile_id='profile', dial=self.dial)
        self.assertIn(b'403', await self.request('http://public.example/'))
        self.assertEqual(self.dials, [])

    async def test_invalid_identity_cannot_start(self):
        with self.assertRaises(ValueError):
            await kitesurf_egress.start_server(
                self.path, lambda: self.registry, lambda: {}, AsyncMock(),
                browser_uid=self.browser_uid, owner_uid=self.browser_uid,
                user_id='user', profile_id='profile')


if __name__ == '__main__':
    unittest.main()
