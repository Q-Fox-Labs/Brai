# ABOUTME: Проверяет конфигурацию личного worker и ограниченный MCP-клиент.
# ABOUTME: Учетные данные и настоящие сетевые службы не используются.
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import tool_client
from identity.worker import load_config


class WorkerConfigTest(unittest.TestCase):
    def test_exact_socket_and_environment(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'worker.json'
            path.write_text(json.dumps({'socketPath':root + '/control/worker.sock'}))
            path.chmod(0o600)
            env = {'HERMES_HOME':root, 'BRAI_IDENTITY_INGRESS_UID':str(os.getuid() + 1),
                   'BRAI_IDENTITY_USER_ID':'u', 'BRAI_IDENTITY_TELEGRAM_ID':'123',
                   'BRAI_IDENTITY_EGRESS':'/run/brai-profile/egress.sock'}
            self.assertEqual(load_config(str(path), env)[0], root + '/control/worker.sock')
            path.write_text(json.dumps({'socketPath':'/tmp/other'}))
            with self.assertRaises(ValueError):
                load_config(str(path), env)

    def test_symlink_config_denied(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'target'
            target.write_text('{}')
            link = Path(root) / 'link'
            link.symlink_to(target)
            with self.assertRaises(OSError):
                load_config(str(link), {})


class ToolClientTest(unittest.TestCase):
    def test_native_sdk_null_params_are_supported(self):
        with patch.object(tool_client, 'broker_call', return_value={'tools': []}):
            result = tool_client.handle('tools/list', None)
        self.assertTrue(any(item['name'] == 'brai_login' for item in result['tools']))
        self.assertEqual(tool_client.handle('ping', None), {})
        for bad in ([], 'bad', 1, False):
            with self.assertRaises(ValueError):
                tool_client.handle('tools/list', bad)

    def test_login_catalog_requires_explicit_request_in_private_telegram(self):
        with patch.object(tool_client, 'broker_call', return_value={'tools': []}):
            result = tool_client.handle('tools/list', {})
        login = next(item for item in result['tools'] if item['name'] == 'brai_login')
        self.assertIn('явной просьбе', login['description'])
        self.assertIn('личном чате Telegram', login['description'])
        self.assertFalse(login['inputSchema']['properties'])
        self.assertFalse(login['inputSchema']['additionalProperties'])

    def test_account_link_tool_requires_no_model_supplied_confirmation_or_owner(self):
        with patch.object(tool_client, 'broker_call', return_value={'tools': []}):
            catalog = tool_client.handle('tools/list', {})['tools']
        tool = next(item for item in catalog if item['name'] == 'brai_telegram_link_account')
        self.assertIn('полный доступ', tool['description'])
        self.assertFalse(tool['inputSchema']['properties'])
        for phase in ['offer', 'command']:
            with patch.object(tool_client, 'broker_call', return_value={
                    'status': 'sent', 'phase': phase, 'suppressFinal': True, 'code': 'private-secret'}) as call:
                result = tool_client.handle('tools/call', {'name': tool['name'], 'arguments': {}})
            call.assert_called_once_with('telegram.link', {})
            self.assertNotIn('private-secret', json.dumps(result))
        with self.assertRaises(ValueError):
            tool_client.handle('tools/call', {'name': tool['name'], 'arguments': {'confirmed': True}})

    def test_unlink_tool_never_accepts_model_confirmation_or_foreign_id(self):
        with patch.object(tool_client, 'broker_call', return_value={'tools': []}):
            tools = tool_client.handle('tools/list', {})['tools']
        tool = next(t for t in tools if t['name'] == 'brai_telegram_unlink_account')
        self.assertEqual(tool['inputSchema']['properties']['target']['enum'], ['current', 'other'])
        for args in [{'target': '123'}, {'target': 'current', 'confirmed': True}, {}]:
            with self.assertRaises(ValueError):
                tool_client.handle('tools/call', {'name': tool['name'], 'arguments': args})
        with patch.object(tool_client, 'broker_call', return_value={'status': 'sent', 'phase': 'offer', 'suppressFinal': True}) as call:
            result = tool_client.handle('tools/call', {'name': tool['name'], 'arguments': {'target': 'other'}})
        call.assert_called_once_with('telegram.unlink', {'target': 'other'})
        self.assertIn('подтверждении', result['content'][0]['text'])

    def test_login_never_exposes_broker_payload(self):
        with patch.object(tool_client, 'broker_call', return_value={'status':'sent', 'suppressFinal':True, 'code':'secret'}):
            result = tool_client.handle('tools/call', {'name':'brai_login', 'arguments':{}})
        self.assertNotIn('secret', json.dumps(result))
        self.assertIn('Код отправлен', result['content'][0]['text'])

    def test_login_requires_confirmed_suppression(self):
        with patch.object(tool_client, 'broker_call', return_value={'status':'sent'}):
            result = tool_client.handle('tools/call', {'name':'brai_login'})
        self.assertTrue(result['isError'])

    def test_tools_call_cannot_set_owner(self):
        with patch.object(tool_client, 'broker_call', return_value={'ok':True}) as call:
            tool_client.handle('tools/call', {'name':'test', 'arguments':{'value':1}, 'uid':0})
        call.assert_called_once_with('tools.call', {'name':'test', 'args':{'value':1}})

class NativeFactoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_register_factory_wires_and_unloads(self):
        from types import SimpleNamespace, ModuleType
        from identity import native_ingress
        class Context:
            def register_telegram_handler(self, callback):
                self.factory = callback
            def on_unload(self, callback):
                self.close = callback
        class App:
            def add_handler(self, handler, group):
                self.handler = handler
            def remove_handler(self, handler, group):
                self.handler = None
        class Handler:
            def __init__(self, kind, callback):
                self.callback = callback
        ctx, app = Context(), App()
        async def admit(event):
            return None
        async def original(event):
            return None
        async def admit_update(update, adapter):
            return True
        adapter = SimpleNamespace(gateway_runner=SimpleNamespace(_hm_admit_event=admit, _is_user_authorized_for_source=lambda source, **kw: False), handle_message=original)
        telegram, ext = ModuleType('telegram'), ModuleType('telegram.ext')
        telegram.Update = type('Update', (), {})
        ext.TypeHandler, ext.ApplicationHandlerStop = Handler, type('ApplicationHandlerStop', (Exception,), {})
        with patch.dict(sys.modules, {'telegram':telegram, 'telegram.ext':ext}):
            native_ingress.register(ctx, build_resolver=lambda adapter, runner: lambda source: None, admit_update=admit_update)
            ctx.factory(app, adapter)
            self.assertTrue(adapter._brai_identity_ingress_ready)
            self.assertTrue(callable(adapter._brai_identity_dispatch))
            self.assertIs(adapter.handle_message, original)
            ctx.close()
            self.assertFalse(adapter._brai_identity_ingress_ready)
            self.assertIsNone(adapter._brai_identity_dispatch)

    def test_factory_fails_closed_without_runner(self):
        from types import SimpleNamespace
        from identity import native_ingress
        class Context:
            def register_telegram_handler(self, callback):
                self.factory = callback
            def on_unload(self, callback):
                pass
        ctx = Context()
        native_ingress.register(ctx, build_resolver=lambda adapter, runner: lambda source: None, admit_update=lambda u, a: None)
        with self.assertRaises(RuntimeError):
            ctx.factory(None, SimpleNamespace())


class WorkerSocketTest(unittest.IsolatedAsyncioTestCase):
    async def test_socket_permissions_and_graceful_cleanup(self):
        import asyncio
        import stat
        from identity.worker import serve
        class Worker:
            async def serve_connection(self, reader, writer):
                writer.close()
                await writer.wait_closed()
        with tempfile.TemporaryDirectory() as root:
            path = root + '/worker.sock'
            stop = asyncio.Event()
            task = asyncio.create_task(serve(path, Worker(), stop))
            for _ in range(100):
                if Path(path).exists():
                    break
                await asyncio.sleep(.01)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o666)
            stop.set()
            await task
            self.assertFalse(Path(path).exists())

class GuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_guard_auth_and_failure_close(self):
        from types import SimpleNamespace, ModuleType
        from identity import native_ingress
        class Context:
            def register_telegram_handler(self, cb):
                self.factory = cb
            def on_unload(self, cb):
                self.close = cb
        class App:
            def add_handler(self, handler, group):
                self.guard = handler.callback
            def remove_handler(self, handler, group):
                pass
        class Handler:
            def __init__(self, kind, callback):
                self.callback = callback
        class Stop(Exception):
            pass
        async def admit(update, adapter):
            if getattr(update, 'fail', False):
                raise RuntimeError('failed')
            return True
        async def native_admit(event):
            return None
        ctx, app = Context(), App()
        adapter = SimpleNamespace(gateway_runner=SimpleNamespace(_hm_admit_event=native_admit, _is_user_authorized_for_source=lambda s, **k: False), handle_message=None)
        telegram, ext = ModuleType('telegram'), ModuleType('telegram.ext')
        telegram.Update, ext.TypeHandler, ext.ApplicationHandlerStop = object, Handler, Stop
        with patch.dict(sys.modules, {'telegram':telegram, 'telegram.ext':ext}):
            native_ingress.register(ctx, build_resolver=lambda a, r: lambda source: None, admit_update=admit)
            ctx.factory(app, adapter)
            message = SimpleNamespace(from_user=SimpleNamespace(id=1, is_bot=False), chat=SimpleNamespace(id=2), message_id=3)
            await app.guard(SimpleNamespace(effective_message=message), None)
            self.assertTrue(native_ingress.message_admitted(message))
            with self.assertRaises(Stop):
                await app.guard(SimpleNamespace(effective_message=message, fail=True), None)
            self.assertFalse(native_ingress.message_admitted(message))
            ctx.close()

class FileToolTest(unittest.TestCase):
    def test_publish_and_fetch_use_owner_bound_broker(self):
        receipt = {'artifactId':'id', 'markdown':'[file](https://example.test/file)'}
        with patch.object(tool_client, 'broker_call', return_value=receipt) as call:
            result = tool_client.handle('tools/call', {'name':'publish_file', 'arguments':{'path':'/user/x', 'requestId':'r'}})
            call.assert_called_once_with('files.publish', {'path':'/user/x', 'requestId':'r'})
        self.assertEqual(result['content'][0]['text'], receipt['markdown'])
        with patch.object(tool_client, 'broker_call', return_value=receipt) as call:
            tool_client.handle('tools/call', {'name':'fetch_file', 'arguments':{'artifactId':'id'}})
            call.assert_called_once_with('files.fetch', {'artifactId':'id'})

class HealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_health_requires_started_runner(self):
        from identity.worker import Worker
        from identity.ipc import RpcError
        worker = Worker(os.getuid() + 1, 'owner', '123', None)
        with self.assertRaises(RpcError):
            await worker.health()
        worker.runner = object()
        worker.adapter = object()
        self.assertEqual(await worker.health(), {'ready':True, 'operational':False, 'userId':'owner', 'telegramId':'123'})
