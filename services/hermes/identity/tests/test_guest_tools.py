# ABOUTME: Проверяет разрешённые действия гостя и опасные аргументы до эффекта.
# ABOUTME: Использует настоящую политику аргументов и синтетический native executor.
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'services/hermes'))
from identity import guest_tools


class ArgumentsTests(unittest.TestCase):
    def test_supported_requests(self):
        cases=[('web_search',{'query':'погода','limit':5}),
          ('image_generate',{'prompt':'море','aspect_ratio':'square'}),
          ('text_to_speech',{'text':'Привет','speed':1}),
          ('browser_navigate',{'url':'https://example.com/a?q=1'}),
          ('browser_click',{'ref':'@e10'}),('browser_type',{'ref':'e2','text':'текст'}),
          ('browser_press',{'key':'Enter'}),('browser_snapshot',{'full':True}),
          ('browser_back',{}),('browser_get_images',{}),
          ('browser_dialog',{'action':'dismiss'}),('browser_vision',{'question':'Что на странице?'})]
        for name,args in cases:
            with self.subTest(name=name):self.assertTrue(guest_tools.validate(name,args))

    def test_paths_execution_overrides_and_invalid_types(self):
        cases=[('web_search',{'query':'x','base_url':'http://localhost'}),
          ('web_search',{'query':'x','limit':True}),('web_search',{'query':'x','limit':21}),
          ('image_generate',{'prompt':'x','image_url':'/etc/passwd'}),
          ('image_generate',{'prompt':'x','reference_image_urls':['file:///etc/passwd']}),
          ('image_generate',{'prompt':'x','output_path':'/tmp/a'}),
          ('text_to_speech',{'text':'x','output_path':'/tmp/a'}),
          ('text_to_speech',{'text':'x'*901}),('text_to_speech',{'text':'x','speed':float('nan')}),
          ('browser_click',{'ref':'--eval=evil'}),('browser_click',{'ref':'#selector'}),
          ('browser_type',{'ref':'e1','text':'x','file':'/etc/passwd'}),
          ('browser_press',{'key':'Control+o'}),('browser_snapshot',{'full':'yes'}),
          ('browser_vision',{'question':'x','output_path':'/tmp/a'}),
          ('browser_dialog',{'action':'accept','dialog_id':'--eval'})]
        for name,args in cases:
            with self.subTest(name=name,args=args):self.assertFalse(guest_tools.validate(name,args))

    def test_internal_urls_and_unsupported_schemes(self):
        for url in ['file:///etc/passwd','javascript:alert(1)','data:text/plain,x',
          'http://localhost','http://localhost.','http://a.localhost','http://x.internal',
          'http://127.0.0.1:19364','http://[::1]/','http://169.254.169.254/',
          'http://10.0.0.1/','https://user:pass@example.com','http://example.com:0/',
          'https://example.com/\\x','https://example.com/\n']:
            with self.subTest(url=url):self.assertFalse(guest_tools.validate('browser_navigate',{'url':url}))

    def test_catalog_does_not_expose_forbidden_parameters(self):
        rows=[{'name':'image_generate','parameters':{'properties':{'prompt':{'type':'string'},'image_url':{'type':'string'}}}},
              {'type':'function','function':{'name':'text_to_speech','parameters':{'properties':{'text':{},'output_path':{}}}}}]
        safe=guest_tools.definitions(rows)
        self.assertEqual(set(safe[0]['parameters']['properties']),{'prompt'})
        self.assertEqual(set(safe[1]['function']['parameters']['properties']),{'text'})
        self.assertIn('image_url',rows[0]['parameters']['properties'])

    def test_modified_arguments_are_denied_immediately_before_callback(self):
        effects=[]
        agent=ModuleType('agent');agent.__path__=[]
        common=ModuleType('agent.tool_executor')
        direct=ModuleType('agent.agent_runtime_helpers')
        inline=ModuleType('agent.inline_tool_executors')
        def dispatch(agent,state,ref,**kwargs):
            ref.args={'prompt':'x','image_url':'/etc/passwd'}
            return kwargs['execute'](ref.args)
        common._dispatch_authorized_once=dispatch
        direct.invoke_tool=lambda *a,**k:effects.append('direct')
        direct.repair_tool_call=lambda *a:None
        inline.resolve_invoke_tool_executor=lambda *a:None
        package=ModuleType('identity');package.__path__=[]
        client=ModuleType('identity.tool_client')
        client.broker_call=lambda method,params:({'allowed':True,'role':'guest','generation':1}
            if method=='native.authorize' else {'role':'guest','generation':1})
        with patch.dict(sys.modules,{'agent':agent,'agent.tool_executor':common,
            'agent.agent_runtime_helpers':direct,'agent.inline_tool_executors':inline,
            'identity':package,'identity.tool_client':client,'identity.guest_tools':guest_tools}):
            spec=importlib.util.spec_from_file_location('identity.native_policy',ROOT/'services/hermes/identity/native_policy.py')
            policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
            policy.install_executor_guard()
            state=SimpleNamespace(blocked=False)
            result=common._dispatch_authorized_once(None,state,
              SimpleNamespace(name='image_generate',args={'prompt':'x'}),
              execute=lambda args:effects.append(args),scope_block=None,display_index=0,
              begin_execution=None,authorization_gate=None)
        self.assertIn('error',json.loads(result))
        self.assertTrue(state.blocked);self.assertEqual(effects,[])
