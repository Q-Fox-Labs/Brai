# ABOUTME: Проверяет уборку отдельного fault stand при раннем сбое подготовки.
# ABOUTME: Использует только временный каталог и не запускает сервисы или сеть.
import asyncio
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest

from identity.tests.delivery_faults import run


class DeliveryFaultCleanupTests(unittest.TestCase):
    def test_early_failure_preserves_reason_and_removes_own_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def fail_archive(_raw, _destination):
                raise ValueError('STAGE_FAILED')

            def remove_owned(path, identity):
                stat = path.lstat()
                self.assertEqual((stat.st_dev, stat.st_ino), identity)
                shutil.rmtree(path)

            fixture = SimpleNamespace(
                RUN_BASE=root,
                candidate_archive=lambda _source, _sha: b'',
                stage_archive=fail_archive,
                safe_error_code=lambda error: str(error),
                remove_owned_root=remove_owned,
                worker_exception_diagnostics=lambda _raw: [],
            )
            result = asyncio.run(run({'sourceRoot': directory, 'sourceSha': 'a' * 40}, fixture, None, None))
            self.assertEqual((result['state'], result['stage'], result['code']),
                             ('failed', 'candidate-archive', 'STAGE_FAILED'))
            self.assertTrue(result['cleaned'])
            self.assertEqual(list(root.iterdir()), [])
