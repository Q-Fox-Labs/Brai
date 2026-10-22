# ABOUTME: Проверяет реальный private FD bootstrap без модели, сети и native Hermes пакетов.
# ABOUTME: Поддельный plugin/канал и native code tools не получают trusted capability.
import importlib.util,sys,os,socket,threading,tempfile,json,hashlib,types
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tested_bootstrap',ROOT/'codeworks/src/agent-hermes.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class Registry:
    def __init__(self):self.entries={}
    def register(self,**entry):self.entries[entry['name']]=types.SimpleNamespace(**entry)
    def get_entry(self,name):return self.entries.get(name)
    def get_schema(self,name):return self.entries[name].schema
    def dispatch(self,name,args,**kw):return self.entries[name].handler(args,**kw)
r=Registry();registry=types.ModuleType('tools.registry');registry.registry=r
sys.modules['tools']=types.ModuleType('tools');sys.modules['tools.registry']=registry
sets=types.ModuleType('toolsets');sets.create_custom_toolset=lambda *a,**kw:None;sys.modules['toolsets']=sets
agent=types.ModuleType('run_agent')
class AIAgent:
    def __init__(self):pass
agent.AIAgent=AIAgent;sys.modules['run_agent']=agent
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);plugin=root/'plugin.py'
    plugin.write_text("import sys\ndef private():\n return sys.modules['_brai_codeworks_gateway'].call_plugin('actions.read',{},2)\n")
    boot=root/'bootstrap';boot.write_text(json.dumps({'key':'12'*32,'env':{'BOOTSTRAP_TEST':'not-in-argv'},'capability':'secret-cap','plugin':{'path':str(plugin),'sha256':hashlib.sha256(plugin.read_bytes()).hexdigest()},'tools':[{'name':'elements_graph_get','inputSchema':{'type':'object'}}]}))
    client,server=socket.socketpair();requests=[];wrong_id=[False]
    def serve():
        pending=b''
        while True:
            chunk=server.recv(65536)
            if not chunk:break
            pending+=chunk
            while b'\n' in pending:
                line,pending=pending.split(b'\n',1);q=json.loads(line);requests.append(q)
                result={'elements':[]} if q['channel']=='owner' else {'id':q['request']['id'],'result':{'safe':True}}
                server.sendall((json.dumps({'id':'wrong' if wrong_id[0] else q['id'],'result':result})+'\n').encode())
    thread=threading.Thread(target=serve,daemon=True);thread.start()
    # install closes fd3 only; use a stable duplicate outside that reserved slot.
    fd=os.dup(client.fileno());installed=mod.install(boot,fd)
    assert not boot.exists() and os.environ['BOOTSTRAP_TEST']=='not-in-argv'
    assert json.loads(r.dispatch('elements_graph_get',{}))=={'elements':[]}
    for name in ['terminal','python','read_file','actions.complete']:
        assert 'NATIVE_TOOL_DISABLED' in r.dispatch(name,{})
    try:sys.modules['_brai_codeworks_gateway'].call_plugin('actions.complete',{},2)
    except RuntimeError as e:assert str(e)=='TRUSTED_PLUGIN_REQUIRED'
    else:raise AssertionError('forged caller accepted')
    spec=importlib.util.spec_from_file_location('canonical_plugin',plugin);canonical=importlib.util.module_from_spec(spec);spec.loader.exec_module(canonical)
    assert canonical.private()=={'safe':True}
    plugin.write_text(plugin.read_text()+'\n# drift\n')
    try:canonical.private()
    except RuntimeError as e:assert str(e)=='TRUSTED_PLUGIN_REQUIRED'
    else:raise AssertionError('changed plugin accepted')
    assert len(requests)==2 and requests[0]['channel']=='owner' and requests[1]['capability']=='secret-cap'
    native=AIAgent();assert native.valid_tool_names=={'codeworks','elements_graph_get'}
    assert 'actions.complete' not in json.dumps(native.tools) and 'secret-cap' not in json.dumps(native.tools)
    wrong_id[0]=True
    assert json.loads(r.dispatch('elements_graph_get',{}))['error']=='PRIVATE_RESPONSE_REJECTED'
    count=len(requests)
    assert json.loads(r.dispatch('elements_graph_get',{}))['error']=='PRIVATE_CHANNEL_UNAVAILABLE'
    assert len(requests)==count  # Unknown result is fenced, never retried blindly.
print('PASS private Hermes consumed bootstrap, exact owner names, canonical-only trusted capability, drift/native denial')
