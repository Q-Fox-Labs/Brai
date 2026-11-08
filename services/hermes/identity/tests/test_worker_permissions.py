# ABOUTME: Воспроизводит потерю ACL после native chmod без реальных профилей.
# ABOUTME: Проверяет сохранение только --x для ingress, владельца и отказ на чужих ACL.
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.permissions import secure_profile_parent
from identity.ingress import Bridge


class ProfilePermissionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.ingress = os.geteuid() + 1
        self.expected = struct.pack('<I', 2) + b''.join(
            struct.pack('<HHI', tag, permission, identifier)
            for tag, permission, identifier in (
                (1, 7, 0xffffffff), (2, 1, self.ingress), (4, 0, 0xffffffff),
                (16, 1, 0xffffffff), (32, 0, 0xffffffff)))
        os.setxattr(self.home, 'system.posix_acl_access', self.expected)
        env = patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker',
            'HERMES_HOME': str(self.home), 'BRAI_IDENTITY_INGRESS_UID': str(self.ingress)})
        env.start()
        self.addCleanup(env.stop)

    def test_native_hardening_preserves_and_restores_exact_ingress_traversal(self):
        self.assertTrue(secure_profile_parent(self.home))
        self.home.chmod(0o700)
        self.assertNotEqual(os.getxattr(self.home, 'system.posix_acl_access'), self.expected)
        self.assertTrue(secure_profile_parent(self.home))
        self.assertEqual(os.getxattr(self.home, 'system.posix_acl_access'), self.expected)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), 0o710)

    def test_foreign_acl_or_owner_is_never_accepted(self):
        self.home.chmod(0o711)
        before = os.getxattr(self.home, 'system.posix_acl_access')
        with self.assertRaises(PermissionError):
            secure_profile_parent(self.home)
        self.assertEqual(os.getxattr(self.home, 'system.posix_acl_access'), before)
        os.setxattr(self.home, 'system.posix_acl_access', self.expected)
        with patch('identity.permissions.os.geteuid', return_value=os.geteuid() + 2):
            with self.assertRaises(PermissionError):
                secure_profile_parent(self.home)

    def test_other_parent_and_non_worker_keep_native_hardening(self):
        self.assertFalse(secure_profile_parent(self.home / 'other'))
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}):
            self.assertFalse(secure_profile_parent(self.home))

    def test_symlink_is_never_followed(self):
        link = self.home / 'link'
        link.symlink_to(self.home, target_is_directory=True)
        with patch.dict(os.environ, {'HERMES_HOME': str(link)}):
            with self.assertRaises(OSError):
                secure_profile_parent(link)


class FailedConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_connection_refusal_never_admits_or_reserves_input(self):
        prepare = AsyncMock()
        bridge = Bridge('owner', '123', 999, '/unused', None, prepare)
        source = NS(platform=NS(value='telegram'), user_id='123', is_bot=False)
        with patch.object(bridge, 'connect', AsyncMock(side_effect=PermissionError('denied'))):
            with self.assertRaises(PermissionError):
                await bridge.dispatch(NS(source=source))
        prepare.assert_not_awaited()
        self.assertEqual(bridge.routes, set())
        self.assertEqual(bridge.received, set())
