// ABOUTME: Проверяет общий допуск свёртки, ограниченные кадры и отзыв Auth во время вычисления.
// ABOUTME: Запускает только собственные короткие синтетические дочерние процессы.
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('свёртка: один исполнитель, busy и прекращение при отзыве',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 execFileSync('python3',['-B','-c',`
import asyncio, hashlib, json, sys
from unittest.mock import patch
from services.hermes.identity import broker as module
class Writer:
    def __init__(self): self.frames=[]
    def write(self,data): self.frames.append(json.loads(data))
    async def drain(self): await asyncio.sleep(0)
class Control:
    enabled=True
    async def call(self,method,params,timeout=3):
        if not self.enabled: raise ConnectionError('Auth unavailable')
        return {'userId':'account-a','profileId':'profile-a','role':'user','generation':0}
program="""import sys,json,hashlib,time
for line in sys.stdin:
 p=json.loads(line)
 if p.get('end'):break
time.sleep(0.1)
text='Полная сводка 37 🧠'
print(json.dumps({'status':'chunk','offset':0,'text':text}),flush=True)
print(json.dumps({'status':'completed','totalBytes':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest()}),flush=True)
"""
async def check():
    control=Control()
    b=module.Broker({'registryPath':'unused','ingressUid':999,'dialoguesServicesPath':'services',
      'dialoguesSummaryConfigPath':'summary','dialoguesSummaryCommand':[sys.executable,'-u','-c',program]},control)
    b.profiles=lambda:{20001:{'userId':'account-a','profileId':'profile-a','status':'active'}}
    services={'version':1,'services':{'30001':{'workerUid':20001,'userId':'account-a','profileId':'profile-a'}}}
    def registry(path): return services if path=='services' else {}
    def reader():
        value=asyncio.StreamReader()
        value.feed_data((json.dumps({'id':'call','text':'original'})+'\\n'+json.dumps({'id':'call','end':True})+'\\n').encode())
        value.feed_eof()
        return value
    header={'jsonrpc':'2.0','id':'call','method':'dialogues.summarize-stream','params':{}}
    with patch.object(module,'protected_json',side_effect=registry):
        target=Writer()
        await b.stream_dialogues_summary(30001,header,reader(),target)
        assert [f['result']['status'] for f in target.frames]==['ready','chunk','completed']
        await b.summary_lock.acquire()
        try:
            busy=Writer()
            await b.stream_dialogues_summary(30001,header,reader(),busy)
            assert busy.frames[0]['result']=={'status':'busy'}
        finally:b.summary_lock.release()
        target=Writer()
        task=asyncio.create_task(b.stream_dialogues_summary(30001,header,reader(),target))
        while not target.frames:await asyncio.sleep(0)
        control.enabled=False
        try:await task
        except ConnectionError:pass
        else:raise AssertionError('Revoked summary escaped')
        assert not any(f['result']['status']=='chunk' for f in target.frames)
        assert not b.summary_lock.locked()
asyncio.run(check())
`],{cwd:root,stdio:'pipe',timeout:15000});
});
