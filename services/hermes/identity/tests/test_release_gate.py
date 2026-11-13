# ABOUTME: Проверяет остановку Telegram polling на границе обновления версии.
# ABOUTME: Не обращается к Telegram и не запускает личные процессы.
import asyncio
import unittest
from types import SimpleNamespace

from identity.ipc import RpcError
from identity.native_ingress import ReleaseGate


class Bot:
    async def get_updates(self, **kwargs):
        return ['update']


class ReleaseGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_fence_waits_for_queue_and_operation_owner(self):
        bot = Bot()
        queue = asyncio.Queue()
        gate = ReleaseGate(SimpleNamespace(bot=bot, update_queue=queue))
        gate.install()
        self.addCleanup(gate.restore)
        await queue.put('update')
        self.assertEqual((await gate.begin('one'))['state'], 'draining')
        poll = asyncio.create_task(bot.get_updates())
        await gate.held.wait()
        self.assertFalse(poll.done())
        self.assertEqual((await gate.status('one'))['state'], 'draining')
        with self.assertRaises(RpcError):
            await gate.resume('other')
        await queue.get()
        queue.task_done()
        await gate.drain
        self.assertEqual((await gate.status('one'))['reason'], 'worker_control_unavailable')
        await gate.resume('one')
        self.assertEqual(await poll, ['update'])

    async def test_worker_resume_failure_keeps_polling_held(self):
        class Resolver:
            async def release_status(self, operationId):
                return {'operationId': operationId, 'state': 'ready', 'reason': None}
            async def release_resume(self, operationId):
                return False
        bot = Bot()
        gate = ReleaseGate(SimpleNamespace(bot=bot, update_queue=asyncio.Queue()))
        gate.resolver = Resolver()
        gate.install()
        self.addCleanup(gate.restore)
        await gate.begin('one')
        poll = asyncio.create_task(bot.get_updates())
        await gate.drain
        self.assertEqual((await gate.status('one'))['state'], 'ready')
        self.assertEqual((await gate.resume('one'))['reason'], 'worker_resume_unconfirmed')
        self.assertFalse(poll.done())
        gate.resolver = None
        await gate.resume('one')
        self.assertEqual(await poll, ['update'])

    async def test_commit_allows_only_cleanup_after_polling_stops(self):
        from datetime import timedelta
        class Resolver:
            async def release_status(self, operationId):
                return {'operationId': operationId, 'state': 'ready', 'reason': None}
            async def release_resume(self, operationId):
                return True
        bot = Bot()
        updater = SimpleNamespace(running=True)
        gate = ReleaseGate(SimpleNamespace(bot=bot, updater=updater, update_queue=asyncio.Queue()))
        gate.resolver = Resolver()
        gate.install()
        self.addCleanup(gate.restore)
        await gate.begin('one')
        normal = asyncio.create_task(bot.get_updates(timeout=timedelta(seconds=10)))
        await gate.drain
        self.assertEqual((await gate.commit('one'))['state'], 'committed')
        self.assertFalse(normal.done())
        updater.running = False
        self.assertEqual(await bot.get_updates(timeout=timedelta(0)), ['update'])
        self.assertFalse(normal.done())
        normal.cancel()
        await asyncio.gather(normal, return_exceptions=True)
        await gate.resume('one')

    async def test_open_gate_probe_and_repeated_resume_are_idempotent(self):
        bot = Bot()
        gate = ReleaseGate(SimpleNamespace(bot=bot, update_queue=asyncio.Queue()))
        gate.install()
        self.addCleanup(gate.restore)
        self.assertEqual((await gate.status('one'))['state'], 'resumed')
        await gate.begin('one')
        self.assertEqual((await gate.resume('one'))['state'], 'resumed')
        self.assertEqual((await gate.resume('one'))['state'], 'resumed')
        self.assertEqual((await gate.status('one'))['state'], 'resumed')
        self.assertEqual(await bot.get_updates(), ['update'])

    async def test_batch_is_durable_before_get_updates_returns(self):
        entered, commit = asyncio.Event(), asyncio.Event()
        class RecordedBot:
            id = 123
            async def get_updates(self, **kwargs): return ['synthetic']
        class Mirror:
            async def capture(self, updates, bot_id):
                self.values=(updates,bot_id)
                entered.set()
                await commit.wait()
        bot=RecordedBot();mirror=Mirror()
        gate=ReleaseGate(SimpleNamespace(bot=bot, update_queue=asyncio.Queue()))
        gate.resolver=SimpleNamespace(mirror=mirror)
        gate.install();self.addCleanup(gate.restore)
        fetching=asyncio.create_task(bot.get_updates())
        await entered.wait()
        self.assertFalse(fetching.done())
        self.assertEqual(mirror.values,(['synthetic'],123))
        commit.set()
        self.assertEqual(await fetching,['synthetic'])

    async def test_preack_storage_error_propagates_instead_of_returning_batch(self):
        class RecordedBot:
            id=123
            async def get_updates(self, **kwargs): return ['synthetic']
        class Mirror:
            async def capture(self, updates, bot_id): raise OSError('synthetic disk failure')
        bot=RecordedBot();gate=ReleaseGate(SimpleNamespace(bot=bot, update_queue=asyncio.Queue()))
        gate.resolver=SimpleNamespace(mirror=Mirror());gate.install();self.addCleanup(gate.restore)
        with self.assertRaisesRegex(OSError,'disk failure'): await bot.get_updates()

    async def test_resume_before_poll_does_not_wait_for_queue(self):
        bot = Bot()
        gate = ReleaseGate(SimpleNamespace(bot=bot, update_queue=asyncio.Queue()))
        gate.install()
        self.addCleanup(gate.restore)
        await gate.begin('one')
        self.assertEqual((await gate.resume('one'))['state'], 'resumed')
        self.assertEqual(await bot.get_updates(), ['update'])


class ReleaseWorkersTest(unittest.IsolatedAsyncioTestCase):
    async def test_all_workers_must_confirm_and_resume_before_unlock(self):
        from unittest.mock import patch
        from identity.telegram_runtime import Resolver
        class Peer:
            def __init__(self, state):
                self.state = state
                self.calls = []
            async def call(self, method, params, timeout=None):
                self.calls.append(method)
                if method == 'release.resume':
                    self.state = 'resumed'
                state = self.state
                return {'operationId': params['operationId'], 'state': state, 'reason': None}
        class Bridge:
            def __init__(self, uid, peer):
                self.worker_uid, self.peer = uid, peer
            async def connect(self):
                return self.peer
        first, second = Peer('ready'), Peer('draining')
        bridges = {1: Bridge(1, first), 2: Bridge(2, second)}
        resolver = Resolver.__new__(Resolver)
        resolver.release_workers = {}
        resolver.bridges = {}
        resolver.adapter = SimpleNamespace(**{name: {} for name in ('_pending_text_batches', '_pending_text_batch_tasks', '_pending_photo_batches', '_pending_photo_batch_tasks', '_media_group_events', '_media_group_tasks')}, _held_inbound_events=[], _held_inbound_redispatch_task=None)
        resolver._bridge = lambda profile: bridges[profile['uid']]
        async def broker(method, params):
            return {'profiles': [{'uid': 1}, {'uid': 2}]}
        with patch('identity.telegram_runtime.broker_call', broker):
            resolver.adapter._media_group_tasks['pending'] = object()
            self.assertEqual((await resolver.release_status('one'))['reason'], 'telegram_batches')
            resolver.adapter._media_group_tasks.clear()
            self.assertEqual((await resolver.release_status('one'))['state'], 'draining')
            second.state = 'ready'
            self.assertEqual((await resolver.release_status('one'))['state'], 'ready')
            self.assertTrue(await resolver.release_resume('one'))
        self.assertEqual(first.calls.count('release.resume'), 1)
        self.assertEqual(second.calls.count('release.resume'), 1)
        self.assertEqual(resolver.release_workers, {})

    async def test_resume_waits_for_worker_recovery_before_polling_opens(self):
        from unittest.mock import patch
        from identity.telegram_runtime import Resolver
        recovering, complete = asyncio.Event(), asyncio.Event()
        class Peer:
            async def call(self, method, params, timeout=None):
                if method != 'release.resume' or timeout is not None:
                    raise AssertionError('Recovery must use unbounded operation wait')
                recovering.set()
                await complete.wait()
                return {'operationId': params['operationId'], 'state': 'resumed', 'reason': None}
        class Bridge:
            async def connect(self): return Peer()
        resolver = Resolver.__new__(Resolver)
        resolver.release_workers = {1: Bridge()}
        task = asyncio.create_task(resolver.release_resume('one'))
        await recovering.wait()
        self.assertFalse(task.done())
        self.assertTrue(resolver.release_workers)
        complete.set()
        self.assertTrue(await task)
        self.assertFalse(resolver.release_workers)

    async def test_resume_failure_keeps_workers_recorded(self):
        from identity.telegram_runtime import Resolver
        class Peer:
            async def call(self, method, params, timeout=None):
                state = 'blocked'
                return {'operationId': params['operationId'], 'state': state, 'reason': None}
        class Bridge:
            async def connect(self): return Peer()
        resolver = Resolver.__new__(Resolver)
        resolver.release_workers = {1: Bridge()}
        self.assertFalse(await resolver.release_resume('one'))
        self.assertTrue(resolver.release_workers)


class PinnedPollingTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_updater_stops_with_only_cleanup_allowed(self):
        try:
            from telegram.ext import Updater
        except ImportError:
            self.skipTest('Нужен установленный закреплённый python-telegram-bot')
        from unittest.mock import patch
        class FakeBot:
            def __init__(self):
                self.calls = []
            async def initialize(self):
                pass
            async def shutdown(self):
                pass
            async def get_updates(self, **kwargs):
                self.calls.append(kwargs)
                return []
        async def bootstrap(*args, **kwargs):
            pass
        class Resolver:
            async def release_status(self, operationId):
                return {'operationId': operationId, 'state': 'ready', 'reason': None}
            async def release_resume(self, operationId):
                return True
        bot = FakeBot()
        queue = asyncio.Queue()
        updater = Updater(bot, queue)
        gate = ReleaseGate(SimpleNamespace(bot=bot, updater=updater, update_queue=queue))
        gate.resolver = Resolver()
        gate.install()
        self.addCleanup(gate.restore)
        await updater.initialize()
        with patch.object(Updater, '_bootstrap', bootstrap):
            await updater.start_polling()
        await gate.begin('op')
        await gate.drain
        self.assertEqual((await gate.commit('op'))['state'], 'committed')
        before = len(bot.calls)
        await updater.stop()
        self.assertEqual(len(bot.calls), before + 1)
        self.assertEqual(bot.calls[-1]['timeout'].total_seconds(), 0)
        await updater.shutdown()
        await gate.resume('op')
