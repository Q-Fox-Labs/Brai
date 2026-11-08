# ABOUTME: Проверяет безопасный ответ worker при запросе входа.
# ABOUTME: Порт не передаёт аргументы получателя и не возвращает секреты.
import unittest

from services.hermes.identity.login import send_login
from services.hermes.identity.ipc import RpcError


class LoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_call_has_no_recipient_and_returns_status(self):
        class Peer:
            async def call(self, method, params):
                self.call_args = (method, params)
                return {'status': 'sent'}
        peer = Peer()
        self.assertEqual(await send_login(peer), {'status': 'sent'})
        self.assertEqual(peer.call_args, ('send_login', {}))

    async def test_unexpected_secret_and_rpc_error_are_hidden(self):
        class Peer:
            async def call(self, method, params):
                return {'status': 'sent', 'code': '123456'}
        self.assertEqual(await send_login(Peer()), {'status': 'unknown'})

        class FailedPeer:
            async def call(self, method, params):
                raise RpcError(-32603, 'failed')
        self.assertEqual(await send_login(FailedPeer()), {'status': 'unknown'})
