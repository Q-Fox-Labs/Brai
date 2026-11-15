# ABOUTME: Проверяет дочитывание runtime spill и справочников без Artifacts.
# ABOUTME: Использует только синтетический профиль и закреплённые native writers.
import ast
from collections import deque
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from files import native, runtime_reads
from files.store import FileError
from files.tests.test_files import Backend


class RuntimeReadsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.backend = Backend(self.home / 'results')
        previous = native._store
        self.addCleanup(setattr, native, '_store', previous)
        self.store = native.configure({'ownerId': 'owner', 'account': 'fixture',
            'stateRoot': str(self.home / 'workspace/files'), 'resultRoot': str(self.home / 'results'),
            'readRoots': [str(self.home / name) for name in ('workspace', 'media', 'results')]}, self.backend)
        constants = types.ModuleType('hermes_constants')
        constants.get_hermes_home = lambda: self.home
        constants.get_hermes_dir = lambda current, legacy, **kw: self.home / current
        self.constants = constants
        ports = patch.dict(sys.modules, {'hermes_constants': constants})
        ports.start()
        self.addCleanup(ports.stop)

    def file(self, relative, raw=b'line 1\nline 2\nline 3\n'):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(raw)
        return path

    def read(self, path, task='turn'):
        return Path(native.before_tool('read_file', {'path': str(path)}, task_id=task)['path'])

    def test_all_pinned_runtime_directories_read_without_publication(self):
        for relative in runtime_reads.READ_DIRECTORIES:
            with self.subTest(directory=relative):
                original = self.file(relative + '/file.txt')
                copied = self.read(original)
                self.assertTrue(copied.is_relative_to(self.store.workspace('turn')))
                self.assertEqual(copied.read_bytes(), original.read_bytes())
                self.assertEqual(copied.stat().st_mode & 0o777, 0o400)
                # Two dispatch boundaries and repeated pagination preserve the same native dedup key.
                version = copied.stat()
                self.assertEqual(self.read(copied), copied)
                self.assertEqual(self.read(original), copied)
                self.assertEqual(copied.stat(), version)
        self.assertEqual(self.backend.calls, [])
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM publications').fetchone()[0], 0)
        self.store.cleanup('turn', cache=False)
        self.assertFalse(copied.exists())
        self.assertTrue(original.exists())

    def test_updated_source_and_other_task_have_separate_snapshots(self):
        original = self.file('cache/spillover/context.txt')
        first = self.read(original)
        second_task = self.read(original, 'other')
        self.assertNotEqual(first, second_task)
        original.write_bytes(b'new context\n')
        changed = self.read(original)
        self.assertNotEqual(first, changed)
        self.assertEqual(changed.read_bytes(), b'new context\n')
        self.assertEqual(first.read_bytes(), b'line 1\nline 2\nline 3\n')
        with self.assertRaisesRegex(FileError, 'FILE_SCOPE_DENIED'):
            self.read(second_task)

    def test_execute_only_profile_parents_allow_reads_and_media_handoff(self):
        context = self.file('cache/spillover/context.txt')
        image = self.file('cache/generated/images/image.png', b'png-fixture')
        self.root.chmod(0o111)
        try:
            self.assertEqual(self.read(context).read_bytes(), context.read_bytes())
            result = json.loads(native.after_tool('image_generate', {},
                json.dumps({'success': True, 'image': str(image)}), task_id='turn'))
            self.assertEqual(Path(result['image']).read_bytes(), b'png-fixture')
        finally:
            self.root.chmod(0o700)

    def test_runtime_sources_are_not_publication_or_write_roots(self):
        original = self.file('cache/spillover/context.txt')
        roots = self.store.read_roots
        for tool in ('write_file', 'patch'):
            with self.assertRaisesRegex(FileError, 'TEMPORARY_OUTPUT_REQUIRED'):
                native.before_tool(tool, {'path': str(original)}, task_id='turn')
        with self.assertRaisesRegex(FileError, 'TEMPORARY_OUTPUT_REQUIRED'):
            native.guard_write(str(original), 'turn')
        with self.assertRaisesRegex(FileError, 'READ_ROOT_DENIED'):
            self.store.publish(original, 'explicit-original')
        text = '[Служебный контекст](' + str(original) + ')'
        self.assertEqual(native.final_text(text, 'turn'), text)
        with self.assertRaisesRegex(FileError, 'TEMPORARY_WORKDIR_REQUIRED'):
            native.before_tool('terminal', {'workdir': str(original.parent)})
        self.assertEqual(self.store.read_roots, roots)
        self.assertEqual(self.backend.calls, [])

    def test_unrelated_cache_foreign_home_and_directories_stay_denied(self):
        for relative in ('cache/auth/token.txt', 'cache/spillover-other/secret.txt', '.env', 'config.yaml'):
            with self.subTest(path=relative):
                with self.assertRaisesRegex(FileError, 'READ_ROOT_DENIED'):
                    self.read(self.file(relative))
        foreign = self.root / 'foreign/cache/spillover/context.txt'
        foreign.parent.mkdir(parents=True)
        foreign.write_bytes(b'foreign')
        with self.assertRaisesRegex(FileError, 'READ_ROOT_DENIED'):
            self.read(foreign)
        with self.assertRaisesRegex(FileError, 'ARTIFACT_DIRECTORY_REQUIRED'):
            self.read(self.home / 'cache')
        self.assertEqual(self.backend.calls, [])

    def test_links_special_files_foreign_uid_and_snapshot_tampering_are_denied(self):
        original = self.file('cache/spillover/context.txt')
        secret = self.file('private/secret.txt', b'secret')
        link = original.parent / 'link.txt'
        link.symlink_to(secret)
        with self.assertRaises(OSError):
            self.read(link)
        directory = original.parent / 'linked'
        directory.symlink_to(secret.parent, target_is_directory=True)
        with self.assertRaises(OSError):
            self.read(directory / secret.name)
        hard = original.parent / 'hard.txt'
        hard.hardlink_to(secret)
        with self.assertRaisesRegex(FileError, 'RUNTIME_READ_DENIED'):
            self.read(hard)
        fifo = original.parent / 'fifo.txt'
        os.mkfifo(fifo)
        with self.assertRaisesRegex(FileError, 'RUNTIME_READ_DENIED'):
            self.read(fifo)
        with patch.object(runtime_reads.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(FileError, 'RUNTIME_READ_DENIED'):
                runtime_reads.snapshot(runtime_reads.source(original), self.store.work)
        copied = self.read(original)
        copied.chmod(0o600)
        copied.write_bytes(b'changed snapshot')
        with self.assertRaisesRegex(FileError, 'RUNTIME_READ_CHANGED'):
            self.read(original)
        copied.unlink()
        copied.symlink_to(secret)
        with self.assertRaises(OSError):
            self.read(original)
        self.assertEqual(self.backend.calls, [])

    def test_skill_paths_remain_package_relative_including_native_rejections(self):
        for tool in ('skill_view', 'skill_manage'):
            for relative in ('references/guide-operations.md', '../private.txt', '/tmp/private.txt'):
                args = {'name': 'memos-memory', 'file_path': relative}
                self.assertEqual(native.before_tool(tool, args), args)
        self.assertEqual(self.backend.calls, [])

    def test_source_change_during_copy_leaves_no_snapshot(self):
        original = self.file('cache/spillover/context.txt')
        inode = original.stat().st_ino
        fstat = os.fstat
        reads = 0
        def changed(fd):
            nonlocal reads
            info = fstat(fd)
            if info.st_ino == inode:
                reads += 1
                if reads == 3:  # open_source validation, before copy, then after copy.
                    fields = {name: getattr(info, name) for name in
                        ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
                    return types.SimpleNamespace(**(fields | {'st_mtime_ns': info.st_mtime_ns + 1}))
            return info
        with patch.object(runtime_reads.os, 'fstat', side_effect=changed):
            with self.assertRaisesRegex(FileError, 'RUNTIME_READ_CHANGED'):
                self.read(original)
        self.assertEqual(list(self.store.workspace('turn').glob('.runtime-read-*')), [])
        self.assertEqual(self.backend.calls, [])

    def test_shared_instruction_generation_can_be_read_but_not_written(self):
        from identity import instructions
        shared = self.root / 'shared'
        generation = shared / '.generations' / ('a' * 64)
        reference = generation / 'skills/memos-memory/references/guide-operations.md'
        reference.parent.mkdir(parents=True)
        reference.write_bytes(b'shared reference')
        (shared / 'current').symlink_to('.generations/' + 'a' * 64)
        # Root ownership is already exercised by instructions' own native tests.
        # This unprivileged fixture substitutes only the protected-generation port/expected UID.
        original_source = runtime_reads.source
        def local_source(path):
            selected = original_source(path)
            return (selected[0], selected[1], os.getuid()) if selected is not None else None
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}), \
             patch.object(instructions, 'ROOT', shared), \
             patch.object(instructions, 'selected_generation', return_value=generation), \
             patch.object(runtime_reads, 'source', side_effect=local_source):
            for path in (reference, shared / 'current' / reference.relative_to(generation)):
                self.assertEqual(self.read(path).read_bytes(), b'shared reference')
                with self.assertRaisesRegex(FileError, 'TEMPORARY_OUTPUT_REQUIRED'):
                    native.guard_write(str(path), 'turn')
            outside = shared / 'other.txt'
            outside.write_bytes(b'not a generation')
            with self.assertRaisesRegex(FileError, 'READ_ROOT_DENIED'):
                self.read(outside)
        self.assertEqual(self.backend.calls, [])

    @unittest.skipUnless(os.environ.get('BRAI_ENGINE_TEST_ROOT'), 'Pinned native source not configured')
    def test_pinned_spill_writers_and_skill_reference_resolver(self):
        engine = Path(os.environ['BRAI_ENGINE_TEST_ROOT'])
        def functions(path, names, **values):
            tree = ast.parse((engine / path).read_text())
            nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
            self.assertEqual({n.name for n in nodes}, set(names))
            module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *nodes], type_ignores=[])
            scope = dict(values)
            exec(compile(ast.fix_missing_locations(module), str(engine / path), 'exec'), scope)
            return types.SimpleNamespace(**scope)
        safety = types.ModuleType('tools.spill_safety')
        safety.__dict__.update(vars(functions('tools/spill_safety.py',
            ['ensure_spill_dir', 'open_exclusive', 'write_text_exclusive'],
            os=os, stat=stat, Path=Path, _O_NOFOLLOW=os.O_NOFOLLOW)))
        logger = logging.getLogger(__name__)
        storage = functions('tools/tool_result_storage.py', ['_write_to_spillover'],
            os=os, logger=logger, get_spillover_dir=lambda: self.home / 'cache/spillover', _prune_spillover_once=lambda: None)
        web = functions('tools/web_tools_truncate.py', ['_store_full_text'],
            logger=logger, MAX_STORED_TEXT_CHARS=2000000)
        snapshot = functions('tools/browser_tool_snapshot.py', ['_store_full_snapshot'],
            _bt=types.SimpleNamespace(logger=logger, MAX_STORED_SNAPSHOT_CHARS=2000000))
        execute = functions('tools/code_execution_tool.py', ['_spill_full_stdout'],
            logger=logger, MAX_SPILLED_STDOUT_BYTES=5000000)
        delegate = functions('tools/delegate_tool_results.py', ['_spill_summary_to_file'], logger=logger)
        hook = functions('tools/hook_output_spill.py', ['_resolve_spill_dir', 'spill_if_oversized'],
            Path=Path, os=os, re=re, uuid=uuid, logger=logger, get_hermes_home=lambda: self.home)
        terminal = functions('tools/environments/base_output.py', ['_BoundedOutputCollector'],
            deque=deque, threading=threading)
        slug = types.ModuleType('tools.web_result_cache')
        slug._host_slug = lambda url: 'example'
        redact = types.ModuleType('agent.redact')
        redact.redact_sensitive_text = lambda text, **kw: text
        text = 'контекст 🌳\n' * 1200
        with patch.dict(sys.modules, {'tools.spill_safety': safety, 'tools.web_result_cache': slug, 'agent.redact': redact}):
            paths = [storage._write_to_spillover(text, 'context.txt'),
                web._store_full_text('https://example.invalid', text),
                snapshot._store_full_snapshot(text), execute._spill_full_stdout(text),
                delegate._spill_summary_to_file(1, text)]
            collector = terminal._BoundedOutputCollector(100, self.home / 'cache/terminal-output/out-fixture.log')
            collector.append(text)
            paths.append(collector.close_spill())
            hook.spill_if_oversized(text, session_id='session', config={'enabled': True, 'max_chars': 1, 'directory': None})
            paths += list((self.home / 'hook_outputs').rglob('*.txt'))
            self.assertEqual(len(paths), 7)
            for path in paths:
                self.assertIsNotNone(path)
                self.assertEqual(self.read(path).read_bytes(), Path(path).read_bytes())
        # Execute the pinned linked-file resolver after the mandatory argument boundary.
        plugin = functions('tools/skills_tool_plugin.py', ['_serve_skill_file'],
            Path=Path, _json=lambda value: json.dumps(value),
            _read_skill_text=lambda path: path.read_text(), _fail=lambda message, **kw: json.dumps({'success': False, 'error': message}),
            _mark_background_review_read=lambda path: None)
        security = types.ModuleType('tools.path_security')
        security.__dict__.update(vars(functions('tools/path_security.py',
            ['has_traversal_component', 'validate_within_dir'], Path=Path)))
        package = self.home / 'skills/memos-memory'
        reference = self.file('skills/memos-memory/references/guide-operations.md', text.encode())
        args = native.before_tool('skill_view', {'name': 'memos-memory', 'file_path': 'references/guide-operations.md'})
        with patch.dict(sys.modules, {'tools.path_security': security}):
            result = json.loads(plugin._serve_skill_file(package, args['file_path'], args['name']))
            for relative in ('../private.txt', '/tmp/private.txt'):
                rejected = native.before_tool('skill_view', {'name': 'memos-memory', 'file_path': relative})
                self.assertFalse(json.loads(plugin._serve_skill_file(package, rejected['file_path'], rejected['name']))['success'])
        self.assertTrue(result['success'], result)
        self.assertEqual(result['content'], text)
        self.assertEqual(self.backend.calls, [])


if __name__ == '__main__':
    unittest.main()
