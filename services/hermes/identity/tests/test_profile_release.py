# ABOUTME: Проверяет условные per-profile RPC и durable receipts без живых служб.
# ABOUTME: Использует только синтетические процессы и временную SQLite.
import asyncio
import threading
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest
import uuid
from unittest.mock import AsyncMock, patch

try:
    from telegram import Bot, Update, User
except ImportError:
    raise unittest.SkipTest('Нужен закреплённый python-telegram-bot')
from identity.chat_journal import IdentityJournal
from identity.ordinary_admission import Mirror
from identity.profile_release import ProfileRelease
from identity.update_inbox import ProfileGateStore, UpdateInbox

P1={'profileId':'11111111-1111-4111-8111-111111111111','userId':'owner1','uid':1001,'telegramId':'42','authorTelegramId':'42','role':'member','generation':1,'workerSocket':'/synthetic'}
P2={'profileId':'22222222-2222-4222-8222-222222222222','userId':'owner2','uid':1002,'telegramId':'43','authorTelegramId':'43','role':'member','generation':1,'workerSocket':'/synthetic2'}

class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        inbox=UpdateInbox(IdentityJournal(Path(self.temp.name)/'chats'))
        async def inventory(): return {'profiles':[P1,P2]}
        async def resolve(actor): return {'state':'known','profile':P1 if actor=='42' else P2}
        self.mirror=Mirror(inbox,resolve,inventory=inventory,gate_store=ProfileGateStore(inbox))
        self.mirror.hydrated=True
        self.resolver=NS(mirror=self.mirror,batch_ownership=NS(busy=lambda uid:False))
        self.app=NS(bot=Bot('123:abc'))
        self.owner=ProfileRelease(self.resolver,self.app)
        self.request={'operationId':str(uuid.uuid4()),'attemptId':str(uuid.uuid4()),'profileId':P1['profileId'],
            'targetPayloadHash':'a'*64,'workerPid':123,'workerStartTime':'456'}

    async def test_busy_profile_remains_open_and_other_profile_independent(self):
        self.mirror.tracker.counts[1001]=1
        async def call(method, params, **kwargs):
            self.assertIn(method, ('release.reject_attempt', 'release.try_status'))
            return {**params, 'state':'busy'}
        with patch.object(self.owner,'_peer',AsyncMock(return_value=NS(call=call))):
            result=await self.owner.try_profile(**self.request)
            self.assertEqual(result['state'],'busy')
            self.assertNotIn(1001,self.mirror.tracker.gates)
            self.assertTrue(self.mirror.tracker.try_gate(1002,'other'))
            self.assertEqual((await self.owner.status(**self.request))['state'],'busy')
            self.assertEqual((await self.owner.try_profile(**self.request))['state'],'busy')

    async def test_ready_is_durable_and_resume_confirms_replacement(self):
        async def call(method,params,**kwargs):
            if method in ('release.try','release.try_status'):
                return {**params,'state':'ready'}
            return {'operationId':params['operationId'],'state':'resumed'}
        peer=NS(call=call)
        with patch.object(self.owner,'_peer',AsyncMock(return_value=peer)):
            ready=await self.owner.try_profile(**self.request)
            self.assertEqual(ready['state'],'ready')
            self.assertEqual(self.mirror.tracker.gates[1001],self.request['operationId'])
            self.assertEqual((await self.owner.status(**self.request))['state'],'ready')
            resumed=await self.owner.resume(**self.request,replacementPid=124,replacementStartTime='789')
            self.assertEqual(resumed['state'],'resumed')
            self.assertNotIn(1001,self.mirror.tracker.gates)
            status=await self.owner.status(**self.request,replacementPid=124,replacementStartTime='789')
            self.assertEqual(status['state'],'resumed')
            self.assertEqual((await self.owner.status(**self.request,replacementPid=125,replacementStartTime='789'))['state'],'unknown')

    async def test_ready_survives_ingress_owner_loss_and_rehydrates_closed(self):
        async def call(method, params, **kwargs):
            self.assertIn(method, ('release.try','release.try_status'))
            return {**params,'state':'ready'}
        peer=NS(call=call)
        with patch.object(self.owner,'_peer',AsyncMock(return_value=peer)):
            self.assertEqual((await self.owner.try_profile(**self.request))['state'],'ready')
        async def inventory(): return {'profiles':[P1,P2]}
        replacement=Mirror(self.mirror.inbox,self.mirror.resolve,inventory=inventory,
                           gate_store=ProfileGateStore(self.mirror.inbox),boot_id=self.owner.boot)
        resolver=NS(mirror=replacement,batch_ownership=NS(busy=lambda uid:False))
        owner=ProfileRelease(resolver,self.app)
        await replacement.hydrate()
        self.assertEqual(replacement.tracker.gates[1001],self.request['operationId'])
        with patch.object(owner,'_peer',AsyncMock(return_value=peer)):
            self.assertEqual((await owner.status(**self.request))['state'],'ready')
            self.assertEqual((await owner.status(**self.request))['state'],'ready')
        self.assertEqual(replacement.tracker.gates[1001],self.request['operationId'])

    async def test_terminal_attempt_task_is_reaped_after_durable_receipt(self):
        calls=[]
        async def call(method,params,**kwargs):
            calls.append(method)
            return {**params,'state':'ready'}
        with patch.object(self.owner,'_peer',AsyncMock(return_value=NS(call=call))):
            self.assertEqual((await self.owner.try_profile(**self.request))['state'],'ready')
            key=(self.request['operationId'],self.request['attemptId'])
            while key in self.owner.tasks:
                await asyncio.sleep(0)
            self.assertEqual((await self.owner.try_profile(**self.request))['state'],'ready')
            self.assertEqual(calls.count('release.try'),1)
            await asyncio.sleep(0)
            if self.owner.reapers:
                await asyncio.gather(*self.owner.reapers)

    async def test_waiting_worker_status_does_not_block_another_profile(self):
        self.owner.store.begin(P1,self.request,self.owner.boot)
        self.owner.store.transition(P1,self.request,self.owner.boot,'arming','ready')
        self.mirror.tracker.gates[1001]=self.request['operationId']
        self.mirror.tracker.counts[1002]=1
        other={**self.request,'operationId':str(uuid.uuid4()),'attemptId':str(uuid.uuid4()),
               'profileId':P2['profileId']}
        entered,release=asyncio.Event(),asyncio.Event()
        async def call(method,params,**kwargs): return {**params,'state':'busy'}
        async def peer(profile,pid,start):
            if profile['uid']==1001:
                entered.set();await release.wait()
            return NS(call=call)
        with patch.object(self.owner,'_peer',side_effect=peer):
            first=asyncio.create_task(self.owner.try_profile(**self.request))
            await entered.wait()
            self.assertEqual((await self.owner.try_profile(**other))['state'],'busy')
            release.set()
            self.assertEqual((await first)['state'],'unknown')

    async def test_rehydrate_moves_preexisting_captured_input_under_durable_gate(self):
        bot=self.app.bot
        update=Update.de_json({'update_id':31,'message':{'message_id':31,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        self.mirror.inbox.capture(P1,update,123)
        self.owner.store.begin(P1,self.request,self.owner.boot)
        self.owner.store.transition(P1,self.request,self.owner.boot,'arming','ready')
        async def inventory(): return {'profiles':[P1,P2]}
        replacement=Mirror(self.mirror.inbox,self.mirror.resolve,inventory=inventory,
                           gate_store=ProfileGateStore(self.mirror.inbox),boot_id=self.owner.boot)
        await replacement.hydrate()
        row=self.mirror.inbox.observe(P1,123,31)
        self.assertEqual((row['state'],row['operation_id']),('held',self.request['operationId']))
        self.assertEqual(replacement.tracker.gates[1001],self.request['operationId'])

    async def test_busy_reopening_replays_held_before_opening_profile(self):
        bot=self.app.bot
        bot._bot_user=User(123,'synthetic',True)
        update=Update.de_json({'update_id':17,'message':{'message_id':17,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic approval'}},bot)
        profile={**P1,'authorTelegramId':'42'}
        self.mirror.inbox.capture(profile,update,123)
        self.mirror.inbox.disposition(profile,123,17,'held',operation_id=self.request['operationId'])
        self.mirror.tracker.gates[1001]=self.request['operationId']
        self.mirror.bot_id=123
        self.owner.store.begin(P1,self.request,self.owner.boot)
        self.owner.store.transition(P1,self.request,self.owner.boot,'arming','reopening')
        processed=[]
        async def process(value):
            key=f'123:{value.update_id}'
            ticket=self.mirror.enter(key,value)
            self.assertFalse(await self.mirror.classify(ticket,value))
            await self.mirror.accepted(NS(_brai_release_updates=[value.update_id]),
                                       {'accepted':True,'turn_id':'synthetic'})
            self.mirror.finish(key,{'deferred':False})
            processed.append(value.update_id)
        async def process_update(value,coro): await coro
        self.app.process_update=process
        self.app.update_processor=NS(process_update=process_update)
        async def resolve(actor): return {'state':'known','profile':profile}
        self.mirror.resolve=resolve
        await self.owner._reopen(P1,self.request,'reopening','busy')
        self.assertEqual(processed,[17])
        self.assertNotIn(1001,self.mirror.tracker.gates)
        self.assertEqual(self.mirror.inbox.observe(P1,123,17)['state'],'accepted')
        async def call(method, params, **kwargs): return {**params, 'state':'busy'}
        with patch.object(self.owner,'_peer',AsyncMock(return_value=NS(call=call))):
            self.assertEqual((await self.owner.status(**self.request))['state'],'busy')

    async def test_stale_empty_read_cannot_open_gate_ahead_of_new_capture(self):
        from telegram.ext import ApplicationBuilder
        bot=self.app.bot
        bot._bot_user=User(123,'synthetic',True)
        update=Update.de_json({'update_id':22,'message':{'message_id':22,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},bot)
        op=self.request['operationId']
        self.mirror.tracker.gates[1001]=op
        self.owner.store.begin(P1,self.request,self.owner.boot)
        self.owner.store.transition(P1,self.request,self.owner.boot,'arming','reopening')
        selected,release=threading.Event(),threading.Event()
        original=self.mirror.inbox.held
        def paused_read(profile,operation):
            rows=original(profile,operation)
            if not selected.is_set():
                selected.set();release.wait()
            return rows
        effects=[]
        async def process(value):
            key=f'123:{value.update_id}'
            ticket=self.mirror.enter(key,value)
            self.assertFalse(await self.mirror.classify(ticket,value))
            await self.mirror.accepted(NS(_brai_release_updates=[value.update_id]),
                                       {'accepted':True,'turn_id':'synthetic'})
            self.mirror.finish(key,{'deferred':False})
            effects.append(value.update_id)
        ptb=ApplicationBuilder().bot(bot).build()
        self.app.process_update=process
        self.app.update_processor=ptb.update_processor
        with patch.object(self.mirror.inbox,'held',side_effect=paused_read):
            task=asyncio.create_task(self.owner._reopen(P1,self.request,'reopening','busy'))
            try:
                await asyncio.to_thread(selected.wait)
                await self.mirror.capture([update],123)
                self.assertEqual(self.mirror.inbox.observe(P1,123,22)['state'],'held')
            finally:
                release.set()
            await task
        self.assertEqual(effects,[22])
        self.assertEqual(self.mirror.inbox.observe(P1,123,22)['state'],'accepted')
        self.assertNotIn(1001,self.mirror.tracker.gates)

    async def test_unknown_worker_response_keeps_ingress_gate(self):
        with patch.object(self.owner,'_peer',side_effect=[NS(), OSError('synthetic peer loss')]):
            result=await self.owner.try_profile(**self.request)
        self.assertEqual(result['state'],'blocked')
        self.assertIn(1001,self.mirror.tracker.gates)
        self.assertEqual((await self.owner.status(**self.request))['state'],'unknown')

    async def test_lost_try_reply_keeps_owned_operation_until_result(self):
        entered, finish=asyncio.Event(),asyncio.Event()
        async def call(method,params,**kwargs):
            if method=='release.try': entered.set();await finish.wait()
            return {**params,'state':'ready'}
        with patch.object(self.owner,'_peer',AsyncMock(return_value=NS(call=call))):
            caller=asyncio.create_task(self.owner.try_profile(**self.request))
            await entered.wait()
            caller.cancel();await asyncio.gather(caller,return_exceptions=True)
            self.assertEqual((await self.owner.status(**self.request))['state'],'pending')
            finish.set()
            result=await self.owner.try_profile(**self.request)
            self.assertEqual(result['state'],'ready')
            self.assertEqual((await self.owner.status(**self.request))['state'],'ready')

if __name__=='__main__': unittest.main()
