# ABOUTME: Проверяет директивы установщика штатным преобразователем Ansible.
# ABOUTME: Не запускает серверные задачи и не читает закрытые настройки.
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest

try:
    import yaml
    from ansible.module_utils.parsing.convert_bool import boolean
except ImportError:
    yaml=None

ROOT=Path(__file__).resolve().parents[1]


@unittest.skipIf(yaml is None,'Ansible controller dependencies are required')
class TaskDirectives(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ansible-playbook'),'Ansible executable is required')
    def test_real_admission_executes_embedded_sources(self):
        """Выполнить настоящую admission-задачу только на временном собственном состоянии."""
        role=ROOT/'roles/brai_install'
        manifest=json.loads((role/'files/product.json').read_text())
        encoded=lambda value:(json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
        digest=hashlib.sha256(encoded(manifest)).hexdigest()
        private={'manifest_sha256':digest,'files':{},'environments':{'fixture':'{{modelPath}}'},
                 'roles':[],'provision':{'user':'fixture','password':'fixture'}}
        task=next(t for t in yaml.safe_load((role/'tasks/admission.yml').read_text())
                  if t.get('name','').startswith('Accept fresh'))
        with tempfile.TemporaryDirectory(prefix='brai-admission-') as scratch:
            scratch=Path(scratch);control=scratch/'control';control.mkdir(mode=0o700)
            for name,value in [('baseline.json',manifest),('inputs.json',private),
                               ('owner.json',{'format':'brai-clean-install-owner-v1','manifest':digest})]:
                path=control/name;path.write_bytes(encoded(value));path.chmod(0o600)
            before=(control/'inputs.json').read_bytes()
            play=[{'hosts':'localhost','connection':'local','gather_facts':False,'vars':{
                'role_path':str(role),'brai_install_root':str(control),
                'brai_install_manifest':'{{ lookup("file", "'+str(control/'baseline.json')+'") | from_json }}',
                'brai_install_inputs':'{{ lookup("file", "'+str(control/'inputs.json')+'") | from_json }}',
                'brai_install_administrative':False},'tasks':[task]}]
            path=scratch/'play.yml';path.write_text(yaml.safe_dump(play))
            result=subprocess.run(['ansible-playbook','-i','localhost,',str(path)],
                env=dict(os.environ,ANSIBLE_LOCAL_TEMP=str(scratch/'ansible'),ANSIBLE_REMOTE_TEMP=str(scratch/'remote')),
                capture_output=True,text=True,timeout=90)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual((control/'inputs.json').read_bytes(),before)

    def test_no_log_is_an_ansible_boolean(self):
        """Отклонить строки, которые YAML читает, но Ansible не принимает как boolean."""
        def inspect(value,path):
            if isinstance(value,dict):
                if 'no_log' in value:
                    flag=value['no_log']
                    if not isinstance(flag,str) or '{{' not in flag:
                        with self.subTest(path=str(path),task=value.get('name')):
                            self.assertIsInstance(boolean(flag,strict=True),bool)
                for child in value.values():inspect(child,path)
            elif isinstance(value,list):
                for child in value:inspect(child,path)
        for path in ROOT.rglob('*.yml'):
            inspect(yaml.safe_load(path.read_text()),path)


if __name__=='__main__':unittest.main()
