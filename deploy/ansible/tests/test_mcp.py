# ABOUTME: Проверяет переносимый MCP lifecycle и сохранение настроек при повторе.
# ABOUTME: Использует временные файлы и не запускает MCP или рабочий Codex.
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

FILES=Path(__file__).resolve().parents[1]/'roles/brai_install/files'
sys.path.insert(0,str(FILES))
import configure_mcp
from mcp_config import normalize,PROXY,PREFIX,PUBLISHER


class ProductMCP(unittest.TestCase):
    def config(self):
        """Создать неприватную конфигурацию текущего продуктового publisher."""
        return {'brai_results':{'command':'/usr/local/bin/node','args':[PUBLISHER],'env':{'TOKEN':'fixture'},'enabled':True}}

    def test_direct_backend_and_legacy_proxy_resolve_to_same_installed_launcher(self):
        direct=self.config();wrapped=copy.deepcopy(direct)
        wrapped['brai_results'].update(command=PROXY,args=[*PREFIX,PUBLISHER])
        self.assertEqual(normalize(direct),wrapped)
        self.assertEqual(normalize(wrapped),wrapped)
        self.assertEqual(normalize(direct)['brai_results']['env'],direct['brai_results']['env'])

    def test_product_block_preserves_unrelated_settings_and_semantic_repeat(self):
        with tempfile.TemporaryDirectory() as scratch:
            root=Path(scratch);inputs=root/'inputs.json';config=root/'config.toml'
            inputs.write_text(json.dumps({'mcp_servers':self.config()}));config.write_text('model = "example"\n')
            identity=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
            self.assertTrue(configure_mcp.configure(inputs,config,identity))
            original=config.read_bytes()
            self.assertFalse(configure_mcp.configure(inputs,config,identity))
            self.assertEqual(config.read_bytes(),original)
            # The administrative reconciler may use equivalent bare keys.
            config.write_text(config.read_text().replace('"command" =','command =').replace('"args" =','args ='))
            self.assertFalse(configure_mcp.configure(inputs,config,identity))
            changed=self.config();changed['brai_results']['env']['TOKEN']='different'
            inputs.write_text(json.dumps({'mcp_servers':changed}))
            with self.assertRaisesRegex(ValueError,'EXISTING_SETTING_CHANGED'):configure_mcp.configure(inputs,config,identity)


if __name__=='__main__':unittest.main()
