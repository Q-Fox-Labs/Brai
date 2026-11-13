# ABOUTME: Checks cold resume waits for the exact worker's policy-ready primary channel.
# ABOUTME: Uses synthetic RPCs and a fake journal, with no Telegram or live process.
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from services.hermes.identity.profile_release import ProfileRelease

class ResumeHealth(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.owner=ProfileRelease.__new__(ProfileRelease)
  self.profile={'profileId':'b116dc14-323a-47dc-b4de-ed282d5c5870','userId':'owner','uid':123}
  self.request={'operationId':'7ac84847-afaa-4c31-8cbd-c05da44043fe','attemptId':'48f65e44-dcbd-4fd7-8b2a-39b525f6ee95','profileId':self.profile['profileId'],'targetPayloadHash':'a'*64,'workerPid':111,'workerStartTime':'100'}
  self.owner.boot='boot';self.events=[]
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
 async def test_wrong_health_identity_does_not_open_gate(self):
  async def call(method,params,**kwargs):return {'userId':'other','ready':True,'operational':True,'policyReady':True}
  self.owner._peer=AsyncMock(return_value=SimpleNamespace(call=call))
  result=await self.owner._resume(self.request,222,'200')
  self.assertEqual(result['state'],'blocked');self.owner._reopen.assert_not_awaited()
if __name__=='__main__':unittest.main()
