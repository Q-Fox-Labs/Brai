# ABOUTME: Проверяет native политику hosted Codex за доверенным локальным relay.
# ABOUTME: Использует настоящий код engine на копии, без модели и credential values.
import ast
import ipaddress
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

ENGINE=os.environ.get('BRAI_ROUTE_ENGINE')
ROOT=Path(__file__).resolve().parents[2]


@unittest.skipUnless(ENGINE,'BRAI_ROUTE_ENGINE points to pre-identity native engine')
class NativeProxyPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.root=Path(cls.tmp.name)
        names=('agent/model_metadata.py','agent/codex_responses_adapter.py','hermes_constants.py','agent/chat_completion_helpers.py')
        for name in names:
            dest=cls.root/name;dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(Path(ENGINE)/name,dest)
        subprocess.run(['git','apply','--include=agent/model_metadata.py','--include=agent/codex_responses_adapter.py',
                        '--include=hermes_constants.py',str(ROOT/'identity/native.patch')],cwd=cls.root,check=True,capture_output=True)
        cls.nodes={}
        for name in names:
            for node in ast.parse((cls.root/name).read_text()).body:
                if isinstance(node,ast.FunctionDef):cls.nodes[node.name]=node

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()

    def compile_function(self,name,namespace):
        exec(compile(ast.Module(body=[self.nodes[name]],type_ignores=[]),'<native>', 'exec'),namespace)
        return namespace[name]

    def policies(self):
        utils=types.ModuleType('utils');utils.base_url_hostname=lambda value:urlsplit(value).hostname or ''
        namespace={'Any':object,'ResponsesRouteFlags':types.SimpleNamespace,
                   '_parse_base_url':urlsplit,'_LOCAL_HOSTS':{'127.0.0.1','localhost','::1'},
                   '_CONTAINER_LOCAL_SUFFIXES':('.docker.internal',),'ipaddress':ipaddress,
                   '_TAILSCALE_CGNAT':ipaddress.ip_network('100.64.0.0/10')}
        classify=self.compile_function('classify_responses_route',namespace)
        local=self.compile_function('is_local_endpoint',namespace)
        return utils,classify,local,namespace

    def test_relay_gets_official_codex_watchdogs_without_new_timeout_values(self):
        utils,classify,local,namespace=self.policies()
        namespace.update(_is_openai_codex_backend=lambda agent:classify(agent).is_codex_backend,
            estimate_request_context_tokens=lambda kwargs:99096,_high_effort_silence_floor=lambda agent:0,
            env_float=lambda name,default:default,_NonStreamWatchdogs=types.SimpleNamespace,
            _local_stream_stale_timeout_default=lambda:300,logger=Mock(),os=os)
        self.compile_function('openai_codex_stale_timeout_floor',namespace)
        self.compile_function('_bound_openai_codex_stale_timeout',namespace)
        # Read the upstream constant; the overlay supplies no new resource limit.
        for node in ast.parse((self.root/'agent/chat_completion_helpers.py').read_text()).body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='CODEX_FIRST_PROGRESS_TIMEOUT_SECONDS' for t in node.targets):
                exec(compile(ast.Module(body=[node],type_ignores=[]),'<native>','exec'),namespace)
        namespace['is_local_endpoint']=local
        watchdogs=self.compile_function('_resolve_nonstream_watchdogs',namespace)
        def agent(provider,url):return types.SimpleNamespace(provider=provider,base_url=url,api_mode='codex_responses',_compute_non_stream_stale_timeout=lambda kwargs:30)
        with patch.dict(sys.modules,{'utils':utils}),patch.dict(os.environ,{'BRAI_IDENTITY_MODE':'worker'}):
            relay=agent('custom','http://127.0.0.1:18080/model/v1')
            official=agent('openai-codex','https://chatgpt.com/backend-api/codex')
            self.assertEqual(vars(watchdogs(relay,{})),vars(watchdogs(official,{})))
            self.assertTrue(watchdogs(relay,{}).idle_requires_progress)

    def test_other_routes_and_nonworker_keep_native_classification(self):
        utils,classify,local,_=self.policies()
        with patch.dict(sys.modules,{'utils':utils}),patch.dict(os.environ,{'BRAI_IDENTITY_MODE':'worker'}):
            self.assertTrue(local('http://127.0.0.1:18081/model/v1'))
            self.assertFalse(classify(types.SimpleNamespace(provider='custom',base_url='http://127.0.0.1:18080/model/v1',api_mode='chat_completions')).is_codex_backend)
        with patch.dict(sys.modules,{'utils':utils}),patch.dict(os.environ,{'BRAI_IDENTITY_MODE':''}):
            self.assertTrue(local('http://127.0.0.1:18080/model/v1'))

    def test_directory_policy_keeps_only_exact_operator_home_acl(self):
        permissions=types.ModuleType('identity.permissions')
        permissions.secure_profile_parent=Mock(side_effect=lambda path:path==Path('/profile'))
        identity=types.ModuleType('identity');identity.__path__=[]
        namespace={'Path':Path,'os':os,'get_managed_system':lambda home:None,
                   '_container_or_chmod_skipped':lambda:False,'_chown_to_hermes_uid':Mock()}
        secure=self.compile_function('apply_secure_dir_policy',namespace)
        with patch.dict(sys.modules,{'identity':identity,'identity.permissions':permissions}),patch.dict(os.environ,{'BRAI_IDENTITY_MODE':'worker'}),patch('os.chmod') as chmod:
            secure(Path('/profile'));chmod.assert_not_called()
            secure(Path('/profile/private'));chmod.assert_called_once_with(Path('/profile/private'),0o700)
        self.assertEqual(permissions.secure_profile_parent.call_count,2)


if __name__=='__main__':unittest.main()
