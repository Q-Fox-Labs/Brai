# ABOUTME: Проверяет owner-bound перенос файлов и transport без общего владельца.
# ABOUTME: Не использует модель, сеть, live-профили или привилегированную установку.
import asyncio
import ast
import base64
import contextlib
import datetime
from hashlib import file_digest, sha256
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import stat
import types
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from files import identity, native, transport
from files.tests.test_files import Backend


class FileIdentityTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Личные файлы fixture должны оставаться закрытыми и при host umask 0002.
        self.addCleanup(os.umask, os.umask(0o077))
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.uid = os.getuid()
        self.home = self.root / 'home'
        self.cache = self.root / 'cache'
        self.stage = self.root / 'stage' / str(self.uid)
        for path in [self.home / name for name in ('workspace', 'media', 'results')] + [self.cache, self.stage]:
            path.mkdir(parents=True, mode=0o700)
        self.profile = {'home': str(self.home), 'userId': 'owner', 'profileId': 'fixture-profile'}
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
        self.cached.chmod(0o600)
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

    def own_cache(self, root, path, uid, **kwargs):
        return identity.open_file(root, path, self.uid, **kwargs)

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
        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: original(root, path, self.uid, **kwargs)):
            result = await self.port.fetch(self.uid, self.profile, {'artifactId': self.aid})
        self.assertEqual(result['localPath'], str(self.home / 'results' / self.aid / 'report.txt'))
        self.assertIn(result['localPath'], result['markdown'])
        self.assertNotIn(str(self.cache), str(result))
        self.assertEqual(self.calls[0], ('artifacts.fetch', {'uid': self.uid, 'artifactId': self.aid}))

    async def test_ingress_opens_exact_inode_without_delivery_copy(self):
        original = identity.open_file
        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: original(root, path, self.uid, **kwargs)):
            metadata, fd = await self.port.open_ingress(self.uid, self.profile, self.aid)
        try:
            self.assertEqual(os.fstat(fd).st_ino, self.cached.stat().st_ino)
            self.assertEqual(os.read(fd, 100), b'report')
            with self.assertRaises(OSError):
                os.write(fd, b'foreign')
            self.assertNotIn('localPath', metadata)
            self.assertFalse((self.root / 'delivery').exists())
        finally:
            os.close(fd)

    async def test_ingress_hash_mismatch_and_foreign_owner_deny_descriptor(self):
        original_fd = identity.open_file(self.cache, self.cached, self.uid)
        self.result['sha256'] = '0' * 64
        with patch.object(self.port, 'open_cache', return_value=original_fd):
            with self.assertRaises(PermissionError):
                await self.port.open_ingress(self.uid, self.profile, self.aid)
        with self.assertRaises(OSError):
            os.fstat(original_fd)
        with patch.object(self.control, 'call', side_effect=PermissionError('Foreign artifact')):
            with self.assertRaises(PermissionError):
                await self.port.open_ingress(self.uid, self.profile, self.aid)

    async def test_ingress_rejects_group_or_other_writable_cache(self):
        original = identity.open_file
        for mode in (0o620, 0o602):
            with self.subTest(mode=oct(mode)):
                self.cached.chmod(mode)
                with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: original(root, path, self.uid, **kwargs)):
                    with self.assertRaisesRegex(PermissionError, 'Writable artifact cache'):
                        await self.port.open_ingress(self.uid, self.profile, self.aid)

    async def test_ingress_receives_readable_copy_without_exposing_root_cache(self):
        (self.root / 'delivery').mkdir(mode=0o700)
        original = identity.open_file
        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: original(root, path, self.uid, **kwargs)):
            result = await self.port.fetch(self.uid, self.profile, {'artifactId': self.aid}, ingress=True)
        self.assertTrue(Path(result['localPath']).is_relative_to(self.root / 'delivery'))
        self.assertNotIn(str(self.cache), str(result))
        self.assertEqual(Path(result['localPath']).read_bytes(), b'report')

    async def test_publish_preserves_basename_and_removes_staging(self):
        source = self.home / 'workspace' / 'report.txt'
        source.write_bytes(b'report')
        directory, file = identity.open_directory, identity.open_file
        with patch.object(identity, 'open_directory', side_effect=lambda path, uid: directory(path, self.uid)), patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: file(root, path, self.uid, **kwargs)):
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

    async def test_large_audio_reaches_publisher_through_admitted_ingress(self):
        ingress = self.root / 'ingress'
        ingress.mkdir(mode=0o700)
        source = ingress / 'recording.wav'
        size = identity.MAX_FILE + 1
        with source.open('wb') as stream:
            stream.truncate(size)
        with source.open('rb') as stream:
            digest = file_digest(stream, 'sha256').hexdigest()
        cache = self.cached.with_name(source.name)
        self.cached.rename(cache)
        with cache.open('r+b') as stream:
            stream.truncate(0)
            stream.truncate(size)
        result = {**self.result, 'localPath': str(cache), 'filename': source.name,
                  'mimeType': 'audio/wav', 'sizeBytes': size, 'sha256': digest}

        async def publish(method, args, **kwargs):
            self.assertEqual(method, 'artifacts.publish')
            self.assertEqual(args['requestId'], 'stable')
            snapshot = Path(args['path'])
            self.assertEqual(snapshot.name, source.name)
            with snapshot.open('rb') as stream:
                self.assertEqual(file_digest(stream, 'sha256').hexdigest(), digest)
            return result

        prepared = await self.port.prepare_ingress(self.uid, self.profile, [str(source)])
        self.control.call = publish
        open_file, open_directory = identity.open_file, identity.open_directory
        marker = Path(prepared['paths'][0]).parent / '.brai-admission.json'
        marker_stat, fstat = marker.stat(), os.fstat

        def marker_owner(fd):
            info = fstat(fd)
            if (info.st_dev, info.st_ino) == (marker_stat.st_dev, marker_stat.st_ino):
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink, st_size=info.st_size)
            return info

        with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kw:
                          open_file(root, path, self.uid, **kw)), patch.object(
                          identity, 'open_directory', side_effect=lambda path, uid: open_directory(path, self.uid)), patch.object(
                          identity.os, 'fstat', side_effect=marker_owner):
            published = await self.port.publish(self.uid, self.profile,
                {'path': prepared['paths'][0], 'requestId': 'stable'}, admitted=True)
            with Path(published['localPath']).open('rb') as stream:
                self.assertEqual(file_digest(stream, 'sha256').hexdigest(), digest)
            with self.assertRaisesRegex(ValueError, 'Invalid artifact'):
                self.port.materialize(self.uid, self.profile, {**result, 'mimeType': 'application/octet-stream'})
        self.assertEqual(list(self.stage.iterdir()), [])
        source.rename(source.with_suffix('.txt'))
        with self.assertRaisesRegex(PermissionError, 'File denied'):
            await self.port.prepare_ingress(self.uid, self.profile, [str(source.with_suffix('.txt'))])

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

    async def test_configuration_allows_only_fixed_readonly_service_roots(self):
        value = {'ownerId': 'owner', 'stateRoot': str(self.home / 'workspace/files'),
                 'resultRoot': str(self.home / 'results'),
                 'serviceRoots': ['/opt/brai-profile/instructions', '/opt/brai-profile/engine',
                                  '/opt/brai-profile/runtime', '/opt/brai-profile/skills', '/opt/brai-profile/system-skills',
                                  str(self.home / 'usercustom/instructions')]}

        async def configuration(method, args):
            self.assertEqual(method, 'files.configuration')
            return value

        self.control.call = configuration
        self.assertEqual(await self.port.configuration(self.uid, self.profile), value)
        for field, path in [('serviceRoots', '/etc'),
                            ('serviceRoots', str(self.root / 'another-user')),
                            ('serviceRoots', '/opt/brai-profile/instructions-extra'),
                            ('serviceRoots', '/opt/brai-profile/skills-extra'),
                            ('readRoots', '/opt/brai-profile/skills'),
                            ('serviceRoots', '/opt/brai-profile/system-skills-extra'),
                            ('readRoots', '/opt/brai-profile/system-skills'),
                            ('temporaryRoots', '/opt/brai-profile/skills'),
                            ('legacyRoots', '/opt/brai-profile/skills'),
                            ('serviceRoots', '/opt/brai-profile/instructions/../engine'),
                            ('readRoots', '/opt/brai-profile/instructions'),
                            ('temporaryRoots', '/opt/brai-profile/instructions'),
                            ('legacyRoots', '/opt/brai-profile/instructions')]:
            original = dict(value)
            value[field] = [path]
            with self.subTest(field=field, path=path), self.assertRaises(PermissionError):
                await self.port.configuration(self.uid, self.profile)
            value.clear()
            value.update(original)

    async def check_generator_outputs(self, cases):
        """Пропустить результаты генераторов через прежние guards и чтение доставки."""
        backend = Backend(self.cache)
        config = {'ownerId': 'owner', 'account': 'test',
                  'stateRoot': str(self.home / 'workspace/files'),
                  'resultRoot': str(self.home / 'results'),
                  'readRoots': [str(self.home / name) for name in ('workspace', 'media', 'results')]}

        async def control(method, args, **kwargs):
            if method == 'files.configuration':
                return config
            return backend.call({'artifacts.publish': 'files.publish', 'artifacts.fetch': 'files.fetch'}[method],
                                {key: value for key, value in args.items() if key != 'uid'})

        self.control.call = control
        configured = await self.port.configuration(self.uid, self.profile)
        loop = asyncio.get_running_loop()
        worker_paths = []

        def worker_call(method, args, **kwargs):
            if method == 'files.publish':
                worker_paths.append(Path(args['path']))
            operation = {'files.publish': self.port.publish, 'files.fetch': self.port.fetch}[method]
            return asyncio.run_coroutine_threadsafe(operation(self.uid, self.profile, args), loop).result()

        previous = native._store
        original, directory = identity.open_file, identity.open_directory
        try:
            native.configure(configured, SimpleNamespace(call=worker_call))
            # Только Root-владение эмулируется; snapshot, SQLite, hash и descriptors настоящие.
            with patch.object(identity, 'open_file', side_effect=lambda root, path, uid, **kwargs: original(root, path, self.uid, **kwargs)), \
                    patch.object(identity, 'open_directory', side_effect=lambda path, uid: directory(path, self.uid)), \
                    patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: self.home)}):
                for number, (name, payload, sources) in enumerate(cases):
                    with self.subTest(tool=name, case=number):
                        before = set(backend.remote)
                        result = await asyncio.to_thread(native.after_tool, name, {}, payload,
                            session_id='session', tool_call_id=str(number))
                        self.assertEqual(type(result), type(payload))
                        value = json.loads(result) if isinstance(result, str) else result
                        if 'success' in value:
                            self.assertTrue(value['success'])
                        added = set(backend.remote) - before
                        self.assertEqual(len(added), len(sources))
                        for aid in added:
                            raw, filename = backend.remote[aid]
                            self.assertEqual(raw, sources[filename])
                            metadata, fd = await self.port.open_ingress(self.uid, self.profile, aid)
                            try:
                                self.assertEqual(os.read(fd, len(raw) + 1), raw)
                                self.assertEqual(metadata['sha256'], sha256(raw).hexdigest())
                            finally:
                                os.close(fd)
                        for method, params in backend.calls:
                            if method == 'files.publish':
                                self.assertTrue(Path(params['path']).is_relative_to(self.stage))
                        self.assertTrue(all(p.is_relative_to(self.home / 'workspace') for p in worker_paths))
                        for field in ('image', 'host_image', 'agent_visible_image', 'video', 'file_path', 'screenshot_path'):
                            if field in value:
                                self.assertTrue(Path(value[field]).is_relative_to(self.home / 'results'))
                        if 'file_paths' in value:
                            self.assertTrue(all(Path(p).is_relative_to(self.home / 'results') for p in value['file_paths']))
                            for path in value['file_paths']:
                                self.assertIn(path, value['media_tag'])
                            self.assertNotIn('/cache/', value['media_tag'])
                        if 'meta' in value:
                            self.assertTrue(Path(value['meta']['screenshot_path']).is_relative_to(self.home / 'results'))
                            self.assertNotIn('/cache/', value['text_summary'])
                            if name == 'computer_use':
                                self.assertIn(value['meta']['screenshot_path'], value['content'][0]['text'])
                                self.assertEqual(value['content'][1:], payload['content'][1:])
                            else:
                                self.assertEqual(value['content'], payload['content'])
                        if name == 'computer_use' and 'summary' in value:
                            self.assertIn(value['screenshot_path'], value['summary'])
                        self.assertEqual(list(self.stage.iterdir()), [])
        finally:
            native._store = previous

    async def test_native_generators_reach_publication_and_ingress_descriptor(self):
        """Изображения, голос, видео и оба вида browser vision сохраняют точные байты."""
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=')
        def output(directory, filename, raw):
            path = self.home / directory / filename
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.write_bytes(raw)
            return str(path)
        image = output('cache/generated/images', 'wallpaper.png', png)
        video = output('cache/generated/videos', 'movie.mp4', b'\x00\x00\x00\x18ftypmp42video-fixture')
        audio = output('cache/audio', 'speech.ogg', b'OggS-audio')
        second = output('cache/audio', 'speech-2.ogg', b'OggS-second')
        shot = output('cache/screenshots', 'browser.png', png)
        native_shot = output('cache/screenshots', 'native.png', png)
        legacy_audio = output('audio_cache', 'legacy.ogg', b'OggS-legacy')
        legacy_shot = output('browser_screenshots', 'legacy.png', png)
        computer_shot = output('cache/images', 'computer_use_capture.png', png)
        legacy_computer = output('image_cache', 'computer_use_legacy.png', png)
        cases = [
            ('image_generate', json.dumps({'success': True, 'image': image, 'host_image': image,
                'agent_visible_image': image, 'prompt': 'wallpaper'}), {'wallpaper.png': png}),
            ('video_generate', json.dumps({'success': True, 'video': video}), {'movie.mp4': Path(video).read_bytes()}),
            ('text_to_speech', json.dumps({'success': True, 'file_path': audio, 'file_paths': [audio, second],
                'media_tag': '[[audio_as_voice]]\nMEDIA:' + audio + '\nMEDIA:' + second}),
                {'speech.ogg': b'OggS-audio', 'speech-2.ogg': b'OggS-second'}),
            ('browser_vision', json.dumps({'success': True, 'screenshot_path': shot}), {'browser.png': png}),
            ('browser_vision', {'_multimodal': True,
                'meta': {'screenshot_path': native_shot, 'image_url': native_shot},
                'text_summary': 'Screenshot path: ' + native_shot,
                'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}]}, {'native.png': png}),
            ('text_to_speech', json.dumps({'success': True, 'file_path': legacy_audio}), {'legacy.ogg': b'OggS-legacy'}),
            ('browser_screenshot', json.dumps({'success': True, 'screenshot_path': legacy_shot}), {'legacy.png': png}),
            ('computer_use', {'_multimodal': True, 'meta': {'screenshot_path': computer_shot},
                'content': [{'type': 'text', 'text': 'shareable screenshot saved to ' + computer_shot},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AA=='}}],
                'text_summary': 'shareable screenshot saved to ' + computer_shot}, {'computer_use_capture.png': png}),
            ('computer_use', json.dumps({'screenshot_path': legacy_computer,
                'summary': 'shareable screenshot saved to ' + legacy_computer}), {'computer_use_legacy.png': png}),
        ]
        await self.check_generator_outputs(cases)
        for path in (image, video, audio, second, shot, native_shot, legacy_audio, legacy_shot):
            self.assertTrue(Path(path).is_file())

    @unittest.skipUnless(os.environ.get('BRAI_ENGINE_TEST_ROOT'), 'Pinned native source not configured')
    async def test_pinned_producers_reach_publication_and_ingress_descriptor(self):
        """Исполнить исходные native writers и форматы до snapshot и FD доставки."""
        engine = Path(os.environ['BRAI_ENGINE_TEST_ROOT'])
        def functions(file, names, **values):
            tree = ast.parse((engine / file).read_text())
            selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
            self.assertEqual({n.name for n in selected}, set(names))
            namespace = types.ModuleType(file)
            namespace.__dict__.update(values)
            module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0),
                *selected], type_ignores=[])
            exec(compile(ast.fix_missing_locations(module), str(engine / file), 'exec'), namespace.__dict__)
            return namespace

        constants = functions('hermes_constants.py', ['get_hermes_dir', '_legacy_path_has_content'],
            Path=Path, stat=stat, get_hermes_home=lambda: self.home)
        media = functions('agent/provider_media.py', ['cache_dir', 'cache_path', 'save_bytes', 'save_b64'],
            Path=Path, uuid=uuid, datetime=datetime, base64=base64)
        video = functions('agent/video_gen_provider.py', ['save_bytes_video', 'success_response'],
            provider_media=media, _GENERATED_VIDEO_KIND='generated/videos')
        tts = functions('tools/tts_tool.py', ['_get_default_output_dir', '_resolve_output_base', '_media_tag', '_text_to_speech_single'],
            Path=Path, datetime=datetime, os=os, json=json, logger=SimpleNamespace(info=lambda *a: None),
            _get_command_tts_output_format=lambda config: config['output_format'],
            _repair_ogg_container=lambda path: path,
            _finalize_voice_delivery=lambda path, *a: (path, True),
            _generate_command_tts=lambda text, path, *a: (Path(path).write_bytes(b'OggS-native-command'), path)[1])
        tts._default_output_dir = tts._get_default_output_dir
        vision = functions('tools/vision_tools.py', ['_build_native_vision_tool_result'])
        vision._EMBED_MAX_DIMENSION = 1024
        vision._resize_image_for_vision = lambda *a, **k: 'data:image/png;base64,AA=='
        browser_vision = functions('tools/browser_tool_vision.py', ['_native_vision_result'])
        browser = functions('tools/browser_tool.py', ['_capture_vision_screenshot'], Path=Path,
            _session=SimpleNamespace(sandbox_screenshot_path=lambda path: None,
                _run_browser_command=lambda task, command, args, **kwargs: (Path(args[-1]).write_bytes(b'png-native-capture'),
                    {'success': True, 'data': {'path': args[-1]}})[1]))
        computer = functions('tools/computer_use/tool.py', ['_secure_dir_policy', '_write_private_bytes',
            '_cache_file', '_write_cache_file', '_persist_capture_image'],
            contextlib=contextlib, uuid=uuid, base64=base64, _MAX_CAPTURE_FILES=20,
            _capture_image_format=lambda cap: ('image/png', '.png'),
            logger=SimpleNamespace(debug=lambda *a, **k: None))
        with patch.dict(sys.modules, {'hermes_constants': constants, 'tools.vision_tools': vision,
                'tools.vision_tools_history_budget': SimpleNamespace(resolve_embed_target_bytes=lambda: 1024)}):
            image = media.save_bytes('generated/images', b'png-native-image', prefix='image', extension='png')
            movie = video.save_bytes_video(b'mp4-native-video')
            audio, error = tts._resolve_output_base(None, 'silero', {'output_format': 'ogg'}, True)
            self.assertIsNone(error)
            audio_result = tts._text_to_speech_single('voice', str(audio), provider='silero', tts_config={},
                command_provider_config={'output_format': 'ogg'}, want_opus=True, instructions=None)
            shot = constants.get_hermes_dir('cache/screenshots', 'browser_screenshots') / 'native-capture.png'
            shot.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            result, actual, error = browser._capture_vision_screenshot('task', False, shot, False)
            self.assertIsNone(error)
            screenshot = browser_vision._native_vision_result(actual, 'page', False, result, None)
            computer_shot = computer._persist_capture_image(SimpleNamespace(png_b64=base64.b64encode(b'png-native-computer').decode()))
            self.assertIsNotNone(computer_shot)
        await self.check_generator_outputs([
            ('image_generate', json.dumps({'success': True, 'image': str(image)}), {image.name: b'png-native-image'}),
            ('video_generate', json.dumps(video.success_response(video=str(movie), model='fixture', prompt='movie',
                provider='fixture')), {movie.name: b'mp4-native-video'}),
            ('text_to_speech', audio_result, {audio.name: b'OggS-native-command'}),
            ('browser_vision', screenshot, {shot.name: b'png-native-capture'}),
            ('computer_use', json.dumps({'screenshot_path': computer_shot,
                'summary': 'shareable screenshot saved to ' + computer_shot}),
                {Path(computer_shot).name: b'png-native-computer'}),
        ])

    def test_native_handoff_rejects_links_and_wrong_generator_roots(self):
        """Перенос в workspace не позволяет читать чужие источники и подмены inode."""
        previous = native._store
        backend = Backend(self.home / 'results')
        native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(self.home / 'workspace/files'),
            'resultRoot': str(self.home / 'results'), 'readRoots': [str(self.home / 'workspace')]}, backend)
        root = self.home / 'cache/generated/images'
        root.mkdir(parents=True, mode=0o700)
        image = root / 'image.png'
        image.write_bytes(b'image')
        link = root / 'link.png'
        link.symlink_to(image)
        hard = root / 'hard.png'
        hard.hardlink_to(image)
        try:
            with patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: self.home)}):
                for name, path in [('image_generate', link), ('image_generate', hard), ('image_generate', image),
                        ('text_to_speech', image)]:
                    with self.subTest(tool=name, path=path), self.assertRaises((ValueError, OSError, native.FileError)):
                        native.after_tool(name, {}, json.dumps({'success': True, 'path': str(path)}), session_id='test')
                hard.unlink()
                with patch.object(identity, 'copy_fd', side_effect=PermissionError('File changed during copy')):
                    with self.assertRaisesRegex(PermissionError, 'File changed'):
                        native.after_tool('image_generate', {}, json.dumps({'image': str(image)}), session_id='test')
            self.assertEqual(backend.calls, [])
            self.assertEqual(image.read_bytes(), b'image')
        finally:
            native._store = previous

    def test_unknown_publication_keeps_snapshot_for_recovery_without_generation(self):
        """Неизвестный исход сохраняет bytes и requestId для существующего recovery."""
        previous = native._store
        backend = Backend(self.home / 'results')
        backend.fail_publish = True
        store = native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(self.home / 'workspace/files'),
            'resultRoot': str(self.home / 'results'), 'readRoots': [str(self.home / 'workspace')]}, backend)
        image = self.home / 'cache/generated/images/image.png'
        image.parent.mkdir(parents=True, mode=0o700)
        image.write_bytes(b'generated once')
        try:
            with patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: self.home)}):
                with self.assertRaisesRegex(native.FileError, 'ARTIFACTS_UNAVAILABLE'):
                    native.after_tool('image_generate', {}, json.dumps({'image': str(image)}),
                        session_id='session', tool_call_id='image')
            first = backend.calls[-1][1]
            self.assertEqual(Path(first['path']).read_bytes(), b'generated once')
            self.assertEqual(image.read_bytes(), b'generated once')
            backend.fail_publish = False
            store.resume_publications()
            self.assertEqual(backend.calls[-1][1], first)
            self.assertEqual(len(backend.remote), 1)
        finally:
            native._store = previous

    def test_cache_cleanup_and_snapshot_cleanup_do_not_hide_confirmed_result(self):
        """После подтверждения все aliases сохраняются даже при удалении кеша и ошибке уборки."""
        previous = native._store
        backend = Backend(self.home / 'results')
        image = self.home / 'cache/generated/images/image.png'
        image.parent.mkdir(parents=True, mode=0o700)
        image.write_bytes(b'generated once')
        def call(method, params, **kwargs):
            result = backend.call(method, params, **kwargs)
            if method == 'files.publish':
                image.unlink()  # Имитирует независимую уборку native cache после snapshot.
            return result
        native.configure({'ownerId': 'owner', 'account': 'test', 'stateRoot': str(self.home / 'workspace/files'),
            'resultRoot': str(self.home / 'results'), 'readRoots': [str(self.home / 'workspace')]}, SimpleNamespace(call=call))
        try:
            with patch.dict(sys.modules, {'hermes_constants': SimpleNamespace(get_hermes_home=lambda: self.home)}), \
                    patch.object(native.shutil, 'rmtree', side_effect=OSError('Cleanup failed')), \
                    self.assertLogs('files.native', level='WARNING') as logs:
                result = json.loads(native.after_tool('image_generate', {}, json.dumps({'success': True,
                    'image': str(image), 'host_image': str(image), 'agent_visible_image': str(image)})))
            self.assertTrue(result['success'])
            self.assertEqual(result['image'], result['host_image'])
            self.assertEqual(result['image'], result['agent_visible_image'])
            self.assertEqual(Path(result['image']).read_bytes(), b'generated once')
            self.assertIn(result['artifactId'], backend.remote)
            self.assertEqual(sum(method == 'files.publish' for method, _ in backend.calls), 1)
            self.assertIn('BRAI_GENERATED_OUTPUT_CLEANUP_FAILED', logs.output[0])
        finally:
            native._store = previous

    async def test_image_cache_publication_rejects_other_roots_and_links(self):
        """Broker по-прежнему отклоняет native cache и любые соседние каталоги."""
        root = self.home / 'cache/generated/images'
        root.mkdir(parents=True, mode=0o700)
        image = root / 'image.png'
        image.write_bytes(b'image')
        link = root / 'link.png'
        link.symlink_to(image)
        hardlink = root / 'hard.png'
        hardlink.hardlink_to(image)
        for path in (self.home / 'cache/spillover/file', self.home / 'cache/generated/images-other/file',
                     root / 'nested/image.png', root / '../images/image.png', self.root / 'foreign/cache/generated/images/image.png',
                     link, hardlink, image):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                await self.port.publish(self.uid, self.profile, {'path': str(path), 'requestId': 'denied'})
        self.assertEqual(self.calls, [])

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
