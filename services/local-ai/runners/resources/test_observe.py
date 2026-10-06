# ABOUTME: Проверяет process-group resource observer на procfs fixtures и test children.
# ABOUTME: Не запускает модель и не сохраняет process content.

from __future__ import annotations

import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import observe


def _stat_line(
    pid: int,
    *,
    comm: str = "worker (fixture)",
    parent_pid: int = 1,
    process_group_id: int = 40,
    session_id: int = 40,
    user_cpu_ticks: int = 3,
    system_cpu_ticks: int = 2,
    thread_count: int = 2,
    start_ticks: int = 100,
    rss_pages: int = 7,
    state: str = "S",
) -> str:
    """Сформировать минимально достаточный Linux stat без пользовательских данных."""
    fields = ["0"] * 22
    fields[0] = state
    fields[1] = str(parent_pid)
    fields[2] = str(process_group_id)
    fields[3] = str(session_id)
    fields[11] = str(user_cpu_ticks)
    fields[12] = str(system_cpu_ticks)
    fields[17] = str(thread_count)
    fields[19] = str(start_ticks)
    fields[21] = str(rss_pages)
    return f"{pid} ({comm}) {' '.join(fields)}\n"


def _write_stat(root: Path, pid: int, **values: object) -> None:
    """Добавить один proc stat fixture в отдельный временный proc root."""
    directory = root / str(pid)
    directory.mkdir()
    (directory / "stat").write_text(_stat_line(pid, **values), encoding="utf-8")


class ResourceObserverTests(unittest.TestCase):
    """Проверить идентичность, scoped aggregation, CPU delta и bounded run."""

    def test_stat_parser_handles_parentheses_and_rejects_pid_reuse_mismatch(self) -> None:
        """Разобрать comm с пробелами/скобками и строго сопоставить PID stat."""
        process = observe._parse_stat(_stat_line(41, comm="name ) with ( punctuation"), 41)
        self.assertEqual(process.identity, (41, 100))
        self.assertEqual(process.process_group_id, 40)
        self.assertEqual(process.cpu_ticks, 5)
        self.assertEqual(process.thread_count, 2)
        with self.assertRaisesRegex(observe.ObserverError, "pid identity"):
            observe._parse_stat(_stat_line(42), 41)
        with self.assertRaises(observe.ObserverError):
            observe._parse_stat("41 (broken) S 1 2", 41)

    def test_module_loads_from_unregistered_importlib_spec(self) -> None:
        """Поддержать controlled wrapper, который загружает файл без sys.modules."""
        spec = importlib.util.spec_from_file_location(
            "local_ai_resource_observer_probe", Path(observe.__file__)
        )
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.MAX_DURATION_SECONDS, 300.0)

    def test_proc_scan_and_aggregate_include_only_exact_group_and_session(self) -> None:
        """Сложить RSS и потоки только для явной группы и её сессии."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_stat(root, 40, process_group_id=40, session_id=40, rss_pages=7, thread_count=2)
            _write_stat(root, 41, process_group_id=40, session_id=40, rss_pages=11, thread_count=3)
            _write_stat(root, 42, process_group_id=42, session_id=42, rss_pages=900, thread_count=99)
            _write_stat(
                root, 43, comm="ignored\nтекст", process_group_id=40,
                session_id=43, rss_pages=800, thread_count=88
            )
            group = observe._scan_group(root, 40, 40, time.monotonic_ns() + 1_000_000_000)
            self.assertEqual({identity[0] for identity in group}, {40, 41})
            self.assertEqual(observe._group_sample_stats(group, 4_096), (2, 5, 18 * 4_096))

    def test_leader_must_own_a_new_session_and_match_start_ticks(self) -> None:
        """Принимать только изолированную session лидера с точной identity."""
        leader = observe._parse_stat(
            _stat_line(60, process_group_id=60, session_id=60, start_ticks=700), 60
        )
        self.assertIs(observe._validate_leader_identity(leader, 60, 60, 700), leader)
        shell_group = observe._parse_stat(
            _stat_line(60, process_group_id=60, session_id=9, start_ticks=700), 60
        )
        with self.assertRaisesRegex(observe.ObserverError, "identity mismatch"):
            observe._validate_leader_identity(shell_group, 60, 60, 700)
        with self.assertRaisesRegex(observe.ObserverError, "identity mismatch"):
            observe._validate_leader_identity(leader, 60, 60, 701)

    def test_cpu_delta_requires_the_same_pid_and_start_ticks(self) -> None:
        """Не засчитывать ticks нового процесса при повторном использовании PID."""
        previous = {(50, 1_000): 80, (51, 1_001): 20}
        same_and_reused = {(50, 1_000): 87, (51, 2_001): 900}
        self.assertEqual(observe._cpu_delta_ticks(same_and_reused, previous), 7)

    def test_expired_proc_scan_is_bounded(self) -> None:
        """Остановить procfs обход на monotonic deadline."""
        with self.assertRaises(observe._DeadlineReached):
            observe._scan_group(Path("/proc"), 1, 1, time.monotonic_ns() - 1)

    def test_actual_own_process_group_includes_child_and_finishes_within_bound(self) -> None:
        """Увидеть test parent+child группу до их собственного завершения."""
        child_source = "import time; time.sleep(0.35)"
        parent_source = (
            "import subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c',sys.argv[1]]); "
            "time.sleep(0.15); child.wait()"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", parent_source, child_source],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        try:
            leader = observe._read_stat(Path("/proc"), process.pid)
            self.assertIsNotNone(leader)
            assert leader is not None
            reaper = threading.Thread(target=process.wait, kwargs={"timeout": 1.5}, daemon=True)
            reaper.start()
            report = observe.observe(process.pid, process.pid, leader.start_ticks, 2.0, 50)
            reaper.join(timeout=1.0)
            self.assertFalse(reaper.is_alive())
            self.assertEqual(report["schemaVersion"], 1)
            self.assertEqual(report["window"]["terminationReason"], "process_group_gone")
            self.assertGreaterEqual(report["window"]["sampleCount"], 2)
            self.assertGreaterEqual(report["summary"]["peakConcurrentProcessCount"], 2)
            self.assertEqual(
                report["summary"]["peakAggregateSampledRssBytes"],
                max(sample["aggregateSampledRssBytes"] for sample in report["samples"]),
            )
            self.assertEqual(
                report["summary"]["totalObservedCpuTicks"],
                sum(sample["observedCpuTicksDelta"] for sample in report["samples"]),
            )
            identities = report["observedIdentities"]
            self.assertTrue(any(identity["pid"] != process.pid for identity in identities))
            self.assertLessEqual(report["window"]["observedDurationMs"], 2_000)
        finally:
            _cleanup_test_group(process)

    def test_long_interval_does_not_extend_monotonic_deadline(self) -> None:
        """Ограничить sleep общим deadline даже при интервале длиннее окна."""
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(2)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        try:
            leader = observe._read_stat(Path("/proc"), process.pid)
            self.assertIsNotNone(leader)
            assert leader is not None
            started = time.monotonic()
            report = observe.observe(process.pid, process.pid, leader.start_ticks, 0.1, 5_000)
            self.assertLess(time.monotonic() - started, 0.8)
            self.assertEqual(report["window"]["terminationReason"], "deadline_reached")
            self.assertEqual(report["window"]["sampleCount"], 1)
        finally:
            _cleanup_test_group(process)

    def test_wrong_start_ticks_fails_before_sampling(self) -> None:
        """Отклонить PID, чей процесс уже не совпадает с заданным starttime."""
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(1)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        try:
            leader = observe._read_stat(Path("/proc"), process.pid)
            self.assertIsNotNone(leader)
            assert leader is not None
            with self.assertRaisesRegex(observe.ObserverError, "identity mismatch"):
                observe.observe(process.pid, process.pid, leader.start_ticks + 1, 0.1, 50)
        finally:
            _cleanup_test_group(process)


def _cleanup_test_group(process: subprocess.Popen[bytes]) -> None:
    """Завершить только созданную этим тестом process group с коротким пределом."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.4)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.4)
        except subprocess.TimeoutExpired:
            pass


if __name__ == "__main__":
    unittest.main()
