# ABOUTME: Проверяет холодный CDP, параллельные запросы и закрытие после задачи.
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from identity import browser_demand


class BrowserDemandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.working = False
        self.commands = []
        self.backend = None

        async def respond(reader, writer):
            try:
                await reader.readexactly(4)
                writer.write(b'CDP\n')
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        async def command(action):
            self.commands.append(action)
            if action == 'start':
                self.backend = await asyncio.start_server(respond, '127.0.0.1', 0)
                browser_demand.CHROME_PORT = self.backend.sockets[0].getsockname()[1]
            else:
                self.backend.close()
                await self.backend.wait_closed()

        self.browser = browser_demand.BrowserDemand(lambda: self.working)
        self.browser._command = command
        self.browser._graceful_exit = AsyncMock()
        self.backend_port = patch('identity.browser_demand.CHROME_PORT', 0)
        self.backend_port.start()
        self.addCleanup(self.backend_port.stop)
        self.frontend_port = patch('identity.browser_demand.CDP_PORT', 0)
        self.frontend_port.start()
        self.addCleanup(self.frontend_port.stop)
        idle = patch('identity.browser_demand.BROWSER_IDLE_SECONDS', 60)
        idle.start()
        self.addCleanup(idle.stop)
        await self.browser.open()
        self.port = self.browser.server.sockets[0].getsockname()[1]
        self.addAsyncCleanup(self.browser.close)

    async def request(self, payload):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        try:
            writer.write(payload)
            await writer.drain()
            writer.write_eof()
            return await asyncio.wait_for(reader.read(), 5)
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_cold_probe_and_jobs(self):
        self.assertEqual(await self.request(b''), b'')
        self.assertEqual(await self.request(b'GET '), b'')
        self.working = True
        self.browser.task_ended()
        self.assertEqual(self.commands, [])
        self.assertEqual(await asyncio.gather(self.request(b'GET '), self.request(b'GET ')), [b'CDP\n'] * 2)
        self.assertEqual(self.commands, ['start'])
        self.browser.task_ended()  # Другая работа ещё пользуется тем же браузером.
        self.assertIsNone(self.browser.idle_timer)
        self.assertEqual(self.commands, ['start'])
        self.working = False
        self.browser.task_ended()
        timer = self.browser.idle_timer
        self.assertIsNotNone(timer)
        self.assertEqual(self.commands, ['start'])
        self.working = True
        self.assertEqual(await self.request(b'GET '), b'CDP\n')
        self.assertTrue(timer.cancelled())
        self.assertEqual(self.commands, ['start'])
        self.working = False
        self.browser.task_ended()
        self.browser.idle_timer.cancel()
        self.browser._idle_elapsed()
        await self.browser.cleanup
        self.assertEqual(self.commands, ['start', 'stop'])
        self.browser._graceful_exit.assert_awaited_once()
