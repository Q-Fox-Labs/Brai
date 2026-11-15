# ABOUTME: Независимо проверяет узкий файловый порт гостя и точные байты.
# ABOUTME: Artifacts подменён локальным портом; UID root не имитирует реальный сервис.
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / 'services/hermes/files/identity.py'
spec = importlib.util.spec_from_file_location('sol_owner_files', SOURCE)
identity = importlib.util.module_from_spec(spec); spec.loader.exec_module(identity)


class OwnerFilesTests(unittest.IsolatedAsyncioTestCase):
    """Проверяет настоящий OwnerFiles без настоящего Artifacts/Control."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.uid = os.getuid()
        self.stage = self.root / 'stage' / str(self.uid)
        self.home = self.root / 'home'
        for path in (self.stage, self.home / 'results'):
            path.mkdir(parents=True, mode=0o700)
        self.calls = []; self.wrong_hash = False
        self.port = identity.OwnerFiles({'artifactCacheRoots':{str(self.uid):str(self.root/'cache')},'stagingRoot':str(self.stage.parent)}, SimpleNamespace(call=self.publish))
        self.profile = {'home':str(self.home),'userId':'sol-synthetic-owner'}
        original = identity.open_directory
        self.directory = patch.object(identity, 'open_directory', side_effect=lambda path, uid: original(path, self.uid))
        self.directory.start(); self.addCleanup(self.directory.stop); self.addCleanup(self.temp.cleanup)
        self.port.materialize = lambda uid, profile, result: result

    async def publish(self, method, params, **kwargs):
        self.calls.append((method,params))
        data = Path(params['path']).read_bytes(); self.saved = data
        return {'artifactId':str(uuid.uuid4()), 'filename':Path(params['path']).name, 'sizeBytes':len(data), 'sha256':'0'*64 if self.wrong_hash else hashlib.sha256(data).hexdigest()}

    async def test_utf8_newlines_nul_and_code_remain_exact_bytes(self):
        text = 'Привет\r\nline\n\x00print(42)\n'
        result = await self.port.create_text(self.uid,self.profile,{'filename':'result.py','content':text,'requestId':'sol-1'})
        self.assertEqual(self.saved,text.encode('utf-8'))
        self.assertEqual(self.calls[0][0],'artifacts.publish')
        self.assertEqual(self.calls[0][1]['uid'],self.uid)
        self.assertEqual(result['filename'],'result.py')
        self.assertEqual(result['markdown'],'[result.py](artifact:'+result['artifactId']+')')
        self.assertEqual(list(self.stage.iterdir()),[])

    async def test_path_traversal_and_control_names_are_rejected(self):
        for name in ('../x','/tmp/x','a/b','a\\b','.','..','x\nfile','x\x00file'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                await self.port.create_text(self.uid,self.profile,{'filename':name,'content':'x','requestId':'sol-2'})
        self.assertEqual(self.calls,[])

    async def test_path_owner_and_command_fields_are_not_accepted(self):
        for key in ('path','ownerId','command','template'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                await self.port.create_text(self.uid,self.profile,{'filename':'x.txt','content':'x','requestId':'sol-3',key:'attacker'})
        self.assertEqual(self.calls,[])

    async def test_publisher_byte_mismatch_is_denied(self):
        self.wrong_hash=True
        with self.assertRaises(PermissionError):
            await self.port.create_text(self.uid,self.profile,{'filename':'x.txt','content':'x','requestId':'sol-4'})
        self.assertEqual(list(self.stage.iterdir()),[])

    async def test_multibyte_size_limit_applies_to_bytes(self):
        with self.assertRaises(ValueError):
            await self.port.create_text(self.uid,self.profile,{'filename':'x.txt','content':'я'*(512*1024+1),'requestId':'sol-5'})
        self.assertEqual(self.calls,[])


if __name__ == '__main__':
    unittest.main(verbosity=2)
