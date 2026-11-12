import asyncio
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from files.generated import GeneratedFiles


class GeneratedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'home'
        (self.home / 'results').mkdir(parents=True, mode=0o700)
        self.stage = Path(self.tmp.name) / 'stage'
        self.stage.mkdir(mode=0o700)
        self.uid = os.getuid()
        self.profile = {'home': str(self.home), 'userId': 'u', 'profileId': 'p', 'role': 'guest', 'generation': 1}
        self.current = dict(self.profile)
        async def authorize(uid):
            return dict(self.current)
        class Control:
            calls = []
            async def call(inner, method, params, **kwargs):
                raw = Path(params['path']).read_bytes()
                inner.calls.append(raw)
                return {'artifactId': 'a', 'filename': Path(params['path']).name,
                        'sizeBytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        class Files:
            control = Control()
            def runtime(inner, uid, profile): return {'stagingRoot': str(self.stage)}
            def materialize(inner, uid, profile, result): return result
        self.files = Files()
        self.port = GeneratedFiles(self.files, authorize)
        from files.identity import open_directory
        self.root_check = patch('files.generated.open_directory',
            side_effect=lambda path, uid: open_directory(path, self.uid))
        self.root_check.start()

    async def asyncTearDown(self):
        self.root_check.stop()
        self.tmp.cleanup()

    async def test_publish_once_and_check_digest(self):
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'image'})
        Path(ticket['path']).write_bytes(b'picture')
        params = {'ticket': ticket['ticket'], 'sizeBytes': 7, 'sha256': hashlib.sha256(b'picture').hexdigest()}
        result = await self.port.finish(self.uid, self.profile, params)
        self.assertEqual(result['artifactId'], 'a')
        self.assertEqual(self.files.control.calls, [b'picture'])
        self.assertFalse(Path(ticket['path']).exists())
        with self.assertRaises(PermissionError):
            await self.port.finish(self.uid, self.profile, params)

    async def test_symlink_and_changed_principal_rejected(self):
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'image'})
        os.symlink('/etc/passwd', ticket['path'])
        with self.assertRaises(OSError):
            await self.port.finish(self.uid, self.profile, {'ticket': ticket['ticket'], 'sizeBytes': 1, 'sha256': '0'*64})
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'audio'})
        Path(ticket['path']).write_bytes(b'a')
        self.current['generation'] = 2
        with self.assertRaises(PermissionError):
            await self.port.finish(self.uid, self.profile, {'ticket': ticket['ticket'], 'sizeBytes': 1, 'sha256': hashlib.sha256(b'a').hexdigest()})
        self.assertEqual(self.files.control.calls, [])

    async def test_mismatch_and_limit(self):
        self.port.limit = 1
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'screenshot'})
        with self.assertRaises(PermissionError):
            await self.port.begin(self.uid, self.profile, {'kind': 'image'})
        Path(ticket['path']).write_bytes(b'a')
        with self.assertRaises(PermissionError):
            await self.port.finish(self.uid, self.profile, {'ticket': ticket['ticket'], 'sizeBytes': 1, 'sha256': '0'*64})
        self.assertEqual(self.files.control.calls, [])

    async def test_reap_and_close_release_tickets(self):
        now = [0]
        self.port.clock = lambda: now[0]
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'image'})
        Path(ticket['path']).write_bytes(b'a')
        now[0] = 1801
        await self.port.reap()
        self.assertFalse(Path(ticket['path']).parent.exists())
        ticket = await self.port.begin(self.uid, self.profile, {'kind': 'image'})
        await self.port.close()
        self.assertFalse(Path(ticket['path']).parent.exists())
        self.assertEqual(self.port.tickets, {})
