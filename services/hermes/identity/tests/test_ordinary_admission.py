import asyncio
import importlib.util
import sys
import tempfile
import shutil
import subprocess
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
try:
    from telegram import Bot, Update, User
    from telegram.ext import ApplicationBuilder, TypeHandler
except ImportError:
    raise unittest.SkipTest('Нужен закреплённый python-telegram-bot')
from identity.ordinary_admission import Tracker, Mirror

BASE = Path(__file__).resolve().parents[1]
FIXTURE = BASE / 'tests/fixtures/ordinary_release/plugins/platforms/telegram/update_admission.py'
PATCH = BASE / 'native.patch'

def patched_module(directory):
    path = Path(directory) / 'plugins/platforms/telegram/update_admission.py'
    path.parent.mkdir(parents=True)
    shutil.copyfile(FIXTURE, path)
    source = PATCH.read_text()
    marker = '--- a/plugins/platforms/telegram/update_admission.py\n'
    if source.count(marker) != 1:
        raise ValueError('Pinned admission patch missing or duplicated')
    section = marker + source.split(marker, 1)[1].split('\n--- a/', 1)[0] + '\n'
    subprocess.run(['patch', '-p1', '--batch'], cwd=directory, input=section,
                   text=True, check=True, stdout=subprocess.DEVNULL)
    spec = importlib.util.spec_from_file_location('_brai_postflight_test',path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestRealPTBClaims(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        global module
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        module = patched_module(self.temp.name)
        self.authorizing=asyncio.Event();self.authorized=asyncio.Event();self.authorized.set()
        async def authorize(update):
            self.authorizing.set()
            await self.authorized.wait()
            return 1001 if update.update_id in (1,3,4,5) else 1002
        self.tracker=Tracker(authorize)
        self.adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
            _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=self.tracker,
            _brai_identity_disposition=self.tracker.finish)
        bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
        self.app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':self.adapter}).build()
        self.app._initialized=True
        self.load=patch.object(module,'_load_receipts',lambda *args:None)
        self.record=patch.object(module,'_record_receipt',lambda adapter,key:adapter._seen_update_ids.update({key:1}))
        self.load.start();self.record.start();self.addCleanup(self.load.stop);self.addCleanup(self.record.stop)
        self.entered=asyncio.Event();self.finish=asyncio.Event();self.handled=[]
        async def handler(update,context):
            self.handled.append(update.update_id)
            if update.update_id==1:
                self.entered.set();await self.finish.wait()
        self.app.add_handler(TypeHandler(Update,handler),group=-100)

    def update(self,ident):
        return Update.de_json({'update_id':ident,'message':{'message_id':ident,'date':1,
             'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
             'text':'synthetic'}},self.app.bot)

    async def test_unclassified_and_per_uid_claims_block_only_valid_gates(self):
        self.authorized.clear()
        first=asyncio.create_task(self.app.process_update(self.update(1)))
        await self.authorizing.wait()
        self.assertFalse(self.tracker.try_gate(1001,'op'))
        self.assertFalse(self.tracker.try_gate(1002,'op'))
        self.authorized.set();await self.entered.wait()
        self.assertFalse(self.tracker.try_gate(1001,'op'))
        self.assertTrue(self.tracker.try_gate(1002,'op'))
        second=self.update(2);await self.app.process_update(second)
        self.assertNotIn(2,self.handled)
        self.assertTrue(self.tracker.last_final[2]['deferred'])
        self.finish.set();await first
        self.assertTrue(self.tracker.try_gate(1001,'op'))
        self.assertEqual(self.tracker.counts[1001],0)
        self.assertEqual(self.adapter._inflight_update_ids,{})

    async def test_native_ptb_spawned_task_retains_claim_until_done(self):
        child_started, child_finish=asyncio.Event(),asyncio.Event()
        async def child(): child_started.set();await child_finish.wait()
        async def spawn(update,context): context.application.create_task(child(),update=update)
        self.app.add_handler(TypeHandler(Update,spawn),group=-200)
        with patch('warnings.warn'):
            await self.app.process_update(self.update(3))
        await child_started.wait()
        self.assertFalse(self.tracker.try_gate(1001,'op'))
        self.assertEqual(self.tracker.counts[1001],1)
        child_finish.set()
        while self.adapter._inflight_update_ids: await asyncio.sleep(0)
        self.assertTrue(self.tracker.try_gate(1001,'op'))

    async def test_plain_asyncio_task_is_not_a_native_claim_owner(self):
        started,finish=asyncio.Event(),asyncio.Event()
        tasks=[]
        async def direct(): started.set();await finish.wait()
        async def spawn(update,context): tasks.append(asyncio.create_task(direct()))
        self.app.add_handler(TypeHandler(Update,spawn),group=-200)
        await self.app.process_update(self.update(4))
        await started.wait()
        self.assertTrue(self.tracker.try_gate(1001,'op'))
        self.assertFalse(tasks[0].done())
        finish.set();await tasks[0]

    async def test_unknown_auth_retains_unclassified_counter(self):
        async def invalid(update): raise OSError('synthetic Auth unavailable')
        self.tracker.authorize=invalid
        with self.assertRaises(OSError): await self.app.process_update(self.update(5))
        self.assertEqual(self.tracker.tickets,{'123:5':None})
        self.assertFalse(self.tracker.try_gate(1001,'op'))

    async def test_failed_disposition_cannot_open_gate_or_delete_claim(self):
        def broken(key,result): raise RuntimeError('synthetic disposition error')
        self.adapter._brai_identity_disposition=broken
        with self.assertRaises(RuntimeError): await self.app.process_update(self.update(3))
        self.assertFalse(self.tracker.try_gate(1001,'op'))
        self.assertIn('123:3',self.adapter._inflight_update_ids)

class MirrorTest(unittest.IsolatedAsyncioTestCase):
    async def test_auth_generation_change_blocks_original_input(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
        bot=Bot('123:abc')
        update=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},'text':'x'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            inbox.capture(profile,update,123)
            async def resolve(actor): return {'state':'known','profile':{**profile,'generation':2}}
            mirror=Mirror(inbox,resolve)
            mirror.bot_id=123
            mirror.register_snapshot('123:1',{'state':'known','profile':profile})
            with self.assertRaises(PermissionError): await mirror._authorize(update)
            self.assertEqual(inbox.observe(profile,123,1)['state'],'blocked')

    async def test_hydration_restores_nonterminal_gates_before_poll(self):
        profiles=[{'uid':1001,'profileId':'p1'}, {'uid':1002,'profileId':'p2'}]
        class Store:
            def current(self, profile, boot):
                if profile['uid']==1001:
                    return {'state':'ready','operation_id':'op1','worker_pid':10,'worker_start':'11'}
                return {'state':'resumed','operation_id':'op2','replacement_pid':20,'replacement_start':'21'}
        async def inventory(): return {'profiles':profiles}
        async def observe(profile): return (20,'different')
        mirror=Mirror(SimpleNamespace(unsettled=lambda profile:[], install_v2=lambda profile:None),lambda actor:None,inventory=inventory,observe=observe,gate_store=Store(),boot_id='synthetic')
        await mirror.hydrate()
        self.assertEqual(mirror.tracker.gates,{1001:'op1',1002:'op2'})
        self.assertEqual(mirror.rehydrated[1002]['record']['state'],'unknown')
        self.assertTrue(mirror.hydrated)

    async def test_hydration_failure_does_not_confirm_gate_inventory(self):
        async def inventory(): raise PermissionError('synthetic Auth failure')
        mirror=Mirror(SimpleNamespace(),lambda actor:None,inventory=inventory,gate_store=SimpleNamespace(),boot_id='synthetic')
        with self.assertRaises(PermissionError): await mirror.hydrate()
        self.assertFalse(mirror.hydrated)

    async def test_restart_replays_only_never_handed_off_inputs(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        import uuid
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
        bot=Bot('123:abc')
        update=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},'text':'x'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            inbox.capture(profile,update,123)
            async def inventory(): return {'profiles':[profile]}
            mirror=Mirror(inbox,lambda actor:None,inventory=inventory,gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            mirror.recover=AsyncMock()
            await mirror.hydrate()
            self.assertIn(1001,mirror.tracker.gates)
            recovery=mirror.tracker.gates[1001]
            self.assertEqual(inbox.observe(profile,123,1)['state'],'held')
            await mirror.recovery_tasks[1001]
            mirror.recover.assert_awaited_once_with(profile,recovery)

    async def test_restart_marks_prior_handoff_unknown_without_replay(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        import uuid
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
        bot=Bot('123:abc')
        update=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},'text':'x'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            inbox.capture(profile,update,123);inbox.claim_for_delivery(profile,123,1)
            async def inventory(): return {'profiles':[profile]}
            mirror=Mirror(inbox,lambda actor:None,inventory=inventory,gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            mirror.recover=AsyncMock()
            await mirror.hydrate()
            self.assertEqual(inbox.observe(profile,123,1)['state'],'unknown')
            self.assertIn(1001,mirror.tracker.gates)
            mirror.recover.assert_not_awaited()

    async def test_known_and_outsider_are_snapshotted_before_return(self):
        stored=[]
        class Inbox:
            def capture_batch(self, items, bot_id):
                stored.extend((profile['uid'], update.update_id) for profile,update in items)
                return [{'state':'captured'} for _ in items]
        async def resolve(actor):
            if actor == '42': return {'state':'known','profile':{'uid':1001,'telegramId':'42'}}
            return {'state':'unregistered'}
        bot=Bot('123:abc')
        def update(update_id, actor):
            return Update.de_json({'update_id':update_id,'message':{'message_id':update_id,'date':1,
                'chat':{'id':actor,'type':'private'},'from':{'id':actor,'is_bot':False,'first_name':'synthetic'},'text':'x'}},bot)
        mirror=Mirror(Inbox(),resolve)
        await mirror.capture([update(1,42),update(2,43)],123)
        self.assertEqual(stored,[(1001,1)])
        self.assertEqual(mirror.snapshot('123:1')['state'],'known')
        self.assertEqual(mirror.snapshot('123:2')['state'],'unregistered')
        self.assertFalse(mirror.pending)

    async def test_failure_propagates_and_keeps_attempt_blocked_until_retry(self):
        class Inbox:
            def __init__(self): self.failure=True
            def capture_batch(self, items, bot_id):
                if self.failure: raise OSError('synthetic commit failure')
                return [{'state':'captured'} for _ in items]
        async def resolve(actor): return {'state':'known','profile':{'uid':1001,'telegramId':actor}}
        bot=Bot('123:abc')
        event=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},'text':'x'}},bot)
        inbox=Inbox();mirror=Mirror(inbox,resolve)
        with self.assertRaises(OSError): await mirror.capture([event],123)
        self.assertTrue(mirror.pending)
        with self.assertRaises(ValueError): mirror.snapshot('123:1')
        inbox.failure=False
        await mirror.capture([event],123)
        self.assertFalse(mirror.pending)
        self.assertEqual(mirror.snapshot('123:1')['profile']['uid'],1001)

class FullAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_restart_replay_and_concurrent_telegram_redelivery_have_one_effect(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        from identity.profile_release import ProfileRelease
        import uuid
        with tempfile.TemporaryDirectory() as directory:
            global module
            module=patched_module(directory)
            profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                     'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            update=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
                'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
                'text':'synthetic'}},bot)
            # The first ingress died after fsync but before handing off this update.
            inbox.capture(profile,update,123)
            async def inventory(): return {'profiles':[profile]}
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,inventory=inventory,gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            resolver=SimpleNamespace(mirror=mirror,batch_ownership=SimpleNamespace(busy=lambda uid:False))
            owner=ProfileRelease(resolver,app);mirror.recover=owner.recover_inbox
            entered,finish=asyncio.Event(),asyncio.Event();effects=[]
            async def handler(value,context):
                effects.append(value.update_id);entered.set();await finish.wait()
                await mirror.accepted(SimpleNamespace(_brai_release_updates=[value.update_id]),
                                      {'accepted':True,'turn_id':'synthetic'})
            app.add_handler(TypeHandler(Update,handler),group=-100)
            def record(adapter,key): adapter._seen_update_ids[key]=1
            with patch.object(module,'_load_receipts',lambda *a:None), patch.object(module,'_record_receipt',record):
                await mirror.hydrate()
                await entered.wait()
                await mirror.capture([update],123)
                await app.process_update(update)
                self.assertEqual(effects,[1])
                finish.set()
                await mirror.recovery_tasks[1001]
            self.assertEqual(effects,[1])
            self.assertNotIn(1001,mirror.tracker.gates)
            self.assertEqual(inbox.observe(profile,123,1)['state'],'accepted')

    async def test_preack_claim_worker_receipt_and_per_profile_gate(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        import uuid
        with tempfile.TemporaryDirectory() as directory:
            global module
            module = patched_module(directory)
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            profile1={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                      'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
            profile2={'profileId':'22222222-2222-4222-8222-222222222222','userId':'u2',
                      'uid':1002,'telegramId':'43','authorTelegramId':'43','role':'member','generation':1}
            async def resolve(actor): return {'state':'known','profile':profile1 if actor=='42' else profile2}
            mirror=Mirror(inbox,resolve);mirror.hydrated=True
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            def event(ident, actor):
                return Update.de_json({'update_id':ident,'message':{'message_id':ident,'date':1,
                    'chat':{'id':actor,'type':'private'},'from':{'id':actor,'is_bot':False,'first_name':'synthetic'},
                    'text':'synthetic'}},bot)
            first,second=event(1,42),event(2,43)
            await mirror.capture([first,second],123)
            op=str(uuid.uuid4());mirror.tracker.gates[1001]=op
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            calls=[]
            async def handler(update,context):
                calls.append(update.update_id)
                await mirror.accepted(SimpleNamespace(_brai_release_updates=[update.update_id]),
                                      {'accepted':True,'turn_id':'synthetic'})
            app.add_handler(TypeHandler(Update,handler),group=-100)
            def record(adapter,key): adapter._seen_update_ids[key]=1
            with patch.object(module,'_load_receipts',lambda *a:None), patch.object(module,'_record_receipt',record):
                await app.process_update(first)
                await app.process_update(second)
            self.assertEqual(calls,[2])
            self.assertEqual(inbox.observe(profile1,123,1)['state'],'held')
            self.assertEqual(inbox.observe(profile2,123,2)['state'],'accepted')
            self.assertNotIn('123:1',adapter._seen_update_ids)
            self.assertIn('123:2',adapter._seen_update_ids)
            self.assertEqual(mirror.tracker.counts[1001],0)
            self.assertEqual(mirror.tracker.counts[1002],0)

    async def test_duplicate_inflight_and_seen_keep_exact_one_worker_effect(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        with tempfile.TemporaryDirectory() as directory:
            global module
            module=patched_module(directory)
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                     'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve);mirror.hydrated=True
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            update=Update.de_json({'update_id':1,'message':{'message_id':1,'date':1,
                'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
                'text':'synthetic'}},bot)
            await mirror.capture([update,update],123)
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            entered,finish=asyncio.Event(),asyncio.Event();effects=[]
            async def handler(value,context):
                effects.append(value.update_id);entered.set();await finish.wait()
                await mirror.accepted(SimpleNamespace(_brai_release_updates=[value.update_id]),
                                      {'accepted':True,'turn_id':'synthetic'})
            app.add_handler(TypeHandler(Update,handler),group=-100)
            def record(adapter,key): adapter._seen_update_ids[key]=1
            with patch.object(module,'_load_receipts',lambda *a:None), patch.object(module,'_record_receipt',record):
                first=asyncio.create_task(app.process_update(update));await entered.wait()
                await app.process_update(update)
                self.assertEqual(effects,[1]);self.assertEqual(mirror.snapshot_refs['123:1'],1)
                finish.set();await first
                self.assertNotIn('123:1',mirror.snapshot_refs)
                await mirror.capture([update],123)
                await app.process_update(update)
                self.assertEqual(effects,[1]);self.assertNotIn('123:1',mirror.snapshot_refs)
            self.assertEqual(inbox.observe(profile,123,1)['state'],'accepted')

if __name__=='__main__': unittest.main()
