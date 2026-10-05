# ABOUTME: Проверяет bounded harness и WER без запуска модели.
# ABOUTME: Не открывает аудио и не требует Python-пакетов runtime.

from __future__ import annotations

import unittest
import sys
import time
from unittest.mock import patch

import measure_short


class ShortMeasurementTest(unittest.TestCase):
    """Проверить WER счётчики и локальные ограничения harness."""

    def test_wer_counts_exact_match_and_each_error_type(self) -> None:
        self.assertEqual(
            measure_short._wer_counts(["мир", "дом"], ["мир", "дом"]),
            (0, 0, 0, 2),
        )
        self.assertEqual(
            measure_short._wer_counts(["мир", "дом"], ["мир", "сад"]),
            (1, 0, 0, 2),
        )
        self.assertEqual(
            measure_short._wer_counts(["мир", "дом"], ["мир"]),
            (0, 1, 0, 2),
        )
        self.assertEqual(
            measure_short._wer_counts(["мир"], ["мир", "дом"]),
            (0, 0, 1, 1),
        )

    def test_normalization_ignores_case_punctuation_and_yo(self) -> None:
        self.assertEqual(
            measure_short._normalize("Ёж, идёт домой!"),
            ["еж", "идет", "домой"],
        )

    def test_decode_and_total_timeouts_have_fixed_acceptance_caps(self) -> None:
        with patch(
            "sys.argv",
            [
                "measure_short.py",
                "--python",
                "/opt/python",
                "--runner",
                "/opt/runner.py",
                "--model-path",
                "/models/asr",
                "--vad-model-path",
                "/models/vad",
                "--fixture-root",
                "/tmp/fixture",
                "--manifest",
                "/tmp/manifest.json",
                "--threads",
                "1",
                "--total-timeout-seconds",
                "181",
            ],
        ):
            with self.assertRaises(SystemExit) as exit_info:
                measure_short._arguments(None)
        self.assertEqual(exit_info.exception.code, 2)

    def test_partial_rpc_line_times_out_and_process_group_is_stopped(self) -> None:
        process = measure_short.RpcProcess(
            [
                sys.executable,
                "-c",
                "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)']); sys.stdout.write('{'); sys.stdout.flush(); time.sleep(5)",
            ],
            {"PATH": "/usr/bin:/bin"},
            time.monotonic() + 0.2,
        )
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(measure_short.MeasurementError, "timed out"):
                process.call("health", {}, "timeout-test")
        finally:
            stopped = process.stop()
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(stopped["pid_released"])
        self.assertTrue(stopped["process_group_released"])


if __name__ == "__main__":
    unittest.main()
