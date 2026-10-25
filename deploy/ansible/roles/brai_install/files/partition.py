# ABOUTME: Выделяет клиентский состав из проверенного полного описания установки.
# ABOUTME: Работает с декларациями и закрытым входом; не обращается к серверу и не читает данные БД.
import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

EXCLUDED=('/srv/projects/admin','/srv/projects/brai-dev','/etc/brai-dev','/var/lib/brai-dev','/etc/geminitix','/opt/geminitix','/srv/projects/Brai-old')


def standalone_native(manifest):
    """Заменить только explicit shared-host Hermes dependency независимой установкой."""
    specs=manifest.get('native_runtimes',{})
    if not specs:return
    assert set(specs)=={'hermes'},'PRODUCT_UNKNOWN_NATIVE_RUNTIME'
    spec=specs['hermes']
    assert spec['format']=='brai-hermes-native-v1' and spec['environment']=='prod','PRODUCT_NATIVE_FORMAT'
    previous=copy.deepcopy(spec)
    spec.update(owner='brai-hermes-production',home='/var/lib/brai/hermes-owner',
                tokenEnvironmentFile='/etc/brai/hermes/telegram-token.env',
                chrome='/opt/brai-hermes-browser/chrome-linux64/chrome',
                software={'mode':'install','core':'/var/lib/brai/hermes/hermes-agent',
                          'custom':'/var/lib/brai/hermes/usercustom/hermescustom'})
    replacements={previous['home']:spec['home'],previous['owner']:spec['owner'],
                  previous['home']+'/.codex':spec['home']+'/.codex',
                  previous['software']['core']:spec['software']['core'],
                  previous['software']['custom']:spec['software']['custom']}
    instances=manifest['operator']['environments']['prod']['components']['hermes']
    for item in [*instances,*manifest['programs'].values()]:
        if item.get('nativeRuntime')!='hermes':continue
        item.pop('environmentFiles',None)
        item.pop('beforeStartCommand',None)
        for key,value in item.get('requiredEnvironment',{}).items():
            item['requiredEnvironment'][key]=replacements.get(value,value)


def encoded(value):
    """Вернуть канонические байты публичного описания."""
    return (json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()


def sanitize_health(document):
    """Не переносить раскрытый в Docker inspect JWT в исходники установки."""
    for service in document['services'].values():
        health=service.get('healthcheck',{})
        if 'test' in health:
            health['test']=[re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '$$ANON_KEY', x) if isinstance(x,str) else x for x in health['test']]


def product(manifest):
    """Вернуть замкнутый состав принятого PROD без административной среды."""
    m=copy.deepcopy(manifest)
    m['scope']='product'
    m['source_revisions']={'prod':m['source_revisions']['prod']}
    m['installed']={'prod':m['installed']['prod']}
    wanted=set(m['installed']['prod'].values())
    m['components']=[c for c in m['components'] if c['artifact']['digest'] in wanted]
    production=m['operator']['environments']['prod']
    projects=set(production['projects'])|{'brai-infrastructure'}
    m['projects']={k:v for k,v in m['projects'].items() if k in projects}
    m['programs']={k:v for k,v in m['programs'].items() if v['environment']=='prod'}
    standalone_native(m)
    m['local_ai']={k:v for k,v in m['local_ai'].items() if k.split('/')[0] in projects}
    m['streams']={'prod':m['streams']['prod']}
    m['broker_configs']=['/etc/brai/alerts-candidate/nats.conf']
    m['npm_repositories']=['/srv/projects/brai']
    m['copies']={}
    m['extra_sources']=[]
    m.pop('socraticode_image',None)
    m.pop('hf_cache_helper_sha256',None)
    m.pop('hermes_uid',None);m.pop('hermes_gid',None)
    infra=m['projects']['brai-infrastructure']['document']
    proxy=infra['services']['caddy']
    proxy['networks']={k:v for k,v in proxy['networks'].items() if not k.startswith('brai_dev')}
    proxy['volumes']=[v for v in proxy['volumes'] if v['source'] not in ['/opt/caddy/Caddyfile','/opt/caddy/brai-dev.caddy','/srv/projects/Brai-old/deploy/web']]
    proxy['volumes'] += [
      {'type':'bind','source':'/etc/brai/caddy/Caddyfile','target':'/etc/caddy/Caddyfile','read_only':True},
      {'type':'bind','source':'/etc/brai/caddy/extra','target':'/etc/caddy/extra','read_only':True}]
    bound=set()
    networks=set();volumes=set();images=set()
    for p in m['projects'].values():
        doc=p['document'];sanitize_health(doc)
        used={n for s in doc['services'].values() for n in s.get('networks',{})}
        doc['networks']={k:v for k,v in doc.get('networks',{}).items() if k in used}
        for net in doc['networks'].values():networks.add(net.get('name'))
        for svc in doc['services'].values():
            if 'volumes' in svc:
                svc['volumes'].sort(key=lambda mount:(mount['target'],mount['type'],mount.get('source','')))
            images.add(svc['image'])
            for mount in svc.get('volumes',[]):
                if mount['source']=='/usr/local/libexec/brai-codeworks-transcription.mjs':
                    mount['source']='/var/lib/brai-install/transcription-launch.mjs'
                if mount['type']=='bind':bound.add(mount['source'])
                else:volumes.add(doc.get('volumes',{}).get(mount['source'],{}).get('name',mount['source']))
    m['images']={k:v for k,v in m['images'].items() if k in images}
    m['runtime_images']={}
    m['networks']={k:v for k,v in m['networks'].items() if k in networks}
    m['volumes']=[v for v in m['volumes'] if v in volumes]
    m['volume_permissions']={k:v for k,v in m['volume_permissions'].items() if k in volumes}
    m['config_paths']=[p for p in m['config_paths'] if (p.startswith(('/etc/brai/','/etc/brai-agent/','/srv/projects/brai/.secrets/')) or p=='/home/agent/.codex/auth.json') and not p.startswith('/etc/brai/caddy/')]
    m['directories']={p:v for p,v in m['directories'].items() if not any(p.startswith(x) for x in EXCLUDED) and (p in bound or any(Path(q).is_relative_to(p) for q in [*bound,*m['config_paths']]))}
    m['directories']['/etc/brai/caddy/extra']={'uid':0,'gid':0,'mode':0o755}
    m['generated_prefixes'] = [p for p in m['generated_prefixes'] if not any(p.startswith(x) for x in EXCLUDED)] + ['/etc/brai/caddy/','/var/lib/brai-install/']
    m['databases']=[d for d in m['databases'] if not d['name'].startswith('brai_dev_') and (d['name']!='brai_codeworks' or 'codeworks' in m['installed']['prod'])]
    m['role_memberships']=[v for v in m['role_memberships'] if not any(x.startswith(('brai_dev_', 'brai_codeworks')) for x in v.values())]
    m['postgres_hba']='\n'.join(l for l in m['postgres_hba'].splitlines() if 'brai_dev' not in l and ('brai_codeworks' not in l or 'codeworks' in m['installed']['prod']))+'\n'
    production['components']={k:v for k,v in production['components'].items() if k in m['installed']['prod']}
    for name,p in production['projects'].items():
        p['accepted']='/var/lib/brai-install/accepted/'+name+'.json'
        p.pop('command',None)
    m['operator']={'environments':{'prod':production}}
    # These values describe upstream code, never a second local checkout.
    validate_product(m)
    return m


def validate_product(manifest):
    """Проверить самостоятельность клиентской поставки; ошибка не раскрывает входы."""
    assert manifest.get('scope')=='product','PRODUCT_SCOPE_REQUIRED'
    assert set(manifest['installed'])=={'prod'} and set(manifest['source_revisions'])=={'prod'},'PRODUCT_PROD_ONLY'
    raw=encoded(manifest).decode()
    assert not any(path in raw for path in EXCLUDED),'PRODUCT_ADMIN_DEPENDENCY'
    expected=set(manifest['installed']['prod'].values())
    assert {c['artifact']['digest'] for c in manifest['components']}==expected,'PRODUCT_COMPONENT_CLOSURE'
    assert not re.search(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',raw),'PRODUCT_EMBEDDED_CREDENTIAL'
    return True


def product_inputs(full_manifest, inputs, public_origin):
    """Выделить закрытую конфигурацию PROD; внешние доступы оператор задаёт отдельно."""
    m=product(full_manifest)
    result={k:copy.deepcopy(inputs[k]) for k in ['registry','git','hf_token','provision','mcp_servers'] if k in inputs}
    result['files']={p:copy.deepcopy(inputs['files'][p]) for p in m['config_paths']}
    result['environments']={k:copy.deepcopy(v) for k,v in inputs['environments'].items() if k.split('/')[0] in m['projects']}
    result['program_environment']={k:copy.deepcopy(v) for k,v in inputs.get('program_environment',{}).items() if k in m['programs']}
    if m.get('native_runtimes',{}).get('hermes'):
        result['native_hermes']=copy.deepcopy(inputs['native_hermes'])
        # OAuth and bot token are client-owned mandatory separate inputs, never copied from DEV.
        result['required_external_inputs']=['native_hermes_auth.content','native_hermes_token_environment']
    result['roles']=[r for r in inputs['roles'] if not r['name'].startswith('brai_dev_') and (r['name']!='brai_codeworks_owner' and r['name']!='brai_codeworks_app' or 'codeworks' in m['installed']['prod'])]
    result['manifest_sha256']=hashlib.sha256(encoded(m)).hexdigest()
    result['public_origin']=public_origin
    result['public_urls']=[public_origin+'/api/timer']
    old_origin=inputs.get('environments',{}).get('brai/web',{}).get('WEB_ORIGIN')
    for path,item in result['files'].items():
        data=base64.b64decode(item['content'])
        if path=='/etc/brai-agent/config.json':
            cfg=json.loads(data)
            cfg['projects']=[p for p in cfg['projects'] if not any(p['cwd'].startswith(x) for x in EXCLUDED)]
            if not cfg['projects']:cfg['projects']=[{'projectId':'brai','name':'Brai','cwd':'/srv/projects/brai'}]
            data=json.dumps(cfg).encode()
        elif path=='/etc/brai-agent/publisher.json':
            cfg=json.loads(data)
            cfg['allowedReadRoots']=[p for p in cfg['allowedReadRoots'] if not any(p.startswith(x) for x in EXCLUDED)] or ['/srv/projects/brai']
            data=json.dumps(cfg).encode()
        if old_origin:data=data.replace(old_origin.encode(),public_origin.encode())
        item['content']=base64.b64encode(data).decode()
    if old_origin:
        result['environments']=json.loads(json.dumps(result['environments']).replace(old_origin,public_origin))
        result['program_environment']=json.loads(json.dumps(result['program_environment']).replace(old_origin,public_origin))
    # The inspect health command used an interpolated token. Keep it private at runtime.
    infra=result['environments']
    anon=next((v['ANON_KEY'] for k,v in infra.items() if k.startswith('brai-infrastructure/') and v.get('ANON_KEY')),None)
    if anon:
        for k,v in infra.items():
            if k.startswith('brai-infrastructure/') and 'realtime' in k:v['ANON_KEY']=anon
    return result


if __name__=='__main__':
    try:
        source=json.loads(Path(sys.argv[1]).read_text())
        out=product(source)
        if len(sys.argv)>2:Path(sys.argv[2]).write_bytes(encoded(out))
        print('PRODUCT_PARTITION_VALID')
    except Exception:
        print('PRODUCT_PARTITION_FAILED',file=sys.stderr);raise SystemExit(1)
