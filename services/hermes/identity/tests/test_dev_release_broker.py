# ABOUTME: Checks DEV release authorization and bounded dispatcher on synthetic identities.
# ABOUTME: Does not open a Root dispatcher, service, network or production data.
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from services.hermes.identity.broker import Broker, validate_params
from services.hermes.identity import tool_client
from unittest.mock import patch

ID='7ac84847-afaa-4c31-8cbd-c05da44043fe'
BASE='48f65e44-dcbd-4fd7-8b2a-39b525f6ee95'
SOURCE='a'*40

class BrokerRelease(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  async def run_inline(fn,*args): return fn(*args)
  override=patch.object(asyncio,'to_thread',side_effect=run_inline);override.start();self.addCleanup(override.stop)
  self.config={'registryPath':'/etc/brai-dev/identity/registry.json','ingressUid':995,'stagingRoot':'/unused'}
  self.broker=Broker(self.config,SimpleNamespace())
  self.profile={'userId':'owner','profileId':'profile','role':'admin','generation':1}
  self.broker.authorize=AsyncMock(return_value=self.profile)
  self.calls=[]
  self.broker._dev_gateway=SimpleNamespace(prepare=lambda p:self.calls.append(('prepare',p)) or {'state':'prepared'},
      publish=lambda p:self.calls.append(('publish',p)) or {'state':'queued','requestId':ID},
      status=lambda operation:self.calls.append(('status',operation)) or {'operation':{'releaseId':operation}})
 def request(self):return {'action':'release','requestId':ID,'sourceSha':SOURCE,'expectedBase':BASE}
 async def test_admin_prepare_rechecks_before_publish_and_status(self):
  result=await self.broker.call(1001,'dev.release',self.request())
  self.assertEqual(result['state'],'queued');self.assertEqual([item[0] for item in self.calls],['prepare','publish'])
  self.assertEqual(self.broker.authorize.await_count,3)
  result=await self.broker.call(1001,'dev.release',{'action':'status','operationId':ID})
  self.assertEqual(result['operation']['releaseId'],ID)
 async def test_role_change_during_preparation_cannot_publish(self):
  self.broker.authorize.side_effect=[self.profile,{**self.profile,'role':'user'}]
  with self.assertRaises(PermissionError):await self.broker.call(1001,'dev.release',self.request())
  self.assertEqual([item[0] for item in self.calls],['prepare'])
 async def test_user_and_prod_cannot_access(self):
  self.broker.authorize.return_value={**self.profile,'role':'user'}
  with self.assertRaises(PermissionError):await self.broker.call(1001,'dev.release',self.request())
  self.broker.authorize.return_value=self.profile;self.config['registryPath']='/etc/brai/identity/registry.json'
  with self.assertRaises(PermissionError):await self.broker.call(1001,'dev.release',self.request())
  self.assertEqual(self.calls,[])
 def test_caller_cannot_add_path_or_command(self):
  with self.assertRaises(ValueError):validate_params('dev.release',{**self.request(),'path':'/evil'})

class ToolCatalog(unittest.TestCase):
 def test_only_dev_creator_or_admin_gets_tool(self):
  for role,enabled,expected in [('admin',True,True),('creator',True,True),('user',True,False),('admin',False,False)]:
   with self.subTest(role=role,enabled=enabled),patch.object(tool_client,'broker_call',return_value={'tools':[],'role':role,'devRelease':enabled}):
    names=[row['name'] for row in tool_client.handle('tools/list',{})['tools']]
    self.assertEqual('brai_dev_release' in names,expected)
 def test_tool_forwards_only_bounded_request_without_deadline(self):
  args={'action':'status','operationId':ID}
  with patch.object(tool_client,'broker_call',return_value={'operation':{'releaseId':ID}}) as call:
   tool_client.handle('tools/call',{'name':'brai_dev_release','arguments':args})
  call.assert_called_once_with('dev.release',args,timeout=None)
  with self.assertRaises(ValueError):tool_client.handle('tools/call',{'name':'brai_dev_release','arguments':{**args,'path':'/evil'}})
if __name__=='__main__':unittest.main()
