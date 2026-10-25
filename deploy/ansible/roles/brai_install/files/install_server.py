#!/usr/bin/python3
# ABOUTME: Создаёт окружение из проверенных сетевых поставок и пустых хранилищ.
# ABOUTME: Не импортирует данные и не выдаёт снимок старой установки за новую приёмку.
"""Fixed first-install stages. Commands and credentials never enter diagnostics."""
import argparse
import base64
import copy
import fcntl
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error

ROOT = Path('/var/lib/brai-install')
# Workers run as the isolated runtime owner, so their public code must not live
# below the root-only installation receipt directory.
if Path('/usr/local/lib/brai-hermes/native_hermes.py').is_file():
    sys.path.insert(0, '/usr/local/lib/brai-hermes')
PROJECTS = ROOT/'projects'
RUNTIME_IMAGES = Path('/var/lib/nodejs-security/brai-runtime-images.json')
IMAGE_NODE = 'node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205'
FORBIDDEN = ('/sessions/', '/conversations/', '/memories/', '/usercustom/AGENTS', '.sqlite', '/db/data/')
STAGES = ('inputs', 'sources', 'infrastructure', 'databases', 'migrations', 'applications', 'models', 'host_services', 'verify')
PACKAGED_BINDS = {'/usr/bin/busybox'}


def require(value, code):
    if not value:
        raise ValueError(code)


def run(argv, *, data=None, env=None, timeout=7200, optional=False):
    result = subprocess.run(argv, input=data, text=True, capture_output=True, env=env, timeout=timeout)
    require(optional or result.returncode == 0, 'INSTALL_COMMAND_FAILED')
    return result


def docker(*args, **kwargs):
    return run(['/usr/bin/docker', *args], **kwargs)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write(path, content, mode=0o600, *, only_new=False):
    path = Path(path)
    require(not any(p.is_symlink() for p in [path, *path.parents]), 'INSTALL_SYMLINK_DESTINATION')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if only_new:
            require(path.read_bytes() == content, 'INSTALL_EXISTING_INPUT_CHANGED')
            require(stat.S_IMODE(path.stat().st_mode) == mode, 'INSTALL_EXISTING_INPUT_MODE_CHANGED')
            return False
        if path.read_bytes() == content and stat.S_IMODE(path.stat().st_mode) == mode:
            return False
    fd, name = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)
    return True


def json_write(path, value, **kwargs):
    return write(path, (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)+'\n').encode(), **kwargs)


def broker_config(data, principal):
    allowed = ['$JS.API.INFO', '$JS.API.STREAM.INFO.*', '$JS.API.STREAM.CREATE.*',
               '$JS.API.CONSUMER.INFO.*.*', '$JS.API.CONSUMER.CREATE.*.>',
               '$JS.API.CONSUMER.DURABLE.CREATE.*.*',
               'brai.local_ai.v1.models.list', 'brai.local_ai.v1.models.get',
               'brai.local_ai.v1.models.install', 'brai.local_ai.v1.operations.get',
               'brai.local_ai.v1.models.configure']
    entry = json.dumps({'user': principal['user'], 'password': principal['password'],
                        'permissions': {'publish': {'allow': allowed},
                                        'subscribe': {'allow': ['_INBOX.brai_install.>']}}})
    text=data.decode()
    if entry in text:return data
    require(not re.search(r'(?:\"user\"|user)\s*[:=]\s*\"?'+re.escape(principal['user'])+r'(?:\"|[\s,}])',text),'INSTALL_BROKER_PRINCIPAL_CONFLICT')
    text, count = re.subn(r'((?:"users"|users)\s*:\s*\[)', lambda m: m.group(1)+entry+',', data.decode(), count=1)
    require(count == 1, 'INSTALL_BROKER_USERS_INVALID')
    return text.encode()


def validate(manifest):
    require(manifest.get('format') == 'brai-clean-install-v1', 'INSTALL_FORMAT_INVALID')
    require(not manifest.get('unresolved'), 'INSTALL_UNRESOLVED_SOURCES')
    require(set(manifest['source_revisions']) in ({'prod'}, {'dev', 'prod'}), 'INSTALL_ENVIRONMENTS_REQUIRED')
    require(all(manifest.get('streams', {}).get(t) is not None for t in manifest['source_revisions']), 'INSTALL_BROKER_DEFINITIONS_REQUIRED')
    for c in manifest['components']:
        a = c['artifact']
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', a['digest']) and a['reference'].endswith('@'+a['digest']), 'INSTALL_IMMUTABLE_ARTIFACT_REQUIRED')
    for path in manifest['config_paths']:
        require(path.startswith(('/etc/', '/home/agent/.codex/', '/srv/projects/', '/opt/', '/var/lib/')) and not any(f in path for f in FORBIDDEN), 'INSTALL_CONFIGURATION_PATH_INVALID')
    images = manifest.get('images', {})
    for project in manifest['projects'].values():
        for svc in project['document']['services'].values():
            image = svc['image']
            require(not image.startswith('sha256:') or image in images, 'INSTALL_LOCAL_IMAGE_WITHOUT_SOURCE')
            for m in svc.get('volumes', []):
                if m['type'] == 'bind':
                    path = m['source']
                    require(not any(x in path for x in FORBIDDEN if x != '/db/data/'), 'INSTALL_USER_DATA_MOUNT_INVALID')
                    require(path in manifest['config_paths'] or path in manifest['copies'] or path in manifest['directories'] or path in manifest.get('downloads', {}) or path in PACKAGED_BINDS or any(path.startswith(p) for p in manifest['generated_prefixes']) or path.startswith('/srv/projects/'), 'INSTALL_BIND_WITHOUT_SOURCE')
    return True


def payload_path(component):
    return Path('/opt/brai-components') / component['id'] / component['artifact']['digest'][7:]


def compose(name, *args):
    return docker('compose', '--project-name', name, '--file', str(PROJECTS / (name+'.json')), '--profile', '*', *args)


class Installer:
    def __init__(self, manifest, inputs):
        self.m, self.inputs = manifest, inputs
        if manifest.get('native_runtimes',{}).get('hermes',{}).get('software',{}).get('mode')=='install':
            import native_hermes
            native_hermes.validate_client_access(inputs)
            native_spec=native_hermes.validate(manifest['native_runtimes']['hermes'])
            native_hermes.validate_inputs(native_spec,inputs.get('native_hermes',{}))
        self.documents = {k: copy.deepcopy(v['document']) for k,v in manifest['projects'].items()}
        self.changed = False
        self.prepare_documents()

    def prepare_documents(self):
        for name, document in self.documents.items():
            for service, svc in document['services'].items():
                if name+'/'+service not in self.m.get('local_ai', {}): continue
                env = copy.deepcopy(self.inputs['environments'][name+'/'+service])
                config = json.loads(env['LOCAL_AI_CONFIG_JSON'])
                old = config['installer']['rootDirectory']
                if name != 'brai-dev':
                    new = '/var/lib/brai/local-ai/models'
                    config = json.loads(json.dumps(config).replace(old, new))
                    for mount in svc.get('volumes', []):
                        mount['source'] = mount['source'].replace(old, new)
                        mount['target'] = mount['target'].replace(old, new)
                config['installer']['maxOperationMs'] = 3_600_000
                config['installer']['maxDownloadBytes'] = 2_147_483_647
                config['transport']['maxRequestMs'] = max(config['transport']['maxRequestMs'], 3_600_000)
                for runtime in config['runtime'].values():
                    runtime['env'].pop('PYTHONHOME', None)
                    runtime['env'].pop('PYTHONPATH', None)
                    if 'LD_LIBRARY_PATH' in runtime['env']:
                        runtime['env']['LD_LIBRARY_PATH'] = runtime['cwd']+':/usr/lib/x86_64-linux-gnu'
                env['LOCAL_AI_CONFIG_JSON'] = json.dumps(config, separators=(',', ':'))
                self.inputs['environments'][name+'/'+service] = env
                gemma = config['runtime'].get('embeddinggemma2_llama_cpp')
                if gemma:
                    # AIDEV-NOTE: Клиентский image уже содержит pinned /app; пустой host mount скрыл бы его.
                    native_root = str(Path(gemma['cwd']).parent)
                    require(native_root.startswith('/opt/brai/local-ai/runtime/embeddinggemma2/'), 'INSTALL_GEMMA_RUNTIME_PATH_INVALID')
                    expected_copy = 'COPY --from=gemma /app ' + gemma['cwd'] + '\n'
                    require(any(r.get('kind') == 'local-ai' and expected_copy in r.get('dockerfile', '') for r in self.m['images'].values()), 'INSTALL_GEMMA_IMAGE_ASSET_REQUIRED')
                    for mount in svc['volumes']:
                        if mount.get('target') == native_root:
                            require(mount.get('source') == native_root and mount.get('read_only') is True, 'INSTALL_GEMMA_NATIVE_MOUNT_CONFLICT')
                    svc['volumes'] = [v for v in svc['volumes'] if v.get('target') != native_root]

    def inputs_stage(self):
        require(all(Path(p).is_file() for p in PACKAGED_BINDS), 'INSTALL_PACKAGED_EXECUTABLE_MISSING')
        require(set(self.inputs.get('files', {})) == set(self.m['config_paths']), 'INSTALL_INPUT_FILES_INCOMPLETE')
        for name in self.m['projects']:
            for service, svc in self.m['projects'][name]['document']['services'].items():
                if svc.get('env_file'):
                    require(name+'/'+service in self.inputs.get('environments', {}), 'INSTALL_SERVICE_ENVIRONMENT_MISSING')
        for path, item in sorted(self.m['directories'].items(), key=lambda p: len(Path(p[0]).parts)):
            p = Path(path)
            require(not any(q.is_symlink() for q in [p,*p.parents]), 'INSTALL_DIRECTORY_SYMLINK')
            if not p.exists(): p.mkdir(parents=True)
            os.chmod(p, item['mode'])
            os.chown(p, item['uid'], item['gid'])
        for path in ['/var/lib/brai-agent', '/var/lib/brai-agent/read-state', '/var/lib/brai-agent/staging',
                     '/var/lib/brai-agent/results', '/home/agent/.codex/generated_images']:
            p = Path(path)
            if not p.exists():
                p.mkdir(parents=True)
                identity = pwd.getpwnam('agent')
                os.chown(p, identity.pw_uid, identity.pw_gid)
                os.chmod(p, 0o700)
        # SQL/system configs contain settings, never table rows or filesystem backups.
        for path, item in self.inputs['files'].items():
            data = base64.b64decode(item['content'], validate=True)
            require(len(data) <= 2*1024*1024, 'INSTALL_CONFIG_TOO_LARGE')
            require(not data.startswith((b'\x1f\x8b', b'PK\x03\x04', b'SQLite format', b'PGDMP')), 'INSTALL_ARCHIVE_INPUT_REJECTED')
            if path in self.m.get('broker_configs', ['/etc/brai/alerts-candidate/nats.conf']):
                data = broker_config(data, self.inputs['provision'])
            self.changed |= self.write_configuration(path, data, item)
            os.chown(path, item['uid'], item['gid'])
        for path, item in self.m['copies'].items():
            source=Path(item['source']); require(sha(source)==item['sha256'], 'INSTALL_GIT_SOURCE_CHANGED')
            self.changed |= write(path,source.read_bytes(),item['mode'],only_new=True)
        self.prepare_proxy()
        json_write(ROOT/'owner.json', {'format':'brai-clean-install-owner-v1','manifest':sha(ROOT/'baseline.json')},only_new=True)

    def write_configuration(self,path,data,item):
        """Сохранить принятые закрытые настройки при повторе установки."""
        return write(path,data,item['mode'],only_new=True)

    def prepare_proxy(self):
        """Создать HTTPS-конфигурацию только для объявленного клиентского домена."""
        if self.m.get('scope') != 'product': return
        origin=self.inputs.get('public_origin', '')
        require(re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?', origin), 'INSTALL_PUBLIC_ORIGIN_REQUIRED')
        text='import /etc/caddy/artifact-attachments.caddy\nimport /etc/caddy/extra/*.caddy\n'+origin.removeprefix('https://')+' {\n encode gzip\n reverse_proxy web:3000 {\n  flush_interval -1\n }\n import artifact-attachment\n import artifact-upload\n}\n'
        self.changed |= write('/etc/brai/caddy/Caddyfile',text.encode(),0o644,only_new=True)

    def sources_stage(self):
        # Isolated registry auth, supplied only through the private input, never argv.
        registry=self.inputs.get('registry')
        if registry:
            private=ROOT/'docker'; private.mkdir(mode=0o700,exist_ok=True)
            os.environ['DOCKER_CONFIG']=str(private)
            docker('login','ghcr.io','--username',registry['username'],'--password-stdin',data=registry['token']+'\n')
        for c in self.m['components']:
            dest=payload_path(c)
            if c['artifact']['metadata']['deliveryKind']=='external-cli':
                self.prepare_external_cli(c,dest)
                continue
            if not dest.exists():
                docker('pull',c['artifact']['reference'])
                cid=docker('create','--entrypoint','/not-executed',c['artifact']['reference']).stdout.strip()
                require(bool(re.fullmatch('[0-9a-f]{64}',cid)), 'INSTALL_CONTAINER_ID_INVALID')
                dest.parent.mkdir(parents=True,exist_ok=True)
                with tempfile.TemporaryDirectory(prefix='.download-',dir=dest.parent) as tmp:
                    try: docker('cp',cid+':/payload/.',tmp)
                    finally: docker('rm',cid)
                    run(['/usr/bin/chown','-hR','root:root',tmp])
                    os.chmod(tmp,0o755)
                    self.verify_payload(c,Path(tmp))
                    os.rename(tmp,dest)
                self.changed=True
            self.verify_payload(c,dest)
        for path, source in self.m.get('downloads', {}).items():
            if Path(path).exists():
                require(sha(path) == source['sha256'], 'INSTALL_DOWNLOADED_FILE_CHANGED')
                continue
            with urllib.request.urlopen(source['url'], timeout=120) as response:
                data = response.read(2*1024*1024+1)
            require(hashlib.sha256(data).hexdigest() == source['sha256'], 'INSTALL_SOURCE_DOWNLOAD_INVALID')
            write(path, data, source['mode'])
            self.changed = True
        self.prepare_program_links()
        for spec in self.m.get('native_runtimes', {}).values():
            import native_hermes
            if spec['software']['mode'] == 'install':
                self.changed |= native_hermes.install_software(spec, self.inputs['native_hermes'],
                    askpass=ROOT/'git-askpass.py', install_root=ROOT)
        for repo in self.m.get('npm_repositories', ['/srv/projects/brai']):
            if not Path(repo+'/node_modules/.package-lock.json').exists():
                run(['/usr/sbin/runuser', '-u', 'agent', '--', '/usr/bin/env', '--chdir='+repo,
                     '/usr/local/bin/npm', 'ci', '--no-audit', '--no-fund'])
                self.changed = True
        self.build_images()
        self.record_runtime_images()
        self.prepare_local_ai_assets()
        self.extra_sources()
        self.render_projects()
        run(['/usr/bin/python3','-B',str(ROOT/'validate_render.py'),str(ROOT/'baseline.json'),str(ROOT/'inputs.json')])

    def prepare_program_links(self):
        """Разложить все установленные native payload, включая программы без запуска unit."""
        for target,environment in self.m['operator']['environments'].items():
            for name,instances in environment['components'].items():
                if name not in self.m['installed'].get(target,{}):continue
                for instance in instances:
                    if instance['kind']=='program':
                        self.link(instance['link'],payload_path(self.component(target,name)))

    def prepare_external_cli(self,component,destination):
        """Проверить CLI из immutable image до записи настоящего descriptor."""
        descriptor=destination/'external.json'
        expected={'artifact':component['artifact'],'verified':True}
        if descriptor.exists():
            require(json.loads(descriptor.read_text())==expected,'INSTALL_EXTERNAL_DESCRIPTOR_CHANGED')
        reference=component['artifact']['reference']
        if docker('image','inspect',reference,optional=True).returncode:
            docker('pull',reference)
            self.changed=True
        docker('run','--rm','--pull=never','--network=none','--read-only',
               '--cap-drop=ALL','--security-opt=no-new-privileges:true',
               '--tmpfs','/tmp:rw,nosuid,nodev,size=16m',reference,'--help')
        self.changed |= json_write(descriptor,expected,only_new=True)

    def record_runtime_images(self):
        """Записать измеренные image IDs и рецепты для последующего штатного выпуска."""
        recipes={}
        for recipe in self.m['images'].values():
            if recipe['kind']=='owner':continue
            identity=json.loads(docker('image','inspect',recipe['reference']).stdout)[0]['Id']
            require(re.fullmatch(r'sha256:[0-9a-f]{64}',identity),'INSTALL_RUNTIME_IMAGE_INVALID')
            if identity in recipes:require(recipes[identity]==recipe,'INSTALL_RUNTIME_RECIPE_CONFLICT')
            recipes[identity]=recipe
        json_write(ROOT/'runtime-recipes.json',{'format':'brai-clean-install-runtime-recipes-v1',
                   'manifest':sha(ROOT/'baseline.json'),'images':recipes})
        records={}
        version=run(['/usr/local/bin/node','--version']).stdout.strip().removeprefix('v')
        checked=set()
        for target,environment in self.m['operator']['environments'].items():
            for name,instances in environment['components'].items():
                if not any(i['kind']=='compose' and not i.get('deliveryImage') for i in instances):continue
                component=self.component(target,name)
                meta=json.loads((payload_path(component)/'artifact-manifest.json').read_text())
                if 'Node.js '+version not in meta.get('systemRequirements',[]):continue
                for instance in instances:
                    if instance['kind']!='compose' or instance.get('deliveryImage'):continue
                    service=self.documents[instance['project']]['services'][instance['service']]
                    recipe=self.m['images'].get(service['image'])
                    reference=recipe['reference'] if recipe else service['image']
                    identity=json.loads(docker('image','inspect',reference).stdout)[0]['Id']
                    require(re.fullmatch(r'sha256:[0-9a-f]{64}',identity),'INSTALL_RUNTIME_IMAGE_INVALID')
                    if identity not in checked:
                        measured=docker('run','--rm','--network=none','--read-only','--cap-drop=ALL',
                                        '--entrypoint','/usr/local/bin/node',reference,'--version').stdout.strip()
                        require(measured=='v'+version,'INSTALL_NODE_RUNTIME_VERSION_MISMATCH')
                        checked.add(identity)
                    records[instance['container']]={'version':version,'base':identity,'image':identity}
        provenance=RUNTIME_IMAGES
        if provenance.exists():
            info=provenance.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==0
                    and stat.S_IMODE(info.st_mode)==0o600,'INSTALL_RUNTIME_PROVENANCE_PERMISSIONS')
            old=json.loads(provenance.read_text())
            require(all(records.get(key)==value for key,value in old.items()),'INSTALL_RUNTIME_PROVENANCE_CHANGED')
        json_write(provenance,records)

    def component(self,target,component):
        digest=self.m['installed'][target][component]
        return next(c for c in self.m['components'] if c['id']==component and c['artifact']['digest']==digest)

    @staticmethod
    def link(path,target):
        p=Path(path); p.parent.mkdir(parents=True,exist_ok=True)
        if p.is_symlink(): require(p.resolve()==target,'INSTALL_RUNTIME_LINK_CHANGED')
        else:
            require(not p.exists(),'INSTALL_RUNTIME_LINK_OCCUPIED'); p.symlink_to(target)

    @staticmethod
    def verify_payload(component,path):
        manifest=json.loads((path/'artifact-manifest.json').read_text())
        require(manifest['componentId']==component['id'] and manifest['payloadHash']==component['artifact']['metadata']['payloadHash'], 'INSTALL_PAYLOAD_IDENTITY_INVALID')
        actual=[]
        for p in sorted(path.rglob('*')):
            if p.is_dir() and not p.is_symlink() or p==path/'artifact-manifest.json': continue
            require(p.is_symlink() or p.is_file(), 'INSTALL_PAYLOAD_TYPE_INVALID')
            require(p.resolve().is_relative_to(path.resolve()), 'INSTALL_PAYLOAD_SYMLINK_ESCAPE')
            data=os.readlink(p).encode() if p.is_symlink() else p.read_bytes()
            item={'path':p.relative_to(path).as_posix(),'sha256':hashlib.sha256(data).hexdigest(),'size':len(data),'mode':stat.S_IMODE(p.lstat().st_mode)}
            if p.is_symlink(): item['symlink']=os.readlink(p)
            actual.append(item)
        actual.sort(key=lambda x:x['path'])
        require(actual==manifest['files'], 'INSTALL_PAYLOAD_CHECKSUM_INVALID')
        encoded=json.dumps({'files':actual,'runtime':manifest['runtime'],'runtimePackages':manifest['runtimePackages']},ensure_ascii=False,separators=(',',':'))
        require(hashlib.sha256(encoded.encode()).hexdigest()==manifest['payloadHash'],'INSTALL_PAYLOAD_MANIFEST_CHANGED')

    def build_images(self):
        for old, recipe in self.m['images'].items():
            if recipe['kind']=='pull':
                if docker('image','inspect',recipe['reference'],optional=True).returncode:
                    docker('pull',recipe['reference']); self.changed=True
                continue
            if recipe['kind']=='owner': continue
            tag=recipe['reference']
            if not docker('image','inspect',tag,optional=True).returncode: continue
            with tempfile.TemporaryDirectory(prefix='build-',dir=ROOT) as tmp:
                context=Path(tmp)
                if recipe['kind']=='local-ai':
                    source=self.local_ai_source()/'runners/gigaam/requirements.lock'
                    shutil.copyfile(source,context/'requirements.lock')
                write(context/'Dockerfile',recipe['dockerfile'].encode())
                docker('build','--pull','--tag',tag,tmp)
                self.changed=True

    def local_ai_source(self):
        """Брать общие runtime assets из принятого PROD независимо от порядка сред."""
        return payload_path(self.component('prod','local-ai'))/'services/local-ai'

    def prepare_local_ai_assets(self):
        profile = self.local_ai_source()/'profiles/gigaam_pytorch.json'
        for aux in json.loads(profile.read_text())['auxiliarySources']:
            directory = Path('/var/lib/brai/local-ai/vad')/aux['revision']
            directory.mkdir(parents=True, exist_ok=True)
            for entry in aux['files']:
                dest = directory/entry['path']
                if dest.exists():
                    require(sha(dest) == entry['sha256'], 'INSTALL_AUXILIARY_BYTES_CHANGED')
                    continue
                request = urllib.request.Request('https://huggingface.co/'+aux['repository']+'/resolve/'+aux['revision']+'/'+entry['path'])
                if self.inputs.get('hf_token'): request.add_header('Authorization', 'Bearer '+self.inputs['hf_token'])
                with urllib.request.urlopen(request, timeout=120) as response:
                    data = response.read(entry['bytes']+1)
                require(len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256'], 'INSTALL_AUXILIARY_DOWNLOAD_INVALID')
                write(dest, data, 0o644)
                self.changed = True
            owner = json.loads((profile.parent.parent/aux['manifest']).read_text())
            json_write(directory/aux['installedManifest'], owner, mode=0o644)
        for name, document in self.documents.items():
            for service, svc in document['services'].items():
                if name+'/'+service not in self.m['local_ai']: continue
                for mount in svc['volumes']:
                    source = mount['source']
                    if not source.startswith(('/var/lib/brai/local-ai/', '/var/lib/brai-dev/local-ai/', '/opt/brai/local-ai/')): continue
                    if name == 'brai-dev' and source.startswith('/var/lib/brai/local-ai/models/'): continue
                    path = Path(source)
                    if not path.exists():
                        path.mkdir(parents=True)
                        os.chown(path, 1000, 1000)
                        os.chmod(path, 0o755)
                config = json.loads(self.inputs['environments'][name+'/'+service]['LOCAL_AI_CONFIG_JSON'])
                for source in [config['installer']['rootDirectory'], config['artifacts']['tempRoot']]:
                    path = Path(source)
                    path.mkdir(parents=True, exist_ok=True)
                    os.chown(path, 1000, 1000)
                    os.chmod(path, 0o750)

    def prepare_hf_cache(self):
        recipe = next(r for r in self.m['images'].values() if r['kind'] == 'local-ai')
        profile = self.local_ai_source()/'profiles/gigaam_pytorch.json'
        meta = json.loads(profile.read_text())
        model = Path('/var/lib/brai/local-ai/models')/meta['modelId']/meta['source']['revision']/meta['profileId']
        source = ROOT/'prepare-transformers-cache.py'
        require(source.is_file(), 'INSTALL_HELPER_SOURCE_MISSING')
        for name, document in self.documents.items():
            for service, svc in document['services'].items():
                if name+'/'+service not in self.m['local_ai']: continue
                for mount in svc['volumes']:
                    if '/hf-modules-cache' not in mount['source']: continue
                    target = Path(mount['source'])
                    if (target/'transformers_modules/gigaam_pytorch/modeling_gigaam.py').is_file(): continue
                    with tempfile.TemporaryDirectory(prefix='hf-cache-', dir=ROOT) as tmp:
                        temp = Path(tmp)
                        (temp/'home').mkdir(); (temp/'hf').mkdir()
                        json_write(temp/'manifest.json', meta['source'], mode=0o644)
                        docker('run', '--rm', '--network', 'none', '--user', '0:0',
                               '--volume', str(temp)+':/prepare', '--volume', str(model)+':/model/gigaam_pytorch:ro',
                               '--volume', str(source)+':/prepare-helper.py:ro', '--env', 'HOME=/prepare/home',
                               '--env', 'HF_HOME=/prepare/hf', '--env', 'TMPDIR=/tmp',
                               '--env', 'HF_MODULES_CACHE=/prepare/cache', '--env', 'HF_HUB_OFFLINE=1',
                               '--env', 'TRANSFORMERS_OFFLINE=1', '--entrypoint',
                               '/opt/brai/local-ai/runtime/gigaam_pytorch/.venv/bin/python', recipe['reference'],
                               '/prepare-helper.py', '--model-dir', '/model/gigaam_pytorch',
                               '--cache-dir', '/prepare/cache', '--manifest', '/prepare/manifest.json')
                        shutil.copytree(temp/'cache', target, dirs_exist_ok=True)

    def render_projects(self):
        for name, document in self.documents.items():
            for service,svc in document['services'].items():
                recipe=self.m['images'].get(svc['image'])
                if recipe: svc['image']=recipe['reference']
                svc.pop('env_file',None)
                env=copy.deepcopy(self.inputs.get('environments',{}).get(name+'/'+service,{}))
                if env: svc['environment']={k:v.replace('$','$$') if isinstance(v,str) else v for k,v in env.items()}
            json_write(str(PROJECTS / (name+'.json')),document)
            # Codeworks owns future releases at its declared accepted paths.
            for env in self.m['operator']['environments'].values():
                if name in env['projects']:
                    json_write(env['projects'][name]['accepted'], document)
        # Per-project units keep restart configuration separate from installation.
        for name,document in self.documents.items():
            services=[n for n,s in document['services'].items() if not s.get('profiles')]
            if name=='brai': services.append('supabase-mcp')
            if name=='brai-artifacts': services.append('artifacts-mcp')
            cmd='/usr/bin/docker compose --project-name '+name+' --file '+str(PROJECTS/(name+'.json'))
            unit='[Unit]\nRequires=docker.service\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nRemainAfterExit=yes\nTimeoutStartSec=0\nExecStart='+cmd+' up --detach --no-build --pull never '+' '.join(services)+'\nExecStop='+cmd+' stop\n[Install]\nWantedBy=multi-user.target\n'
            write('/etc/systemd/system/brai-install-'+name+'.service',unit.encode(),0o644)

    def infrastructure_stage(self):
        for name,cfg in self.m['networks'].items():
            if not docker('network','inspect',name,optional=True).returncode: continue
            args=['network','create','--driver',cfg['driver']]
            if cfg['internal']: args+=['--internal']
            for block in cfg['ipam']:
                if block.get('Subnet'): args+=['--subnet',block['Subnet']]
                if block.get('Gateway'): args+=['--gateway',block['Gateway']]
                if block.get('IPRange'): args+=['--ip-range',block['IPRange']]
            for k,v in cfg.get('options',{}).items(): args+=['--opt',k+'='+v]
            docker(*args,name); self.changed=True
        for name in self.m['volumes']:
            if docker('volume','inspect',name,optional=True).returncode:
                docker('volume','create',name)
                volume=json.loads(docker('volume','inspect',name).stdout)[0]['Mountpoint']
                permissions=self.m['volume_permissions'][name]
                os.chown(volume,permissions['uid'],permissions['gid'])
                os.chmod(volume,permissions['mode'])
                self.changed=True
        self.prepare_artifacts_volume()
        # Applications and Caddy are started only after owner schemas exist.
        infra=self.documents['brai-infrastructure']['services']
        compose('brai-infrastructure','up','--detach','--no-deps','supabase-db')
        self.wait_postgres()
        if 'nats' in infra: compose('brai-infrastructure','up','--detach','--no-deps','nats')
        self.extra_infrastructure()

    def prepare_artifacts_volume(self):
        """Создать owner-подкаталоги до монтирования files subpath; данные не менять."""
        project=self.documents.get('brai-artifacts')
        if not project:return
        service=project['services']['artifacts']
        mount=next(v for v in service['volumes'] if v['target']=='/var/lib/brai-artifacts')
        volume=project['volumes'][mount['source']]['name']
        root=Path(json.loads(docker('volume','inspect',volume).stdout)[0]['Mountpoint'])
        require(not root.is_symlink(),'INSTALL_ARTIFACTS_VOLUME_UNSAFE')
        folders={'files':0o750,'tmp':0o700}
        present=list(root.iterdir())
        require(all(p.name in folders and p.is_dir() and not p.is_symlink() for p in present),'INSTALL_ARTIFACTS_VOLUME_UNSAFE')
        if all((root/name).is_dir() for name in folders):
            require(all((root/name).stat().st_uid==1000 and (root/name).stat().st_gid==1000
                        and stat.S_IMODE((root/name).stat().st_mode)==mode for name,mode in folders.items()),
                    'INSTALL_ARTIFACTS_VOLUME_PERMISSIONS')
            return
        require(all(not any(p.iterdir()) for p in present),'INSTALL_ARTIFACTS_PARTIAL_VOLUME_HAS_DATA')
        source="""const f=require('node:fs/promises');const root='/var/lib/brai-artifacts';
(async()=>{await f.mkdir(root,{recursive:true});
for(const [name,mode] of [['files',0o750],['tmp',0o700]]){
const path=root+'/'+name;await f.mkdir(path,{recursive:true});await f.chown(path,1000,1000);await f.chmod(path,mode);}
await f.chown(root,1000,1000);await f.chmod(root,0o750);})().catch(()=>process.exit(1));"""
        docker('run','--rm','--network=none','--user','0:0','--volume',volume+':/var/lib/brai-artifacts',
               '--entrypoint','/usr/local/bin/node',service['image'],'-e',source)
        require(all((root/name).is_dir() for name in folders),'INSTALL_ARTIFACTS_VOLUME_NOT_READY')
        self.changed=True

    @staticmethod
    def wait_postgres():
        """Дождаться готовности PostgreSQL после первого запуска или смены HBA path."""
        for attempt in range(120):
            if not docker('exec','--user','postgres','supabase-db','pg_isready','-U','supabase_admin',optional=True).returncode:return
            time.sleep(2)
        raise ValueError('INSTALL_POSTGRES_NOT_READY')

    def activate_hba(self,setting):
        """Применить postmaster-настройку до приложений и проверить прочтение HBA."""
        if self.sql('SHOW hba_file;') != setting:
            self.sql("ALTER SYSTEM SET hba_file = '"+setting+"';")
            docker('restart','supabase-db')
            self.wait_postgres()
            self.changed=True
        require(self.sql('SHOW hba_file;')==setting,'INSTALL_POSTGRES_HBA_NOT_ACTIVE')
        self.sql('SELECT pg_reload_conf();')
        require(self.sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;')=='0',
                'INSTALL_POSTGRES_HBA_INVALID')

    @staticmethod
    def sql(statement,database='postgres'):
        return docker('exec','-i','--user','postgres','supabase-db','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',database,'-At',data=statement).stdout.strip()

    def databases_stage(self):
        quote=lambda s:'"'+s.replace('"','""')+'"'
        literal=lambda s:"'"+s.replace("'","''")+"'"
        for r in self.inputs['roles']:
            if r['name'].startswith('brai_dev_memos'): continue
            if not self.sql('SELECT 1 FROM pg_roles WHERE rolname='+literal(r['name'])):
                stmt='CREATE ROLE '+quote(r['name'])+(' LOGIN' if r['login'] else ' NOLOGIN')
                stmt += ' INHERIT' if r.get('inherit', True) else ' NOINHERIT'
                if r.get('password'): stmt+=' PASSWORD '+literal(r['password'])
                self.sql(stmt+';'); self.changed=True
        for d in self.m['databases']:
            if d['name'] == 'brai_dev_memos': continue
            if not self.sql('SELECT 1 FROM pg_database WHERE datname='+literal(d['name'])):
                self.sql('CREATE DATABASE '+quote(d['name'])+' OWNER '+quote(d['owner'])+';');self.changed=True
        for member in self.m.get('role_memberships', []):
            if any(v.startswith('brai_dev_memos') for v in member.values()): continue
            self.sql('GRANT '+quote(member['role'])+' TO '+quote(member['member'])+';')
        volume=json.loads(docker('volume','inspect','supabase_db-config').stdout)[0]['Mountpoint']
        hba=Path(volume)/'brai-clean-install-hba.conf'
        # MemOS later adds its new block through its own owner lifecycle.
        if not hba.exists(): write(hba,self.m['postgres_hba'].encode(),0o644)
        setting='/etc/postgresql-custom/brai-clean-install-hba.conf'
        self.activate_hba(setting)
        run(['/usr/local/bin/node',str(ROOT/'install_models.mjs'),'brokers',str(ROOT/'inputs.json'),str(ROOT/'baseline.json')])

    def migrations_stage(self):
        for name,document in self.documents.items():
            for service,svc in document['services'].items():
                if 'migration' in svc.get('profiles',[]): compose(name,'run','--rm','--no-deps',service)
        for target,env in self.m['operator']['environments'].items():
            for component,instances in env['components'].items():
                for i in instances:
                    owner=i.get('ownerContainer')
                    if not owner: continue
                    svc=self.documents[i['project']]['services'][i['service']]
                    args=['run','--rm','--network',owner['network'],'--env-file',owner['env']]
                    c=self.component(target,component)
                    args+=['--volume',str(payload_path(c))+':/payload:ro','--workdir','/payload','--entrypoint','/usr/local/bin/node',IMAGE_NODE,*owner['command']]
                    docker(*args)
        self.extra_migrations()

    def program_env(self,unit):
        return dict(os.environ,**self.inputs.get('program_environment',{}).get(unit,{}))

    def applications_stage(self):
        for name,document in self.documents.items():
            services=[s for s,v in document['services'].items() if not v.get('profiles') and s!='caddy' and not(name=='brai-dev' and s=='local-ai')]
            if name=='brai': services.append('supabase-mcp')
            if name=='brai-artifacts': services.append('artifacts-mcp')
            if services: compose(name,'up','--detach','--no-build','--pull','never','--no-deps',*services)
        run(['/usr/bin/systemctl','daemon-reload'])
        for unit,program in self.m['programs'].items():
            if program.get('nativeRuntime'):
                require(program['nativeRuntime'] == 'hermes', 'INSTALL_NATIVE_RUNTIME_UNKNOWN')
                import native_hermes
                spec=self.m['native_runtimes']['hermes']
                if spec['software']['mode']=='install':
                    self.changed |= native_hermes.prepare(spec, self.inputs['native_hermes'])
                continue
            runtime=Path(program['link'])
            env=self.inputs.get('program_environment',{}).get(unit,{})
            content=''.join(k+'='+json.dumps(v,ensure_ascii=False)+'\n' for k,v in env.items())
            env_path='/etc/brai-install/programs/'+unit+'.env'
            write(env_path,content.encode())
            files=[env_path,*program.get('environmentFiles',[])]
            text='[Unit]\nAfter=docker.service network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=agent\nGroup=agent\nWorkingDirectory='+str(runtime/program['program']['workingDir'])+'\n'+''.join('EnvironmentFile='+f+'\n' for f in files)+'ExecStart=/usr/local/bin/node '+str(runtime/program['program']['entrypoint'])+'\nRestart=on-failure\nRestartSec=5\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n'
            write('/etc/systemd/system/'+unit,text.encode(),0o644)
        run(['/usr/bin/systemctl','daemon-reload'])

    def models_stage(self):
        for target in sorted(self.m['source_revisions'], key=lambda target: target != 'prod'):
            if target == 'dev': self.extra_model_start()
            run(['/usr/local/bin/node',str(ROOT/'install_models.mjs'),target,str(ROOT/'inputs.json'),str(ROOT/'baseline.json')])
            self.prepare_hf_cache()

    def extra_sources(self):
        """Hook дополнительных исходников; самостоятельной установке не нужен."""

    def extra_infrastructure(self):
        """Hook дополнительной инфраструктуры оператора."""

    def extra_migrations(self):
        """Hook миграций дополнительных компонентов оператора."""

    def extra_model_start(self):
        """Hook запуска дополнительного экземпляра Local AI."""

    def verify_extras(self):
        """Hook независимой проверки дополнения оператора."""

    def host_services_stage(self):
        self.activate_native_runtimes()
        mcp=run(['/usr/bin/python3','-B',str(ROOT/'configure_mcp.py')])
        if 'INSTALL_PRODUCT_MCP_CHANGED' in mcp.stdout: run(['/usr/bin/systemctl','restart','codex-native-agent.service'])
        run(['/usr/bin/systemctl','daemon-reload'])
        for unit in self.m['programs']: run(['/usr/bin/systemctl','enable','--now',unit])
        for name in self.documents: run(['/usr/bin/systemctl','enable','--now','brai-install-'+name+'.service'])

    def activate_native_runtimes(self):
        """Завершить явную клиентскую установку после models и real native acceptance."""
        if self.m.get('native_runtimes', {}).get('hermes'):
            import native_hermes
            spec=self.m['native_runtimes']['hermes'];inputs=self.inputs['native_hermes']
            native_hermes.operate('prepare',spec,inputs,start=True)
            native_hermes.wait_dependencies()
            memos=native_hermes.memory(spec)
            if not memos.ACCEPTANCE.exists():native_hermes.operate('accept-memory',spec,inputs)
            native_hermes.operate('activate',spec,inputs)

    def check_https(self):
        interfaces=json.loads(run(['/usr/sbin/ip','-j','address','show','scope','global']).stdout)
        local={entry['local'] for interface in interfaces for entry in interface.get('addr_info',[])}
        for url in self.inputs.get('public_urls', []):
            host=urllib.parse.urlsplit(url).hostname
            addresses={entry[4][0] for entry in socket.getaddrinfo(host,443)}
            require(addresses and addresses.issubset(local),'INSTALL_PUBLIC_DNS_NOT_LOCAL')
            for attempt in range(12):
                try:
                    with urllib.request.urlopen(url,timeout=10) as response: code=response.status
                except urllib.error.HTTPError as error: code=error.code
                except (OSError,urllib.error.URLError): code=0
                if code==401: break
                time.sleep(2)
            else: raise ValueError('INSTALL_PUBLIC_HTTPS_NOT_READY')

    def verify_stage(self):
        # Full health, including Local AI weights, rather than a successful process launch.
        for name,document in self.documents.items():
            services=[s for s,v in document['services'].items() if not v.get('profiles')]
            if name=='brai': services.append('supabase-mcp')
            if name=='brai-artifacts': services.append('artifacts-mcp')
            for service in services:
                ids=compose(name,'ps','--quiet',service).stdout.split()
                require(len(ids)==1,'INSTALL_SERVICE_NOT_RUNNING')
                for attempt in range(120):
                    state=json.loads(docker('inspect',ids[0]).stdout)[0]['State']
                    if state['Running'] and (not state.get('Health') or state['Health']['Status']=='healthy'): break
                    time.sleep(2)
                else: raise ValueError('INSTALL_SERVICE_NOT_HEALTHY')
        for unit,program in self.m['programs'].items():
            run(['/usr/bin/systemctl','is-active','--quiet',unit])
            if program.get('healthCommand'):
                for attempt in range(60):
                    if not run(program['healthCommand'],env=dict(os.environ,**program.get('healthEnv',{})),timeout=20,optional=True).returncode: break
                    time.sleep(2)
                else: raise ValueError('INSTALL_PROGRAM_NOT_READY')
        run(['/usr/bin/systemctl','is-active','--quiet','codex-native-agent.service'])
        self.verify_extras()
        self.check_https()


def main(installer_class=Installer):
    parser=argparse.ArgumentParser()
    parser.add_argument('stage',choices=('validate',)+STAGES)
    parser.add_argument('--manifest',required=True)
    parser.add_argument('--inputs')
    parser.add_argument('--root', default='/var/lib/brai-install')
    args=parser.parse_args()
    global ROOT, PROJECTS
    ROOT=Path(args.root)
    PROJECTS=ROOT/'projects'
    manifest=json.loads(Path(args.manifest).read_text())
    validate(manifest)
    if args.stage=='validate': print('INSTALL_CONTRACT_VALID'); return
    require(os.geteuid()==0,'INSTALL_ROOT_REQUIRED')
    require(ROOT.is_dir(), 'INSTALL_CONTROL_DIRECTORY_REQUIRED')
    with (ROOT/'lock').open('r' if args.stage=='verify' else 'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        inputs=json.loads(Path(args.inputs).read_text())
        require(inputs.get('manifest_sha256') == sha(args.manifest), 'INSTALL_PROTECTED_MANIFEST_MISMATCH')
        installer=installer_class(manifest,inputs)
        os.environ['DOCKER_CONFIG']=str(ROOT/'docker')
        os.environ['BRAI_INSTALL_ROOT']=str(ROOT)
        os.environ['BRAI_INSTALL_NPM_ROOT']='/srv/projects/brai'
        getattr(installer,args.stage+'_stage')()
        print('INSTALL_CHANGED' if installer.changed else 'INSTALL_STAGE_CHECKED')


if __name__=='__main__':
    try: main()
    except Exception as error:
        # No argv, URL, SQL, input bytes or child output may leak via Ansible failure.
        code=str(error)
        print(code if re.fullmatch(r'INSTALL_[A-Z_]+',code) else 'INSTALL_FAILED_'+type(error).__name__,file=__import__('sys').stderr)
        raise SystemExit(1)
