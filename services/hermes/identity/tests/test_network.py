# ABOUTME: Проверяет границу доступа и передачу потоков через настоящий Unix-сокет.
# ABOUTME: Внешние сетевые соединения заменены локальным тестовым сервером.
import asyncio
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

from identity import egress, network


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "egress.sock")
        self.profile = {"status": "active", "userId": "u", "profileId": "p",
                        "telegramId": "123", "username": "user", "home": "/home/user",
                        "workerSocket": "/run/worker.sock", "homeScope": "scope",
                        "memoryEpoch": 1, "authorId": "author", "cubes": []}
        self.registry = {"version": 1, "profiles": {str(os.getuid()): self.profile}}
        self.allowed = True
        self.auth_requests = []
        self.auth_path = os.path.join(self.tmp.name, "auth.sock")
        self.auth_server = await asyncio.start_unix_server(self.auth_broker, self.auth_path)
        self.received = []
        self.release = asyncio.Event()
        self.remote = await asyncio.start_server(self.provider, "127.0.0.1", 0)
        self.remote_port = self.remote.sockets[0].getsockname()[1]

        async def dial(host, port, tls, denied):
            self.received.append((host, port, tls, denied))
            if not egress._public(host, denied):
                raise egress.Rejected(403)
            return await asyncio.open_connection("127.0.0.1", self.remote_port)

        def registry():
            return self.registry

        self.server = await egress.start_server(
            self.path, registry,
            lambda: {"provider": {"baseUrl": "https://8.8.8.8/v1", "apiKey": "secret"},
                     "deniedAddresses": ["8.8.4.4"]}, self.authorize, dial)
        self.relay = await network.start_relay(self.path, 0)
        self.port = self.relay.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.release.set()
        for server in (self.relay, self.server, self.remote, self.auth_server):
            server.close()
            await server.wait_closed()
        self.tmp.cleanup()

    async def authorize(self, uid):
        return await egress._authorize_socket(self.auth_path, uid)

    async def auth_broker(self, reader, writer):
        try:
            request = json.loads(await reader.readuntil(b"\n"))
            self.auth_requests.append(request)
            result = {"jsonrpc": "2.0", "id": request["id"], "result": {"allowed": self.allowed}}
            writer.write(json.dumps(result).encode() + b"\n")
            await writer.drain()
        finally:
            writer.close()

    async def provider(self, reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            size = 0
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    size = int(line.split(b":", 1)[1])
            body = await reader.readexactly(size)
            self.received.append((head, body))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: first\n\n")
            await writer.drain()
            await self.release.wait()
            writer.write(b"data: last\n\n")
            await writer.drain()
        except (OSError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def request(self, payload):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(payload)
        await writer.drain()
        return reader, writer

    async def test_credentials_registry_and_model_secret(self):
        self.release.set()
        body = b'{"model":"example"}'
        reader, writer = await self.request(
            b"POST /model/v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer dummy\r\nContent-Length: "
            + str(len(body)).encode() + b"\r\n\r\n" + body)
        self.assertIn(b"200 OK", await reader.read())
        head, sent = self.received[-1]
        self.assertIn(b"Authorization: Bearer secret", head)
        self.assertNotIn(b"dummy", head)
        self.assertIn(b'"store":false', sent)
        writer.close()
        for status in ("provisioning", "blocked", "disabled", "unknown"):
            self.registry = {"version": 1, "profiles": {
                str(os.getuid()): {**self.profile, "status": status}}}
            reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
            self.assertIn(b"403", await reader.read())
            writer.close()
        self.registry = {"version": 1, "profiles": {}}
        reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"403", await reader.read())
        writer.close()
        self.registry = {"version": 2, "profiles": {str(os.getuid()): self.profile}}
        reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"403", await reader.read())
        writer.close()

    async def test_auth_revocation_closes_live_stream(self):
        reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"data: first", await asyncio.wait_for(reader.readuntil(b"data: first\n\n"), 2))
        self.assertEqual(self.auth_requests[0]["method"], "authorize")
        self.assertEqual(self.auth_requests[0]["params"], {"uid": os.getuid()})
        self.allowed = False
        self.assertEqual(await asyncio.wait_for(reader.read(), 1.0), b"")
        self.assertGreaterEqual(len(self.auth_requests), 2)
        writer.close()

    async def test_auth_unavailable_fails_closed(self):
        self.auth_server.close()
        await self.auth_server.wait_closed()
        reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertIn(b"403", await asyncio.wait_for(reader.read(), 1))
        self.assertEqual(self.received, [])
        writer.close()

    async def test_codex_credentials_are_refreshed_per_request(self):
        self.release.set()
        counter = 0

        async def credentials(provider):
            nonlocal counter
            counter += 1
            return "token" + str(counter), "account-id"

        async def dial(host, port, tls, denied):
            self.assertEqual((host, port, tls), ("chatgpt.com", 443, True))
            return await asyncio.open_connection("127.0.0.1", self.remote_port)

        path = os.path.join(self.tmp.name, "codex.sock")
        server = await egress.start_server(path, lambda: self.registry,
            lambda: {"provider": {"type": "codex-cli"}}, self.authorize, dial)
        relay = await network.start_relay(path, 0)
        port = relay.sockets[0].getsockname()[1]
        try:
            with patch.object(egress, "_codex_credentials", credentials):
                for expected in (b"token1", b"token2"):
                    reader, writer = await asyncio.open_connection("127.0.0.1", port)
                    body = b'{"model":"fixture","input":"hello"}'
                    writer.write(b"POST /model/v1/responses HTTP/1.1\r\nHost: localhost\r\n"
                                 b"Authorization: Bearer untrusted\r\nContent-Length: "
                                 + str(len(body)).encode() + b"\r\n\r\n" + body)
                    await writer.drain()
                    self.assertIn(b"200 OK", await asyncio.wait_for(reader.read(), 2))
                    head, sent = self.received[-1]
                    self.assertIn(b"POST /backend-api/codex/responses HTTP/1.1", head)
                    self.assertIn(b"Authorization: Bearer " + expected, head)
                    self.assertIn(b"ChatGPT-Account-Id: account-id", head)
                    self.assertNotIn(b"untrusted", head)
                    self.assertIn(b'"store":false', sent)
                    writer.close()
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(b"POST /model/v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                self.assertIn(b"403", await asyncio.wait_for(reader.read(), 2))
                self.assertEqual(counter, 2)
                writer.close()
        finally:
            relay.close()
            server.close()
            await asyncio.gather(relay.wait_closed(), server.wait_closed())

    async def test_codex_parameters_reject_unsafe_identity_and_paths(self):
        import pwd
        uid = os.getuid()
        gid = pwd.getpwuid(uid).pw_gid
        provider = {"type": "codex-cli", "uid": uid, "gid": gid,
                    "runtime": "/runtime", "ownerHome": "/runtime/owner",
                    "python": "/runtime/installs/fixture/bin/python",
                    "core": "/engine", "profileHome": "/profile"}
        self.assertEqual(egress._codex_parameters(provider), (uid, gid))
        for override in ({"uid": 0}, {"uid": True}, {"gid": 0},
                         {"gid": gid + 1}, {"ownerHome": "/other/owner"},
                         {"python": "/runtime/installs/../other/python"},
                         {"core": "relative"}):
            with self.assertRaises(egress.Rejected):
                egress._codex_parameters({**provider, **override})

    async def test_codex_subprocess_identity_environment_and_timeout(self):
        import pwd
        uid = os.getuid()
        gid = pwd.getpwuid(uid).pw_gid
        provider = {"type": "codex-cli", "uid": uid, "gid": gid,
                    "runtime": "/runtime", "ownerHome": "/runtime/owner",
                    "python": "/runtime/installs/fixture/bin/python",
                    "core": "/engine", "profileHome": "/profile"}
        calls = []

        class FakeProcess:
            def __init__(self, payload):
                self.stdout = asyncio.StreamReader()
                if payload is not None:
                    self.stdout.feed_data(payload)
                    self.stdout.feed_eof()
                self.returncode = 0 if payload is not None else None
                self.killed = False

            async def wait(self):
                if self.returncode is None:
                    self.returncode = -9
                return self.returncode

            def kill(self):
                self.killed = True

        process = FakeProcess(b'{"access":"token","account":"account"}\n')

        async def spawn(*args, **kwargs):
            calls.append((args, kwargs))
            return process

        with patch.object(egress.asyncio, "create_subprocess_exec", spawn):
            self.assertEqual(await egress._codex_credentials(provider), ("token", "account"))
        args, kwargs = calls[0]
        self.assertEqual(args[:2], (provider["python"], "-B"))
        self.assertEqual((kwargs["user"], kwargs["group"], kwargs["extra_groups"]), (uid, gid, []))
        self.assertEqual(kwargs["env"]["HOME"], "/runtime/owner")
        self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
        self.assertNotIn("OPENROUTER_API_KEY", kwargs["env"])

        process = FakeProcess(None)
        with patch.object(egress.asyncio, "create_subprocess_exec", spawn), \
             patch.object(egress, "CREDENTIAL_TIMEOUT", 0.01):
            with self.assertRaises(egress.Rejected):
                await egress._codex_credentials(provider)
        self.assertTrue(process.killed)

    async def test_codex_resolver_failure_fails_closed(self):
        async def failure(provider):
            raise egress.Rejected(503)
        with patch.object(egress, "_codex_credentials", failure):
            with self.assertRaises(egress.Rejected):
                await egress._resolve_provider({"provider": {"type": "codex-cli"}})

    async def test_sse_stream_and_disconnect(self):
        reader, writer = await self.request(b"GET http://8.8.8.8/ HTTP/1.1\r\nHost: x\r\n\r\n")
        first = await asyncio.wait_for(reader.readuntil(b"data: first\n\n"), 2)
        self.assertIn(b"200 OK", first)
        self.release.set()
        self.assertIn(b"data: last", await asyncio.wait_for(reader.read(), 2))
        writer.close()

    async def test_denied_requests(self):
        requests = [
            b"CONNECT 8.8.8.8:80 HTTP/1.1\r\nHost: x\r\n\r\n",
            b"GET http://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n\r\n",
            b"GET http://8.8.4.4/ HTTP/1.1\r\nHost: x\r\n\r\n",
            b"GET /model/v1/responses/secret HTTP/1.1\r\nHost: x\r\n\r\n",
            b"DELETE /model/v1/responses HTTP/1.1\r\nHost: x\r\n\r\n",
            b"POST /model/v1/responses HTTP/1.1\r\nHost: x\r\nContent-Length: 14\r\n\r\n" + b'{"store":true}',
            b"GET http://8.8.8.8/ HTTP/1.1\r\nX: a\r\ninjected\r\n\r\n",
            b"POST http://8.8.8.8/ HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n",
            b"GET file:///etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n",
        ]
        for payload in requests:
            reader, writer = await self.request(payload)
            response = await asyncio.wait_for(reader.read(), 2)
            self.assertRegex(response, rb"HTTP/1.1 4[0-9][0-9]", payload)
            writer.close()

    async def test_connect_duplex_and_cancellation(self):
        disconnected = asyncio.Event()

        async def echo(reader, writer):
            try:
                while data := await reader.read(1024):
                    writer.write(data)
                    await writer.drain()
            finally:
                disconnected.set()
                writer.close()

        remote = await asyncio.start_server(echo, "127.0.0.1", 0)
        remote_port = remote.sockets[0].getsockname()[1]

        async def dial(host, port, tls, denied):
            return await asyncio.open_connection("127.0.0.1", remote_port)

        path = os.path.join(self.tmp.name, "tunnel.sock")
        server = await egress.start_server(path, lambda: {"version": 1, "profiles": {
            str(os.getuid()): {"status": "active", "userId": "u", "profileId": "p"}}},
            lambda: {}, self.authorize, dial)
        relay = await network.start_relay(path, 0)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", relay.sockets[0].getsockname()[1])
            writer.write(b"CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8\r\n\r\n")
            await writer.drain()
            self.assertIn(b"200", await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 2))
            writer.write(b"tunnel-data")
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.readexactly(11), 2), b"tunnel-data")
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(disconnected.wait(), 2)
        finally:
            relay.close()
            server.close()
            remote.close()
            await asyncio.gather(relay.wait_closed(), server.wait_closed(), remote.wait_closed())

    async def test_address_policy_and_dns_rebinding(self):
        for address in ("127.0.0.1", "10.0.0.1", "::1", "::ffff:8.8.8.8",
                        "169.254.1.1", "192.0.2.1", "224.0.0.1", "8.8.4.4"):
            self.assertFalse(egress._public(address, {"8.8.4.4"}), address)
        self.assertTrue(egress._public("8.8.8.8", set()))
        loop = asyncio.get_running_loop()
        original = loop.getaddrinfo
        async def mixed(*args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]
        loop.getaddrinfo = mixed
        try:
            with self.assertRaises(egress.Rejected):
                await egress._dial("example.test", 80, False, set())
        finally:
            loop.getaddrinfo = original


if __name__ == "__main__":
    unittest.main()
