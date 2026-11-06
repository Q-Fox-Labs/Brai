# ABOUTME: Проверяет owner-bound перенос файлов и transport без общего владельца.
# ABOUTME: Не использует модель, сеть, live-профили или привилегированную установку.
import asyncio
from hashlib import sha256
import importlib.util
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from files import identity, native, transport
from files.tests.test_files import Backend


class FileIdentityTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.uid = os.getuid()
        self.home = self.root / 'home'
        self.cache = self.root / 'cache'
        self.stage = self.root / 'stage' / str(self.uid)
        for path in [self.home / name for name in ('workspace', 'media', 'results')] + [self.cache, self.stage]:
            path.mkdir(parents=True, mode=0o700)
        self.profile = {'home': str(self.home), 'userId': 'owner'}
        self.control = SimpleNamespace(call=self.call)
        self.calls = []
        self.port = identity.OwnerFiles({'artifactCacheRoots': {str(self.uid): str(self.cache)},
            'stagingRoot': str(self.stage.parent), 'ingressUid': self.uid,
            'ingressReadRoots': [str(self.root / 'ingress')],
            'ingressDeliveryRoot': str(self.root / 'delivery')}, self.control)
        self.aid = str(uuid.uuid4())
        self.cached = self.cache / self.aid / 'report.txt'
        self.cached.parent.mkdir(mode=0o700)
        self.cached.write_bytes(b'report')
        self.result = {'artifactId': self.aid, 'filename': self.cached.name,
            'localPath': str(self.cached), 'mimeType': 'text/plain',
            'sizeBytes': 6, 'sha256': sha256(b'report').hexdigest()}

    def tearDown(self):
        self.temp.cleanup()

    async def call(self, method, args, **kwargs):
        self.calls.append((method, args))
        if method == 'artifacts.publish':
            self.assertEqual(Path(args['path']).name, 'report.txt')
            self.assertEqual(Path(args['path']).read_bytes(), b'report')
        return dict(self.result)

    def own_cache(self, root, path, uid):
        return identity.open_file(root, path, self.uid)

    def test_open_rejects_symlink_hardlink_and_foreign_uid(self):
        area = self.home / 'workspace'
        source = area / 'file'
        source.write_bytes(b'private')
        symlink = area / 'link'
        symlink.symlink_to(source)
        with self.assertRaises(OSError):
            identity.open_file(area, symlink, self.uid)
        with self.assertRaises(PermissionError):
            identity.open_file(area, source, self.uid + 1)
        (area / 'hardlink').hardlink_to(source)
        with self.assertRaises(PermissionError):
            identity.open_file(area, source, self.uid)

    def test_open_rejects_directory_symlink_and_traversal(self):
        (self.home / 'workspace' / 'link').symlink_to(self.cached.parent, target_is_directory=True)
        with self.assertRaises(OSError):
            identity.open_file(self.home / 'workspace', self.home / 'workspace' / 'link' / 'report.txt', self.uid)
        with self.assertRaises(PermissionError):
            identity.open_file(self.home / 'workspace', self.home / 'workspace' / '..' / 'results' / 'file', self.uid)

    def test_personal_copy_replaces_symlink_without_touching_target(self):
        result = self.home / 'results' / self.aid
        result.mkdir(mode=0o700)
        target = self.root / 'outside'
        target.write_bytes(b'unchanged')
        (result / 'report.txt').symlink_to(target)
        source = identity.open_file(self.cache, self.cached, self.uid)
        try:
            path = identity.copy_to_profile(source, self.home, 'results', self.aid, 'report.txt', self.uid, self.result)
        finally:
            os.close(source)
        self.assertEqual(Path(path).read_bytes(), b'report')
        self.assertFalse(Path(path).is_symlink())
        self.assertEqual(target.read_bytes(), b'unchanged')

    def test_hash_mismatch_does_not_replace_existing_copy(self):
        target = self.home / 'results' / self.aid
        target.mkdir(mode=0o700)
        (target / 'report.txt').write_bytes(b'previous')
        source = identity.open_file(self.cache, self.cached, self.uid)
        try:
            with self.assertRaises(PermissionError):
                identity.copy_to_profile(source, self.home, 'results', self.aid, 'report.txt', self.uid,
                                         {**self.result, 'sha256': '0' * 64})
        finally:
            os.close(source)
        self.assertEqual((target / 'report.txt').read_bytes(), b'previous')

    def test_cache_path_must_match_configured_owner_root(self):
        with self.assertRaises(ValueError):
            self.port.open_cache(self.uid, {**self.result, 'localPath': '/etc/passwd'})
        with self.assertRaises(KeyError):
            self.port.open_cache(self.uid + 1, self.result)

    async def test_fetch_returns_personal_path_and_never_root_descriptor(self):
        original = identity.open_file
        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid: original(root, path, self.uid)):
            result = await self.port.fetch(self.uid, self.profile, {'artifactId': self.aid})
        self.assertEqual(result['localPath'], str(self.home / 'results' / self.aid / 'report.txt'))
        self.assertIn(result['localPath'], result['markdown'])
        self.assertNotIn(str(self.cache), str(result))
        self.assertEqual(self.calls[0], ('artifacts.fetch', {'uid': self.uid, 'artifactId': self.aid}))

    async def test_ingress_receives_readable_copy_without_exposing_root_cache(self):
        (self.root / 'delivery').mkdir(mode=0o700)
        original = identity.open_file
        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid: original(root, path, self.uid)):
            result = await self.port.fetch(self.uid, self.profile, {'artifactId': self.aid}, ingress=True)
        self.assertTrue(Path(result['localPath']).is_relative_to(self.root / 'delivery'))
        self.assertNotIn(str(self.cache), str(result))
        self.assertEqual(Path(result['localPath']).read_bytes(), b'report')

    async def test_publish_preserves_basename_and_removes_staging(self):
        source = self.home / 'workspace' / 'report.txt'
        source.write_bytes(b'report')
        directory, file = identity.open_directory, identity.open_file
        with patch.object(identity, 'open_directory', side_effect=lambda path, uid: directory(path, self.uid)), patch.object(identity, 'open_file', side_effect=lambda root, path, uid: file(root, path, self.uid)):
            result = await self.port.publish(self.uid, self.profile, {'path': str(source), 'requestId': 'stable'})
        self.assertEqual(result['artifactId'], self.aid)
        self.assertEqual(list(self.stage.iterdir()), [])
        self.assertEqual(self.calls[0][1]['requestId'], 'stable')

    async def test_publish_rejects_injected_owner_and_foreign_path(self):
        with self.assertRaises(ValueError):
            await self.port.publish(self.uid, self.profile, {'path': str(self.cached), 'requestId': 'a', 'uid': 0})
        with self.assertRaises(ValueError):
            await self.port.publish(self.uid, self.profile, {'path': str(self.cached), 'requestId': 'a'})
        self.assertEqual(self.calls, [])

    async def test_ingress_copies_only_declared_files(self):
        root = self.root / 'ingress'
        root.mkdir(mode=0o700)
        source = root / 'input.txt'
        source.write_text('input')
        result = await self.port.prepare_ingress(self.uid, self.profile, [str(source)])
        self.assertTrue(Path(result['paths'][0]).is_relative_to(self.home / 'media'))
        self.assertEqual(Path(result['paths'][0]).read_text(), 'input')
        self.assertEqual(source.read_text(), 'input')
        with self.assertRaises(PermissionError):
            await self.port.prepare_ingress(self.uid, self.profile, ['/etc/passwd'])

    def test_runtime_mapping_reloads_and_rejects_changed_owner(self):
        entry = {'userId': 'owner', 'profileId': 'profile', 'home': str(self.home),
                 'cacheRoot': str(self.cache), 'stagingRoot': str(self.stage)}
        values = {str(self.uid): entry}
        profile = {**self.profile, 'profileId': 'profile'}
        port = identity.OwnerFiles({'runtimeProfilesPath': '/root/mapping'}, self.control,
                                   config_reader=lambda path: values)
        self.assertEqual(port.runtime(self.uid, profile)['cacheRoot'], str(self.cache))
        entry['userId'] = 'another-owner'
        with self.assertRaises(PermissionError):
            port.runtime(self.uid, profile)
        values.clear()
        with self.assertRaises(PermissionError):
            port.runtime(self.uid, profile)

    async def test_transport_preserves_original_ids_without_file_access(self):
        source = SimpleNamespace(platform='telegram', chat_id='1', thread_id='', user_id='2', profile='')
        first = SimpleNamespace(source=source, message_id='10', text='caption 1', media_urls=['/missing/1'],
                                metadata={}, raw_message=SimpleNamespace(media_group_id='album'))
        second = SimpleNamespace(source=source, message_id='11', text='caption 2', media_urls=['/missing/2'],
                                 metadata={}, raw_message=SimpleNamespace(media_group_id='album'))
        with patch('builtins.open', side_effect=AssertionError('No file IO')):
            self.assertFalse(await transport.capture(None, first))
            self.assertFalse(await transport.capture(None, second))
            transport.merge_events(first, second)
            transport.install_adapter(None)
            transport.schedule_recovery(None)
        self.assertEqual([item['itemId'] for item in first._brai_identity_inputs], ['10:0', '11:0'])
        self.assertEqual([item['caption'] for item in first._brai_identity_inputs], ['caption 1', 'caption 2'])
        with self.assertRaises(transport.FileError):
            transport.store()

    async def test_parent_admit_hooks_preserve_metadata_without_file_store_or_io(self):
        event = SimpleNamespace(message_id='42', text='caption', media_urls=['/missing/private-input'],
                                metadata={}, raw_message=None)
        with patch('builtins.open', side_effect=AssertionError('No file IO')), \
                patch('os.open', side_effect=AssertionError('No descriptor IO')), \
                patch.object(native, 'store', side_effect=AssertionError('No shared FileStore')):
            self.assertTrue(await transport.accept_event(event, admit=False))
            transport.track_inbound(event)
            with transport.inbound_events(event) as current:
                self.assertIs(current, event)
                self.assertTrue(await transport.accept_event(event))
        self.assertEqual(event._brai_identity_inputs,
                         [{'path': '/missing/private-input', 'itemId': '42:0', 'caption': 'caption', 'groupId': '42'}])
        self.assertNotIn('_brai_artifacts', event.metadata)
        event.metadata['fileSetStatus'] = 'incomplete'
        with self.assertRaisesRegex(transport.FileError, 'INCOMPLETE_FILE_SET'):
            await transport.accept_event(event, admit=False)
        with self.assertRaisesRegex(transport.FileError, 'FILES_OWNER_REQUIRED'):
            transport.conversation(None, 'agent execution', None)

    async def test_worker_ingests_each_original_message_and_caption(self):
        backend = Backend(self.home / 'results')
        native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(self.home / 'workspace' / 'files'),
                          'resultRoot': str(self.home / 'results'), 'readRoots': [str(self.home / 'media')]}, backend)
        first, second = self.home / 'media' / 'one.txt', self.home / 'media' / 'two.txt'
        first.write_text('one')
        second.write_text('two')
        event = SimpleNamespace(source=SimpleNamespace(platform='telegram', chat_id='1', thread_id='', user_id='2'),
            message_id='10', text='merged caption', media_urls=[str(first), str(second)], metadata={},
            _brai_identity_inputs=[{'path': str(first), 'itemId': '10:0', 'caption': 'first', 'groupId': 'album'},
                                  {'path': str(second), 'itemId': '11:0', 'caption': 'second', 'groupId': 'album'}])
        await native.accept_event(event, admit=False)
        with native.store().db() as db:
            rows = db.execute('SELECT source,caption,position FROM items ORDER BY position').fetchall()
        self.assertEqual([row['caption'] for row in rows], ['first', 'second'])
        self.assertEqual([row['position'] for row in rows], [10000, 11000])
        self.assertIn('10:0', rows[0]['source'])
        self.assertIn('11:0', rows[1]['source'])

    def test_worker_bootstrap_without_owner_port_fails_before_legacy_config(self):
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), patch.dict(sys.modules):
            sys.modules.pop('_brai_identity_worker', None)
            with self.assertRaisesRegex(RuntimeError, 'FILES_PORT_NOT_READY'):
                runpy.run_path(str(Path(__file__).resolve().parents[1] / 'bootstrap.py'))

    def test_parent_bootstrap_never_reads_fixed_owner_config(self):
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'telegram'}), patch.dict(sys.modules, {'brai_files_transport': transport}):
            scope = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'bootstrap.py'))
        self.assertIs(scope['native'], transport)
        self.assertNotIn('config', scope)


if __name__ == '__main__':
    unittest.main()
