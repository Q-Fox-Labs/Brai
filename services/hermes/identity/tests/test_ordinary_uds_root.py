# ABOUTME: Проверяет Root-only ingress UDS и kernel peer binding двух synthetic процессов.
# ABOUTME: Требует root в изолированном fixture; не использует DEV UID, процессы и данные.
import asyncio
import json
import multiprocessing
import os
from pathlib import Path
import socket
import tempfile
import unittest
import uuid
from types import SimpleNamespace

from identity.chat_journal import IdentityJournal
from identity.ingress import Bridge, serve_chat_control
from identity.ipc import Peer
from identity.ordinary_admission import Mirror
from identity.profile_release import ProfileRelease
from identity.update_inbox import ProfileGateStore, UpdateInbox


def synthetic_worker(path, control):
    os.setgroups([]);os.setgid(65534);os.setuid(65534)
    async def main():
        state={'effect':0}
        async def release_try(**params):
            return {**params,'state':'ready'}
        async def release_status(**params):
            return {**params,'state':'ready'}
        async def health(require_tools=False):
            return {'userId':'synthetic','ready':True,'operational':True,'policyReady':True}
        async def release_resume(operationId):
            state['effect']+=1
            control.send(('effect',state['effect']))
            if state['effect'] == 1:
                await asyncio.to_thread(control.recv)
            return {'operationId':operationId,'state':'resumed'}
        async def serve(reader,writer):
            try:
                await Peer(reader,writer,{'release.try':release_try,'release.try_status':release_status,
                                         'release.resume':release_resume, 'health':health}).run()
            finally:
                writer.close();await writer.wait_closed()
        server=await asyncio.start_unix_server(serve,path=path)
        control.send(('ready',os.getpid()))
        async with server:
            await server.serve_forever()
    asyncio.run(main())


def foreign_client(path, result_fd):
    os.setgroups([]);os.setgid(65534);os.setuid(65534)
    try:
        client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        client.connect(path)
        try:
            client.sendall(b'{"jsonrpc":"2.0","id":1,"method":"release.status","params":{"operationId":"x"}}\n')
            reply=client.recv(4096)
        except ConnectionError:
            reply=b''
        os.write(result_fd,b'denied' if not reply else b'accepted')
        client.close()
    except Exception:
        os.write(result_fd,b'connect-failed')
    finally:
        os.close(result_fd)
        os._exit(0)


@unittest.skipUnless(os.geteuid()==0,'Нужен root только для synthetic SO_PEERCRED fixture')
class RootSocketTest(unittest.IsolatedAsyncioTestCase):
    async def test_peer_binding_root_only_and_lost_resume_reply(self):
        with tempfile.TemporaryDirectory(prefix='brai-uds-proof-',dir='/run') as directory:
            root=Path(directory);os.chmod(root,0o711)
            workers=root/'worker';workers.mkdir(mode=0o700);os.chown(workers,65534,65534)
            worker_path=str(workers/'worker.sock')
            parent,child=multiprocessing.Pipe()
            process=multiprocessing.get_context('fork').Process(target=synthetic_worker,args=(worker_path,child))
            process.start();child.close()
            control_task=None;client_tasks=[];writers=[]
            try:
                ready,pid=await asyncio.to_thread(parent.recv)
                self.assertEqual((ready,pid),('ready',process.pid))
                os.chmod(root,0o700)
                start=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
                profile={'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic',
                         'uid':65534,'telegramId':'42','authorTelegramId':'42','role':'user','generation':1,
                         'workerSocket':worker_path}
                journal=IdentityJournal(root/'journal');inbox=UpdateInbox(journal)
                async def inventory(): return {'profiles':[profile]}
                mirror=Mirror(inbox,lambda actor:None,inventory=inventory,gate_store=ProfileGateStore(inbox))
                mirror.hydrated=True
                bridge=Bridge('synthetic','42',65534,worker_path,None,None)
                resolver=SimpleNamespace(mirror=mirror,batch_ownership=SimpleNamespace(busy=lambda uid:False),
                                         _bridge=lambda profile:bridge)
                owner=ProfileRelease(resolver,SimpleNamespace(bot=SimpleNamespace(id=123)))
                await owner._peer(profile,pid,start)
                for bad in ((pid+1,start),(pid,'0')):
                    with self.assertRaises(PermissionError): await owner._peer(profile,*bad)
                with self.assertRaises(PermissionError): await owner._peer({**profile,'uid':65533},pid,start)

                async def unused(**params): return {'state':'ready'}
                release=SimpleNamespace(begin=unused,status=unused,resume=unused,commit=unused,
                    profile_try=owner.try_profile,profile_status=owner.status,profile_resume=owner.resume)
                control_path=str(root/'control.sock')
                control_task=asyncio.create_task(serve_chat_control(control_path,unused,release))
                while not Path(control_path).exists():
                    if control_task.done(): await control_task
                    await asyncio.sleep(0)
                reader,writer=await asyncio.open_unix_connection(control_path);writers.append(writer)
                peer=Peer(reader,writer,{})
                client_tasks.append(asyncio.create_task(peer.run()))
                request={'operationId':str(uuid.uuid4()),'attemptId':str(uuid.uuid4()),
                    'profileId':profile['profileId'],'targetPayloadHash':'a'*64,
                    'workerPid':pid,'workerStartTime':start}
                self.assertEqual((await peer.call('profile.release.try',request,timeout=None))['state'],'ready')
                # Close the Root caller after the worker effect and before its reply.
                resume={**request,'replacementPid':pid,'replacementStartTime':start}
                pending=asyncio.create_task(peer.call('profile.release.resume',resume,timeout=None))
                self.assertEqual(await asyncio.to_thread(parent.recv),('effect',1))
                writer.close();await writer.wait_closed()
                await asyncio.gather(pending,return_exceptions=True)
                parent.send('continue')
                # Wait on the owned operation, not on a timer, before fresh Root status.
                owned=owner.tasks[(request['operationId'],request['attemptId'],'resume')][1]
                await owned
                reader2,writer2=await asyncio.open_unix_connection(control_path);writers.append(writer2)
                peer2=Peer(reader2,writer2,{})
                client_tasks.append(asyncio.create_task(peer2.run()))
                status=await peer2.call('profile.release.status',resume,timeout=None)
                self.assertEqual((status['state'],status['replacementPid'],status['replacementStartTime']),
                                 ('resumed',pid,start))
                self.assertEqual((await peer2.call('profile.release.resume',resume,timeout=None))['state'],'resumed')
                self.assertFalse(parent.poll())

                # Temporarily expose only this synthetic socket to reach the kernel UID check.
                os.chmod(root,0o711);os.chmod(control_path,0o666)
                read_fd,write_fd=os.pipe()
                foreign=multiprocessing.get_context('fork').Process(target=foreign_client,args=(control_path,write_fd))
                foreign.start();os.close(write_fd)
                try:
                    answer=await asyncio.to_thread(os.read,read_fd,32)
                    self.assertEqual(answer,b'denied')
                finally:
                    os.close(read_fd);foreign.join();os.chmod(root,0o700);os.chmod(control_path,0o600)
            finally:
                for writer in writers:
                    writer.close();await writer.wait_closed()
                for task in client_tasks: task.cancel()
                await asyncio.gather(*client_tasks,return_exceptions=True)
                if control_task:
                    control_task.cancel();await asyncio.gather(control_task,return_exceptions=True)
                process.terminate();await asyncio.to_thread(process.join)
                parent.close()
