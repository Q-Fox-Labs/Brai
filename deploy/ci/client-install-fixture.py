#!/usr/bin/env python3
# ABOUTME: Готовит защищённый тестовый комплект для явно заданного клиентского манифеста.
# ABOUTME: Привязывает входы к SHA кандидата, создаёт локальные секреты и сохраняет шаблоны Ansible.
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

import yaml

ORIGIN = 'https://brai-ci.localhost'
LOCAL_SECRET = re.compile(r'@CI_SECRET\(([a-z0-9_-]+)\)@')


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
    return {
        'files': {path: dict(text=None, mode=None, uid=None, gid=None) for path in manifest['config_paths']},
        'environments': dict.fromkeys(sorted(service_names(manifest))),
        'program_environment': dict.fromkeys(sorted(manifest['programs'])),
        'roles': [dict(name=owner, login=True, inherit=False, password=f'@CI_SECRET(db-{owner})@') for owner in owners],
        'provision': dict(user='brai_install', password='@CI_SECRET(nats-provision)@'),
        'mcp_servers': {},
        'public_origin': ORIGIN,
        'public_urls': [],
    }


def check_settings(manifest, inputs):
    """Отклонить незаполненные или не соответствующие манифесту поля."""
    if inputs.get('public_origin') != ORIGIN or inputs.get('public_urls') != []:
        raise ValueError('Use the local test origin and an empty public URL list')
    if 'registry' in inputs or 'git' in inputs or 'hf_token' in inputs:
        raise ValueError('Supply registry, Git and Hugging Face access separately through Actions')
    if inputs.get('identity_mode', 'email') != 'email':
        raise ValueError('This smoke workflow uses the standalone client entry without personal identity setup')
    if set(inputs.get('files', {})) != set(manifest['config_paths']):
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
            output = {'brai_install_manifest': manifest, 'fresh_install_inputs': values}
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
    except (AttributeError, KeyError, TypeError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f'Test input preparation failed ({type(error).__name__})') from None
    except ValueError as error:
        raise SystemExit(f'Test input preparation failed: {error}') from None


if __name__ == '__main__':
    main()
