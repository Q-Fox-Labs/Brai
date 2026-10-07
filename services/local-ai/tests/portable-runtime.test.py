# ABOUTME: Проверяет hash cache portable ELF closure без запуска ldd или установки пакетов.
# ABOUTME: Повторные ссылки сохраняют SHA-проверки, изменившиеся bytes и SONAME конфликты отклоняются.
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('portable_runtime', Path(__file__).parents[1] / 'release/prepare-portable-runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class DependencyHashTests(unittest.TestCase):
    """Проверить reuse и invalidation на настоящих собственных файлах."""

    def run_closure(self, root, outputs):
        rows = []
        with patch.object(runtime, 'run', side_effect=outputs):
            runtime.ldd_closure([Path('first'), Path('second')], root, root / 'system', rows, {}, {'system'})
        return rows

    def test_repeated_dependency_hashes_source_once_and_keeps_final_inventory_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'libfixture.so'
            source.write_bytes(b'pinned-library')
            output = f' libfixture.so => {source} (0x0)'
            original = runtime.sha256
            with patch.object(runtime, 'sha256', wraps=original) as digest:
                rows = self.run_closure(root, [output, output])
                self.assertEqual(sum(call.args[0] == source for call in digest.call_args_list), 1)
                self.assertTrue(any(call.args[0] == root / 'system/libfixture.so' for call in digest.call_args_list))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['sha256'], original(source))

    def test_same_path_changed_with_same_size_and_mtime_is_rehashed_and_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'libfixture.so'
            source.write_bytes(b'old-bytes')
            before = source.stat()
            output = f' libfixture.so => {source} (0x0)'
            count = 0

            def changed(_argv, **_kwargs):
                nonlocal count
                count += 1
                if count == 2:
                    source.write_bytes(b'new-bytes')
                    os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
                return output

            with self.assertRaisesRegex(ValueError, 'conflicting ELF dependency bytes'):
                self.run_closure(root, changed)

    def test_different_paths_with_conflicting_soname_remain_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / 'first.so', root / 'second.so'
            first.write_bytes(b'one')
            second.write_bytes(b'two')
            with self.assertRaisesRegex(ValueError, 'conflicting ELF dependency bytes'):
                self.run_closure(root, [f' libfixture.so => {first} (0x0)', f' libfixture.so => {second} (0x0)'])


if __name__ == '__main__':
    unittest.main()
