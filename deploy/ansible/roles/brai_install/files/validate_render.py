#!/usr/bin/python3
# ABOUTME: Проверяет сгенерированные Compose-документы без записи и запуска контейнеров.
# ABOUTME: Передаёт секреты только через stdin и не выводит их при ошибке.
import json
import base64
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
import install_server as engine


def validate(manifest_path, input_path, bundle=False, brokers=False):
    manifest=json.loads(Path(manifest_path).read_text())
    inputs=json.loads(Path(input_path).read_text())
    if bundle: inputs=inputs['fresh_install_inputs']
    engine.validate(manifest)
    engine.require(inputs['manifest_sha256']==engine.sha(manifest_path),'INSTALL_PROTECTED_MANIFEST_MISMATCH')
    engine.require(set(inputs['files'])==set(manifest['config_paths']),'INSTALL_INPUT_FILES_INCOMPLETE')
    rendered={}
    def collect(path,value,**kwargs):
        if Path(path).parent == engine.PROJECTS:rendered[Path(path).stem]=value
        return False
    installer=engine.Installer(manifest,inputs)
    with patch.object(engine,'json_write',side_effect=collect),patch.object(engine,'write',return_value=False):
        installer.render_projects()
    for name,document in rendered.items():
        result=subprocess.run(['/usr/bin/docker','compose','--project-directory','/','--env-file','/dev/null','--project-name',name,'--file','/dev/stdin','--profile','*','config','--quiet'],
                              input=json.dumps(document),text=True,capture_output=True,timeout=30)
        engine.require(result.returncode==0,'INSTALL_COMPOSE_INVALID_'+name.upper().replace('-','_'))
    print('INSTALL_COMPOSE_DOCUMENTS_VALID_'+str(len(rendered)))
    if brokers:
        for path, container in [(p,'brai-dev-nats' if p.startswith('/etc/brai-dev/') else 'nats') for p in manifest.get('broker_configs',['/etc/brai/alerts-candidate/nats.conf'])]:
            candidate=engine.broker_config(base64.b64decode(inputs['files'][path]['content']),inputs['provision'])
            result=subprocess.run(['/usr/bin/docker','exec','-i',container,'/nats-server','-t','-c','/dev/stdin'],input=candidate,capture_output=True,timeout=30)
            engine.require(result.returncode==0,'INSTALL_BROKER_CONFIGURATION_INVALID')
        print('INSTALL_BROKER_CONFIGURATIONS_VALID')


if __name__=='__main__':
    try:validate(*sys.argv[1:3],bundle='--bundle' in sys.argv[3:],brokers='--check-running-broker-parsers' in sys.argv[3:])
    except Exception as error:
        code=str(error)
        print(code if code.startswith('INSTALL_') and all(c.isupper() or c=='_' or c.isdecimal() for c in code) else 'INSTALL_COMPOSE_VALIDATION_FAILED',file=sys.stderr)
        raise SystemExit(1)
