#!/usr/bin/env python3
# ABOUTME: Готовит защищённый тестовый комплект для явно заданного клиентского манифеста.
# ABOUTME: Привязывает входы к SHA кандидата, создаёт локальные секреты и сохраняет шаблоны Ansible.
import argparse
import base64
from contextlib import contextmanager
import gzip
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler

import yaml

ORIGIN = 'https://brai-ci.localhost'
RESEND_INPUT = '/srv/projects/brai/.secrets/resend_api_key.env'
LOCAL_SECRET = re.compile(r'@CI_SECRET\(([a-z0-9_-]+)\)@')
TELEGRAM_TEST_TOKEN = '@TELEGRAM_TEST_BOT_TOKEN@'
IDENTITY_FIELDS = {
    'instance': 'brai_identity_instance',
    'settings': 'brai_identity_settings',
    'control': 'brai_identity_control_config',
    'services': 'brai_identity_service_configs',
    'ingress': 'brai_identity_ingress_environment',
    'managedMemos': 'brai_identity_managed_memos_config',
}


class Literal(str):
    """Значение, требующее передачи через Ansible без подстановки Jinja."""


class AnsibleDumper(yaml.SafeDumper):
    """Сохраняет обычные YAML-типы и явно помеченные буквальные строки."""


AnsibleDumper.add_representer(Literal, lambda dumper, value: dumper.represent_scalar('!unsafe', str(value)))


def manifest_hash(manifest):
    """Использовать каноническую сериализацию Ansible-установщика."""
    return hashlib.sha256((json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()).hexdigest()


def check_manifest(manifest, source):
    """Сверить целевой SHA и границу клиентского состава."""
    if (not re.fullmatch(r'[0-9a-f]{40}', source) or manifest.get('scope') != 'product'
            or manifest.get('format') != 'brai-clean-install-v1'
            or manifest.get('source_revisions') != {'prod': source}
            or set(manifest.get('installed', {})) != {'prod'}):
        raise ValueError('Expected a product manifest for the exact requested Brai SHA')


def service_names(manifest):
    """Вернуть имена всех сервисов с отдельными входными переменными."""
    return {f'{name}/{service}' for name, project in manifest['projects'].items()
            for service, config in project['document']['services'].items() if config.get('env_file')}


def template(manifest):
    """Создать заготовку полей из выбранного манифеста для отдельного тестового экземпляра."""
    owners = sorted({database['owner'] for database in manifest['databases']})
    result = {
        'files': {path: dict(text=None, mode=None, uid=None, gid=None) for path in manifest['config_paths']},
        'environments': dict.fromkeys(sorted(service_names(manifest))),
        'program_environment': dict.fromkeys(sorted(manifest['programs'])),
        'roles': [dict(name=owner, login=True, inherit=False, password=f'@CI_SECRET(db-{owner})@') for owner in owners],
        'provision': dict(user='brai_install', password='@CI_SECRET(nats-provision)@'),
        'mcp_servers': {},
        'public_origin': ORIGIN,
        'public_urls': [],
    }
    if 'brai' in manifest.get('identity_telegram', {}).get('projects', {}):
        result['files'].pop(RESEND_INPUT, None)
        result.update(identity_mode='telegram', identity_auth_project='brai',
                      identity_deployment={
                          'instance': 'production',
                          'settings': {'parentUnit': 'brai-hermes-production.service'},
                          'control': None,
                          'services': None,
                          'ingress': None,
                          'managedMemos': {
                              'freshInstall': True,
                              'technicalProviders': [],
                              'providerDescriptor': {'variant': 'external-http-v1', 'llm': None, 'embedding': None},
                              'sdkDistribution': manifest.get('identity_memos_sdk_distribution'),
                          },
                      })
    return result


def check_identity(manifest, inputs):
    mode = inputs.get('identity_mode', 'email')
    if 'identity_bootstrap' in inputs:
        raise ValueError('Use an empty identity registry for the clean installation')
    if mode == 'email':
        if 'identity_deployment' in inputs or 'identity_auth_project' in inputs:
            raise ValueError('Use Telegram mode with identity deployment settings')
        return
    if mode != 'telegram' or inputs.get('identity_auth_project') != 'brai':
        raise ValueError('Use the standalone Telegram Auth project brai')
    identity = manifest.get('identity_telegram', {})
    if identity.get('format') != 'brai-identity-telegram-v1' or 'brai' not in identity.get('projects', {}):
        raise ValueError('The candidate manifest does not declare Telegram support for brai')
    deployment = inputs.get('identity_deployment')
    if not isinstance(deployment, dict) or set(deployment) != set(IDENTITY_FIELDS):
        raise ValueError('Complete the standalone Telegram deployment settings')
    if (not isinstance(deployment['instance'], str)
            or not re.fullmatch('[a-z][a-z0-9-]{0,31}', deployment['instance'])
            or any(not isinstance(deployment[key], dict) for key in IDENTITY_FIELDS if key != 'instance')
            or set(deployment['services']) != {'broker', 'egress', 'memory'}):
        raise ValueError('Specify the identity instance and its three gateway settings')
    if deployment['settings'].get('parentUnit') != 'brai-hermes-production.service':
        raise ValueError('Use the standalone Hermes parent unit')
    managed = deployment['managedMemos']
    provider = managed.get('providerDescriptor', {})
    if (managed.get('freshInstall') is not True or managed.get('technicalProviders') != []
            or not isinstance(provider, dict) or provider.get('variant') not in ('external-http-v1', 'release-local-v1')
            or any(not isinstance(provider.get(key), dict) for key in ('llm', 'embedding'))):
        raise ValueError('Specify both providers for the selected MemOS first installation')
    if provider['variant'] == 'release-local-v1' and not isinstance(provider.get('broker'), dict):
        raise ValueError('Specify the private NATS broker and the test embedding credentials')
    distribution = manifest.get('identity_memos_sdk_distribution', {})
    checksum = distribution.get('sha256', '')
    if (not isinstance(checksum, str) or not re.fullmatch('[a-f0-9]{64}', checksum)
            or distribution != {'path': f'/var/lib/brai-install/identity-sdk-distribution/{checksum}/distribution.json',
                                'sha256': checksum}
            or managed.get('sdkDistribution') != distribution):
        raise ValueError('Use the same portable MemOS SDK in the manifest and test deployment')


def check_settings(manifest, inputs):
    """Отклонить незаполненные или не соответствующие манифесту поля."""
    if inputs.get('public_origin') != ORIGIN or inputs.get('public_urls') != []:
        raise ValueError('Use the local test origin and an empty public URL list')
    if 'registry' in inputs or 'git' in inputs or 'hf_token' in inputs:
        raise ValueError('Supply registry, Git and Hugging Face access separately through Actions')
    layout_sha = inputs.get('release_oci_archive_sha256')
    if layout_sha is not None and (not isinstance(layout_sha, str) or not re.fullmatch('[a-f0-9]{64}', layout_sha)):
        raise ValueError('Pin the exported RELEASE OCI archive by SHA-256')
    check_identity(manifest, inputs)
    expected_files = set(manifest['config_paths'])
    test_files = set(inputs.get('files', {}))
    optional_files = {RESEND_INPUT} if inputs.get('identity_mode') == 'telegram' else set()
    if not expected_files - optional_files <= test_files <= expected_files:
        raise ValueError('The test file paths differ from the manifest')
    for path, item in inputs['files'].items():
        if (not isinstance(item, dict) or set(item) != {'text', 'mode', 'uid', 'gid'}
                or not isinstance(item['text'], str)
                or any(type(item[field]) is not int or item[field] < 0 for field in ('uid', 'gid', 'mode'))):
            raise ValueError(f'Complete text and file permissions for {path}')
    for section, names in (('environments', service_names(manifest)), ('program_environment', set(manifest['programs']))):
        values = inputs.get(section, {})
        if set(values) != names or any(not isinstance(settings, dict) for settings in values.values()):
            raise ValueError(f'Complete the manifest entries in {section}')
    roles = inputs.get('roles')
    if not isinstance(roles, list) or any(
        not isinstance(role, dict) or not isinstance(role.get('name'), str) or not role['name']
        or type(role.get('login')) is not bool or type(role.get('inherit', True)) is not bool
        or ('password' in role and not isinstance(role['password'], str)) for role in roles
    ):
        raise ValueError('Specify test database roles with names and login flags')
    names = {role['name'] for role in roles}
    owners = {database['owner'] for database in manifest['databases']}
    if len(names) != len(roles) or not owners <= names:
        raise ValueError('Specify each database owner once')
    provision = inputs.get('provision', {})
    if not isinstance(inputs.get('mcp_servers'), dict) or not provision.get('user') or not provision.get('password'):
        raise ValueError('Specify broker provision and MCP settings')


def materialize(inputs):
    """Подставить одинаковые локальные секреты по ссылке и закодировать файлы."""
    generated = {}
    def expand(value):
        if isinstance(value, dict):
            return {name: expand(item) for name, item in value.items()}
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, str):
            if value == TELEGRAM_TEST_TOKEN:
                token = os.environ.get('BRAI_CI_TELEGRAM_BOT_TOKEN', '')
                if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token):
                    raise ValueError('Provide the dedicated Telegram test bot token')
                return token

            def secret(match):
                key = match.group(1)
                if key not in generated:
                    generated[key] = secrets.token_hex(24)
                return generated[key]
            return LOCAL_SECRET.sub(secret, value)
        return value
    result = expand(inputs)
    for item in result['files'].values():
        item['content'] = base64.b64encode(item.pop('text').encode()).decode()
    return result


class SDKRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != 'https':
            raise ValueError('The MemOS SDK download must stay on HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@contextmanager
def open_archive(url, directory):
    """Open a checked HTTPS stream, decrypting it locally when a CI passphrase is present."""
    opener = build_opener(SDKRedirectHandler())
    passphrase = os.environ.get('BRAI_CI_ARCHIVE_PASSPHRASE')
    if not passphrase:
        with opener.open(url, timeout=180) as response:
            yield response
        return
    with TemporaryDirectory(prefix='archive-', dir=directory) as temporary:
        temporary = Path(temporary)
        encrypted = temporary / 'encrypted.gpg'
        decoded = temporary / 'decoded.tar'
        with opener.open(url, timeout=180) as response, encrypted.open('xb') as output:
            shutil.copyfileobj(response, output)
        process = subprocess.run(
            ['gpg', '--homedir', str(temporary), '--batch', '--no-tty',
             '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--no-symkey-cache',
             '--output', str(decoded), '--decrypt', str(encrypted)],
            input=passphrase.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if process.returncode:
            raise ValueError('The encrypted test archive could not be opened')
        encrypted.unlink()
        with decoded.open('rb') as archive:
            yield archive


def stage_sdk(url, checksum, root):
    """Stage only the files declared by the candidate's pinned software manifest."""
    if not url or urlsplit(url).scheme != 'https':
        raise ValueError('Supply the temporary HTTPS source of the portable MemOS SDK')
    root.mkdir(mode=0o700)
    with open_archive(url, root.parent) as source, tarfile.open(fileobj=source, mode='r|') as archive:
        entry = archive.next()
        if not entry or entry.name != 'distribution.json' or not entry.isfile() or entry.size > 1024 * 1024:
            raise ValueError('The MemOS SDK archive must start with distribution.json')
        manifest = archive.extractfile(entry).read()
        if hashlib.sha256(manifest).hexdigest() != checksum:
            raise ValueError('The staged MemOS distribution does not match the candidate manifest')
        files = json.loads(manifest)['files']
        write_private(root / entry.name, manifest)
        for entry in iter(archive.next, None):
            name = PurePosixPath(entry.name)
            if name.is_absolute() or '..' in name.parts or str(name) != entry.name or not entry.isfile():
                raise ValueError('The MemOS SDK archive contains an unexpected entry')
            expected = files.pop(entry.name, None)
            if expected is None or entry.size != expected['size']:
                raise ValueError('The MemOS SDK archive contains an unexpected file')
            destination = root / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with destination.open('xb') as output:
                shutil.copyfileobj(archive.extractfile(entry), output)
            with destination.open('rb') as staged:
                if hashlib.file_digest(staged, 'sha256').hexdigest() != expected['sha256']:
                    raise ValueError('A staged MemOS SDK file differs from its manifest')
        if files:
            raise ValueError('The MemOS SDK archive is incomplete')
    return root


def stage_release_layout(manifest, checksum, run_directory):
    """Fetch the test-only OCI archive, then hand it to the Root path verifier."""
    url = os.environ.get('BRAI_CI_RELEASE_PACKAGES_URL', '')
    if not url or urlsplit(url).scheme != 'https':
        raise ValueError('Supply the temporary HTTPS source of the RELEASE OCI packages')
    path = run_directory / 'release-oci.tar'
    with open_archive(url, run_directory) as source, path.open('xb') as destination:
        shutil.copyfileobj(source, destination)
    with path.open('rb') as staged:
        if hashlib.file_digest(staged, 'sha256').hexdigest() != checksum:
            raise ValueError('The downloaded RELEASE OCI archive differs from the test bundle')
    write_private(run_directory / 'release-manifest.json', (json.dumps(manifest) + '\n').encode())


def ansible_variables(manifest, inputs, run_directory):
    if checksum := inputs.pop('release_oci_archive_sha256', None):
        stage_release_layout(manifest, checksum, run_directory)
    output = {'brai_install_manifest': manifest, 'fresh_install_inputs': inputs}
    if inputs.get('identity_mode') != 'telegram':
        return output

    checksum = manifest['identity_memos_sdk_distribution']['sha256']
    sdk_root = stage_sdk(os.environ.get('BRAI_CI_MEMOS_SDK_URL'), checksum, run_directory / 'memos-sdk')
    deployment = inputs.pop('identity_deployment')
    output.update({variable: deployment[key] for key, variable in IDENTITY_FIELDS.items()})
    output.update(brai_identity_enabled=True, brai_identity_auth_project=inputs['identity_auth_project'],
                  brai_identity_memos_sdk_distribution_source=str(sdk_root.resolve()))
    return output


def literal_values(value):
    """Пометить только Jinja-строки, сохраняя строковые числа в YAML."""
    if isinstance(value, dict):
        return {key: literal_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [literal_values(item) for item in value]
    if isinstance(value, str) and any(marker in value for marker in ('{{', '{%', '{#')):
        return Literal(value)
    return value


def write_private(path, value):
    """Записать только новый файл с правами владельца."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(value)


def load_json(path):
    """Прочитать JSON без вывода закрытых значений."""
    return json.loads(path.read_text())


def main():
    """Собрать, упаковать или подготовить комплект для Ansible на раннере."""
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest='action', required=True)
    for action in ('template', 'pack', 'unpack'):
        command = subcommands.add_parser(action)
        command.add_argument('source')
        if action != 'unpack':
            command.add_argument('manifest', type=Path)
        if action == 'pack':
            command.add_argument('settings', type=Path)
        command.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'unpack':
            packed = os.environ.get('BRAI_CI_INSTALL_BUNDLE')
            if not packed:
                raise ValueError('Set BRAI_CI_INSTALL_BUNDLE to the packed test inputs')
            bundle = json.loads(gzip.decompress(base64.b64decode(packed, validate=True)))
            manifest, inputs = bundle['manifest'], bundle['test_inputs']
            check_manifest(manifest, args.source)
            check_settings(manifest, inputs)
            if bundle['manifest_hash'] != manifest_hash(manifest):
                raise ValueError('The packed manifest hash differs')
            hf_token = os.environ.get('BRAI_CI_HF_TOKEN')
            registry_token = os.environ.get('BRAI_CI_REGISTRY_TOKEN') or os.environ.get('CI_PACKAGES_TOKEN')
            if not hf_token or not registry_token:
                raise ValueError('Provide test Hugging Face access and OCI package read access')
            registry_user = os.environ.get('BRAI_CI_REGISTRY_USER') or os.environ.get('GITHUB_ACTOR', '')
            if not registry_user:
                raise ValueError('Specify the registry user')
            values = materialize(inputs)
            values.update(manifest_sha256=bundle['manifest_hash'], hf_token=hf_token,
                          registry={'username': registry_user, 'token': registry_token})
            output = ansible_variables(manifest, values, args.output.parent)
            write_private(args.output, yaml.dump(literal_values(output), Dumper=AnsibleDumper, allow_unicode=True).encode())
        else:
            manifest = load_json(args.manifest)
            check_manifest(manifest, args.source)
            if args.action == 'template':
                write_private(args.output, (json.dumps(template(manifest), indent=2) + '\n').encode())
            else:
                inputs = load_json(args.settings)
                check_settings(manifest, inputs)
                bundle = {'manifest': manifest, 'manifest_hash': manifest_hash(manifest), 'test_inputs': inputs}
                packed = base64.b64encode(gzip.compress(json.dumps(bundle, separators=(',', ':')).encode(), mtime=0))
                if len(packed) > 48 * 1024:
                    raise ValueError('The packed bundle exceeds the GitHub Actions secret size limit')
                write_private(args.output, packed)
        print(f'{args.action}: Brai {args.source} test inputs')
    except (AttributeError, KeyError, TypeError, OSError, json.JSONDecodeError, HTTPException,
            EOFError, tarfile.TarError) as error:
        raise SystemExit(f'Test input preparation failed ({type(error).__name__})') from None
    except ValueError as error:
        raise SystemExit(f'Test input preparation failed: {error}') from None


if __name__ == '__main__':
    main()
