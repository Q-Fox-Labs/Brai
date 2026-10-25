# ABOUTME: Проверяет границу клиентской установки и безопасное административное дополнение.
# ABOUTME: Использует временные файлы и не запускает Docker, службы или миграции.
import base64
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

FILES=Path(__file__).resolve().parents[1]/'roles/brai_install/files'
sys.path.insert(0,str(FILES))
import install_server as engine
import partition
import prepare_state as state


def fixture():
    """Создать маленькую декларацию двух сред без зависимости от Admin."""
    return {'scope':'administrative','format':'brai-clean-install-v1','unresolved':[],
      'source_revisions':{'dev':'d'*40,'prod':'a'*40},'installed':{'dev':{'web':'sha256:'+'d'*64},'prod':{'web':'sha256:'+'a'*64}},
      'components':[{'id':'web','artifact':{'digest':'sha256:'+x*64}} for x in ['a','d']],
      'operator':{'environments':{'prod':{'projects':{'brai':{'accepted':'/var/lib/brai-install/accepted/brai.json'}},'components':{'web':[]}}}},
      'projects':{'brai':{'document':{'services':{'web':{'image':'web','networks':{}}}}},'brai-infrastructure':{'document':{'services':{'caddy':{'image':'caddy','networks':{},'volumes':[]}}}}},
      'programs':{},'local_ai':{},'streams':{'dev':[],'prod':[]},'images':{},'runtime_images':{},'networks':{},'volumes':[],
      'volume_permissions':{},'copies':{},'config_paths':[],'directories':{},'generated_prefixes':[],
      'databases':[],'role_memberships':[],'postgres_hba':'local all all trust\n'}


def inputs(manifest):
    """Связать тестовые закрытые настройки с точными байтами декларации."""
    return {'manifest_sha256':hashlib.sha256(partition.encoded(manifest)).hexdigest(),'files':{},'environments':{},'roles':[],'provision':{'user':'installer','password':'fixture'}}


class ProductBoundary(unittest.TestCase):
    def setUp(self):self.manifest=json.loads((FILES/'product.json').read_text())

    def test_actual_prod_is_closed_and_independent(self):
        self.assertTrue(partition.validate_product(self.manifest))
        self.assertTrue(engine.validate(self.manifest))
        self.assertEqual(set(self.manifest['installed']['prod']),{'artifacts','agent','timer','auth','history','alerts','web','local-ai','transcription','supabase-mcp'})
        self.assertEqual(set(self.manifest['programs']),{'brai-agent.service'})
        self.assertEqual(self.manifest['npm_repositories'],['/srv/projects/brai'])

    def test_no_private_environment_is_packaged(self):
        for project in self.manifest['projects'].values():
            for service in project['document']['services'].values():self.assertNotIn('environment',service)
        self.assertEqual(self.manifest['copies'],{})
        self.assertEqual(self.manifest['extra_sources'],[])

    def test_dev_change_does_not_change_product(self):
        full=fixture();full['runtime_images']={'web':{'name':'prod','references':['same-image']}}
        before=partition.product(full)
        full['source_revisions']['dev']='e'*40
        full['installed']['dev']['web']='sha256:'+'e'*64
        full['hf_cache_helper_sha256']='e'*64
        full['runtime_images']['web']['name']='dev'
        full['components'].append({'id':'web','artifact':{'digest':'sha256:'+'e'*64}})
        self.assertEqual(before,partition.product(full))

    def test_prod_change_is_reflected(self):
        full=fixture();before=partition.product(full)
        full['source_revisions']['prod']='b'*40
        self.assertNotEqual(before,partition.product(full))

    def test_health_credentials_remain_runtime_values(self):
        document={'services':{'db':{'healthcheck':{'test':['CMD-SHELL','curl -H eyJabc.def.ghi']}}}}
        partition.sanitize_health(document)
        self.assertEqual(document['services']['db']['healthcheck']['test'][1],'curl -H $$ANON_KEY')

    def test_restart_units_use_same_documents_as_initial_install(self):
        manifest=fixture();instance=engine.Installer(manifest,{'environments':{}});written={}
        with patch.object(engine,'PROJECTS',Path('/var/lib/brai-install/projects')),patch.object(engine,'json_write'),patch.object(engine,'write',side_effect=lambda path,data,*a,**k:written.update({str(path):data.decode()}) or False):
            instance.render_projects()
        self.assertTrue(all('/var/lib/brai-install/projects/' in text for text in written.values()))

    def test_prod_models_exist_before_shared_cache_is_prepared(self):
        instance=engine.Installer(fixture(),{'environments':{}});events=[]
        with patch.object(engine,'run',side_effect=lambda argv:events.append(argv[2])),patch.object(instance,'prepare_hf_cache',side_effect=lambda:events.append('cache')):
            instance.models_stage()
        self.assertEqual(events,['prod','cache','dev','cache'])


class Admission(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)/'control'
        self.guard=patch.object(state,'has_unowned_runtime',return_value=False);self.guard.start();self.addCleanup(self.guard.stop)
        self.full=fixture();self.client=partition.product(self.full)

    def install(self):state.prepare(self.root,self.client,inputs(self.client))

    def test_repeat_preserves_identical_inputs(self):
        self.install();before=(self.root/'inputs.json').stat().st_mtime_ns
        self.install();self.assertEqual(before,(self.root/'inputs.json').stat().st_mtime_ns)
        self.assertEqual((self.root/'inputs.json').stat().st_mode & 0o777,0o600)

    def test_admin_can_extend_matching_client(self):
        self.install();state.prepare(self.root,self.full,inputs(self.full),administrative=True)
        self.assertEqual(json.loads((self.root/'baseline.json').read_text()),self.full)
        state.prepare(self.root,self.full,inputs(self.full),administrative=True)

    def test_extension_does_not_accept_another_product(self):
        self.install();other=copy.deepcopy(self.full);other['source_revisions']['prod']='f'*40
        before=(self.root/'baseline.json').read_bytes()
        with self.assertRaisesRegex(ValueError,'PRODUCT_MISMATCH'):state.prepare(self.root,other,inputs(other),True)
        self.assertEqual(before,(self.root/'baseline.json').read_bytes())

    def test_changed_credentials_are_rejected(self):
        self.install();changed=inputs(self.full);changed['provision']['password']='different'
        with self.assertRaisesRegex(ValueError,'INPUT_CHANGED'):state.prepare(self.root,self.full,changed,True)

    def test_extension_requires_administrative_mode(self):
        self.install()
        with self.assertRaisesRegex(ValueError,'PRODUCT_MISMATCH'):state.prepare(self.root,self.full,inputs(self.full))

    def test_changed_resume_input_is_rejected(self):
        self.install();changed=inputs(self.client);changed['extra']='different'
        with self.assertRaisesRegex(ValueError,'RESUMED_INPUT_CHANGED'):state.prepare(self.root,self.client,changed)

    def test_foreign_or_symlink_control_directory_is_rejected(self):
        self.root.mkdir();(self.root/'foreign').touch()
        with self.assertRaisesRegex(ValueError,'UNOWNED_CONTROL'):self.install()
        linked=Path(self.directory.name)/'link';linked.symlink_to(self.root,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'UNSAFE_CONTROL'):state.prepare(linked,self.client,inputs(self.client))

    def test_symlink_control_file_is_rejected(self):
        self.install();p=self.root/'inputs.json';p.unlink();p.symlink_to(self.root/'baseline.json')
        with self.assertRaisesRegex(ValueError,'UNSAFE_CONTROL'):self.install()

    def test_unowned_runtime_is_rejected(self):
        with patch.object(state,'has_unowned_runtime',return_value=True):
            with self.assertRaisesRegex(ValueError,'UNOWNED_SERVER'):self.install()

    def test_only_additive_project_settings_are_accepted(self):
        def item(value):return {'content':base64.b64encode(json.dumps(value).encode()).decode(),'mode':0o600,'uid':1,'gid':1}
        old=item({'projects':[{'cwd':'/srv/projects/brai'}],'token':'unchanged'})
        new=item({'projects':[{'cwd':'/srv/projects/brai'},{'cwd':'/srv/projects/brai-dev'}],'token':'unchanged'})
        self.assertTrue(state.compatible_file('/etc/brai-agent/config.json',old,new))
        changed=item({'projects':[{'cwd':'/srv/projects/brai'}],'token':'changed'})
        self.assertFalse(state.compatible_file('/etc/brai-agent/config.json',old,changed))
        self.assertFalse(state.compatible_file('/etc/brai/application.env',old,new))


if __name__=='__main__':unittest.main()
