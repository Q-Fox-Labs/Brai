# ABOUTME: Проверяет реальные развилки первого запуска с пустыми хранилищами.
# ABOUTME: Подменяет только внешние Docker/Postgres операции и не касается рабочих служб.
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

FILES=Path(__file__).resolve().parents[1]/'roles/brai_install/files'
sys.path.insert(0,str(FILES))
import install_server as engine


class FirstStart(unittest.TestCase):
    def instance(self):
        """Создать установщик с настоящей публичной декларацией PROD без закрытых данных."""
        manifest=json.loads((FILES/'product.json').read_text())
        with patch.object(engine.Installer,'prepare_documents'):
            return engine.Installer(manifest,{'environments':{}})

    def test_installed_passive_program_gets_immutable_link_without_unit(self):
        """Наличие passive payload не требует запуска, но требует проверяемого runtime link."""
        installer=self.instance()
        with tempfile.TemporaryDirectory() as temp:
            link=Path(temp)/'passive-agent'
            instance=copy.deepcopy(installer.m['operator']['environments']['prod']['components']['agent'][0])
            instance.update(active=False,link=str(link))
            installer.m['operator']['environments']['prod']['components']={'agent':[instance]}
            installer.m['programs']={}
            with patch.object(engine,'run') as run,patch.object(engine,'docker') as docker:
                installer.prepare_program_links()
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.readlink(),engine.payload_path(installer.component('prod','agent')))
            run.assert_not_called();docker.assert_not_called()

    def test_shared_local_ai_assets_always_use_prod(self):
        """DEV-first порядок манифеста не меняет source runtime клиентского PROD."""
        installer=self.instance();installer.m['source_revisions']={'dev':{},'prod':{}}
        expected=engine.payload_path(installer.component('prod','local-ai'))/'services/local-ai'
        with patch.object(installer,'component',wraps=installer.component) as component:
            self.assertEqual(installer.local_ai_source(),expected)
        component.assert_called_once_with('prod','local-ai')

    def test_artifacts_owner_init_precedes_any_subpath_consumer(self):
        """Создать files/tmp в пустом томе и сохранить пользовательские файлы при повторе."""
        installer=self.instance();events=[]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            def docker(*args,**kwargs):
                events.append(args)
                if args[:2]==('volume','inspect'):return SimpleNamespace(stdout=json.dumps([{'Mountpoint':temp}]))
                self.assertEqual(args[0],'run')
                for name,mode in [('files',0o750),('tmp',0o700)]:
                    path=root/name;path.mkdir();path.chmod(mode)
                return SimpleNamespace(stdout='')
            with patch.object(engine,'docker',side_effect=docker):
                installer.prepare_artifacts_volume()
                self.assertTrue((root/'files').is_dir())
                data=root/'files/user-file';data.write_text('preserve')
                original_stat=Path.stat
                def runtime_stat(path,*args,**kwargs):
                    info=original_stat(path,*args,**kwargs)
                    if path in [root/'files',root/'tmp']:
                        values=list(info);values[4:6]=[1000,1000]
                        return os.stat_result(values)
                    return info
                with patch.object(Path,'stat',runtime_stat):installer.prepare_artifacts_volume()
                self.assertEqual(data.read_text(),'preserve')
            self.assertEqual(sum(args[0]=='run' for args in events),1)

    def test_partial_populated_artifacts_volume_is_not_changed(self):
        """Отказать неоднозначному неполному тому, не исправляя его права или содержимое."""
        installer=self.instance()
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'files';path.mkdir();(path/'existing').write_text('preserve')
            with patch.object(engine,'docker',return_value=SimpleNamespace(stdout=json.dumps([{'Mountpoint':temp}]))):
                with self.assertRaisesRegex(ValueError,'PARTIAL_VOLUME_HAS_DATA'):installer.prepare_artifacts_volume()
            self.assertEqual((path/'existing').read_text(),'preserve')
            self.assertFalse((Path(temp)/'tmp').exists())

    def test_hba_path_change_restarts_before_checking_active_path(self):
        """Не считать reload достаточным для postmaster-настройки hba_file."""
        installer=self.instance();setting='/etc/postgresql-custom/brai-clean-install-hba.conf';events=[]
        def sql(statement):
            events.append(statement)
            if statement=='SHOW hba_file;':return setting if 'ready' in events else '/old.conf'
            return '0'
        with patch.object(installer,'sql',side_effect=sql),patch.object(engine,'docker',side_effect=lambda *a:events.append(a)),\
             patch.object(installer,'wait_postgres',side_effect=lambda:events.append('ready')):
            installer.activate_hba(setting)
        self.assertIn(('restart','supabase-db'),events)
        self.assertLess(events.index(('restart','supabase-db')),events.index('ready'))
        self.assertEqual(events[-1],'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;')

    def test_active_hba_is_reloaded_without_restart_and_errors_are_fatal(self):
        """Повтор не перезапускает БД и отклоняет ошибочные правила."""
        installer=self.instance();setting='/same.conf'
        with patch.object(installer,'sql',side_effect=lambda query:setting if query=='SHOW hba_file;' else '1'),patch.object(engine,'docker') as docker:
            with self.assertRaisesRegex(ValueError,'HBA_INVALID'):installer.activate_hba(setting)
        docker.assert_not_called()

    def test_external_cli_descriptor_requires_successful_probe(self):
        """Не выдавать успешную загрузку image за проверенный CLI."""
        installer=self.instance();component={'id':'example','artifact':{'reference':'registry/example@sha256:'+'a'*64}}
        with tempfile.TemporaryDirectory() as temp:
            destination=Path(temp)/'payload'
            with patch.object(engine,'docker',side_effect=[SimpleNamespace(returncode=0),ValueError('INSTALL_COMMAND_FAILED')]):
                with self.assertRaises(ValueError):installer.prepare_external_cli(component,destination)
            self.assertFalse(destination.exists())
            with patch.object(engine,'docker',return_value=SimpleNamespace(returncode=0)):
                installer.prepare_external_cli(component,destination)
                installer.prepare_external_cli(component,destination)
            self.assertEqual(json.loads((destination/'external.json').read_text()),{'artifact':component['artifact'],'verified':True})

    def test_runtime_provenance_uses_measured_identity_and_rejects_wrong_node(self):
        """Записать реальные IDs собранного image, не IDs с прежнего сервера."""
        installer=self.instance();identity='sha256:'+'e'*64;version='24.22.1'
        installer.m['images']={'old-image':{'kind':'local-ai','reference':'installed:fixture','dockerfile':'FROM fixture'}}
        installer.m['operator']['environments']['prod']['components']={'local-ai':installer.m['operator']['environments']['prod']['components']['local-ai']}
        local=installer.m['operator']['environments']['prod']['components']['local-ai'][0]
        installer.documents[local['project']]['services'][local['service']]['image']='old-image'
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'baseline.json').write_text('{}')
            payload=root/'payload';payload.mkdir();(payload/'artifact-manifest.json').write_text(json.dumps({'systemRequirements':['Node.js '+version]}))
            def docker(*args,**kwargs):
                if args[:2]==('image','inspect'):return SimpleNamespace(stdout=json.dumps([{'Id':identity}]))
                return SimpleNamespace(stdout='v'+version+'\n')
            with patch.object(engine,'ROOT',root),patch.object(engine,'RUNTIME_IMAGES',root/'runtime.json'),\
                 patch.object(engine,'payload_path',return_value=payload),patch.object(engine,'run',return_value=SimpleNamespace(stdout='v'+version+'\n')),\
                 patch.object(engine,'docker',side_effect=docker):
                installer.record_runtime_images()
                expected={'base':identity,'image':identity,'version':version}
                self.assertEqual(json.loads((root/'runtime.json').read_text())[local['container']],expected)
                recipes=json.loads((root/'runtime-recipes.json').read_text())
                self.assertEqual(recipes['images'],{identity:installer.m['images']['old-image']})
                (root/'runtime.json').unlink()
                def wrong_node(*args,**kwargs):
                    return docker(*args,**kwargs) if args[:2]==('image','inspect') else SimpleNamespace(stdout='v22.0.0')
                with patch.object(engine,'docker',side_effect=wrong_node):
                    with self.assertRaisesRegex(ValueError,'NODE_RUNTIME_VERSION_MISMATCH'):installer.record_runtime_images()
                self.assertFalse((root/'runtime.json').exists())


if __name__=='__main__':unittest.main()
