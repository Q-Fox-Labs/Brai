# ABOUTME: Проверяет, что delivery включает фактическую Python closure нового ingress.
# ABOUTME: Использует существующий упаковщик и только временный synthetic root.
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
COMPONENT = ROOT/'services/hermes/component.json'
PREFIX = 'services/hermes/identity/'
REQUIRED = {PREFIX + name for name in ('ordinary_admission.py','profile_release.py',
            'transport_inbox.py','update_inbox.py','release-contract.json')}
CHECKS = {PREFIX + 'tests/' + name for name in ('test_ordinary_admission.py','test_ordinary_batches.py',
          'test_ordinary_boundaries.py','test_ordinary_uds_root.py','test_profile_release.py',
          'test_release_contract.py','test_transport_inbox.py','test_update_inbox.py',
          'test_component_release_package.py','ordinary_uds_proof.py','test_ordinary_uds_proof.py')}
FIXTURES = {PREFIX + 'tests/fixtures/ordinary_release/plugins/platforms/telegram/' + name for name in
            ('adapter.py','telegram_held_inbound.py','update_admission.py')}


class ReleasePackageTest(unittest.TestCase):
    def test_real_packager_delivers_importable_factory_closure_and_contract(self):
        component=json.loads(COMPONENT.read_text())
        self.assertTrue(REQUIRED <= set(component['inputs']['runtime']))
        self.assertTrue(REQUIRED <= set(component['delivery']['files']))
        self.assertTrue((CHECKS | FIXTURES) <= set(component['inputs']['checks']))
        identity=[path for path in component['delivery']['files'] if path.startswith(PREFIX)]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for path in identity:
                dest=root/path;dest.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(ROOT/path,dest)
            packager=(ROOT/'deploy/components/package-runtime.mjs').as_uri()
            script='''const {packageComponent}=await import(process.argv[1]);
const root=process.argv[2], files=JSON.parse(process.argv[3]);
const component={id:'hermes-proof',directory:'services/hermes',
 delivery:{kind:'ready-files',files,entrypoints:[],smokeImports:[]},npm:{workspaces:[]}};
const result=await packageComponent(root,component,'tmp/out');
process.stdout.write(result.path);'''
            built=subprocess.run(['node','--input-type=module','-e',script,packager,str(root),json.dumps(identity)],
                                 check=True,text=True,capture_output=True)
            artifact=Path(built.stdout)
            env={**os.environ,'PYTHONPATH':str(artifact/'services/hermes'),'PYTHONDONTWRITEBYTECODE':'1'}
            subprocess.run([sys.executable,'-B','-c',
                'from identity import native_ingress,ordinary_admission,profile_release,transport_inbox,update_inbox; '
                'native_ingress._verify_release_contract()'],cwd=root,env=env,check=True,capture_output=True,text=True)
            for path in REQUIRED:
                self.assertTrue((artifact/path).is_file(),path)
