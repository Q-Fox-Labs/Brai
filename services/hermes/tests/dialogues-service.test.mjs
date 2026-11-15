// ABOUTME: Проверяет служебную авторизацию обработчика Диалогов без реальных профилей.
// ABOUTME: UID берётся аргументом серверного обработчика; клиент не задаёт владельца.
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Dialogues: служебный UID, неизменная привязка и отказ Auth',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 execFileSync('python3',['-B','-c',`
import asyncio
from unittest.mock import patch
from services.hermes.identity import broker as module
class Control:
    enabled=True
    async def call(self, method, params, timeout=3):
        assert method=='authorize' and params=={'uid':20001}
        if not self.enabled: raise ConnectionError('synthetic Auth unavailable')
        return {'userId':'a','profileId':'p','role':'user','generation':0}
async def check():
    c=Control()
    b=module.Broker({'registryPath':'unused','ingressUid':999,'dialoguesServicesPath':'protected'},c)
    profile={'userId':'a','profileId':'p','status':'active'}
    b.profiles=lambda:{20001:profile}
    entry={'workerUid':20001,'userId':'a','profileId':'p'}
    registry={'version':1,'services':{'30001':entry}}
    with patch.object(module,'protected_json',return_value=registry):
        assert await b.call(30001,'dialogues.authorize',{})=={'userId':'a','profileId':'p'}
        for uid,args in [(0,{}),(20001,{}),(30002,{}),(30001,{'userId':'b'}),(30001,{'workerUid':20001})]:
            try: await b.call(uid,'dialogues.authorize',args)
            except (PermissionError,ValueError): pass
            else: raise AssertionError('forged service was authorized')
        entry['profileId']='different'
        try: await b.call(30001,'dialogues.authorize',{})
        except PermissionError: pass
        else: raise AssertionError('profile mismatch')
        entry['profileId']='p'
        profile['status']='blocked'
        try: await b.call(30001,'dialogues.authorize',{})
        except PermissionError: pass
        else: raise AssertionError('blocked profile')
        profile['status']='active';c.enabled=False
        try: await b.call(30001,'dialogues.authorize',{})
        except ConnectionError: pass
        else: raise AssertionError('Auth failure opened access')
asyncio.run(check())
`],{cwd:root,stdio:'pipe'});
});
