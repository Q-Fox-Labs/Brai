# ABOUTME: Сохраняет узкий ingress traversal при native защите личного HOME.
# ABOUTME: Не разрешает чтение каталога, чужие ACL или обход проверки владельца.
"""POSIX ACL личного worker должен переживать secure_parent_dir."""
import os
from pathlib import Path
import stat
import struct


def secure_profile_parent(parent):
    """Обработать только свой HOME с точным уже установленным ingress ACL."""
    if os.environ.get('BRAI_IDENTITY_MODE') != 'worker':
        return False
    home = os.environ.get('HERMES_HOME', '')
    if not home.startswith('/') or Path(home) != parent:
        return False
    ingress = os.environ.get('BRAI_IDENTITY_INGRESS_UID', '')
    if not ingress.isascii() or not ingress.isdecimal():
        raise PermissionError('Invalid ingress identity')
    ingress = int(ingress)
    if ingress in (0, os.geteuid()) or ingress > 0xfffffffe:
        raise PermissionError('Invalid ingress identity')
    def acl(mask):
        return struct.pack('<I', 2) + b''.join(
            struct.pack('<HHI', tag, permission, identifier)
            for tag, permission, identifier in (
                (1, 7, 0xffffffff), (2, 1, ingress), (4, 0, 0xffffffff),
                (16, mask, 0xffffffff), (32, 0, 0xffffffff)))
    expected, masked = acl(1), acl(0)
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or not stat.S_ISDIR(info.st_mode):
            raise PermissionError('Unexpected profile owner')
        if os.getxattr(fd, 'system.posix_acl_access') not in (expected, masked):
            raise PermissionError('Unexpected profile ACL')
        # Именованному ingress нужен только проход к control/worker.sock.
        # Базовая группа и остальные не получают никаких прав.
        os.setxattr(fd, 'system.posix_acl_access', expected)
        return True
    finally:
        os.close(fd)
