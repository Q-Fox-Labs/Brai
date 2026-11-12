# ABOUTME: Независимо проверяет квитанцию входного файла и запрет её переиспользования.
# ABOUTME: Реальный OwnerFiles работает с test UID; root metadata адаптирована только для marker.
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('sol_admission',ROOT/'services/hermes/files/identity.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    """Проверить path/profile/hash привязки без действительного Artifacts."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.uid=os.getuid()
        self.home=self.root/'home';self.ingress=self.root/'ingress';self.stage=self.root/'stage'/str(self.uid)
        for path in (self.home/'media',self.ingress,self.stage):path.mkdir(parents=True,mode=0o700)
        self.profile={'home':str(self.home),'userId':'owner','profileId':'profile'}
        self.calls=[]
        self.port=module.OwnerFiles({'stagingRoot':str(self.stage.parent),'artifactCacheRoots':{str(self.uid):str(self.root/'cache')},'ingressUid':self.uid,'ingressReadRoots':[str(self.ingress)]},SimpleNamespace(call=self.publish))
        self.port.materialize=lambda uid,profile,result:result
        original_directory=module.open_directory
        directory=patch.object(module,'open_directory',side_effect=lambda path,uid:original_directory(path,self.uid));directory.start();self.addCleanup(directory.stop)
        original_fstat=os.fstat
        def marker_root(fd):
            info=original_fstat(fd)
            if Path(os.readlink('/proc/self/fd/'+str(fd))).name=='.brai-admission.json':
                return SimpleNamespace(st_mode=info.st_mode,st_uid=0,st_nlink=info.st_nlink,st_size=info.st_size)
            return info
        self.metadata=patch.object(module.os,'fstat',side_effect=marker_root);self.metadata.start();self.addCleanup(self.metadata.stop)

    async def publish(self,method,args,**kwargs):
        self.calls.append((method,args));self.saved=Path(args['path']).read_bytes()
        return {'artifactId':str(uuid.uuid4()),'filename':Path(args['path']).name,'sizeBytes':len(self.saved),'sha256':hashlib.sha256(self.saved).hexdigest()}

    async def admitted(self):
        source=self.ingress/'in.txt';source.write_bytes('Точные\r\nбайты\x00'.encode())
        result=await self.port.prepare_ingress(self.uid,self.profile,[str(source)])
        return Path(result['paths'][0])

    async def test_prepare_receipt_and_publish_keep_exact_owner_bytes(self):
        path=await self.admitted();receipt=json.loads((path.parent/'.brai-admission.json').read_text())
        self.assertEqual(receipt['path'],str(path));self.assertEqual(receipt['userId'],'owner');self.assertEqual(receipt['profileId'],'profile')
        await self.port.publish(self.uid,self.profile,{'path':str(path),'requestId':'sol-input'},admitted=True)
        self.assertEqual(self.saved,path.read_bytes());self.assertEqual(len(self.calls),1)

    async def test_changed_input_bytes_are_rejected_before_publisher(self):
        path=await self.admitted();path.write_bytes(b'changed')
        with self.assertRaises(PermissionError):await self.port.publish(self.uid,self.profile,{'path':str(path),'requestId':'sol-input'},admitted=True)
        self.assertEqual(self.calls,[])

    async def test_receipt_cannot_be_used_for_other_owner_profile_or_path(self):
        path=await self.admitted()
        for field in ('userId','profileId'):
            with self.subTest(field=field),self.assertRaises(PermissionError):self.port.input_admission(self.uid,{**self.profile,field:'foreign'},path)
        sibling=path.parent/'other.txt';sibling.write_bytes(path.read_bytes())
        with self.assertRaises(PermissionError):self.port.input_admission(self.uid,self.profile,sibling)

    async def test_symlink_or_hardlink_marker_is_rejected(self):
        path=await self.admitted();marker=path.parent/'.brai-admission.json';target=path.parent/'receipt';marker.rename(target);marker.symlink_to(target)
        with self.assertRaises(OSError):self.port.input_admission(self.uid,self.profile,path)
        marker.unlink();marker.hardlink_to(target)
        with self.assertRaises(PermissionError):self.port.input_admission(self.uid,self.profile,path)

    async def test_guest_generated_file_without_receipt_is_rejected(self):
        directory=self.home/'media'/('a'*32);directory.mkdir(mode=0o700);path=directory/'own.txt';path.write_bytes(b'own')
        with self.assertRaises(FileNotFoundError):await self.port.publish(self.uid,self.profile,{'path':str(path),'requestId':'sol-input'},admitted=True)
        self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main(verbosity=2)
