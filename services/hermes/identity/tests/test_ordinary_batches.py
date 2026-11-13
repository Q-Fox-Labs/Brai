# ABOUTME: Проверяет native Telegram batching и held-event ownership на pinned AST.
# ABOUTME: Использует только временные файлы и синтетические события без Telegram сети.
import ast
import asyncio
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock

from identity.ordinary_admission import BatchOwnership, Tracker

BASE=Path(__file__).resolve().parents[1]
FIXTURE=BASE/'tests/fixtures/ordinary_release'
MARKER='--- a/plugins/platforms/telegram/update_admission.py\n'
B1=(1001,'profile1','owner1','42','42','member',1)
B2=(1002,'profile2','owner2','43','43','member',1)


def event(binding, update_id):
    return NS(source=NS(chat_id=binding[3],user_id=binding[3]),text='synthetic',
              media_urls=[],media_types=[],_brai_release_binding=binding,_brai_release_updates=[update_id])


class PatchedFixture(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        shutil.copytree(FIXTURE/'plugins',root/'plugins')
        source=(BASE/'native.patch').read_text()
        self.assertEqual(source.count(MARKER),1)
        section=MARKER+source.split(MARKER,1)[1]
        subprocess.run(['patch','-p1','--batch'],cwd=root,input=section,text=True,check=True,stdout=subprocess.DEVNULL)
        self.adapter_path=root/'plugins/platforms/telegram/adapter.py'
        self.held_path=root/'plugins/platforms/telegram/telegram_held_inbound.py'
        self.mirror=NS(tracker=Tracker(lambda event:None),block_event=AsyncMock())
        self.pending={};self.held=[]
        self.adapter=NS(_bot=NS(id=123),_pending_text_batches=self.pending,
                        _pending_photo_batches={},_media_group_events={},_held_inbound_events=self.held)
        self.batch=BatchOwnership(self.adapter,self.mirror)

    def method(self,path,name):
        tree=ast.parse(path.read_text())
        return next(node for node in ast.walk(tree) if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name==name)

    async def test_text_owner_checked_before_native_merge(self):
        calls=[]
        class Base:
            def _enqueue_text_event(self, value): calls.append(value)
        method=self.method(self.adapter_path,'_enqueue_text_event')
        unit=ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),
            ast.ClassDef(name='Adapter',bases=[ast.Name(id='Base',ctx=ast.Load())],keywords=[],body=[method],decorator_list=[])],type_ignores=[]))
        scope={'Base':Base};exec(compile(unit,str(self.adapter_path),'exec'),scope)
        instance=scope['Adapter']()
        instance._pending_text_batches=self.pending;instance._pending_text_batch_tasks={}
        instance._text_batch_key=lambda value:'same'
        instance._should_drop_delayed_delivery=lambda:False
        instance._accept_update=lambda:None
        instance._brai_identity_text_batch=self.batch.text
        self.adapter._text_batch_key=instance._text_batch_key
        self.adapter._pending_text_batch_tasks=instance._pending_text_batch_tasks
        self.pending['same']=event(B1,1)
        with self.assertRaises(PermissionError): instance._enqueue_text_event(event(B2,2))
        self.assertEqual(calls,[])
        self.assertEqual(self.pending['same']._brai_release_updates,[1])

    async def test_native_flush_tracks_popped_event_until_receipt(self):
        method=self.method(self.adapter_path,'_flush_buffered')
        unit=ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[]))
        scope={'asyncio':asyncio};exec(compile(unit,str(self.adapter_path),'exec'),scope)
        started,finish=asyncio.Event(),asyncio.Event()
        async def handle(value): started.set();await finish.wait()
        async def idle(_): pass
        app=NS(update_processor=NS(wait_for_chat_idle=idle))
        self.adapter._app=app;self.adapter._should_drop_delayed_delivery=lambda:False
        self.adapter._hold_inbound_event=lambda ev,where:self.held.append(ev)
        self.adapter.handle_message=handle
        value=event(B1,1);self.adapter._pending_photo_batches['same']=value
        tasks={}
        task=asyncio.create_task(scope['_flush_buffered'](self.adapter,self.adapter._pending_photo_batches,tasks,'same',0,'photo'))
        tasks['same']=task;self.batch.track(task,value)
        await started.wait()
        self.assertFalse(self.adapter._pending_photo_batches)
        self.assertTrue(self.batch.busy(1001));self.assertFalse(self.batch.busy(1002))
        finish.set();await task
        self.assertFalse(self.batch.busy(1001))

    async def test_cancelled_held_redispatch_stays_unknown_and_never_repeats(self):
        method=self.method(self.held_path,'_redispatch_held_inbound')
        unit=ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),method],type_ignores=[]))
        async def cancel_task(_): pass
        scope={'asyncio':asyncio,'cancel_task':cancel_task,'logger':NS(warning=lambda *a,**k:None,exception=lambda *a,**k:None)}
        exec(compile(unit,str(self.held_path),'exec'),scope)
        started=asyncio.Event();wait=asyncio.Event();first,second=event(B1,1),event(B2,2)
        self.held.extend([first,second])
        async def handle(value): started.set();await wait.wait()
        self.adapter.handle_message=handle
        self.adapter._is_permanent_fatal=lambda:False;self.adapter._should_drop_delayed_delivery=lambda:False
        self.adapter._brai_identity_take_held=self.batch.take_held
        self.adapter._brai_identity_finish_held=self.batch.finish_held
        self.adapter._brai_identity_rehold_held=self.batch.rehold
        self.adapter._brai_identity_can_redispatch=self.batch.can_redispatch
        self.adapter._rehold_from=lambda events,idx,where:self.held.extend(events[idx:])
        self.adapter._schedule_held_inbound_redispatch=lambda:None
        task=asyncio.create_task(scope['_redispatch_held_inbound'](self.adapter))
        await started.wait();task.cancel();await asyncio.gather(task,return_exceptions=True)
        await asyncio.sleep(0)
        self.assertFalse(self.batch.can_redispatch(first))
        self.assertTrue(self.batch.can_redispatch(second))
        self.assertTrue(self.batch.busy(1001));self.assertTrue(self.batch.busy(1002))
        self.mirror.block_event.assert_awaited_once_with(first)

if __name__=='__main__': unittest.main()
