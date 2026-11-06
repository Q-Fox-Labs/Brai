# ABOUTME: Формирует личный sandbox-enabled Chrome для отдельного Hermes worker.
# ABOUTME: Не запускает браузер и не открывает общий пользовательский CDP.
"""Чистая конфигурация browser unit; установщик проверяет исходный бинарник."""

import re
import uuid
from pathlib import PurePosixPath

from .profiles import _path


def browser_unit(profile, *, chrome_root, instance='dev'):
    """Сформировать unit собственного Chrome в сетевом пространстве worker."""
    home = _path(profile['home'])
    root = _path(chrome_root)
    name = profile['username']
    profile_id = profile['profileId']
    if not re.fullmatch(r'braiu-[0-9a-f]{20}', name):
        raise ValueError('Invalid profile account')
    if not isinstance(profile_id, str) or str(uuid.UUID(profile_id)) != profile_id:
        raise ValueError('Invalid profile identity')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', instance):
        raise ValueError('Invalid instance')
    worker = 'brai-hermes-' + instance + '-user-' + profile_id + '.service'
    source = home + '/browser'
    browser = '/var/lib/brai-browser'
    chrome = str(PurePosixPath(root) / 'chrome')
    lines = [
        '[Unit]', 'Description=Brai personal browser ' + profile_id,
        'After=' + worker, 'Requires=' + worker, 'BindsTo=' + worker,
        'PartOf=' + worker, 'JoinsNamespaceOf=' + worker,
        '[Service]', 'Type=simple', 'User=' + name, 'Group=' + name,
        'Environment=HOME=' + browser, 'Environment=TMPDIR=' + browser + '/tmp',
        'Environment=XDG_CACHE_HOME=' + browser + '/cache',
        'ExecStart=' + chrome + ' --headless=new --remote-debugging-address=127.0.0.1'
        ' --remote-debugging-port=19364 --user-data-dir=' + browser + '/profile'
        ' --no-first-run --no-default-browser-check --disable-background-networking'
        ' --disable-component-update --disable-sync --proxy-server=http://127.0.0.1:18080'
        ' --proxy-bypass-list=<-loopback> about:blank',
        'UMask=0077', 'Restart=on-failure', 'RestartSec=3',
        'PrivateNetwork=yes', 'PrivateTmp=yes', 'PrivateDevices=yes',
        'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
        'ProtectSystem=strict', 'ProtectHome=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
        'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes',
        'ProtectControlGroups=yes', 'RestrictNamespaces=user pid net', 'RestrictSUIDSGID=yes',
        'LockPersonality=yes', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        'TemporaryFileSystem=/run:ro /var/lib:ro /opt:ro',
        'InaccessiblePaths=-/srv -/etc/brai -/etc/brai-dev -/etc/ansible -/mnt -/media',
        'BindReadOnlyPaths=' + root + ':' + root,
        'BindPaths=' + source + ':' + browser,
        'ReadWritePaths=' + browser,
        'KillMode=control-group', 'TimeoutStopSec=30', 'LimitNOFILE=4096',
        'TasksMax=256', 'MemoryHigh=1G', 'MemoryMax=2G',
        '[Install]', 'WantedBy=multi-user.target', '',
    ]
    return '\n'.join(lines)
