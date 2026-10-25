# ABOUTME: Проверяет изоляцию image-native Gemma при клиентской подготовке Local AI.
# ABOUTME: Использует синтетические inputs без Docker и protected конфигурации.
import json
from pathlib import Path
import sys
import unittest
FILES=Path(__file__).resolve().parents[1]/'roles/brai_install/files'
sys.path.insert(0,str(FILES))
import install_server as engine


class LocalAiRuntime(unittest.TestCase):
    """Не маскировать встроенный engine host mount и не терять системные библиотеки."""
    def installer(self):
        root='/opt/brai/local-ai/runtime/embeddinggemma2/pinned'
        cfg={'runtime':{'embeddinggemma2_llama_cpp':{'cwd':root+'/app','env':{'LD_LIBRARY_PATH':root+'/app:'+root+'/system','PYTHONHOME':'/old'}}},'installer':{'rootDirectory':'/old/models'},'transport':{'maxRequestMs':240000}}
        result=engine.Installer.__new__(engine.Installer)
        result.inputs={'environments':{'prod/local_ai':{'LOCAL_AI_CONFIG_JSON':json.dumps(cfg)}}}
        result.documents={'prod':{'services':{'local_ai':{'volumes':[{'type':'bind','source':root,'target':root,'read_only':True},{'type':'bind','source':'/old/models','target':'/old/models'}]}}}}
        result.m={'local_ai':{'prod/local_ai':{}},'images':{'image':{'kind':'local-ai','dockerfile':'COPY --from=gemma /app '+root+'/app\n'}}}
        return result,root

    def test_baked_native_uses_image_libraries_and_preserves_model_storage(self):
        installer,root=self.installer();installer.prepare_documents()
        cfg=json.loads(installer.inputs['environments']['prod/local_ai']['LOCAL_AI_CONFIG_JSON'])
        runtime=cfg['runtime']['embeddinggemma2_llama_cpp']
        self.assertEqual(runtime['cwd'],root+'/app')
        self.assertEqual(runtime['env']['LD_LIBRARY_PATH'],root+'/app:/usr/lib/x86_64-linux-gnu')
        self.assertNotIn('PYTHONHOME',runtime['env'])
        self.assertEqual(installer.documents['prod']['services']['local_ai']['volumes'],[{'type':'bind','source':'/var/lib/brai/local-ai/models','target':'/var/lib/brai/local-ai/models'}])

    def test_native_requires_declared_image_recipe(self):
        installer,_=self.installer();installer.m['images']={}
        with self.assertRaisesRegex(ValueError,'INSTALL_GEMMA_IMAGE_ASSET_REQUIRED'):
            installer.prepare_documents()

    def test_native_mount_substitution_is_rejected(self):
        installer,_=self.installer();installer.documents['prod']['services']['local_ai']['volumes'][0]['source']='/unrelated'
        with self.assertRaisesRegex(ValueError,'INSTALL_GEMMA_NATIVE_MOUNT_CONFLICT'):
            installer.prepare_documents()

    def test_owner_acl_includes_only_required_model_configure_permission(self):
        cfg=engine.broker_config(b'authorization { users: [] }',{'user':'fixture','password':'synthetic'})
        self.assertIn(b'brai.local_ai.v1.models.configure',cfg)
        self.assertNotIn(b'brai.local_ai.v1.>',cfg)


if __name__=='__main__':unittest.main()
