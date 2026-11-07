# ABOUTME: Проверяет двусторонние вызовы и маршруты IPC пользовательского Hermes.
# ABOUTME: Тесты не обращаются к настоящему Telegram и пользовательской памяти.
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.ipc import Peer, RpcError
from identity.ingress import Bridge
from identity.worker import Worker


class IpcTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / 'rpc.sock')
        self.peers = []
        async def accept(reader, writer):
            peer = Peer(reader, writer, {'echo': echo, 'nested': nested})
            self.peers.append(peer)
            await peer.run()
        async def echo(value):
            return value
        async def nested():
            return await self.peers[0].call('echo', {'value': 'nested'})
        self.server = await asyncio.start_unix_server(accept, self.path)
        reader, writer = await asyncio.open_unix_connection(self.path)
        self.client = Peer(reader, writer, {'echo': echo})
        self.client_task = asyncio.create_task(self.client.run())

    async def asyncTearDown(self):
        self.client.writer.close()
        await self.client_task
        self.server.close()
        await self.server.wait_closed()
        self.tmp.cleanup()

    async def test_nested_bidirectional_call(self):
        self.assertEqual(await self.client.call('nested', {}), 'nested')

    async def test_unknown_method_is_error(self):
        with self.assertRaises(RpcError) as error:
            await self.client.call('missing', {})
        self.assertEqual(error.exception.code, -32601)

    async def test_batch_and_notification(self):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write((json.dumps([{'jsonrpc':'2.0','method':'echo','params':{'value':1}}, {'jsonrpc':'2.0','id':'a','method':'echo','params':{'value':2}}])+'\n').encode())
        await writer.drain()
        reply = json.loads(await reader.readline())
        self.assertEqual(reply, [{'jsonrpc':'2.0','id':'a','result':2}])
        writer.close()
        await writer.wait_closed()

    async def test_invalid_json(self):
        reader, writer = await asyncio.open_unix_connection(self.path)
        writer.write(b'{bad\n')
        await writer.drain()
        self.assertEqual(json.loads(await reader.readline())['error']['code'], -32700)
        writer.close()
        await writer.wait_closed()


class BoundaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_send_rejects_foreign_destination_and_edit(self):
        delivered = []
        async def deliver(owner, action, payload):
            delivered.append(action)
            return {'success': True, 'message_id': 'sent'}
        bridge = Bridge('owner', '123', 999, '/unused', deliver, None)
        bridge.routes.add(('chat', 'thread'))
        with self.assertRaises(RpcError):
            await bridge.send('send', {'chat_id':'other', 'metadata':{'thread_id':'thread'}})
        with self.assertRaises(RpcError):
            await bridge.send('edit_message', {'chat_id':'chat', 'message_id':'foreign', 'metadata':{'thread_id':'thread'}})
        self.assertEqual(delivered, [])
        await bridge.send('send', {'chat_id':'chat', 'metadata':{'thread_id':'thread'}})
        await bridge.send('edit_message', {'chat_id':'chat', 'message_id':'sent', 'metadata':{'thread_id':'thread'}})
        self.assertEqual(delivered, ['send', 'edit_message'])

    async def test_file_requires_artifact(self):
        bridge = Bridge('owner', '123', 999, '/unused', None, None)
        bridge.routes.add(('chat', ''))
        with self.assertRaises(RpcError):
            await bridge.send('send_document', {'chat_id':'chat', 'file_path':'/etc/passwd'})

    async def test_reject_same_uid(self):
        import os
        with self.assertRaises(ValueError):
            Worker(os.getuid(), 'owner', '123', None)

class WorkerLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_steer_cancel_and_receipt(self):
        import os
        import types
        from unittest.mock import patch
        from enum import Enum

        class Platform(Enum):
            TELEGRAM = 'telegram'
        class MessageType(Enum):
            TEXT = 'text'
            COMMAND = 'command'
        class Source:
            def __init__(self, user_id):
                self.user_id, self.platform, self.is_bot = user_id, Platform.TELEGRAM, False
                self.chat_id, self.chat_name, self.chat_type = 'x', None, 'dm'
            @classmethod
            def from_dict(cls, value):
                return cls(value['user_id'])
            def to_dict(self):
                return {'user_id':self.user_id, 'platform':'telegram', 'chat_id':'x'}
        class Event:
            def __init__(self, source, message_type, **kw):
                self.source, self.message_type = source, message_type
                self.__dict__.update(kw)
                self._gateway_accepted = False
        class Base:
            def __init__(self, config, platform):
                self._session_tasks = {}
            async def handle_message(self, event):
                event._gateway_accepted = True
                if event.text == '/stop':
                    self._session_tasks['key'].cancel()
                elif 'key' not in self._session_tasks:
                    self._session_tasks['key'] = asyncio.create_task(asyncio.Event().wait())
            def _event_session_key(self, event):
                return 'key'
        class Runner:
            def __init__(self):
                self.config = SimpleNamespace(multiplex_profiles=False)
                self.adapters = {}
                self.delivery_router = SimpleNamespace(adapters={})
            def _wire_adapter_handlers(self, adapter, **kwargs):
                self.wired = True
            def _publish_primary_adapter(self, platform, adapter):
                self.adapters[platform] = adapter
        async def publish(path):
            return {'artifact_id': 'a'}
        class Rpc:
            async def call(self, method, params):
                return {'success':True, 'message_id':'42'}
        modules = {
            'gateway': types.ModuleType('gateway'),
            'gateway.run': types.ModuleType('gateway.run'),
            'gateway.config': types.ModuleType('gateway.config'),
            'gateway.platforms': types.ModuleType('gateway.platforms'),
            'gateway.platforms.base': types.ModuleType('gateway.platforms.base'),
            'gateway.platforms.event': types.ModuleType('gateway.platforms.event'),
            'gateway.session': types.ModuleType('gateway.session'),
        }
        from unittest.mock import AsyncMock, Mock
        discovery = AsyncMock()
        modules['gateway.run']._discover_gateway_mcp_tools = discovery
        modules['tools.registry'] = types.ModuleType('tools.registry')
        entry = Mock(return_value=object())
        modules['tools.registry'].registry = SimpleNamespace(get_entry=entry)
        modules['gateway.run'].GatewayRunner = Runner
        modules['gateway.config'].Platform = Platform
        modules['gateway.config'].PlatformConfig = type('Config', (), {})
        modules['gateway.platforms.base'].BasePlatformAdapter = Base
        modules['gateway.platforms.base'].SendResult = lambda **kwargs: SimpleNamespace(**kwargs)
        modules['gateway.platforms.event'].MessageEvent = Event
        modules['gateway.platforms.event'].MessageType = MessageType
        modules['gateway.session'].SessionSource = Source
        with patch.dict(sys.modules, modules):
            worker = Worker(os.getuid() + 1, 'owner', '123', publish)
            entry.return_value = None
            await worker.start(Rpc())
            self.assertTrue((await worker.health())['ready'])
            discovery.assert_not_awaited()
            with self.assertRaisesRegex(RpcError, 'login tool unavailable'):
                await worker.health(require_tools=True)
            source = {'user_id':'123', 'platform':'telegram', 'chat_id':'x'}
            with self.assertRaisesRegex(RpcError, 'login tool unavailable'):
                await worker.dispatch({'source':source, 'text':'hello', 'message_id':'0'}, 'owner')
            self.assertEqual(worker.adapter._session_tasks, {})
            entry.return_value = object()
            self.assertTrue((await worker.health(require_tools=True))['ready'])
            self.assertEqual(discovery.await_count, 3)
            entry.assert_called_with('mcp__brai__brai_login')
            started = await worker.dispatch({'source':source, 'text':'hello', 'message_id':'1'}, 'owner')
            self.assertTrue(started['accepted'])
            self.assertTrue((await worker.dispatch({'source':source, 'text':'steer', 'message_id':'2'}, 'owner'))['accepted'])
            self.assertEqual((await worker.cancel('2', 'owner'))['state'], 'not_running')
            self.assertEqual((await worker.cancel(started['turn_id'], 'owner'))['state'], 'stopped')
            receipt = await worker.adapter.send('x', 'text')
            self.assertTrue(receipt.success)
            self.assertEqual(discovery.await_count, 3)
            with self.assertRaises(RpcError):
                await worker.dispatch({'source':dict(source, user_id='999'), 'text':'bad', 'message_id':'3'}, 'owner')

class IngressInstallTest(unittest.IsolatedAsyncioTestCase):
    async def test_native_admission_precedes_bridge_and_internal_denied(self):
        from identity.ingress import install
        calls = []
        source = SimpleNamespace(platform=SimpleNamespace(value='telegram'), user_id='123', is_bot=False)
        event = SimpleNamespace(source=source, internal=False, _gateway_accepted=False)
        class Runner:
            def _is_user_authorized_for_source(self, source, **kwargs):
                return False
            async def _hm_admit_event(self, incoming):
                calls.append('admit')
                assert self._is_user_authorized_for_source(incoming.source)
                return incoming, incoming.source, False
        class StubBridge(Bridge):
            async def dispatch(self, incoming):
                calls.append('dispatch')
                return {'accepted':True}
        bridge = StubBridge('owner', '123', 44, '/none', None, None)
        async def resolve(actual):
            calls.append('resolve')
            return bridge
        adapter = SimpleNamespace(handle_message=None)
        install(Runner(), adapter, resolve)
        await adapter._brai_identity_dispatch(event)
        self.assertEqual(calls, ['resolve', 'admit', 'dispatch'])
        self.assertTrue(event._gateway_accepted)
        event.internal = True
        with self.assertRaises(PermissionError):
            await adapter._brai_identity_dispatch(event)

class EndTurnTest(unittest.IsolatedAsyncioTestCase):
    async def test_early_completion_waits_for_known_turn(self):
        done = []
        async def ended(turn_id):
            done.append(turn_id)
        bridge = Bridge('owner', '123', 999, '/unused', None, None, on_turn_end=ended)
        await bridge.turn_ended('owner', 'turn')
        self.assertEqual(done, [])
        bridge.known_turns.add('turn')
        await bridge._close_turn('turn')
        self.assertEqual(done, ['turn'])
        with self.assertRaises(RpcError):
            await bridge.turn_ended('other', 'turn')

class IdleTurnTest(unittest.IsolatedAsyncioTestCase):
    async def test_idle_closes_and_steer_keeps_active(self):
        ended = []
        async def on_end(turn_id):
            ended.append(turn_id)
        async def prepare(event):
            return {'text':'/status', 'message_id':'1'}
        bridge = Bridge('owner','123',99,'/unused',None,prepare,on_turn_end=on_end)
        class PeerStub:
            async def call(self, method, params):
                return {'accepted':True, 'turn_id':None}
        async def connect():
            return PeerStub()
        bridge.connect = connect
        class Source:
            platform = SimpleNamespace(value='telegram')
            user_id, is_bot, chat_id, thread_id = '123', False, 'chat', None
            def to_dict(self):
                return {'platform':'telegram', 'user_id':'123', 'chat_id':'chat'}
        event = SimpleNamespace(source=Source(), message_id='1')
        await bridge.dispatch(event)
        self.assertEqual(ended, [None])
        bridge.known_turns.add('running')
        await bridge.dispatch(event)
        self.assertEqual(ended, [None])
