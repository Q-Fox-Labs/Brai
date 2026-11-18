# ABOUTME: Проверяет запрет повторов и условия смены владельца браузерной сессии.
# ABOUTME: Двойники браузеров не подтверждают перенос данных реальных сайтов.
import asyncio
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock

from identity.browser_handoff import BrowserJournal, UncertainBrowserState


class BrowserHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, 'journal.sqlite3')
        self.db = sqlite3.connect(self.path)
        self.journal = BrowserJournal(self.db)

    async def asyncTearDown(self):
        self.db.close()
        self.temp.cleanup()

    async def test_switch_requires_proof_and_keeps_source(self):
        session = self.journal.create('kitesurf', 'session')
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
        session = self.journal.create('kitesurf', 'session')
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
        session = self.journal.create('kitesurf', 'session')
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
        session = self.journal.create('kitesurf', 'session')
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
        session = self.journal.create('kitesurf', 'session')
        with self.assertRaises(ConnectionError):
            await session.switch('chrome', AsyncMock(side_effect=ConnectionError()))
        self.assertEqual(session.backend, 'kitesurf')
        with self.assertRaises(UncertainBrowserState):
            await session.execute(AsyncMock())

    async def test_cannot_replace_unknown_session_or_use_volatile_database(self):
        session = self.journal.create('kitesurf', 'session')
        with self.assertRaises(ConnectionError):
            await session.execute(AsyncMock(side_effect=ConnectionError()))
        with self.assertRaises(sqlite3.IntegrityError):
            self.journal.create('chrome', 'session')
        with self.assertRaises(UncertainBrowserState):
            await self.journal.attach('session').execute(AsyncMock())
        with sqlite3.connect(':memory:') as volatile:
            with self.assertRaises(ValueError):
                BrowserJournal(volatile)

    async def test_process_exit_during_command_survives_reopening(self):
        self.journal.create('kitesurf', 'session')
        script = '''
import asyncio, os, sqlite3, sys
from identity.browser_handoff import BrowserJournal
async def main():
    session = BrowserJournal(sqlite3.connect(sys.argv[1])).attach('session')
    async def operation(backend, identity):
        with open(sys.argv[2], 'w') as output:
            output.write('action sent')
        os._exit(17)
    await session.execute(operation)
asyncio.run(main())
'''
        marker = os.path.join(self.temp.name, 'action')
        process = subprocess.run([sys.executable, '-c', script, self.path, marker], check=False)
        self.assertEqual(process.returncode, 17)
        self.assertTrue(os.path.isfile(marker))
        self.db.close()
        self.db = sqlite3.connect(self.path)
        self.journal = BrowserJournal(self.db)
        session = self.journal.attach('session')
        with self.assertRaises(UncertainBrowserState):
            await session.execute(AsyncMock())
        with self.assertRaises(UncertainBrowserState):
            await session.switch('chrome', AsyncMock(return_value=True))

    async def test_restored_copy_quarantines_even_previously_idle_session(self):
        self.journal.create('kitesurf', 'session')
        backup_path = os.path.join(self.temp.name, 'backup.sqlite3')
        with sqlite3.connect(backup_path) as backup:
            self.db.backup(backup)
        with sqlite3.connect(backup_path) as restored:
            journal = BrowserJournal(restored)
            journal.quarantine_restored()
            with self.assertRaises(UncertainBrowserState):
                await journal.attach('session').execute(AsyncMock())

    async def test_two_connections_cannot_dispatch_same_session(self):
        session = self.journal.create('kitesurf', 'session')
        with sqlite3.connect(self.path) as other_db:
            other = BrowserJournal(other_db).attach('session')
            called = asyncio.Event()
            finish = asyncio.Event()

            async def operation(backend, session_id):
                called.set()
                await finish.wait()

            first = asyncio.create_task(session.execute(operation))
            await called.wait()
            with self.assertRaises(UncertainBrowserState):
                await other.execute(AsyncMock())
            finish.set()
            await first

    async def test_other_process_cannot_dispatch_or_repeat_inflight_operation(self):
        session = self.journal.create('kitesurf', 'session')
        script = '''
import asyncio, sqlite3, sys
from identity.browser_handoff import BrowserJournal
async def main():
    session = BrowserJournal(sqlite3.connect(sys.argv[1])).attach('session')
    async def operation(backend, identity):
        print('dispatched', flush=True)
        await asyncio.Event().wait()
    await session.execute(operation)
asyncio.run(main())
'''
        process = subprocess.Popen([sys.executable, '-c', script, self.path],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'dispatched')
            operation = AsyncMock()
            with self.assertRaises(UncertainBrowserState):
                await session.execute(operation)
            operation.assert_not_awaited()
        finally:
            process.terminate()
            process.communicate()
        with self.assertRaises(UncertainBrowserState):
            await session.execute(AsyncMock())


if __name__ == '__main__':
    unittest.main()
