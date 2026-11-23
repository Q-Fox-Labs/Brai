#!/usr/bin/env python3
# ABOUTME: Передаёт штатному Ansible точные пакеты RELEASE из закрытого OCI-архива.
# ABOUTME: Принимает только байты, закреплённые в манифесте, и сохраняет обычные пути installer.
"""Verify an exported OCI layout before pre-staging its component payloads."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tarfile
from tempfile import TemporaryDirectory

SHA = re.compile(r'sha256:[a-f0-9]{64}')
COMPONENT = re.compile(r'[a-z][a-z0-9-]*')


def require(ok, code):
    """Report a bounded validation error without expressing protected input values."""
    if not ok:
        raise ValueError(code)


def blob(layout, descriptor):
    """Read only a regular OCI blob with the declared digest and length."""
    checksum = descriptor['digest']
    require(isinstance(checksum, str) and SHA.fullmatch(checksum), 'INVALID_OCI_DIGEST')
    entry = layout.getmember('blobs/sha256/' + checksum[7:])
    require(entry.isfile() and (descriptor.get('size') is None or entry.size == descriptor['size']),
            'INVALID_OCI_BLOB')
    with layout.extractfile(entry) as stream:
        raw = stream.read()
    require(hashlib.sha256(raw).hexdigest() == checksum[7:], 'OCI_BYTES_CHANGED')
    return raw


def extract_payload(layout, component, destination, installer):
    """Copy one validated package to its canonical destination on the disposable runner."""
    require(not any(path.is_symlink() for path in (destination, *destination.parents)),
            'PACKAGE_DESTINATION_SYMLINK')
    if destination.exists():
        installer.verify_payload(component, destination)
        return
    digest = component['artifact']['digest']
    document = json.loads(blob(layout, {'digest': digest}))
    layers = document['layers']
    require(document.get('schemaVersion') == 2 and len(layers) == 1, 'INVALID_OCI_PAYLOAD_MANIFEST')
    data = blob(layout, layers[0])
    destination.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix='.release-test-', dir=destination.parent) as directory:
        stage = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as layers_archive:
            require(all(Path(entry.name).parts[:1] == ('payload',) and '..' not in Path(entry.name).parts
                        for entry in layers_archive),
                    'INVALID_PAYLOAD_LAYER_PATH')
            layers_archive.extractall(stage, filter='data')
        payload = stage / 'payload'
        installer.verify_payload(component, payload)
        require(not destination.exists(), 'PACKAGE_DESTINATION_CREATED_CONCURRENTLY')
        payload.rename(destination)


def prepare(layout_path, manifest, installer_path):
    """Require a client baseline, resolve every selected package, then verify its payload."""
    require(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'DISPOSABLE_ROOT_RUNNER_REQUIRED')
    spec = importlib.util.spec_from_file_location('release_test_installer', installer_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.validate(manifest)
    require(manifest.get('scope') == 'product' and list(manifest['installed']) == ['prod'], 'PRODUCT_BASELINE_REQUIRED')
    constructor = module.Installer
    selected = manifest['installed']['prod']
    operator = manifest['operator']['environments']['prod']
    artifacts = {(row['id'], row['artifact']['digest']): row for row in manifest['components']}
    require(len(artifacts) == len(manifest['components']), 'AMBIGUOUS_PAYLOADS')
    require(all((component, digest) in artifacts for component, digest in selected.items()), 'INCOMPLETE_COMPONENT_SET')
    # Runtime users traverse these public directories. Downloaded test inputs stay private.
    os.umask(0o022)
    with tarfile.open(layout_path, mode='r:') as layout:
        for (component_id, digest), component in artifacts.items():
            require(isinstance(component_id, str) and COMPONENT.fullmatch(component_id), 'INVALID_COMPONENT_ID')
            if component['artifact']['metadata']['deliveryKind'] == 'external-cli':
                continue
            instances = operator['components'][component_id] if selected.get(component_id) == digest else ()
            destination = module.payload_path(component, instances, 'prod')
            require(destination.is_relative_to(Path('/opt/brai-components')), 'INVALID_COMPONENT_DESTINATION')
            extract_payload(layout, component, destination, constructor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('layout', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('installer', type=Path)
    args = parser.parse_args()
    try:
        prepare(args.layout, json.loads(args.manifest.read_text()), args.installer)
    except (KeyError, TypeError, ValueError, OSError, tarfile.TarError):
        raise SystemExit('RELEASE OCI layout did not satisfy the selected client baseline') from None
    print('Verified the selected RELEASE packages at the canonical installer paths')


if __name__ == '__main__':
    main()
