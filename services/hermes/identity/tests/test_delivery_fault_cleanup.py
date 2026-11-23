# ABOUTME: Проверяет уборку отдельного fault stand при раннем сбое подготовки.
# ABOUTME: Использует только временный каталог и не запускает сервисы или сеть.
import asyncio
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest

from identity.tests.delivery_faults import eventually, run


class DeliveryFaultCleanupTests(unittest.TestCase):
    @staticmethod
    def fixture(root, remove_owned):
        def fail_archive(_raw, _destination):
            raise ValueError('STAGE_FAILED')

        return SimpleNamespace(
            RUN_BASE=root,
            candidate_archive=lambda _source, _sha: b'',
            stage_archive=fail_archive,
            safe_error_code=lambda error: str(error),
            remove_owned_root=remove_owned,
            worker_exception_diagnostics=lambda _raw: [],
        )

    def test_early_failure_preserves_reason_and_removes_own_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def remove_owned(path, identity):
                stat = path.lstat()
                self.assertEqual((stat.st_dev, stat.st_ino), identity)
                shutil.rmtree(path)

            fixture = self.fixture(root, remove_owned)
            result = asyncio.run(run({'sourceRoot': directory, 'sourceSha': 'a' * 40}, fixture, None, None))
            self.assertEqual((result['state'], result['stage'], result['code']),
                             ('failed', 'candidate-archive', 'STAGE_FAILED'))
            self.assertTrue(result['cleaned'])
            self.assertEqual(list(root.iterdir()), [])

    def test_cleanup_failure_retains_both_errors_and_the_own_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def refuse_cleanup(_path, _identity):
                raise OSError('CLEANUP_FAILED')

            result = asyncio.run(run({'sourceRoot': directory, 'sourceSha': 'a' * 40},
                                     self.fixture(root, refuse_cleanup), None, None))
            self.assertEqual((result['stage'], result['code']), ('candidate-archive', 'STAGE_FAILED'))
            self.assertFalse(result['cleaned'])
            self.assertEqual(result['cleanupErrors'], [{'type': 'OSError', 'code': 'CLEANUP_FAILED'}])
            self.assertEqual(list(root.iterdir()), [Path(result['fixtureRoot'])])

    def test_wait_without_deadline_still_detects_a_dead_worker(self):
        with self.assertRaisesRegex(ValueError, 'WORKER_EXITED'):
            asyncio.run(eventually(lambda: False, 'retry', watch=SimpleNamespace(returncode=1), timeout=None))

    def test_missing_source_does_not_create_a_fixture_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(KeyError):
                asyncio.run(run({'sourceRoot': directory}, self.fixture(root, None), None, None))
            self.assertEqual(list(root.iterdir()), [])
