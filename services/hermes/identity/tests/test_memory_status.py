# ABOUTME: Проверяет личный scheduler status без сервера и пользовательских данных.
# ABOUTME: Подделки области, расширенные DTO и oversized ответы отвергаются.
import ast
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

def load(name, path, package=None):
    module=types.ModuleType(name); module.__file__=str(path)
    module.__package__=package
    exec(compile(path.read_text(),str(path),'exec'),module.__dict__)
    return module

gateway=load('services.hermes.identity.memory_gateway_candidate',ROOT/'services/hermes/identity/memory_gateway.py','services.hermes.identity')
client=load('memory_status_client_candidate',ROOT/'services/hermes/extensions/plugins/memos-rest/client.py')
helper=load('memory_status_helper_candidate',ROOT/'services/hermes/extensions/skill-scripts/note-taking/memos-memory/scripts/memos_client.py')
P={'userId':'owner-a','profileId':'profile-a','status':'active','cubes':['main']}
class Fake:
    calls=[]
    result={'code':200,'message':'Memory get status successfully','data':[{'task_id':'task-own','status':'completed'}]}
    def __init__(self, config): self.config=config
    def request(self,path,body=None,**kwargs):
        self.calls.append((self.config,path,body,kwargs))
        return copy.deepcopy(self.result)

class StatusTest(unittest.TestCase):
    def setUp(self):
        Fake.calls=[]; Fake.result={'code':200,'message':'ok','data':[{'task_id':'task-own','status':'completed'}]}
        self.allowed=True
        self.boundary=gateway.Boundary('/unused','http://127.0.0.1:1',authorize=lambda *a:self.allowed,
            cursor_key=b'x'*32,registry_loader=lambda p:{21001:P},clients=Fake)
    def call(self,path='/product/scheduler/status',body=None,method='GET'):
        return self.boundary.handle(21001,method,path,{} if body is None else body)
    def test_forced_owner_closed_query_and_limits_before_backend(self):
        for path,body,method in [
            ('/product/scheduler/status?user_id=other',{},'GET'),
            ('/product/scheduler/status?user_id=owner-a&user_id=other',{},'GET'),
            ('/product/scheduler/status?task_id=one&task_id=two',{},'GET'),
            ('/product/scheduler/status?all=true',{},'GET'),
            ('/product/scheduler/status?task_id='+('a'*257),{},'GET'),
            ('/product/scheduler/status?task_id=%0A',{},'GET'),
            ('/product/scheduler/status#secret',{},'GET'),
            ('/product/scheduler/status',{'user_id':'other'},'GET'),
            ('/product/scheduler/status',{'task_id':'x'},'GET'),
            ('/product/scheduler/status',{},'POST'),
            ('/product/scheduler/allstatus',{},'GET'),
            ('/product/scheduler/task_queue_status',{},'GET'),
        ]:
            with self.subTest(path=path,body=body,method=method):
                with self.assertRaises(gateway.Denied): self.call(path,body,method)
                self.assertEqual(Fake.calls,[])
        self.allowed=False
        with self.assertRaises(gateway.Denied): self.call()
        self.assertEqual(Fake.calls,[])
    def test_scoped_status_only_ids_and_states_no_global_metrics(self):
        result=self.call('/product/scheduler/status?user_id=owner-a&task_id=task-own')
        self.assertEqual(result['data'],[{'task_id':'task-own','status':'completed'}])
        config,path,body,kwargs=Fake.calls[0]
        self.assertEqual(config['user_id'],'owner-a')
        self.assertEqual(path,'/product/scheduler/status?user_id=owner-a&task_id=task-own')
        self.assertIsNone(body)
        self.assertEqual(kwargs,{'timeout':10,'max_response_bytes':262144})
        self.assertEqual(result['message'],'Memory get status successfully')
    def test_rejects_invalid_or_overbroad_upstream_without_partial_results(self):
        good=copy.deepcopy(Fake.result)
        for value in [
            {'code':200,'message':'ok','data':[],'global_queue':1},
            {'code':200,'message':'ok','data':[{'task_id':'task-own','status':'completed','text':'private'}]},
            {'code':200,'message':'ok','data':[{'task_id':'other-task','status':'completed'}]},
            {'code':200,'message':'ok','data':[{'task_id':'task-own','status':'unknown'}]},
            {'code':200,'message':'ok','data':good['data']*2},
            {'code':200,'message':'ok','data':good['data']*1001},
        ]:
            Fake.result=value
            with self.subTest(value=str(value)[:100]):
                with self.assertRaises(gateway.Denied): self.call('/product/scheduler/status?task_id=task-own')
    def test_more_than_thousand_owned_tasks_fit_without_count_truncation(self):
        Fake.result['data']=[{'task_id':'task-'+str(i),'status':'completed'} for i in range(1001)]
        self.assertLess(len(json.dumps(Fake.result).encode()),262144)
        self.assertEqual(self.call()['data'],Fake.result['data'])
    def test_helper_uses_owner_config_and_bounded_sdk(self):
        args=types.SimpleNamespace(command='status',base_url=None,user=None,cube=None,timeout=30,task_id='task-own')
        config={'user_id':'owner-a','cube_id':'main'}
        Fake.calls=[]
        with patch.object(helper,'worker_client',lambda value:Fake({'user_id':value['user_id']})):
            helper.private_request(args,config)
        self.assertEqual(args.user,'owner-a')
        self.assertEqual(Fake.calls[0][1],'/product/scheduler/status?user_id=owner-a&task_id=task-own')
        self.assertEqual(Fake.calls[0][3],{'timeout':10,'max_response_bytes':262144})
        args.user='other'
        with self.assertRaisesRegex(ValueError,'SCOPE_OVERRIDE'): helper.private_request(args,config)
    def test_sdk_reads_one_bounded_buffer_and_never_retries(self):
        api=client.Client({'base_url':'http://127.0.0.1:1','user_id':'owner-a','cube_id':'main'})
        class Response(io.BytesIO):
            def __exit__(self,*a): self.close()
        class Opener:
            calls=0
            def open(self,*a,**kw):
                self.calls+=1
                return Response(b'x'*33)
        api.opener=Opener()
        with self.assertRaisesRegex(client.MemOSError,'too large'):
            api.request('/product/scheduler/status?user_id=owner-a',max_response_bytes=32)
        self.assertEqual(api.opener.calls,1)
        for invalid in [True,0,-1,1048577]:
            with self.assertRaises(ValueError): api.request('/health',max_response_bytes=invalid)
        self.assertEqual(api.opener.calls,1)

if __name__=='__main__': unittest.main()
