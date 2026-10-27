# ABOUTME: Переносит явно перечисленные пользовательские материалы Hermes в Artifacts.
# ABOUTME: Проверяет manifest, размер, SHA-256 и восстановление перед освобождением старых путей.
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from files.store import FileError, canonical, key

EXCLUDED = {'.git', '.env', '.ssh', '.aws', '.codex', 'secrets', 'credentials', 'auth.json',
            'config.yaml', 'tools.json', 'publisher.json', 'runtime.env', 'instructions', 'skills'}
SECRET_SUFFIXES = {'.key', '.pem', '.p12', '.pfx', '.kdbx'}


def digest(path):
    """Хешировать поток без загрузки пользовательского файла в память."""
    result, size = sha256(), 0
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            size += len(chunk)
            result.update(chunk)
    return size, result.hexdigest()


def inventory(roots):
    """Составить manifest только явно выбранных legacy user roots, исключая служебные файлы."""
    records = []
    for raw in roots:
        root = Path(raw)
        if not root.is_absolute() or root.resolve() != root or not root.is_dir():
            raise FileError('MIGRATION_ROOT_INVALID')
        for directory, names, filenames in os.walk(root, followlinks=False):
            names[:] = sorted(name for name in names if name not in EXCLUDED and not (Path(directory) / name).is_symlink())
            for name in sorted(filenames):
                path = Path(directory) / name
                if name in EXCLUDED or name.startswith('.env.') or name.startswith('id_') or path.suffix.lower() in SECRET_SUFFIXES:
                    continue
                if path.is_symlink() or not path.is_file() or path.resolve() != path:
                    raise FileError('MIGRATION_FILE_INVALID')
                size, checksum = digest(path)
                records.append({'path': str(path), 'sizeBytes': size, 'sha256': checksum})
    return {'version': 1, 'roots': [str(Path(root)) for root in roots], 'items': records}


def migrate(store, manifest, retire=False):
    """Проверить весь набор и round trip; старые пути сохраняются в durable aliases."""
    if manifest.get('version') != 1 or set(manifest) != {'version', 'roots', 'items'}:
        raise FileError('MIGRATION_MANIFEST_INVALID')
    roots = [Path(root) for root in manifest['roots']]
    allowed = getattr(store, 'legacy_roots', ())
    if not roots or any(not root.is_absolute() or root.resolve() != root or root not in allowed for root in roots):
        raise FileError('MIGRATION_ROOT_NOT_APPROVED')
    if any(root.is_relative_to(service) or service.is_relative_to(root) for root in roots for service in store.service_roots):
        # Корень files может содержать старые records; инструкции/навыки должны быть отдельными roots.
        raise FileError('MIGRATION_SERVICE_ROOT_OVERLAP')
    migration_id = key(manifest)
    items = manifest['items']
    if len({item['path'] for item in items}) != len(items):
        raise FileError('MIGRATION_MANIFEST_INVALID')
    for item in items:
        path = Path(item['path'])
        if (not path.is_absolute() or path.resolve() != path or not any(path.is_relative_to(root) for root in roots)
                or set(item) != {'path', 'sizeBytes', 'sha256'} or any(part in EXCLUDED for part in path.parts)
                or path.suffix.lower() in SECRET_SUFFIXES or path.name.startswith('.env.')):
            raise FileError('MIGRATION_FILE_INVALID')
        if path.exists() and digest(path) != (item['sizeBytes'], item['sha256']):
            raise FileError('MIGRATION_SOURCE_CHANGED')
        if not path.exists():
            with store.db() as db:
                known = db.execute('SELECT artifact FROM aliases WHERE path=?', (str(path),)).fetchone()
            if known is None:
                raise FileError('MIGRATION_SOURCE_MISSING')
    receipts = []
    work = store.workspace(['migration', migration_id])
    try:
        for index, item in enumerate(items):
            path = Path(item['path'])
            value = store.resolve(path, ['migration', migration_id, str(path), item['sha256']])
            if (value['sizeBytes'], value['sha256']) != (item['sizeBytes'], item['sha256']):
                raise FileError('MIGRATION_ARTIFACT_MISMATCH')
            with store.materialize([store.checked(value)], ['restore', migration_id, index]) as files:
                restored = work / str(index)
                shutil.copyfile(files[0]['localPath'], restored)
                if digest(restored) != (item['sizeBytes'], item['sha256']):
                    raise FileError('MIGRATION_RESTORE_FAILED')
                restored.unlink()
            receipts.append({**item, 'artifactId': value['artifactId'], 'restored': True})
        # Полный receipt записан и fsync ДО первого освобождения исходного пути.
        receipt = store.root / ('migration-' + migration_id + '.json')
        with receipt.open('w') as stream:
            stream.write(canonical({'manifestId': migration_id, 'items': receipts}) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        if retire:
            # Повторно проверить ВЕСЬ состав перед первым удалением, без частичной миграции при изменении источника.
            for item in items:
                path = Path(item['path'])
                if path.exists() and digest(path) != (item['sizeBytes'], item['sha256']):
                    raise FileError('MIGRATION_SOURCE_CHANGED')
            for item in items:
                Path(item['path']).unlink(missing_ok=True)
        return {'manifestId': migration_id, 'filesVerified': len(receipts), 'retired': retire}
    finally:
        store.cleanup(['migration', migration_id])


def main():
    """Применять только через Ansible с защищённым manifest; inventory не читает секреты."""
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    inv = sub.add_parser('inventory')
    inv.add_argument('--root', action='append', required=True)
    inv.add_argument('--output', required=True)
    apply = sub.add_parser('apply')
    apply.add_argument('--manifest', required=True)
    apply.add_argument('--bootstrap', required=True)
    apply.add_argument('--retire', action='store_true')
    args = parser.parse_args()
    if args.action == 'inventory':
        output = Path(args.output)
        with output.open('x') as stream:
            os.chmod(output, 0o600)
            stream.write(json.dumps(inventory(args.root), ensure_ascii=False, indent=2) + '\n')
    else:
        import importlib.util
        sys.path.insert(0, str(Path(args.bootstrap).parent))
        spec = importlib.util.spec_from_file_location('brai_files', args.bootstrap)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = migrate(module.store(), json.loads(Path(args.manifest).read_text()), args.retire)
        print(json.dumps(result))


if __name__ == '__main__':
    main()
