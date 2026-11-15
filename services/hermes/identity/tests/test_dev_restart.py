# ABOUTME: Проверяет DEV restart на настоящих SQLite и Telegram Update.
# ABOUTME: Не посылает сообщения и не запускает настоящие профили.
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from telegram import Bot, User
from identity.chat_journal import IdentityJournal
from identity.update_inbox import UpdateInbox, ProfileGateStore
from identity.transport_inbox import TransportInbox
from identity.ordinary_admission import Mirror
from identity.tests.test_update_inbox import PROFILE, OP, update

class DevRestartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'BRAI_IDENTITY_INSTANCE':'dev'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.inbox = UpdateInbox(IdentityJournal(Path(self.tmp.name)/'chats'))
        self.transport = TransportInbox(self.inbox.journal)
        self.bot = Bot('123:abc'); self.bot._bot_user = User(123, 'fixture', True)
        async def resolve(actor): return {'state':'known','profile':PROFILE}
        async def inventory(): return {'profiles':[PROFILE], 'allProfileIds':[PROFILE['profileId']]}
        self.resolve, self.inventory = resolve, inventory

    def capture(self, ident):
        item=update(ident)
        self.transport.capture_batch([(item, {'state':'known','profile':PROFILE})], 123)
        self.inbox.capture(PROFILE,item,123)
        return item

    async def test_restart_preserves_unknown_and_requeues_only_never_dispatched(self):
        self.capture(1); self.capture(2)
        self.transport.transition(123,1,'captured','handing_off')
        self.inbox.claim_for_delivery(PROFILE,123,1)
        self.inbox.disposition(PROFILE,123,2,'held',operation_id=OP)
        original=self.inbox.journal.database(PROFILE)
        payloads=list(original.execute('SELECT update_id,payload,digest FROM release_inbox ORDER BY seq'))
        original.close()
        for iteration in range(2):
            mirror=Mirror(self.inbox,self.resolve,transport=self.transport,inventory=self.inventory,
                          gate_store=ProfileGateStore(self.inbox))
            mirror.app=SimpleNamespace(bot=self.bot,update_queue=asyncio.Queue())
            await mirror.hydrate()
            self.assertEqual(mirror.tracker.gates,{})
            self.assertEqual(mirror.app.update_queue.qsize(),1 if iteration==0 else 0)
            self.assertEqual(self.inbox.observe(PROFILE,123,1)['state'],'unknown')
            self.assertEqual(self.transport.observe(123,1)['state'],'unknown')
            if iteration==0:
                queued=mirror.app.update_queue.get_nowait()
                self.assertEqual(queued.update_id,2)
                mirror.enter('123:2',queued)
                self.assertFalse(await mirror.classify('123:2',queued))
                await mirror.handled(queued)
                mirror.finish('123:2',{})
        self.capture(3)
        self.assertEqual(self.inbox.claim_for_delivery(PROFILE,123,3)['update']['update_id'],3)
        db=self.inbox.journal.database(PROFILE)
        self.assertEqual([tuple(row) for row in db.execute('SELECT update_id,payload,digest FROM release_inbox WHERE update_id IN (?,?) ORDER BY seq', ('1','2'))],
                         [tuple(row) for row in payloads]); db.close()
        with self.assertRaisesRegex(ValueError,'NOT_REPLAYABLE'):
            self.inbox.claim_for_delivery(PROFILE,123,1)

    async def test_restart_keeps_user_pause_and_consent_generation(self):
        self.capture(1)
        self.inbox.journal.set_chat_pause(PROFILE,('42',''),True)
        before=self.inbox.journal.chat_state(PROFILE,('42',''))
        self.inbox.prepare_restart(PROFILE)
        self.assertEqual(self.inbox.journal.chat_state(PROFILE,('42','')),before)
        with self.assertRaisesRegex(PermissionError,'CONSENT_CHANGED'):
            self.inbox.claim_for_delivery(PROFILE,123,1)

    async def test_prod_policy_does_not_change(self):
        self.capture(1); self.capture(2)
        self.inbox.claim_for_delivery(PROFILE,123,1);self.inbox.markunknown(PROFILE,123,1)
        with patch.dict(os.environ,{'BRAI_IDENTITY_INSTANCE':'prod'}):
            inbox=UpdateInbox(self.inbox.journal)
        with self.assertRaisesRegex(PermissionError,'DEV_RESTART_ONLY'):
            inbox.prepare_restart(PROFILE)
        with self.assertRaisesRegex(ValueError,'ORDER_BLOCKED'):
            inbox.claim_for_delivery(PROFILE,123,2)
