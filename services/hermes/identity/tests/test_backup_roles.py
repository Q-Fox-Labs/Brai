# ABOUTME: Проверяет запрет серверных бэкапов обычным пользователям и прямым RPC.
# ABOUTME: Использует реальный broker dispatch с фиктивным Auth и без серверных процессов.
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from services.hermes.identity.broker import Broker
from services.hermes.identity import tool_client


class BackupRoles(unittest.IsolatedAsyncioTestCase):
    """Каталог и выполнение должны независимо применять текущую роль Auth."""
    def subject(self, role):
        subject = object.__new__(Broker)
        subject.turns = {}
        subject.config = {'ingressUid': 999}
        subject.authorize = AsyncMock(return_value={'userId': 'fixture', 'profileId': 'fixture', 'role': role, 'generation': 1})
        return subject

    async def test_user_and_guest_cannot_call_privileged_rpc_even_with_forged_role(self):
        for role in ('user', 'guest'):
            for method in ('backup.status', 'backup.run'):
                for arguments in ({}, {'role': 'admin', 'uid': 0}):
                    with self.subTest(role=role, method=method), patch('asyncio.create_subprocess_exec') as process:
                        with self.assertRaises(PermissionError):
                            await self.subject(role).call(1001, method, arguments)
                        process.assert_not_called()

    async def test_admin_and_creator_accept_no_arguments_and_use_fixed_job(self):
        for role in ('admin', 'creator'):
            subject = self.subject(role)
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'', b'')))
            metadata = SimpleNamespace(st_uid=0, st_mode=0o100700)
            with patch.object(Path, 'lstat', return_value=metadata), patch('services.hermes.identity.broker.protected_json'), patch('asyncio.create_subprocess_exec', AsyncMock(return_value=process)) as execute:
                result = await subject.call(1001, 'backup.run', {})
                self.assertEqual(result, {'stage': 'starting', 'cloud_verified': False})
                self.assertEqual(execute.call_args.args, ('/usr/bin/systemctl', 'start', '--no-block', 'brai-recovery.service'))
                with self.assertRaises(ValueError):
                    await subject.call(1001, 'backup.run', {'command': '/bin/sh'})

    async def test_demotion_before_execution_prevents_start(self):
        subject = self.subject('admin')
        admin = subject.authorize.return_value
        subject.authorize.side_effect = [admin, {**admin, 'role': 'user', 'generation': 2}]
        with patch('asyncio.create_subprocess_exec') as execute:
            with self.assertRaises(PermissionError):
                await subject.call(1001, 'backup.run', {})
            execute.assert_not_called()

    async def test_personal_file_operations_remain_available_to_ordinary_user(self):
        subject = self.subject('user')
        subject.files = SimpleNamespace(create_text=AsyncMock(return_value={'artifactId': 'fixture'}),
                                        read_text=AsyncMock(return_value={'text': 'fixture'}),
                                        create_structured=AsyncMock(return_value={'artifactId': 'fixture'}))
        for method in ('files.create-text', 'files.read-text', 'files.create-document', 'files.create-spreadsheet'):
            value = await subject.call(1001, method, {})
            self.assertTrue(value)

    def test_catalog_hides_backup_tools_from_user_and_guest(self):
        for role in ('creator', 'admin', 'user', 'guest'):
            with patch.object(tool_client, 'broker_call', return_value={'role': role, 'tools': []}):
                catalog = tool_client.handle('tools/list', {})
            names = {item['name'] for item in catalog['tools']}
            self.assertEqual('brai_backup_status' in names, role in ('creator', 'admin'))
            self.assertEqual('brai_backup_run' in names, role in ('creator', 'admin'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
