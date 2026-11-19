# ABOUTME: Формирует изолированные systemd units Kitesurf и его сетевого relay.
# ABOUTME: Не создаёт аккаунты, сокеты, каталоги и не запускает службы.
"""Чистая конфигурация личного браузера Kitesurf."""

import re
import uuid
from pathlib import PurePosixPath

from .profiles import _digest, _path


def units(profile, *, runtime_root, software_root, node_root, python, browser_egress,
          instance='dev'):
    """Вернуть unit браузера, relay и путь его личного CDP-сокета."""
    for value in (runtime_root, software_root, node_root, python, browser_egress):
        _path(value)
    profile_id = profile['profileId']
    if not isinstance(profile_id, str) or str(uuid.UUID(profile_id)) != profile_id:
        raise ValueError('Invalid profile identity')
    username = profile['username']
    if not isinstance(username, str) or not re.fullmatch(r'braiu-[0-9a-f]{20}', username):
        raise ValueError('Invalid profile account')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', instance):
        raise ValueError('Invalid instance')
    browser_user = 'braik-' + _digest(profile['userId'])[:20]
    name = 'brai-hermes-' + instance + '-kitesurf-' + profile_id + '.service'
    relay = 'brai-hermes-' + instance + '-kitesurf-net-' + profile_id + '.service'
    socket_dir = '/run/brai-kitesurf-' + instance + '-' + profile_id
    socket = socket_dir + '/cdp.sock'
    python_root = str(PurePosixPath(python).parent.parent)
    python_name = PurePosixPath(python).name
    shared = [
        'PrivateTmp=yes', 'PrivateDevices=yes', 'NoNewPrivileges=yes',
        'CapabilityBoundingSet=', 'AmbientCapabilities=', 'ProtectSystem=strict',
        'ProtectHome=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
        'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes',
        'ProtectControlGroups=yes', 'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes',
        'LockPersonality=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        'TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro',
        'InaccessiblePaths=-/srv -/etc/brai -/etc/brai-dev -/etc/ansible -/mnt -/media',
        'UMask=0077', 'KillMode=control-group',
    ]
    engine = [
        '[Unit]', 'Description=Brai Kitesurf ' + profile_id,
        '[Service]', 'Type=notify', 'NotifyAccess=all', 'User=' + browser_user, 'Group=' + username,
        'RuntimeDirectory=' + socket_dir.removeprefix('/run/'), 'RuntimeDirectoryMode=0750',
        'RuntimeDirectoryPreserve=yes',
        'Environment=KITESURF_CDP_SOCKET=' + socket,
        'Environment=KITESURF_BUNDLE_ROOT=' + software_root + '/bundle',
        'Environment=KITESURF_ASSET_ROOT=' + software_root + '/assets',
        'Environment=MINIFLARE_WORKERD_V8_FLAGS=--expose-gc',
        'Environment=HOME=/tmp', 'Environment=TMPDIR=/tmp',
        'Environment=XDG_CONFIG_HOME=/tmp', 'Environment=XDG_CACHE_HOME=/tmp',
        'ExecStart=' + node_root + '/bin/node ' + software_root + '/services/hermes/kitesurf/engine.mjs',
        'PrivateNetwork=yes', *shared,
        'BindPaths=' + socket_dir,
        'BindReadOnlyPaths=-/run/systemd/notify',
        'BindReadOnlyPaths=' + software_root,
        'BindReadOnlyPaths=' + node_root,
        'StandardOutput=null', 'StandardError=null',
        '[Install]', 'WantedBy=multi-user.target', '',
    ]
    network = [
        '[Unit]', 'Description=Brai Kitesurf public relay ' + profile_id,
        'After=' + name, 'Requires=' + name, 'BindsTo=' + name,
        'JoinsNamespaceOf=' + name,
        '[Service]', 'Type=notify', 'NotifyAccess=main', 'User=' + username, 'Group=' + username,
        'Environment=PYTHONPATH=/opt/brai-profile/runtime/services/hermes',
        'Environment=PYTHONDONTWRITEBYTECODE=1',
        'ExecStart=/opt/brai-profile/python/bin/' + python_name + ' -s -P -B -m identity.network --socket /run/brai-profile/browser-egress.sock --port 18081',
        'PrivateNetwork=yes', *shared,
        'BindReadOnlyPaths=' + runtime_root + ':/opt/brai-profile/runtime',
        'BindReadOnlyPaths=' + python_root + ':/opt/brai-profile/python',
        'BindReadOnlyPaths=-/run/systemd/notify',
        'BindReadOnlyPaths=' + browser_egress + ':/run/brai-profile/browser-egress.sock',
        '[Install]', 'WantedBy=multi-user.target', '',
    ]
    return {'browserUser': browser_user, 'engineName': name, 'relayName': relay,
            'cdpSocket': socket, 'engineUnit': '\n'.join(engine), 'relayUnit': '\n'.join(network)}
