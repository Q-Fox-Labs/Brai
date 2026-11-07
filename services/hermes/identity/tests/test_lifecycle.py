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


if __name__ == '__main__':
    unittest.main()
