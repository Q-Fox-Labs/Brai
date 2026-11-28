# ABOUTME: Проверяет учёт и восстановление входов Telegram на native fixture.
# ABOUTME: Не подключается к настоящим профилям и службам Telegram.
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
    section = marker + source.split(marker, 1)[1].split('\ndiff --git ', 1)[0] + '\n'
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
    async def test_same_group_topic_is_recovered_under_each_senders_profile(self):
        from identity.chat_journal import IdentityJournal
        from identity.transport_inbox import TransportInbox
        from identity.update_inbox import UpdateInbox
        first = {'profileId': '11111111-1111-4111-8111-111111111111', 'userId': 'u1',
                 'uid': 1001, 'telegramId': '42', 'authorTelegramId': '42', 'role': 'user', 'generation': 1}
        second = {**first, 'profileId': '22222222-2222-4222-8222-222222222222', 'userId': 'u2',
                  'uid': 1002, 'telegramId': '43', 'authorTelegramId': '43'}
        profiles = {value['telegramId']: value for value in (first, second)}
        async def resolve(actor):
            return {'state': 'known', 'profile': profiles[actor]} if actor in profiles else {'state': 'unregistered'}
        bot = Bot('123:abc')
        bot._bot_user = User(123, 'synthetic', True)
        def update(ident, sender, *, forum=True, thread=77):
            chat = {'id': -10012, 'type': 'supergroup', 'title': 'Synthetic', 'is_forum': forum}
            message = {'message_id': ident, 'date': 1, 'chat': chat, 'message_thread_id': thread,
                       'from': {'id': sender, 'is_bot': False, 'first_name': 'Synthetic'}, 'text': str(sender)}
            return Update.de_json({'update_id': ident, 'message': message}, bot)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BRAI_IDENTITY_INSTANCE': 'dev'}):
            journal = IdentityJournal(Path(directory) / 'chats')
            inbox = UpdateInbox(journal)
            transport = TransportInbox(journal)
            mirror = Mirror(inbox, resolve, transport=transport)
            await mirror.capture([update(10, 42), update(11, 43), update(12, 44),
                                 update(13, 42, forum=False, thread=55), update(14, 43, thread=None)], 123)
            self.assertEqual(mirror.snapshot('123:12'), {'state': 'outside'})
            for old, foreign, owner in ((10, 11, first), (11, 10, second)):
                row = inbox.observe(owner, 123, old)
                self.assertEqual((row['chat'], row['thread']), ('-10012', '77'))
                with self.assertRaisesRegex(ValueError, 'INBOX_NOT_FOUND'):
                    inbox.observe(owner, 123, foreign)
            self.assertEqual(inbox.observe(first, 123, 13)['thread'], '')
            self.assertEqual(inbox.observe(second, 123, 14)['thread'], '')
            # После нового процесса очереди исходный Auth и группа восстанавливаются по сохранённому update.
            restarted = Mirror(UpdateInbox(IdentityJournal(journal.root)), resolve, transport=transport)
            restarted.hydrated = True
            restarted.bot_id = bot.id
            restarted.app = SimpleNamespace(bot=bot, update_queue=asyncio.Queue())
            await restarted.pump()
            recovered = {}
            while not restarted.app.update_queue.empty():
                item = restarted.app.update_queue.get_nowait()
                binding = restarted.snapshot(f'123:{item.update_id}')['profile']
                self.assertEqual(str(item.effective_user.id), binding['telegramId'])
                self.assertEqual(item.effective_chat.id, -10012)
                recovered[item.update_id] = binding['uid']
            self.assertEqual(recovered, {10: 1001, 11: 1002, 13: 1001, 14: 1002})
            restarted.auto_inputs.add('123:14')
            active_route = ('-10012', '1')
            async def ready(profile, route):
                return profile == second and route == active_route
            restarted.input_ready = ready
            wrong = SimpleNamespace(source=SimpleNamespace(chat_id='-10012', thread_id='77'),
                                    _brai_release_updates=[14])
            with self.assertRaisesRegex(PermissionError, 'Group delivery route changed'):
                await restarted.before_delivery(wrong)
            general = SimpleNamespace(source=SimpleNamespace(chat_id='-10012', thread_id='1'),
                                      _brai_release_updates=[14])
            receipt = await restarted.before_delivery(general)
            self.assertIn('delivery_id', receipt)
            self.assertEqual(inbox.observe(second, 123, 14)['state'], 'handing_off')

    async def test_group_reaction_allows_capture_of_following_topic_message(self):
        from identity.chat_journal import IdentityJournal
        from identity.transport_inbox import TransportInbox
        from identity.update_inbox import UpdateInbox
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        bot=Bot('123:synthetic');bot._bot_user=User(123,'synthetic',True)
        chat={'id':-10012,'type':'supergroup','title':'Synthetic','is_forum':True}
        actor={'id':42,'is_bot':False,'first_name':'Synthetic'}
        reaction=Update.de_json({'update_id':41,'message_reaction':{'message_id':9,'date':1,
            'chat':chat,'user':actor,'old_reaction':[],'new_reaction':[{'type':'emoji','emoji':'👍'}]}},bot)
        message=Update.de_json({'update_id':42,'message':{'message_id':10,'date':2,
            'chat':chat,'from':actor,'message_thread_id':77,'is_topic_message':True,'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BRAI_IDENTITY_INSTANCE':'dev'}):
            journal=IdentityJournal(Path(directory)/'chats');inbox=UpdateInbox(journal)
            transport=TransportInbox(journal);inbox.install_v2(profile)
            async def resolve(actor_id): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,transport=transport)
            await mirror.capture([reaction],123)
            self.assertEqual(mirror.snapshot('123:41'),{'state':'outside'})
            self.assertEqual(transport.observe(123,41)['state'],'ignored')
            ticket=mirror.enter('123:41',reaction)
            self.assertFalse(await mirror.classify(ticket,reaction))
            mirror.finish(ticket,{'deferred':True})
            self.assertNotIn('123:41',mirror.tracker.tickets)
            await mirror.capture([message],123)
            row=inbox.observe(profile,123,42)
            self.assertEqual((row['state'],row['chat'],row['thread']),('captured','-10012','77'))

    async def test_reaction_does_not_block_next_topic(self):
        await self._reaction_case(None, False, False, False)

    async def test_reaction_with_main_topic_paused_does_not_block_other_topic(self):
        await self._reaction_case(None, True, False, False)

    async def test_old_captured_reaction_recovers_while_main_topic_paused(self):
        await self._reaction_case(None, True, False, True)

    async def test_gate_cannot_start_while_pump_saves_reaction(self):
        await self._reaction_case(None, True, False, 'race')

    async def test_cancelled_pump_holds_gate_until_sqlite_finishes(self):
        await self._reaction_case(None, True, False, 'cancel')

    async def test_cancelled_pump_preserves_cancellation_when_write_fails(self):
        await self._reaction_case(None, True, False, 'cancel_error')

    async def test_reaction_recovers_after_partial_journal_write(self):
        await self._reaction_case(None, True, True, True)

    async def test_failed_reaction_disposition_does_not_reach_other_handlers(self):
        await self._reaction_case('profile', False, False, False)

    async def test_failed_transport_write_retries_reaction_without_new_input(self):
        await self._reaction_case('transport', True, False, False)

    async def test_held_reaction_write_failure_keeps_gate_closed_until_reconciled(self):
        await self._reaction_case('held', False, False, False)

    async def _reaction_case(self, write_fails, main_paused, partial, pump):
        from types import SimpleNamespace as NS
        from identity import native_ingress
        from identity.chat_journal import IdentityJournal
        from identity.transport_inbox import TransportInbox
        from identity.update_inbox import UpdateInbox

        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        bot=Bot('123:synthetic');bot._bot_user=User(123,'synthetic',True)
        reaction=Update.de_json({'update_id':41,'message_reaction':{'message_id':9,'date':1,
            'chat':{'id':42,'type':'private'},'user':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'old_reaction':[],'new_reaction':[{'type':'emoji','emoji':'👍'}]}},bot)
        message=Update.de_json({'update_id':42,'message':{'message_id':10,'date':2,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'message_thread_id':3,'is_topic_message':True,'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BRAI_IDENTITY_INSTANCE':'release'}):
            module=patched_module(directory)
            journal=IdentityJournal(Path(directory)/'chats');inbox=UpdateInbox(journal)
            transport=TransportInbox(journal);inbox.install_v2(profile)
            if main_paused:
                journal.set_chat_pause(profile,('42',''),True)
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,transport=transport);mirror.hydrated=True
            mirror.input_ready=AsyncMock(return_value=True)
            adapter=NS(_update_admission=None,_updates_dispatched_total=0,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_batch_protocol=1,
                _brai_identity_held_protocol=1,_pending_text_batches={},_pending_photo_batches={},
                _media_group_events={},_held_inbound_events=[],gateway_runner=NS(_hm_admit_event=AsyncMock()))
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            class Resolver:
                journal=None
                def __init__(self): self.mirror=mirror
                def __call__(self,source): return None
            resolver=Resolver()
            ctx=NS(register_telegram_handler=lambda callback:setattr(ctx,'factory',callback),
                   on_unload=lambda callback:setattr(ctx,'close',callback))
            forward=NS(_brai_restore_authorize=lambda:None)
            async def admit(update, adapter): return True
            receipts=[]
            with patch.object(native_ingress,'install',return_value=forward), \
                 patch.object(module,'_load_receipts',lambda *args:None), \
                 patch.object(module,'_record_receipt',lambda adapter,key:receipts.append(key)):
                native_ingress.register(ctx,build_resolver=lambda *args:resolver,admit_update=admit)
                ctx.factory(app,adapter)
                handled=[]
                async def handle(update,context):
                    handled.append(update.update_id)
                    event=NS(_brai_release_updates=[update.update_id])
                    await mirror.before_delivery(event)
                    await mirror.accepted(event,{'accepted':True,'turn_id':'synthetic'})
                app.add_handler(TypeHandler(Update,handle),group=0)
                if pump:
                    mirror.bot_id=123
                    transport.capture_batch([(reaction,{'state':'known','profile':profile})],123)
                    if partial:
                        inbox.capture(profile,reaction,123)
                else:
                    await mirror.capture([reaction],123)
                if partial:
                    inbox.ignore_reaction(profile,123,41)
                if write_fails == 'held':
                    from identity.profile_release import ProfileRelease
                    import uuid
                    operation=str(uuid.uuid4())
                    inbox.disposition(profile,123,41,'held',operation_id=operation)
                    mirror._release_snapshot('123:41')
                    mirror.tracker.gates[1001]=operation
                    owner=ProfileRelease(resolver,app)
                    with patch.object(transport,'ignore_reaction',side_effect=OSError('synthetic failure')):
                        with self.assertRaises(OSError):
                            await owner._reopen(profile,{'operationId':operation},None,None)
                    self.assertEqual(mirror.tracker.gates[1001],operation)
                    self.assertEqual(inbox.observe(profile,123,41)['state'],'handled')
                    self.assertEqual(transport.observe(123,41)['state'],'captured')
                    await owner._reopen(profile,{'operationId':operation},None,None)
                    self.assertNotIn(1001,mirror.tracker.gates)
                elif write_fails:
                    target=inbox if write_fails == 'profile' else transport
                    with patch.object(target,'ignore_reaction',side_effect=OSError('synthetic failure')):
                        await app.process_update(reaction)
                    self.assertEqual(handled,[])
                    self.assertEqual(receipts,[])
                    self.assertEqual(inbox.observe(profile,123,41)['state'],
                                     'captured' if write_fails == 'profile' else 'handled')
                    self.assertEqual(transport.observe(123,41)['state'],'captured')
                    self.assertEqual(mirror.tracker.counts.get(1001,0),0)
                    await mirror.pump()
                elif pump:
                    if pump in ('race', 'cancel', 'cancel_error'):
                        import threading
                        entered,proceed=threading.Event(),threading.Event()
                        original=inbox.capture
                        def capture(*args):
                            entered.set();proceed.wait()
                            if pump == 'cancel_error':
                                raise OSError('synthetic failure')
                            return original(*args)
                        with patch.object(inbox,'capture',side_effect=capture):
                            task=asyncio.create_task(mirror.pump())
                            await asyncio.to_thread(entered.wait)
                            self.assertFalse(mirror.tracker.try_gate(1001,'synthetic'))
                            if pump in ('cancel', 'cancel_error'):
                                task.cancel()
                                await asyncio.sleep(0)
                                task.cancel()
                                await asyncio.sleep(0)
                                self.assertFalse(task.done())
                                self.assertTrue(mirror.capture_lock.locked())
                                self.assertFalse(mirror.tracker.try_gate(1001,'synthetic'))
                            proceed.set()
                            if pump in ('cancel', 'cancel_error'):
                                with self.assertRaises(asyncio.CancelledError): await task
                            else:
                                await task
                    else:
                        await mirror.pump()
                else:
                    await app.process_update(reaction)
                if pump == 'cancel_error':
                    await mirror.pump()
                self.assertEqual(inbox.observe(profile,123,41)['state'],'handled')
                self.assertEqual(transport.observe(123,41)['state'],'handled')
                self.assertEqual(mirror.tracker.counts.get(1001,0),0)
                await mirror.capture([message],123)
                await app.process_update(message)
                self.assertEqual(handled,[42])
                self.assertEqual(inbox.observe(profile,123,42)['state'],'accepted')
                ctx.close()

    async def test_reserved_profile_collision_is_rejected_before_global_journal_open(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        from identity.transport_inbox import TransportInbox, TRANSPORT_PROFILE
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            async def inventory(): return {'profiles':[],'allProfileIds':[TRANSPORT_PROFILE['profileId']]}
            mirror=Mirror(inbox,lambda actor:None,transport=TransportInbox(inbox.journal),
                          inventory=inventory,gate_store=ProfileGateStore(inbox),boot_id='synthetic')
            with self.assertRaisesRegex(ValueError,'TRANSPORT_PROFILE_COLLISION'):
                await mirror.hydrate()
            self.assertFalse(inbox.journal.root.exists())

    async def test_crash_before_gate_receipt_keeps_orphan_held_input_unknown(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        import uuid
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        bot=Bot('123:abc')
        update=Update.de_json({'update_id':10,'message':{'message_id':10,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            inbox.capture(profile,update,123)
            abandoned=str(uuid.uuid4())
            inbox.disposition(profile,123,10,'held',operation_id=abandoned)
            async def inventory(): return {'profiles':[profile]}
            mirror=Mirror(inbox,lambda actor:None,inventory=inventory,
                          gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            mirror.recover=AsyncMock()
            await mirror.hydrate()
            self.assertEqual(mirror.rehydrated[1001]['record']['state'],'unknown')
            self.assertIn(1001,mirror.tracker.gates)
            self.assertEqual(inbox.observe(profile,123,10)['operation_id'],abandoned)
            mirror.recover.assert_not_awaited()

    async def test_global_only_commit_recovers_original_owner_and_keeps_inactive_visible(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        from identity.transport_inbox import TransportInbox
        import uuid
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
        update=Update.de_json({'update_id':6,'message':{'message_id':6,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            transport=TransportInbox(inbox.journal)
            transport.capture_batch([(update,{'state':'known','profile':profile})],123)
            async def inactive(): return {'profiles':[],'allProfileIds':[profile['profileId']]}
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,transport=transport,inventory=inactive,
                          gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            mirror.app=SimpleNamespace(bot=bot)
            await mirror.hydrate()
            self.assertEqual(len(mirror.transport_unavailable),1)
            self.assertIn(1001,mirror.transport_blocked)
            self.assertFalse((inbox.journal.root/profile['profileId']).exists())
            async def active(): return {'profiles':[profile],'allProfileIds':[profile['profileId']]}
            restarted=Mirror(inbox,resolve,transport=transport,inventory=active,
                             gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            restarted.app=SimpleNamespace(bot=bot);restarted.recover=AsyncMock()
            await restarted.hydrate()
            await restarted.recovery_tasks[1001]
            self.assertEqual(inbox.observe(profile,123,6)['state'],'held')
            restarted.recover.assert_awaited_once()

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
        self.assertEqual(mirror.tracker.gates,{1001:'op1'})
        self.assertEqual(mirror.rehydrated[1002]['record']['state'],'resumed')
        self.assertTrue(mirror.hydrated)

    async def test_changed_resumed_worker_keeps_unsettled_inputs_held(self):
        profile={'uid':1001,'profileId':'11111111-1111-4111-8111-111111111111'}
        record={'state':'resumed','operation_id':'op','replacement_pid':20,'replacement_start':'21'}
        async def inventory(): return {'profiles':[profile]}
        async def observe(profile): return (30,'31')
        for state, bound in [('unknown',True),('blocked',True),('handing_off',True),
                             ('held',True),('captured',True),('held',False)]:
            with self.subTest(state=state,bound=bound):
                item={'state':state,'bound':bound,'operationId':'op','botId':'1','updateId':'2'}
                inbox=SimpleNamespace(install_v2=lambda p:None,unsettled=lambda p:[item],
                    markunknown=lambda *args:None,disposition=lambda *args,**kwargs:None)
                mirror=Mirror(inbox,lambda actor:None,inventory=inventory,observe=observe,
                    gate_store=SimpleNamespace(current=lambda *args:record),boot_id='synthetic')
                mirror.recover=AsyncMock()
                await mirror.hydrate()
                self.assertEqual(mirror.tracker.gates,{1001:'op'})
                self.assertEqual(mirror.rehydrated[1001]['record']['state'],'unknown')
                mirror.recover.assert_not_awaited()

    async def test_changed_resumed_worker_keeps_unresolved_transport_held(self):
        import json
        profile={'uid':1001,'profileId':'11111111-1111-4111-8111-111111111111'}
        record={'state':'resumed','operation_id':'op','replacement_pid':20,'replacement_start':'21'}
        async def inventory(): return {'profiles':[profile],'allProfileIds':[profile['profileId']]}
        async def observe(profile): return (30,'31')
        for binding in ({'state':'known','profile':profile},{'state':'unknown'}):
            with self.subTest(binding=binding):
                transport=SimpleNamespace(pending=lambda:[{'state':'unknown','binding':json.dumps(binding)}],
                                          blocked_for=lambda uid:False)
                inbox=SimpleNamespace(install_v2=lambda p:None,unsettled=lambda p:[])
                mirror=Mirror(inbox,lambda actor:None,inventory=inventory,observe=observe,
                    gate_store=SimpleNamespace(current=lambda *args:record),boot_id='synthetic',transport=transport)
                mirror.app=SimpleNamespace(bot=SimpleNamespace(id=123))
                await mirror.hydrate()
                self.assertEqual(mirror.tracker.gates,{1001:'op'})
                self.assertEqual(mirror.rehydrated[1001]['record']['state'],'unknown')

    async def test_resumed_without_verified_worker_remains_held(self):
        profile={'uid':1001,'profileId':'p1'}
        record={'state':'resumed','operation_id':'op','replacement_pid':20,'replacement_start':'21'}
        async def inventory(): return {'profiles':[profile]}
        async def observe(profile): raise PermissionError('worker unavailable')
        mirror=Mirror(SimpleNamespace(install_v2=lambda p:None,unsettled=lambda p:[]),lambda actor:None,
            inventory=inventory,observe=observe,gate_store=SimpleNamespace(current=lambda *args:record),boot_id='synthetic')
        await mirror.hydrate()
        self.assertEqual(mirror.tracker.gates,{1001:'op'})
        self.assertEqual(mirror.rehydrated[1001]['record']['state'],'unknown')

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
    async def test_known_worker_receipt_closes_both_transport_and_profile_rows(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        from identity.transport_inbox import TransportInbox
        with tempfile.TemporaryDirectory() as directory:
            global module
            module=patched_module(directory)
            profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                     'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'));transport=TransportInbox(inbox.journal)
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,transport=transport);mirror.hydrated=True
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            update=Update.de_json({'update_id':5,'message':{'message_id':5,'date':1,
                'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
                'text':'synthetic'}},bot)
            await mirror.capture([update],123)
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            async def handler(value,context):
                await mirror.accepted(SimpleNamespace(_brai_release_updates=[value.update_id]),
                                      {'accepted':True,'turn_id':'synthetic'})
            app.add_handler(TypeHandler(Update,handler),group=-100)
            with patch.object(module,'_load_receipts',lambda *a:None), patch.object(module,'_record_receipt',lambda *a:None):
                await app.process_update(update)
            self.assertEqual(inbox.observe(profile,123,5)['state'],'accepted')
            self.assertEqual(transport.pending(),[])

    async def test_locked_global_index_fails_before_poll_return(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        from identity.transport_inbox import TransportInbox
        from identity.native_ingress import ReleaseGate
        import sqlite3
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
        update=Update.de_json({'update_id':3,'message':{'message_id':3,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'))
            transport=TransportInbox(inbox.journal)
            locked=transport._open()
            async def resolve(actor): return {'state':'known','profile':profile}
            mirror=Mirror(inbox,resolve,transport=transport);mirror.hydrated=True
            gate=ReleaseGate(SimpleNamespace(bot=bot,update_queue=asyncio.Queue()))
            gate.resolver=SimpleNamespace(mirror=mirror)
            with patch.object(Bot,'get_updates',AsyncMock(return_value=[update])):
                gate.install()
                try:
                    locked.execute('BEGIN IMMEDIATE')
                    with self.assertRaises(sqlite3.OperationalError): await bot.get_updates()
                finally:
                    locked.rollback();locked.close()
                self.assertFalse((inbox.journal.root/profile['profileId']).exists())
                self.assertEqual(await bot.get_updates(),[update])
                self.assertEqual(inbox.observe(profile,123,3)['state'],'captured')
                gate.restore()

    async def test_locked_profile_fails_before_poll_return_and_preserves_global_owner(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        from identity.transport_inbox import TransportInbox
        from identity.native_ingress import ReleaseGate
        import sqlite3
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        changed={**profile,'profileId':'22222222-2222-4222-8222-222222222222','userId':'u2','uid':1002}
        bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
        update=Update.de_json({'update_id':4,'message':{'message_id':4,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        with tempfile.TemporaryDirectory() as directory:
            inbox=UpdateInbox(IdentityJournal(Path(directory)/'chats'));inbox.install_v2(profile)
            transport=TransportInbox(inbox.journal)
            current=[profile]
            async def resolve(actor): return {'state':'known','profile':current[0]}
            mirror=Mirror(inbox,resolve,transport=transport);mirror.hydrated=True
            gate=ReleaseGate(SimpleNamespace(bot=bot,update_queue=asyncio.Queue()))
            gate.resolver=SimpleNamespace(mirror=mirror)
            with patch.object(Bot,'get_updates',AsyncMock(return_value=[update])):
                gate.install()
                locked=inbox.journal.database(profile)
                try:
                    locked.execute('BEGIN IMMEDIATE')
                    with self.assertRaises(sqlite3.OperationalError): await bot.get_updates()
                finally:
                    locked.rollback();locked.close()
                self.assertEqual(transport.pending()[0]['state'],'captured')
                current[0]=changed
                self.assertEqual(await bot.get_updates(),[update])
                self.assertEqual(mirror.snapshot('123:4')['state'],'binding_changed')
                self.assertEqual(transport.pending()[0]['state'],'blocked')
                self.assertFalse((inbox.journal.root/changed['profileId']).exists())
                gate.restore()

    async def test_unregistered_invite_replays_original_without_worker_routing(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox, ProfileGateStore
        from identity.transport_inbox import TransportInbox
        from identity.profile_release import ProfileRelease
        from identity import telegram_runtime as runtime
        from telegram.ext import ApplicationHandlerStop
        import uuid
        with tempfile.TemporaryDirectory() as directory:
            global module
            module=patched_module(directory)
            journal=IdentityJournal(Path(directory)/'chats')
            inbox=UpdateInbox(journal);transport=TransportInbox(journal)
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            update=Update.de_json({'update_id':8,'message':{'message_id':8,'date':1,
                'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
                'text':'/start invite_abcdefghijklmnop'}},bot)
            transport.capture_batch([(update,{'state':'unregistered'})],123)
            async def inventory(): return {'profiles':[],'allProfileIds':[]}
            async def resolve(actor): return {'state':'unregistered'}
            mirror=Mirror(inbox,resolve,transport=transport,inventory=inventory,
                          gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,_bot=bot,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True;mirror.app=app
            owner=ProfileRelease(SimpleNamespace(mirror=mirror,batch_ownership=SimpleNamespace(busy=lambda uid:False)),app)
            mirror.recover_external=owner.recover_external
            effects=[];methods=[]
            async def broker(method,params,**kwargs):
                methods.append(method)
                if method=='ingress.resolve-known': return {'state':'unregistered'}
                if method=='identity.invite-redeem': return {'user':{'status':'active'}}
                raise AssertionError('unexpected worker routing')
            async def guard(value,context):
                if not await runtime.admit_update(value,adapter):
                    await mirror.handled(value)
                    raise ApplicationHandlerStop
            async def handler(value,context): effects.append(value.update_id)
            app.add_handler(TypeHandler(Update,guard),group=-100)
            app.add_handler(TypeHandler(Update,handler),group=0)
            with patch.dict(runtime._resolvers,{id(adapter):SimpleNamespace(mirror=mirror,journal=None)}), \
                 patch.object(runtime,'broker_call',broker), patch.object(runtime,'_notice',AsyncMock()), \
                 patch.object(module,'_load_receipts',lambda *a:None), \
                 patch.object(module,'_record_receipt',lambda *a:None):
                await mirror.hydrate()
                await mirror.recovery_tasks['123:8']
            self.assertEqual(methods.count('identity.invite-redeem'),1)
            self.assertNotIn('identity.resolve',methods)
            self.assertEqual(effects,[])
            self.assertEqual(transport.pending(),[])

    async def test_redelivery_after_auth_rebind_never_reaches_new_owner(self):
        from identity.chat_journal import IdentityJournal
        from identity.update_inbox import UpdateInbox
        from identity.transport_inbox import TransportInbox
        from identity import telegram_runtime as runtime
        from telegram.ext import ApplicationHandlerStop
        with tempfile.TemporaryDirectory() as directory:
            global module
            module=patched_module(directory)
            journal=IdentityJournal(Path(directory)/'chats')
            inbox=UpdateInbox(journal); transport=TransportInbox(journal)
            before={'profileId':'11111111-1111-4111-8111-111111111111','userId':'u1',
                    'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
            after={**before,'profileId':'22222222-2222-4222-8222-222222222222','userId':'u2','uid':1002}
            bot=Bot('123:abc');bot._bot_user=User(123,'synthetic',True)
            update=Update.de_json({'update_id':9,'message':{'message_id':9,'date':1,
                'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
                'text':'synthetic'}},bot)
            async def old_resolve(actor): return {'state':'known','profile':before}
            old=Mirror(inbox,old_resolve,transport=transport)
            await old.capture([update],123)  # crash before Telegram offset acknowledgement
            async def new_resolve(actor): return {'state':'known','profile':after}
            mirror=Mirror(inbox,new_resolve,transport=TransportInbox(journal))
            await mirror.capture([update],123)
            self.assertEqual(mirror.snapshot('123:9')['state'],'binding_changed')
            self.assertFalse((journal.root / after['profileId']).exists())
            adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,_bot=bot,
                _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
                _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
            app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
            app._initialized=True
            effects=[]
            async def guard(value,context):
                if not await runtime.admit_update(value,adapter): raise ApplicationHandlerStop
            async def handler(value,context): effects.append(value.update_id)
            app.add_handler(TypeHandler(Update,guard),group=-100)
            app.add_handler(TypeHandler(Update,handler),group=0)
            with patch.dict(runtime._resolvers,{id(adapter):SimpleNamespace(mirror=mirror)}), \
                 patch.object(runtime,'broker_call',AsyncMock(return_value={'state':'known','profile':after})), \
                 patch.object(runtime,'_notice',AsyncMock()), \
                 patch.object(module,'_load_receipts',lambda *a:None), \
                 patch.object(module,'_record_receipt',lambda *a:None):
                await app.process_update(update)
            self.assertEqual(effects,[])
            self.assertEqual(transport.pending()[0]['state'],'blocked')

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
