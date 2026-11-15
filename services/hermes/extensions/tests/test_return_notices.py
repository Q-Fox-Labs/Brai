# ABOUTME: Проверяет постоянные отказы, поколения и сроки повторов return notices.
# ABOUTME: Исполняет точный модуль из overlay; транспорт и атомарная запись заменены тестовыми портами.
import contextlib
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
PATCH = ROOT/'services/hermes/extensions/patches/hermes-core.patch'


def module_source():
    """Прочитать полный создаваемый native модуль из существующего patch."""
    raw = PATCH.read_text()
    header = 'diff --git a/gateway/return_notices.py b/gateway/return_notices.py\n'
    section = raw[raw.index(header)+len(header):].split('diff --git ',1)[0]
    return '\n'.join(line[1:] for line in section.splitlines()
        if line.startswith('+') and not line.startswith('+++'))+'\n'


class ReturnNoticeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'tmp')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'pending.json'
        utils = NS(atomic_json_write=lambda path,data,**_:path.write_text(json.dumps(data)))
        module = ModuleType('candidate_return_notices')
        with patch.dict(sys.modules, {'utils':utils}):
            exec(compile(module_source(),str(PATCH),'exec'),module.__dict__)
        self.module = module
        self.sent = []
        self.outcomes = {}
        async def send(platform,chat,text,metadata=None):
            self.sent.append((chat,metadata))
            value = self.outcomes.get(chat,NS(success=True))
            return await value() if callable(value) else value
        transport = NS(adapter=object(),send=send)
        self.ports = patch.dict(sys.modules,{
            'agent.i18n':NS(t=lambda key:'Brai онлайн'),
            'gateway.config':NS(Platform=lambda value:value),
            'gateway.run_notifications':NS(_safe_delivery_transport=lambda *_,**kw:transport),
            'gateway.run_shutdown':NS(_send_failed=lambda result:not result.success),
            'gateway.run':NS(_async_profile_runtime_scope=lambda _:contextlib.nullcontext(),
                _interim_metadata=lambda value:value,
                _non_conversational_metadata=lambda value,**_:value)})
        self.ports.start()
        self.addCleanup(self.ports.stop)
        self.runner = module.GatewayReturnNoticesMixin()
        self.runner.config = object()
        self.runner._adapters_for_profile = lambda _: {}
        self.runner._thread_metadata_for_target = lambda platform,chat,thread,**_: {'thread_id':thread}
        self.states = {}
        self.runner._brai_return_notice_state = lambda chat,thread:self.states.get(chat,
            {'generation':2,'paused':False})

    def save(self, *rows):
        self.path.write_text(json.dumps({'recipients':[dict(platform='telegram',chat_id=chat,
            thread_id='77',profile=None,notice_id=chat,generation=generation)
            for chat,generation in rows]}))

    async def replay(self):
        await self.runner._replay_return_notices(self.path,self.module.read_return_notices(self.path))

    async def test_paused_stale_and_legacy_cancel_without_blocking_valid_recipient(self):
        self.save(('paused',2),('stale',0),('legacy',None),('valid',2))
        self.states['paused'] = {'generation':2,'paused':True}
        await self.replay()
        self.assertEqual([chat for chat,_ in self.sent],['valid'])
        self.assertEqual(self.sent[0][1]['_brai_return_notice_generation'],2)
        self.assertFalse(self.path.exists())

    async def test_permanent_failure_removed_temporary_failure_retained(self):
        self.save(('permanent',2),('temporary',2))
        self.outcomes = {'permanent':NS(success=False,error_kind='forbidden'),
            'temporary':NS(success=False,error_kind='transient')}
        await self.replay()
        self.assertEqual([r['chat_id'] for r in self.module.read_return_notices(self.path)],['temporary'])

    async def test_retry_after_survives_readback_and_suppresses_early_attempt(self):
        self.save(('limited',2))
        self.outcomes['limited'] = NS(success=False,error_kind='rate_limited',retry_after=120)
        await self.replay()
        target = self.module.read_return_notices(self.path)[0]
        await self.replay()
        self.assertEqual(len(self.sent),1)
        self.outcomes['limited'] = NS(success=True)
        with patch.object(self.module.time,'time',return_value=target['retry_at']+1):
            await self.replay()
        self.assertEqual(len(self.sent),2)
        self.assertFalse(self.path.exists())

    async def test_result_for_old_receipt_cannot_remove_replacement(self):
        self.save(('recipient',2))
        async def replaced():
            self.module.remember_return_notice(self.path,'telegram','recipient','77',generation=2)
            return NS(success=False,error_kind='forbidden')
        self.outcomes['recipient'] = replaced
        await self.replay()
        remaining = self.module.read_return_notices(self.path)
        self.assertEqual(len(remaining),1)
        self.assertNotEqual(remaining[0]['notice_id'],'recipient')

    async def test_unknown_snapshot_waits_without_send_or_deletion(self):
        self.save(('unknown',2))
        self.states['unknown'] = None
        await self.replay()
        self.assertEqual(self.sent,[])
        self.assertEqual(len(self.module.read_return_notices(self.path)),1)

    async def test_native_without_identity_fence_keeps_existing_notice_behavior(self):
        self.save(('legacy',None))
        del self.runner._brai_return_notice_state
        await self.replay()
        self.assertEqual([chat for chat,_ in self.sent],['legacy'])
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
