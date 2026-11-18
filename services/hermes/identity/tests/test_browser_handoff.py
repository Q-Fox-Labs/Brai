# ABOUTME: Проверяет запрет повторов и условия смены владельца браузерной сессии.
# ABOUTME: Двойники браузеров не подтверждают перенос данных реальных сайтов.
import asyncio
import unittest
from unittest.mock import AsyncMock

from identity.browser_handoff import BrowserSession, UncertainBrowserState


class BrowserHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def test_switch_requires_proof_and_keeps_source(self):
        session = BrowserSession('kitesurf', 'session')
        verify = AsyncMock(return_value=False)
        self.assertFalse(await session.switch('chrome', verify))
        self.assertEqual(session.backend, 'kitesurf')
        verify.assert_awaited_once_with('kitesurf', 'chrome', 'session')
        verify.return_value = True
        self.assertTrue(await session.switch('chrome', verify))
        call = AsyncMock(return_value='ok')
        self.assertEqual(await session.execute(call), 'ok')
        call.assert_awaited_once_with('chrome', 'session')

    async def test_lost_response_prevents_repeat_and_handoff(self):
        session = BrowserSession('kitesurf', 'session')
        operation = AsyncMock(side_effect=ConnectionError('response lost'))
        with self.assertRaises(ConnectionError):
            await session.execute(operation)
        with self.assertRaises(UncertainBrowserState):
            await session.execute(operation)
        verify = AsyncMock(return_value=True)
        with self.assertRaises(UncertainBrowserState):
            await session.switch('chrome', verify)
        operation.assert_awaited_once()
        verify.assert_not_awaited()
        self.assertEqual(session.backend, 'kitesurf')

    async def test_cancellation_does_not_trigger_retry(self):
        session = BrowserSession('kitesurf', 'session')
        started = asyncio.Event()
        finish = asyncio.Event()

        async def operation(backend, session_id):
            started.set()
            await finish.wait()

        task = asyncio.create_task(session.execute(operation))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        with self.assertRaises(UncertainBrowserState):
            await session.execute(AsyncMock())

    async def test_handoff_waits_until_command_has_completed(self):
        session = BrowserSession('kitesurf', 'session')
        started = asyncio.Event()
        finish = asyncio.Event()

        async def operation(backend, session_id):
            started.set()
            await finish.wait()
            return 'done'

        command = asyncio.create_task(session.execute(operation))
        await started.wait()
        verify = AsyncMock(return_value=True)
        handoff = asyncio.create_task(session.switch('chrome', verify))
        await asyncio.sleep(0)
        verify.assert_not_awaited()
        finish.set()
        self.assertEqual(await command, 'done')
        self.assertTrue(await handoff)
        verify.assert_awaited_once()

    async def test_failed_verification_leaves_source_and_blocks_further_commands(self):
        session = BrowserSession('kitesurf', 'session')
        with self.assertRaises(ConnectionError):
            await session.switch('chrome', AsyncMock(side_effect=ConnectionError()))
        self.assertEqual(session.backend, 'kitesurf')
        with self.assertRaises(UncertainBrowserState):
            await session.execute(AsyncMock())


if __name__ == '__main__':
    unittest.main()
