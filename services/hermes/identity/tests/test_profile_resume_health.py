# ABOUTME: Checks cold resume waits for the exact worker's policy-ready primary channel.
# ABOUTME: Uses synthetic RPCs and a fake journal, with no Telegram or live process.
import asyncio
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, patch
from services.hermes.identity.profile_release import ProfileRelease

class ResumeHealth(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.owner=ProfileRelease.__new__(ProfileRelease)
  self.profile={'profileId':'b116dc14-323a-47dc-b4de-ed282d5c5870','userId':'owner','uid':123}
  self.request={'operationId':'7ac84847-afaa-4c31-8cbd-c05da44043fe','attemptId':'48f65e44-dcbd-4fd7-8b2a-39b525f6ee95','profileId':self.profile['profileId'],'targetPayloadHash':'a'*64,'workerPid':111,'workerStartTime':'100'}
  self.owner.boot='boot';self.events=[]
  self.owner.mirror=SimpleNamespace(hydrated=True,pending=False,tracker=SimpleNamespace(gates={123:self.request['operationId']},tickets={},counts={}),
   transport_blocked=set(),inbox=SimpleNamespace(unsettled=lambda profile:[]),transport=None)
  self.owner._profile=AsyncMock(return_value=self.profile)
  self.owner.store=SimpleNamespace(status=lambda *args:{'state':'ready'},transition=lambda *args,**kwargs:self.events.append('journal-resuming'))
  self.owner._reopen=AsyncMock(side_effect=lambda *args:self.events.append('reopened'))
  async def inline(function,*args,**kwargs):return function(*args,**kwargs)
  scope=patch('services.hermes.identity.profile_release.asyncio.to_thread',side_effect=inline);scope.start();self.addCleanup(scope.stop)
 async def test_health_and_policy_precede_resume_without_opening_gate(self):
  entered=asyncio.Event();policy=asyncio.Event()
  async def call(method,params,**kwargs):
   self.events.append(method)
   if method=='health':
    entered.set();return {'userId':'owner','ready':True,'operational':True,'policyReady':policy.is_set()}
   return {'operationId':self.request['operationId'],'state':'resumed'}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  task=asyncio.create_task(self.owner._resume(self.request,222,'200'))
  await entered.wait();self.assertNotIn('release.resume',self.events);self.assertNotIn('reopened',self.events)
  policy.set();result=await task
  self.assertEqual(result['state'],'resumed')
  self.assertLess(self.events.index('health'),self.events.index('release.resume'))
  self.assertEqual(self.owner._peer.await_count,2)
 async def test_missing_policy_status_fails_closed(self):
  async def call(method,params,**kwargs):return {'userId':'owner','ready':True,'operational':True}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner._resume(self.request,222,'200')
  self.assertEqual(result['state'],'blocked');self.owner._reopen.assert_not_awaited()
 async def test_wrong_health_identity_does_not_open_gate(self):
  async def call(method,params,**kwargs):return {'userId':'other','ready':True,'operational':True,'policyReady':True}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner._resume(self.request,222,'200')
  self.assertEqual(result['state'],'blocked');self.owner._reopen.assert_not_awaited()
 async def test_status_accepts_exact_cold_replacement_when_old_is_gone(self):
  calls=[]
  async def peer(profile,pid,start):
   calls.append((pid,start))
   if (pid,start)!=(222,'200'):raise PermissionError('old gone')
   async def call(method,params,**kwargs):
    self.assertEqual(method,'release.status')
    return {'operationId':self.request['operationId'],'state':'ready'}
   return SimpleNamespace(call=call)
  self.owner._peer=AsyncMock(side_effect=peer)
  result=await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200')
  self.assertEqual(result['state'],'ready');self.assertEqual(calls,[(222,'200')])
 async def test_status_rejects_wrong_replacement_and_unheld(self):
  self.owner._peer=AsyncMock(side_effect=PermissionError('wrong pid'))
  self.assertEqual((await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200'))['state'],'unknown')
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=AsyncMock(return_value={'operationId':self.request['operationId'],'state':'resumed'})))
  self.assertEqual((await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200'))['state'],'unknown')
 async def test_status_rejects_unknown_inbox_and_durable_or_memory_transport(self):
  self.owner._peer=AsyncMock()
  for mutation in ('inbox','transport','memory'):
   with self.subTest(mutation=mutation):
    self.owner.mirror.inbox.unsettled=lambda profile: ([{'bound':False,'state':'unknown','operationId':self.request['operationId']}] if mutation=='inbox' else [])
    self.owner.mirror.transport=SimpleNamespace(blocked_for=lambda uid:mutation=='transport')
    self.owner.mirror.transport_blocked={123} if mutation=='memory' else set()
    result=await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200')
    self.assertEqual(result['state'],'unknown')
  self.owner._peer.assert_not_awaited()
 async def test_old_ready_status_keeps_attempt_binding(self):
  calls=[]
  async def call(method,params,**kwargs):
   calls.append((method,params))
   return {**params,'state':'ready'}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner.status(**self.request)
  self.assertEqual(result['state'],'ready')
  self.owner._peer.assert_awaited_once_with(self.profile,111,'100')
  self.assertEqual(calls,[('release.try_status',self.request)])
 async def test_unknown_inputs_prevent_resume_before_durable_transition(self):
  self.owner.mirror.inbox.unsettled=lambda profile:[{'bound':False,'state':'unknown','operationId':self.request['operationId']}]
  self.owner._peer=AsyncMock()
  result=await self.owner._resume(self.request,222,'200')
  self.assertEqual(result['state'],'blocked')
  self.owner._peer.assert_not_awaited();self.assertNotIn('journal-resuming',self.events)
 async def test_busy_receipt_rejects_resume_without_worker_effect(self):
  self.owner.store.status=lambda *args:{'state':'busy'}
  self.owner._peer=AsyncMock()
  self.assertEqual((await self.owner._resume(self.request,222,'200'))['state'],'blocked')
  self.owner._peer.assert_not_awaited();self.assertNotIn('journal-resuming',self.events)
 async def test_transport_change_during_health_prevents_worker_resume(self):
  async def call(method,params,**kwargs):
   self.events.append(method)
   if method=='health':
    self.owner.mirror.transport_blocked.add(123)
    return {'userId':'owner','ready':True,'operational':True,'policyReady':True}
   raise AssertionError('unexpected worker resume')
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner._resume(self.request,222,'200')
  self.assertEqual(result['state'],'blocked');self.assertNotIn('release.resume',self.events)
  self.owner._reopen.assert_not_awaited()
 async def test_transport_change_during_ledger_transition_keeps_gate_closed(self):
  import sys
  self.owner._reopen=ProfileRelease._reopen.__get__(self.owner)
  tracker=self.owner.mirror.tracker
  tracker.changed=asyncio.Event();tracker.counts={};tracker.tickets={}
  tracker.resume=lambda uid,op:tracker.gates.pop(uid)
  self.owner.mirror.pending=False;self.owner.mirror.capture_lock=asyncio.Lock()
  self.owner.mirror.inbox.held=lambda profile,op:[]
  self.owner.resolver=SimpleNamespace(batch_ownership=SimpleNamespace(busy=lambda uid:False))
  self.owner.store.transition=lambda *args,**kwargs:self.owner.mirror.transport_blocked.add(123)
  with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
   with self.assertRaisesRegex(ValueError,'GATE_CHANGED'):
    await self.owner._reopen(self.profile,self.request,'resuming','resumed',222,'200')
  self.assertEqual(tracker.gates[123],self.request['operationId'])
 async def test_transition_failure_reinstates_gate_before_other_tasks_run(self):
  import sys
  self.owner._reopen=ProfileRelease._reopen.__get__(self.owner)
  tracker=self.owner.mirror.tracker
  tracker.changed=asyncio.Event();tracker.resume=lambda uid,op:tracker.gates.pop(uid)
  self.owner.mirror.capture_lock=asyncio.Lock()
  self.owner.mirror.inbox.held=lambda profile,op:[]
  self.owner.resolver=SimpleNamespace(batch_ownership=SimpleNamespace(busy=lambda uid:False))
  def fail(*args,**kwargs):raise OSError('synthetic commit failure')
  self.owner.store.transition=fail
  with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
   with self.assertRaisesRegex(OSError,'commit failure'):
    await self.owner._reopen(self.profile,self.request,'resuming','resumed',222,'200')
  self.assertEqual(tracker.gates[123],self.request['operationId'])
 async def test_resuming_status_binds_replacement_and_reconciles_worker_outcome(self):
  self.owner.store.status=lambda *args:{'state':'resuming','replacement_pid':222,'replacement_start':'200'}
  reply={'state':'ready','operationId':self.request['operationId']}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=AsyncMock(side_effect=lambda *a,**k:dict(reply))))
  self.assertEqual((await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200'))['state'],'ready')
  reply['state']='resumed'
  value=await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200')
  self.assertEqual((value['state'],value['reason']),('pending','ingress_completion'))
  self.assertEqual((await self.owner.status(**self.request,replacementPid=333,replacementStartTime='300'))['state'],'unknown')
  self.owner.store.status=lambda *args:{'state':'resuming','replacement_pid':None,'replacement_start':None}
  self.assertEqual((await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200'))['state'],'unknown')
 async def test_failed_resuming_task_can_be_retried_with_same_binding(self):
  self.owner.tasks={};self.owner.reapers=set();self.owner.task_lock=asyncio.Lock()
  self.owner.store.status=lambda *args:{'state':'resuming','replacement_pid':222,'replacement_start':'200'}
  self.owner._resume=AsyncMock(side_effect=[{'state':'blocked'},{'state':'resumed'}])
  args={**self.request,'replacementPid':222,'replacementStartTime':'200'}
  self.assertEqual((await self.owner.resume(**args))['state'],'blocked')
  key=(self.request['operationId'],self.request['attemptId'],'resume')
  while key in self.owner.tasks:await asyncio.sleep(0)
  self.assertEqual((await self.owner.resume(**args))['state'],'resumed')
  await asyncio.sleep(0)
  if self.owner.reapers:await asyncio.gather(*self.owner.reapers)
 async def test_late_guard_recovery_does_not_repeat_native_resume(self):
  import sys
  self.owner._reopen=ProfileRelease._reopen.__get__(self.owner)
  tracker=self.owner.mirror.tracker
  tracker.changed=asyncio.Event();tracker.counts={};tracker.tickets={}
  tracker.resume=lambda uid,op:tracker.gates.pop(uid)
  self.owner.mirror.pending=False;self.owner.mirror.capture_lock=asyncio.Lock()
  self.owner.mirror.inbox.held=lambda profile,op:[]
  self.owner.resolver=SimpleNamespace(batch_ownership=SimpleNamespace(busy=lambda uid:False))
  row={'state':'ready'};methods=[]
  self.owner.store.status=lambda *args:dict(row)
  def transition(profile,request,boot,expected,target,**kwargs):
   self.assertEqual(row['state'],expected);row['state']=target
   if target=='resumed':
    row.update(replacement_pid=kwargs['replacement_pid'],replacement_start=kwargs['replacement_start'])
    self.owner.mirror.transport_blocked.add(123)
  self.owner.store.transition=transition
  async def call(method,params,**kwargs):
   methods.append(method)
   if method=='health':return {'userId':'owner','ready':True,'operational':True,'policyReady':True}
   return {'operationId':self.request['operationId'],'state':'resumed'}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
   self.assertEqual((await self.owner._resume(self.request,222,'200'))['state'],'blocked')
   self.assertEqual(row['state'],'resumed');self.assertIn(123,tracker.gates)
   self.owner.mirror.transport_blocked.clear()
   self.assertEqual((await self.owner._resume(self.request,222,'200'))['state'],'resumed')
  self.assertNotIn(123,tracker.gates);self.assertEqual(methods.count('release.resume'),1)
  self.assertEqual(methods.count('release.status'),1)
 async def test_status_exposes_only_exact_resumed_ingress_completion(self):
  self.owner.store.status=lambda *args:{'state':'resumed','replacement_pid':222,'replacement_start':'200'}
  calls=[]
  async def call(method,params,**kwargs):
   calls.append(method);return {'state':'resumed','operationId':self.request['operationId']}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200')
  self.assertEqual((result['state'],result['reason'],result['replacementPid'],result['replacementStartTime']),
                   ('pending','ingress_completion',222,'200'))
  self.assertEqual(calls,['release.status'])
  self.assertEqual((await self.owner.status(**self.request,replacementPid=333,replacementStartTime='300'))['reason'],'replacement_changed')
  self.owner.mirror.transport_blocked.add(123)
  self.assertEqual((await self.owner.status(**self.request,replacementPid=222,replacementStartTime='200'))['state'],'unknown')
 async def test_resumed_recovery_rejects_wrong_replacement_or_foreign_gate(self):
  self.owner.store.status=lambda *args:{'state':'resumed','replacement_pid':222,'replacement_start':'200'}
  self.owner._peer=AsyncMock()
  self.assertEqual((await self.owner._resume(self.request,333,'300'))['state'],'blocked')
  self.owner._peer.assert_not_awaited()
  self.owner.mirror.tracker.gates[123]='another-operation'
  self.assertEqual((await self.owner._resume(self.request,222,'200'))['state'],'unknown')
  self.assertEqual(self.owner.mirror.tracker.gates[123],'another-operation')
  self.owner._peer.assert_not_awaited()
class DurableResume(unittest.IsolatedAsyncioTestCase):
 async def test_lost_worker_response_completes_same_attempt(self):
  import sys
  from services.hermes.identity.chat_journal import IdentityJournal
  from services.hermes.identity.ordinary_admission import Mirror
  from services.hermes.identity.update_inbox import UpdateInbox, ProfileGateStore
  async def inline(function,*args,**kwargs):return function(*args,**kwargs)
  with tempfile.TemporaryDirectory() as directory, patch('asyncio.to_thread',side_effect=inline), \
       patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
   profile={'profileId':str(uuid.uuid4()),'userId':'owner','uid':123}
   boot=str(uuid.uuid4());op=str(uuid.uuid4())
   request={'operationId':op,'attemptId':str(uuid.uuid4()),'profileId':profile['profileId'],
            'targetPayloadHash':'a'*64,'workerPid':111,'workerStartTime':'100'}
   inbox=UpdateInbox(IdentityJournal(Path(directory)));store=ProfileGateStore(inbox)
   store.begin(profile,request,boot);store.transition(profile,request,boot,'arming','ready')
   async def inventory():return {'profiles':[profile]}
   mirror=Mirror(inbox,None,inventory=inventory,gate_store=store,boot_id=boot)
   mirror.hydrated=True;mirror.tracker.gates[123]=op
   owner=ProfileRelease(SimpleNamespace(mirror=mirror,batch_ownership=SimpleNamespace(busy=lambda uid:False)),SimpleNamespace())
   owner.boot=boot
   state={'resumed':False,'calls':0}
   async def call(method,params,**kwargs):
    if method=='health':return {'userId':'owner','ready':True,'operational':True,'policyReady':True}
    if method=='release.status':return {'operationId':op,'state':'resumed' if state['resumed'] else 'ready'}
    state['calls']+=1
    if not state['resumed']:
     state['resumed']=True
     raise ConnectionError('lost response')
    return {'operationId':op,'state':'resumed'}
   owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
   self.assertEqual((await owner._resume(request,222,'200'))['state'],'blocked')
   self.assertEqual(store.status(profile,request,boot)['state'],'resuming')
   self.assertEqual((await owner.status(**request,replacementPid=222,replacementStartTime='200'))['reason'],'ingress_completion')
   self.assertEqual((await owner._resume(request,222,'200'))['state'],'resumed')
   self.assertNotIn(123,mirror.tracker.gates)
   self.assertEqual(store.status(profile,request,boot)['state'],'resumed')
   self.assertEqual(state['calls'],2)
 async def test_binding_and_rehydration_after_interrupted_resume(self):
  import sys
  from services.hermes.identity.chat_journal import IdentityJournal
  from services.hermes.identity.ordinary_admission import Mirror
  from services.hermes.identity.update_inbox import UpdateInbox, ProfileGateStore
  async def inline(function,*args,**kwargs):return function(*args,**kwargs)
  scope=patch('asyncio.to_thread',side_effect=inline);scope.start();self.addCleanup(scope.stop)
  with tempfile.TemporaryDirectory() as directory:
   profile={'profileId':str(uuid.uuid4()),'userId':'owner','uid':123}
   boot=str(uuid.uuid4());op=str(uuid.uuid4())
   request={'operationId':op,'attemptId':str(uuid.uuid4()),'profileId':profile['profileId'],
            'targetPayloadHash':'a'*64,'workerPid':111,'workerStartTime':'100'}
   inbox=UpdateInbox(IdentityJournal(Path(directory)))
   store=ProfileGateStore(inbox)
   store.begin(profile,request,boot);store.transition(profile,request,boot,'arming','ready')
   store.transition(profile,request,boot,'ready','resuming',replacement_pid=222,replacement_start='200')
   row=store.status(profile,request,boot)
   self.assertEqual((row['state'],row['replacement_pid'],row['replacement_start']),('resuming',222,'200'))
   with self.assertRaisesRegex(ValueError,'REPLACEMENT_CHANGED'):
    store.transition(profile,request,boot,'resuming','resumed',replacement_pid=333,replacement_start='300')
   async def inventory():return {'profiles':[profile],'allProfileIds':[profile['profileId']]}
   async def observe(_):return (222,'200')
   async def resolve(_):return {'state':'unknown'}
   transport=SimpleNamespace(pending=lambda:[],blocked_for=lambda uid:True)
   mirror=Mirror(inbox,resolve,inventory=inventory,observe=observe,gate_store=store,boot_id=boot,transport=transport)
   mirror.app=SimpleNamespace(bot=SimpleNamespace(id=123))
   with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
    await mirror.hydrate()
   self.assertEqual(mirror.tracker.gates[123],op)
   store.transition(profile,request,boot,'resuming','resumed',replacement_pid=222,replacement_start='200')
   mirror=Mirror(inbox,resolve,inventory=inventory,observe=observe,gate_store=store,boot_id=boot,transport=transport)
   mirror.app=SimpleNamespace(bot=SimpleNamespace(id=123))
   with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
    await mirror.hydrate()
   self.assertEqual(mirror.tracker.gates[123],op)
   transport.blocked_for=lambda uid:False
   unknown={'state':'unknown','bound':True,'operationId':op,'botId':'123','updateId':'1'}
   with patch.object(inbox,'unsettled',return_value=[unknown]):
    mirror=Mirror(inbox,resolve,inventory=inventory,observe=observe,gate_store=store,boot_id=boot,transport=transport)
    mirror.app=SimpleNamespace(bot=SimpleNamespace(id=123))
    with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
     await mirror.hydrate()
    self.assertEqual(mirror.tracker.gates[123],op)
   mirror=Mirror(inbox,resolve,inventory=inventory,observe=observe,gate_store=store,boot_id=boot,transport=transport)
   mirror.app=SimpleNamespace(bot=SimpleNamespace(id=123))
   with patch.dict(sys.modules,{'telegram':SimpleNamespace(Update=object)}):
    await mirror.hydrate()
   self.assertNotIn(123,mirror.tracker.gates)
if __name__=='__main__':unittest.main()
