# ABOUTME: Проверяет границу доступа и передачу потоков через настоящий Unix-сокет.
# ABOUTME: Внешние сетевые соединения заменены локальным тестовым сервером.
import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import socket
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

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

        self.config = {"provider": {"baseUrl": "https://8.8.8.8/v1", "apiKey": "secret"},
                       "deniedAddresses": ["8.8.4.4"]}
        self.server = await egress.start_server(
            self.path, registry, lambda: self.config, self.authorize, dial)
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

    async def test_gif_uses_separate_protected_key_through_real_uid_gate(self):
        self.config['gifProvider'] = {'credentialsFile': '/trusted/gif.json'}
        body = {'model': 'gpt-image-2.6-flare', 'prompt': 'Луна', 'size': 'auto',
                'quality': 'low', 'complexity': 'low', 'n': 1, 'output_format': 'gif',
                'frame_count': 9, 'frame_duration_ms': 200}
        self.release.set()
        public = egress._public
        with patch.object(egress, '_root_directory'), patch.object(egress, '_protected_json',
                return_value={'apiKey': 'gif-only-secret'}) as secret, patch.object(
                egress, '_resolve_provider', new_callable=AsyncMock) as chat_provider, patch.object(
                egress, '_public', side_effect=lambda address, denied: address == 'api.openai.com' or public(address, denied)):
            raw = json.dumps(body).encode()
            reader, writer = await self.request(
                b'POST /gif/v1/images/generations HTTP/1.1\r\nHost: localhost\r\n'
                b'Authorization: Bearer client-value\r\nContent-Length: '
                + str(len(raw)).encode() + b'\r\n\r\n' + raw)
            self.assertIn(b'200 OK', await reader.read())
            writer.close()
            secret.assert_called_once_with(Path('/trusted/gif.json'))
            chat_provider.assert_not_awaited()
            head, sent = self.received[-1]
            self.assertIn(b'Authorization: Bearer gif-only-secret', head)
            self.assertNotIn(b'client-value', head)
            self.assertEqual(json.loads(sent), body)
            self.assertEqual(self.config['provider']['apiKey'], 'secret')
            secret.reset_mock()
            body['model'] = 'unapproved-model'
            raw = json.dumps(body).encode()
            reader, writer = await self.request(
                b'POST /gif/v1/images/generations HTTP/1.1\r\nHost: localhost\r\nContent-Length: '
                + str(len(raw)).encode() + b'\r\n\r\n' + raw)
            self.assertIn(b'403', await reader.read())
            writer.close()
            secret.assert_not_called()

    async def test_native_images_keep_subscription_and_never_use_gif_key(self):
        body = {'model': 'gpt-image-2', 'prompt': 'Луна', 'size': '1024x1024',
                'quality': 'medium', 'n': 1, 'background': 'opaque'}
        resolver = AsyncMock(return_value=({'codexSubscription': True,
            'provider': {'apiKey': 'subscription-secret'}}, 'account'))
        target = await egress._image_target('POST', '/image/images/generations',
                                            self.config, json.dumps(body).encode(), resolver)
        self.assertEqual(target[:3], ('chatgpt.com', 443, '/backend-api/codex/images/generations'))
        self.assertEqual(target[4:], ('subscription-secret', 'account'))
        resolver.reset_mock()
        for patch_value in [{'model': 'unapproved'}, {'n': 2}, {'images': [{'image_url': 'http://localhost/secret'}]}]:
            invalid = {**body, **patch_value}
            with self.assertRaises(egress.Rejected):
                await egress._image_target('POST', '/image/images/generations',
                                           self.config, json.dumps(invalid).encode(), resolver)
        resolver.assert_not_awaited()
        editing = {**body, 'images': [{'image_url': 'data:image/png;base64,AAAA'}]}
        target = await egress._image_target('POST', '/image/images/edits',
                                            self.config, json.dumps(editing).encode(), resolver)
        self.assertTrue(target[2].endswith('/images/edits'))
        with self.assertRaises(egress.Rejected):
            await egress._image_target('POST', '/image/images/generations', self.config,
                json.dumps(body).encode(), AsyncMock(return_value=(self.config, None)))

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

    def codex_provider(self):
        import pwd
        home = Path(self.tmp.name) / "fresh-owner"
        home.mkdir(mode=0o700, exist_ok=True)
        (home / ".codex").mkdir(mode=0o700, exist_ok=True)
        return {"type": "codex-cli", "uid": os.getuid(), "gid": pwd.getpwuid(os.getuid()).pw_gid,
                "sourceSha": "a" * 40, "python": "/sealed/python/bin/python3.14", "sitePackages": "/sealed/site-packages",
                "codex": "/sealed/codex/bin/codex", "node": "/sealed/node", "ownerHome": str(home),
                "codexHome": str(home / ".codex"), "workerDir": "/sealed/cwd", "componentRoot": "/sealed/component",
                "helperPath": "/sealed/component/services/hermes/extensions/tools/codex_cli_owner.py", "helperSha256": "b" * 64,
                "closedConfig": {"path": "/sealed/closed.toml", "sha256": "c" * 64},
                "providerSourceReceipt": {"path": "/sealed/provider-receipt.json", "sha256": "d" * 64},
                "expectedProviderSourceProducerSha256": "e" * 64}

    async def test_codex_parameters_reject_unsafe_identity_and_paths(self):
        provider = self.codex_provider()
        with patch.object(egress, "_root_directory"), patch.object(egress, "_codex_source"), patch.object(egress, "_codex_mounts"):
            self.assertEqual(egress._codex_parameters(provider), (provider["uid"], provider["gid"]))
            for override in ({"uid": 0}, {"uid": True}, {"gid": 0}, {"gid": provider["gid"] + 1},
                             {"codexHome": "/other/.codex"}, {"python": "/sealed/../other/python"},
                             {"componentRoot": "relative"}, {"runtime": "/legacy/runtime"}, {"sourceSha": "bad"}):
                with self.subTest(override=override), self.assertRaises(egress.Rejected):
                    egress._codex_parameters({**provider, **override})
        with patch.object(egress, "_root_directory"), patch.object(egress, "_codex_source"), \
             patch.object(egress, "_codex_mounts", side_effect=egress.Rejected(503)):
            with self.assertRaises(egress.Rejected):
                egress._codex_parameters(provider)

    async def test_codex_source_refuses_old_receipt_and_path_or_producer_drift(self):
        provider = self.codex_provider()
        paths = {key: provider[key] for key in ("python", "sitePackages", "codex", "node", "ownerHome", "codexHome", "workerDir", "componentRoot")}
        source = {"version": 1, "kind": "brai_identity_provider_source", "state": "verified", "sourceSha": provider["sourceSha"],
                  "paths": paths, "closedConfig": provider["closedConfig"], "producerPath": "/sealed/producer.py", "producerSha256": "e" * 64}
        with patch.object(egress, "_root_file", return_value=json.dumps(source).encode()) as sealed, patch.object(egress, "_root_directory"):
            egress._codex_source(provider)
            self.assertEqual(sum(call.kwargs.get("executable", False) for call in sealed.call_args_list), 3)
        for change in ({"kind": "codex-only"}, {"producerSha256": "f" * 64}, {"paths": {**paths, "python": "/old995/python"}}):
            with patch.object(egress, "_root_file", return_value=json.dumps({**source, **change}).encode()), self.assertRaises(egress.Rejected):
                egress._codex_source(provider)

    async def test_codex_mounts_require_pinned_directories_and_readonly_config(self):
        provider = self.codex_provider()
        target = Path(provider["codexHome"]) / "config.toml"
        target.write_bytes(b"closed")
        target.chmod(0o444)
        provider["closedConfig"]["sha256"] = hashlib.sha256(b"closed").hexdigest()
        mount = lambda path, flags: "1 0 0:1 / " + str(path) + " " + flags + " - tmpfs tmpfs rw\n"
        rows = mount(provider["ownerHome"], "rw") + mount(provider["codexHome"], "rw") + mount(target, "ro")
        real_fstat = os.fstat
        def root_metadata(fd):
            value = list(real_fstat(fd)); value[4] = 0; return os.stat_result(value)
        with patch("builtins.open", return_value=io.StringIO(rows)), patch.object(egress.os, "fstat", side_effect=root_metadata):
            egress._codex_mounts(provider)
        for invalid in (rows.replace(str(provider["codexHome"]) + " rw", "/other rw"), rows.replace(str(target) + " ro", str(target) + " rw")):
            with patch("builtins.open", return_value=io.StringIO(invalid)), self.assertRaises(egress.Rejected):
                egress._codex_mounts(provider)

    async def test_codex_subprocess_identity_environment_and_timeout(self):
        provider = self.codex_provider()
        calls = []
        class FakeProcess:
            def __init__(self, payload):
                self.stdout = asyncio.StreamReader()
                if payload is not None:
                    self.stdout.feed_data(payload); self.stdout.feed_eof()
                self.returncode = 0 if payload is not None else None
                self.killed = False
            async def wait(self):
                if self.returncode is None: self.returncode = -9
                return self.returncode
            def kill(self): self.killed = True
        process = FakeProcess(b'{"access":"token","account":"account"}\n')
        async def spawn(*args, **kwargs):
            calls.append((args, kwargs)); return process
        with patch.object(egress, "_codex_parameters", return_value=(provider["uid"], provider["gid"])), \
             patch.object(egress.asyncio, "create_subprocess_exec", spawn):
            self.assertEqual(await egress._codex_credentials(provider), ("token", "account"))
        args, kwargs = calls[0]
        self.assertEqual(args[:4], (provider["python"], "-I", "-S", "-B"))
        self.assertEqual((kwargs["user"], kwargs["group"], kwargs["extra_groups"]), (provider["uid"], provider["gid"], []))
        self.assertEqual(kwargs["cwd"], provider["workerDir"])
        self.assertEqual(kwargs["env"], {"HOME": provider["ownerHome"], "CODEX_HOME": provider["codexHome"],
            "PATH": "/sealed:/usr/bin:/bin", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        process = FakeProcess(None)
        with patch.object(egress, "_codex_parameters", return_value=(provider["uid"], provider["gid"])), \
             patch.object(egress.asyncio, "create_subprocess_exec", spawn), patch.object(egress, "CREDENTIAL_TIMEOUT", 0.01):
            with self.assertRaises(egress.Rejected): await egress._codex_credentials(provider)
        self.assertTrue(process.killed)

    async def test_real_stdlib_resolver_rebinds_only_fresh_data_and_ignores_ambient_imports(self):
        provider = self.codex_provider()
        root = Path(self.tmp.name)
        helper = root / "component/tools/codex_cli_owner.py"
        helper.parent.mkdir(parents=True)
        original = Path(__file__).resolve().parents[2] / "extensions/tools/codex_cli_owner.py"
        helper.write_bytes(original.read_bytes())
        provider["helperPath"], provider["helperSha256"] = str(helper), hashlib.sha256(helper.read_bytes()).hexdigest()
        claims = {"exp": int(time.time()) + 3600, "https://api.openai.com/auth": {"chatgpt_account_id": "fixture-account"}}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        token = "fixture." + payload + ".fixture"
        auth = Path(provider["codexHome"]) / "auth.json"
        auth.write_text(json.dumps({"tokens": {"access_token": token, "account_id": "fixture-account"}})); auth.chmod(0o600)
        evil = root / "ambient"; evil.mkdir()
        (evil / "sitecustomize.py").write_text("raise RuntimeError('ambient startup executed')")
        (evil / "json.py").write_text("raise RuntimeError('ambient json executed')")
        parameters = {key: provider[key] for key in ("helperPath", "helperSha256", "ownerHome", "codexHome", "codex")}
        environment = {"HOME": provider["ownerHome"], "CODEX_HOME": provider["codexHome"],
                       "PATH": "/usr/bin:/bin", "PYTHONPATH": str(evil), "PYTHONUSERBASE": str(evil)}
        argv = [sys.executable, "-I", "-S", "-B", "-c", egress._CODEX_OWNER_PROGRAM, json.dumps(parameters)]
        result = subprocess.run(argv, cwd=evil, env=environment, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {"access": token, "account": "fixture-account"})
        helper.write_text("raise RuntimeError('tampered helper')")
        self.assertNotEqual(subprocess.run(argv, cwd=evil, env=environment, capture_output=True, timeout=5).returncode, 0)

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

    async def test_public_web_origin_is_exact_and_keeps_private_dns_denied(self):
        denied = {'8.8.4.4'}
        config = {'publicWebOrigins': ['https://dev.brai.one']}
        allowed = egress._browser_denied('dev.brai.one', 443, config, denied)
        self.assertTrue(egress._public('8.8.4.4', allowed))
        self.assertFalse(egress._public('127.0.0.1', allowed))
        for host, port in [('other.test', 443), ('dev.brai.one', 80),
                           ('dev.brai.one.evil.test', 443)]:
            self.assertEqual(egress._browser_denied(host, port, config, denied), denied)
        self.assertEqual(egress._browser_denied('dev.brai.one', 443, {}, denied), denied)
        for origin in ['http://dev.brai.one', 'https://8.8.4.4',
                       'https://dev.brai.one:22', 'https://u@dev.brai.one',
                       'https://dev.brai.one/path']:
            with self.assertRaises(egress.Rejected):
                egress._browser_denied('dev.brai.one', 443,
                                       {'publicWebOrigins': [origin]}, denied)

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
