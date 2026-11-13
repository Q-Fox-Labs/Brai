# ABOUTME: Проверяет pinned PTB polling на локальном синтетическом Bot HTTP API.
# ABOUTME: Не использует сеть Telegram, действующие сервисы и реальные профили.
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs

try:
    from telegram import Bot
    from telegram.ext import Updater
except ImportError:
    raise unittest.SkipTest('Нужен закреплённый python-telegram-bot')

from identity.chat_journal import IdentityJournal
from identity.native_ingress import ReleaseGate
from identity.ordinary_admission import Mirror
from identity.transport_inbox import TransportInbox
from identity.update_inbox import UpdateInbox


class LocalBotAPI:
    def __init__(self):
        self.offsets=[]
        self.clients=set()
        self.second=asyncio.Event()
        self.allow_retry=asyncio.Event()
        self.release_later=asyncio.Event()
        self.pending={'update_id':41,'message':{'message_id':41,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}}

    async def serve(self,reader,writer):
        self.clients.add(writer)
        try:
            head=await reader.readuntil(b'\r\n\r\n')
            lines=head.decode('ascii').split('\r\n')
            target=lines[0].split()[1]
            headers={line.split(':',1)[0].lower():line.split(':',1)[1].strip()
                     for line in lines[1:] if ':' in line}
            body=await reader.readexactly(int(headers.get('content-length','0')))
            payload={key:values[0] for key,values in parse_qs(body.decode()).items()}
            if target.endswith('/getMe'):
                result={'id':123,'is_bot':True,'first_name':'synthetic','username':'synthetic_bot'}
            elif target.endswith('/getUpdates'):
                offset=int(payload.get('offset',0))
                self.offsets.append(offset)
                if len(self.offsets)==2:
                    self.second.set()
                    await self.allow_retry.wait()
                if offset>41:
                    await self.release_later.wait()
                result=[self.pending] if offset<=41 else []
            else:
                raise AssertionError('Unexpected synthetic Bot API method')
            encoded=json.dumps({'ok':True,'result':result}).encode()
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '
                         +str(len(encoded)).encode()+b'\r\n\r\n'+encoded)
            await writer.drain()
        except (asyncio.IncompleteReadError,ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
            self.clients.discard(writer)


class PollingBoundaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_capture_failure_keeps_real_updater_offset_until_retry(self):
        api=LocalBotAPI()
        server=await asyncio.start_server(api.serve,'127.0.0.1',0)
        port=server.sockets[0].getsockname()[1]
        bot=Bot('123:synthetic',base_url=f'http://127.0.0.1:{port}/bot')
        queue=asyncio.Queue();updater=Updater(bot,queue)
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        journal=IdentityJournal(Path(temp.name)/'chats')
        inbox=UpdateInbox(journal);transport=TransportInbox(journal)
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        inbox.install_v2(profile)
        locked=journal.database(profile)
        locked.execute('BEGIN IMMEDIATE')
        async def resolve(actor): return {'state':'known','profile':profile}
        mirror=Mirror(inbox,resolve,transport=transport);mirror.hydrated=True
        gate=ReleaseGate(SimpleNamespace(bot=bot,updater=updater,update_queue=queue))
        gate.resolver=SimpleNamespace(mirror=mirror)
        async def bootstrap(*args,**kwargs): pass
        try:
            await updater.initialize()
            gate.install()
            with patch.object(Updater,'_bootstrap',bootstrap):
                await updater.start_polling()
                await api.second.wait()
                self.assertEqual(api.offsets[:2],[0,0])
                self.assertTrue(queue.empty())
                self.assertEqual(len(transport.pending()),1)
                self.assertEqual(transport.pending()[0]['state'],'captured')
                locked.rollback();locked.close();locked=None
                api.allow_retry.set()
                update=await queue.get();queue.task_done()
                self.assertEqual(update.update_id,41)
                self.assertEqual(inbox.observe(profile,123,41)['state'],'captured')
                self.assertEqual(len(transport.pending()),1)
                self.assertEqual(updater._last_update_id,42)
        finally:
            if locked is not None:
                locked.rollback();locked.close()
            api.allow_retry.set();api.release_later.set()
            if updater.running: await updater.stop()
            if gate.restore: gate.restore()
            await updater.shutdown()
            server.close();await server.wait_closed()

    async def test_real_updater_cleanup_then_cancel_recovers_in_same_process(self):
        from telegram.ext import ApplicationBuilder, TypeHandler
        from identity.profile_release import ProfileRelease
        from identity.update_inbox import ProfileGateStore
        from test_ordinary_admission import patched_module
        import uuid

        class CleanupAPI(LocalBotAPI):
            def __init__(self):
                super().__init__()
                self.first_started=asyncio.Event();self.allow_empty=asyncio.Event()
                self.recovered=asyncio.Event()
            async def serve(self,reader,writer):
                self.clients.add(writer)
                try:
                    head=await reader.readuntil(b'\r\n\r\n')
                    lines=head.decode('ascii').split('\r\n')
                    target=lines[0].split()[1]
                    headers={line.split(':',1)[0].lower():line.split(':',1)[1].strip()
                             for line in lines[1:] if ':' in line}
                    body=await reader.readexactly(int(headers.get('content-length','0')))
                    payload={key:values[0] for key,values in parse_qs(body.decode()).items()}
                    if target.endswith('/getMe'):
                        result={'id':123,'is_bot':True,'first_name':'synthetic','username':'synthetic_bot'}
                    elif target.endswith('/getUpdates'):
                        offset=int(payload.get('offset',0));self.offsets.append(offset)
                        if len(self.offsets)==1:
                            self.first_started.set();await self.allow_empty.wait();result=[]
                        elif len(self.offsets)==2:
                            result=[self.pending]  # PTB stop cleanup, not queued by Updater
                        else:
                            await self.recovered.wait()
                            if offset>41:
                                await self.release_later.wait()
                            result=[self.pending] if offset<=41 else []
                    else: raise AssertionError('Unexpected synthetic Bot API method')
                    encoded=json.dumps({'ok':True,'result':result}).encode()
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: '
                                 +str(len(encoded)).encode()+b'\r\n\r\n'+encoded)
                    await writer.drain()
                except (asyncio.IncompleteReadError,ConnectionError):
                    pass
                finally:
                    writer.close();await writer.wait_closed();self.clients.discard(writer)

        api=CleanupAPI();server=await asyncio.start_server(api.serve,'127.0.0.1',0)
        port=server.sockets[0].getsockname()[1]
        bot=Bot('123:synthetic',base_url=f'http://127.0.0.1:{port}/bot')
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        module=patched_module(temp.name)
        profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic',
                 'uid':1001,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1}
        journal=IdentityJournal(Path(temp.name)/'chats');inbox=UpdateInbox(journal);transport=TransportInbox(journal)
        async def inventory(): return {'profiles':[profile],'allProfileIds':[profile['profileId']]}
        async def resolve(actor): return {'state':'known','profile':profile}
        mirror=Mirror(inbox,resolve,transport=transport,inventory=inventory,
                      gate_store=ProfileGateStore(inbox),boot_id=str(uuid.uuid4()))
        adapter=SimpleNamespace(_update_admission=None,_updates_dispatched_total=0,
            _seen_update_ids={},_inflight_update_ids={},_brai_identity_preflight=mirror,
            _brai_identity_disposition=mirror.finish,_brai_identity_duplicate=mirror.duplicate)
        app=ApplicationBuilder().bot(bot).application_class(module.TelegramApplication,{'adapter':adapter}).build()
        app._initialized=True;mirror.app=app
        updater=Updater(bot,app.update_queue)
        class Resolver:
            def __init__(self):
                self.mirror=mirror;self.batch_ownership=SimpleNamespace(busy=lambda uid:False)
            async def release_status(self,operationId): return {'operationId':operationId,'state':'ready','reason':None}
            async def release_resume(self,operationId): return True
        resolver=Resolver();owner=ProfileRelease(resolver,app);mirror.recover=owner.recover_inbox
        effects=[]
        async def handler(value,context):
            effects.append(value.update_id)
            await mirror.accepted(SimpleNamespace(_brai_release_updates=[value.update_id]),
                                  {'accepted':True,'turn_id':'synthetic'})
            api.recovered.set()
        app.add_handler(TypeHandler(__import__('telegram').Update,handler),group=-100)
        def record(adapter,key): adapter._seen_update_ids[key]=1
        async def bootstrap(*args,**kwargs): pass
        gate=ReleaseGate(SimpleNamespace(bot=bot,updater=updater,update_queue=app.update_queue))
        gate.resolver=resolver
        try:
            await updater.initialize();gate.install()
            with patch.object(Updater,'_bootstrap',bootstrap), patch.object(module,'_load_receipts',lambda *a:None), \
                 patch.object(module,'_record_receipt',record):
                await updater.start_polling()
                await api.first_started.wait()
                await gate.begin('op');api.allow_empty.set();await gate.drain
                self.assertEqual((await gate.commit('op'))['state'],'committed')
                await updater.stop()
                self.assertEqual(api.offsets[:2],[0,0])
                self.assertTrue(app.update_queue.empty())
                self.assertFalse(mirror.hydrated)
                self.assertEqual(inbox.observe(profile,123,41)['state'],'captured')
                await gate.resume('op')
                await updater.start_polling()
                duplicate=await app.update_queue.get();app.update_queue.task_done()
                await app.process_update(duplicate)
                self.assertEqual(api.offsets[:3],[0,0,0])
                self.assertEqual(effects,[41])
                self.assertEqual(inbox.observe(profile,123,41)['state'],'accepted')
                self.assertEqual(transport.pending(),[])
        finally:
            api.allow_empty.set();api.recovered.set();api.release_later.set()
            if updater.running: await updater.stop()
            if gate.restore: gate.restore()
            await updater.shutdown();server.close()
            for writer in tuple(api.clients): writer.close()
            await server.wait_closed()
