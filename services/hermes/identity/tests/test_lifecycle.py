# ABOUTME: Проверяет обработку постоянных Auth-заданий реальным subprocess.
# ABOUTME: Не запускает системные службы, не использует Telegram и пользовательские данные.
"""Lease, отмена и ошибки личного lifecycle."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.lifecycle import LifecycleRunner
from identity.broker import rpc_request


class Control:
    """Подставить Auth только на границе; команды исполняются настоящим Python."""

    def __init__(self, *, renew=True):
        self.calls = []
        self.accept_renewal = renew
        self.operation = {'id': 'op', 'requestId': 'request', 'kind': 'prepare',
                          'leaseToken': 'token', 'user': {'id': 'user'}}

    async def call(self, method, params, timeout=12):
        self.calls.append((method, params))
        if method == 'identity.lifecycle-claim':
            operation, self.operation = self.operation, None
            return {'operation': operation}
        return {'accepted': self.accept_renewal if method.endswith('renew') else True}


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    """Проверить исполняемый lifecycle и отсутствие привилегированного Unix API."""

    async def test_success_completes_only_after_renewal(self):
        control = Control()
        script = "import sys,json; assert json.load(sys.stdin)['user']['id']=='user'"
        runner = LifecycleRunner(control, [sys.executable, '-c', script])
        self.assertTrue(await runner.once())
        self.assertEqual([name for name, _ in control.calls],
                         ['identity.lifecycle-claim', 'identity.lifecycle-renew',
                          'identity.lifecycle-complete'])
        self.assertTrue(control.calls[-1][1]['success'])
        self.assertFalse(await runner.once())

    async def test_process_failure_is_reported_without_retry(self):
        control = Control()
        runner = LifecycleRunner(control, [sys.executable, '-c', 'raise SystemExit(2)'])
        await runner.once()
        self.assertEqual(control.calls[-1][1]['errorCode'], 'PROFILE_FAILED')
        self.assertFalse(control.calls[-1][1]['success'])
        self.assertFalse(await runner.once())

    async def test_lost_lease_terminates_subprocess_and_never_activates(self):
        control = Control(renew=False)
        runner = LifecycleRunner(control, [sys.executable, '-c', 'import time; time.sleep(120)'],
                                 renew_interval=0.02)
        await asyncio.wait_for(runner.once(), 3)
        self.assertFalse(any(params.get('success') for _, params in control.calls))

    async def test_shutdown_cancels_own_work_without_success(self):
        control = Control()
        runner = LifecycleRunner(control, [sys.executable, '-c', 'import time; time.sleep(120)'])
        task = asyncio.create_task(runner.once())
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
        self.assertFalse(any(params.get('success') for _, params in control.calls))

    async def test_worker_cannot_claim_or_complete_lifecycle(self):
        class Forbidden:
            async def call(self, *args):
                raise AssertionError('Must not dispatch privileged method')
        for method in ('identity.lifecycle-claim', 'identity.lifecycle-renew',
                       'identity.lifecycle-complete'):
            reply = await rpc_request(Forbidden(), 1001, {
                'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': {}})
            self.assertEqual(reply['error']['code'], -32601)


class BootstrapAndInviteTests(unittest.IsolatedAsyncioTestCase):
    """Старое приглашение не обходит очередь; restore открывает только startup config."""

    def fixture(self, statuses):
        from identity.broker import Broker
        profile = {'userId': 'u', 'profileId': 'p', 'telegramId': '123',
                   'status': 'active', 'home': '/unused'}
        class Port:
            def __init__(self):
                self.calls = []
                self.states = iter(statuses)
                self.state = 'provisioning'
            async def call(self, method, params, timeout=35):
                self.calls.append(method)
                if method == 'identity.invite-redeem':
                    return {'user': {'id': 'u', 'profileId': 'p', 'telegramId': '123',
                                     'status': 'provisioning'}}
                if method == 'identity.resolve':
                    self.state = next(self.states, self.state)
                    return {'user': {'id': 'u', 'profileId': 'p', 'telegramId': '123',
                                     'status': self.state}}
                raise PermissionError('Tools require active Auth')
        port = Port()
        broker = Broker({'ingressUid': 995, 'registryPath': '/unused',
                         'accessCommand': [sys.executable, '/unused/access.py']}, port)
        broker.profiles = lambda: {1001: profile}
        return broker, port

    async def test_prepared_restore_bootstrap_is_not_data_or_tools_access(self):
        from unittest.mock import AsyncMock
        broker, port = self.fixture(['provisioning'])
        prior = broker.profiles()[1001]
        broker.profiles = lambda: {1001: {**prior, 'status': 'provisioning'}}
        broker.files.configuration = AsyncMock(return_value={'ownerId': 'u'})
        self.assertEqual(await broker.call(1001, 'files.configuration', {}), {'ownerId': 'u'})
        with self.assertRaises(PermissionError):
            await broker.call(1001, 'tools.list', {})
        self.assertEqual(broker.files.configuration.await_count, 1)

    async def test_blocked_profile_has_no_bootstrap_exemption(self):
        from unittest.mock import AsyncMock
        broker, port = self.fixture(['blocked'])
        broker.files.configuration = AsyncMock()
        with self.assertRaises(PermissionError):
            await broker.call(1001, 'files.configuration', {})
        broker.files.configuration.assert_not_called()

    async def test_invitation_waits_for_queue_without_starting_another_installer(self):
        from unittest.mock import AsyncMock, patch
        broker, port = self.fixture(['provisioning', 'active', 'active'])
        with patch('asyncio.create_subprocess_exec', side_effect=AssertionError('Legacy bypass')), \
                patch('asyncio.sleep', new=AsyncMock()):
            result = await broker.call(995, 'identity.invite-redeem', {
                'telegramId': '123', 'code': 'synthetic'})
        self.assertEqual(result['userId'], 'u')
        self.assertNotIn('identity.profile-ready', port.calls)

    async def test_revocation_aborts_waiting_invitation(self):
        from unittest.mock import AsyncMock, patch
        broker, port = self.fixture(['provisioning', 'blocked'])
        with patch('asyncio.create_subprocess_exec', side_effect=AssertionError('Legacy bypass')), \
                patch('asyncio.sleep', new=AsyncMock()), self.assertRaises(PermissionError):
            await broker.call(995, 'identity.invite-redeem', {'telegramId': '123', 'code': 'synthetic'})


if __name__ == '__main__':
    unittest.main()
