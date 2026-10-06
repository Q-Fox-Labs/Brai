#!/usr/bin/env python3
# ABOUTME: Снимает ограниченные ресурсные метаданные явной Linux process group.
# ABOUTME: Не запускает и не останавливает процессы и не читает их содержимое.

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any


MIN_DURATION_SECONDS = 0.1
MAX_DURATION_SECONDS = 300.0
MIN_INTERVAL_MS = 50
MAX_INTERVAL_MS = 5_000
MAX_SAMPLES = 6_001
MAX_PROC_ENTRIES = 131_072
MAX_PID = 4_194_304
MAX_REPORTED_IDENTITIES = 8_192


class ObserverError(RuntimeError):
    """Сообщает о небезопасном или неполном измерении без данных процесса."""


class _DeadlineReached(Exception):
    """Прерывает обход procfs, когда общий monotonic deadline истёк."""


class ProcessStat:
    """Сохраняет только числовые поля `/proc/<pid>/stat`, нужные измерению."""

    __slots__ = (
        "pid", "process_group_id", "session_id", "user_cpu_ticks",
        "system_cpu_ticks", "thread_count", "start_ticks", "rss_pages",
    )

    def __init__(
        self,
        pid: int,
        process_group_id: int,
        session_id: int,
        user_cpu_ticks: int,
        system_cpu_ticks: int,
        thread_count: int,
        start_ticks: int,
        rss_pages: int,
    ) -> None:
        """Сохранить проверенные поля без зависимости от импорта модуля."""
        self.pid = pid
        self.process_group_id = process_group_id
        self.session_id = session_id
        self.user_cpu_ticks = user_cpu_ticks
        self.system_cpu_ticks = system_cpu_ticks
        self.thread_count = thread_count
        self.start_ticks = start_ticks
        self.rss_pages = rss_pages

    @property
    def identity(self) -> tuple[int, int]:
        """Вернуть PID вместе с starttime для защиты от повторного использования PID."""
        return (self.pid, self.start_ticks)

    @property
    def cpu_ticks(self) -> int:
        """Вернуть накопленные user+system CPU ticks одного процесса."""
        return self.user_cpu_ticks + self.system_cpu_ticks


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    """Проверить целочисленный вход с явными нижней и верхней границами."""
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ObserverError(f"invalid {name}")
    return value


def _parse_stat(raw: str, expected_pid: int) -> ProcessStat:
    """Строго разобрать нужные поля stat, игнорируя process name и прочий текст."""
    if not isinstance(raw, str) or len(raw) > 16_384:
        raise ObserverError("invalid proc stat")
    if raw.endswith("\n"):
        raw = raw[:-1]
    separator = raw.find(" ")
    closing = raw.rfind(")")
    if separator <= 0 or closing <= separator or raw[separator + 1] != "(":
        raise ObserverError("invalid proc stat")
    try:
        pid = int(raw[:separator], 10)
    except ValueError:
        raise ObserverError("invalid proc stat") from None
    if pid != expected_pid:
        raise ObserverError("proc pid identity changed")

    fields = raw[closing + 1 :].split()
    if len(fields) < 22 or len(fields[0]) != 1:
        raise ObserverError("incomplete proc stat")
    try:
        # fields[0] — поле 3 (state); поле n находится по индексу n-3.
        values = {
            "process_group_id": int(fields[2], 10),
            "session_id": int(fields[3], 10),
            "user_cpu_ticks": int(fields[11], 10),
            "system_cpu_ticks": int(fields[12], 10),
            "thread_count": int(fields[17], 10),
            "start_ticks": int(fields[19], 10),
            "rss_pages": int(fields[21], 10),
        }
    except ValueError:
        raise ObserverError("invalid proc stat fields") from None
    if (
        values["process_group_id"] <= 0
        or values["session_id"] <= 0
        or values["user_cpu_ticks"] < 0
        or values["system_cpu_ticks"] < 0
        or values["thread_count"] < 1
        or values["start_ticks"] <= 0
        or values["rss_pages"] < 0
    ):
        raise ObserverError("invalid proc stat values")
    return ProcessStat(pid=pid, **values)


def _read_stat(proc_root: Path, pid: int) -> ProcessStat | None:
    """Прочитать stat одного PID; исчезнувший PID считать гонкой снимка."""
    try:
        raw = (proc_root / str(pid) / "stat").read_bytes().decode(
            "utf-8", errors="surrogateescape"
        )
    except FileNotFoundError:
        return None
    except PermissionError:
        raise ObserverError("proc stat is not readable") from None
    except OSError:
        raise ObserverError("proc stat read failed") from None
    try:
        return _parse_stat(raw, pid)
    except ObserverError:
        # PID может быть повторно использован между перечислением и чтением.
        # Поле PID в stat всё равно должно совпасть с путём; неверная строка — отказ.
        raise


def _validate_leader_identity(
    leader: ProcessStat | None,
    pid: int,
    process_group_id: int,
    leader_start_ticks: int,
) -> ProcessStat:
    """Подтвердить изолированного лидера по PID, PGID, SID и starttime."""
    if leader is None:
        raise ObserverError("leader is unavailable")
    if (
        leader.pid != pid
        or pid != process_group_id
        or leader.process_group_id != process_group_id
        or leader.session_id != pid
        or leader.start_ticks != leader_start_ticks
    ):
        raise ObserverError("leader identity mismatch")
    return leader


def _cpu_delta_ticks(
    current: dict[tuple[int, int], int], previous: dict[tuple[int, int], int]
) -> int:
    """Суммировать CPU delta только для того же PID и starttime."""
    return sum(
        max(0, current[identity] - previous[identity])
        for identity in current.keys() & previous.keys()
    )


def _group_sample_stats(
    current: dict[tuple[int, int], ProcessStat],
    page_size: int,
) -> tuple[int, int, int]:
    """Вернуть process count, thread count и сумму sampled RSS группы."""
    return (
        len(current),
        sum(process.thread_count for process in current.values()),
        sum(process.rss_pages for process in current.values()) * page_size,
    )


def _scan_group(
    proc_root: Path,
    process_group_id: int,
    session_id: int,
    deadline_ns: int,
) -> dict[tuple[int, int], ProcessStat]:
    """Собрать только процессы точной группы и сессии до общего deadline."""
    try:
        entries = os.scandir(proc_root)
    except OSError:
        raise ObserverError("procfs is unavailable") from None
    results: dict[tuple[int, int], ProcessStat] = {}
    with entries:
        for index, entry in enumerate(entries):
            if index >= MAX_PROC_ENTRIES:
                raise ObserverError("procfs entry limit exceeded")
            if time.monotonic_ns() >= deadline_ns:
                raise _DeadlineReached
            if not entry.name.isascii() or not entry.name.isdecimal():
                continue
            try:
                pid = int(entry.name, 10)
            except ValueError:
                continue
            if not 1 <= pid <= MAX_PID:
                continue
            process = _read_stat(proc_root, pid)
            if process is None:
                continue
            if process.process_group_id == process_group_id and process.session_id == session_id:
                results[process.identity] = process
    return results


def _report(
    leader: ProcessStat,
    process_group_id: int,
    requested_duration_seconds: float,
    interval_ms: int,
    samples: list[dict[str, int | float]],
    identities: dict[tuple[int, int], tuple[int, int]],
    total_cpu_ticks: int,
    ticks_per_second: int,
    termination_reason: str,
) -> dict[str, Any]:
    """Собрать typed evidence только из ограниченных агрегатных измерений."""
    return {
        "schemaVersion": 1,
        "subject": {
            "pid": leader.pid,
            "processGroupId": process_group_id,
            "leaderStartTicks": leader.start_ticks,
            "sessionId": leader.session_id,
        },
        "metricSemantics": {
            "rss": "sampled_aggregate_sum_shared_pages_may_be_double_counted",
            "cpu": "observed_delta_same_pid_and_start_ticks_only",
        },
        "window": {
            "requestedDurationMs": round(requested_duration_seconds * 1_000, 3),
            "observedDurationMs": samples[-1]["offsetMs"],
            "samplingIntervalMs": interval_ms,
            "sampleCount": len(samples),
            "terminationReason": termination_reason,
        },
        "samples": samples,
        "summary": {
            "peakConcurrentProcessCount": max(sample["processCount"] for sample in samples),
            "peakConcurrentThreadCount": max(sample["threadCount"] for sample in samples),
            "peakAggregateSampledRssBytes": max(
                sample["aggregateSampledRssBytes"] for sample in samples
            ),
            "totalObservedCpuTicks": total_cpu_ticks,
            "ticksPerSecond": ticks_per_second,
            "totalObservedCpuSeconds": round(total_cpu_ticks / ticks_per_second, 6),
        },
        "observedIdentities": [
            {
                "pid": pid,
                "startTicks": start_ticks,
                "firstSample": bounds[0],
                "lastSample": bounds[1],
            }
            for (pid, start_ticks), bounds in sorted(identities.items())
        ],
    }


def observe(
    pid: int,
    process_group_id: int,
    leader_start_ticks: int,
    duration_seconds: float,
    interval_ms: int,
) -> dict[str, Any]:
    """Наблюдать только явно указанную, предварительно идентифицированную process group.

    Читает Linux procfs до исчезновения process group или истечения monotonic
    duration. Не запускает, не сигнализирует и не завершает процессы. RSS —
    sampled сумма RSS процессов и может несколько раз учитывать общие страницы.
    """
    pid = _integer(pid, "pid", 1, MAX_PID)
    process_group_id = _integer(process_group_id, "process group", 1, MAX_PID)
    leader_start_ticks = _integer(leader_start_ticks, "leader start ticks", 1, 2**63 - 1)
    if pid != process_group_id:
        raise ObserverError("leader pid must equal the requested process group id")
    if (
        isinstance(duration_seconds, bool)
        or not isinstance(duration_seconds, (int, float))
        or not math.isfinite(duration_seconds)
        or not MIN_DURATION_SECONDS <= duration_seconds <= MAX_DURATION_SECONDS
    ):
        raise ObserverError("duration is outside the bounded range")
    interval_ms = _integer(interval_ms, "sampling interval", MIN_INTERVAL_MS, MAX_INTERVAL_MS)

    proc_root = Path("/proc")
    started_ns = time.monotonic_ns()
    deadline_ns = started_ns + int(float(duration_seconds) * 1_000_000_000)
    leader = _validate_leader_identity(
        _read_stat(proc_root, pid), pid, process_group_id, leader_start_ticks
    )
    session_id = leader.session_id
    try:
        initial = _scan_group(proc_root, process_group_id, session_id, deadline_ns)
    except _DeadlineReached:
        raise ObserverError("deadline elapsed before identity validation") from None

    leader_identity = (pid, leader_start_ticks)
    if leader_identity not in initial:
        raise ObserverError("leader is outside the requested process group")

    page_size = os.sysconf("SC_PAGE_SIZE")
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    if not isinstance(page_size, int) or page_size <= 0 or not isinstance(ticks_per_second, int) or ticks_per_second <= 0:
        raise ObserverError("kernel resource units are unavailable")

    trusted: set[tuple[int, int]] = set(initial)
    previous: dict[tuple[int, int], int] = {}
    identities: dict[tuple[int, int], tuple[int, int]] = {}
    samples: list[dict[str, int | float]] = []
    total_cpu_ticks = 0
    termination_reason = "deadline_reached"
    next_sample_at = started_ns
    first_sample = initial

    while True:
        now_ns = time.monotonic_ns()
        if now_ns >= deadline_ns:
            termination_reason = "deadline_reached"
            break
        if samples and now_ns < next_sample_at:
            sleep_until_ns = min(next_sample_at, deadline_ns)
            time.sleep((sleep_until_ns - now_ns) / 1_000_000_000)
            if time.monotonic_ns() >= deadline_ns:
                termination_reason = "deadline_reached"
                break
        if first_sample is not None:
            current = first_sample
            first_sample = None
        else:
            try:
                current = _scan_group(proc_root, process_group_id, session_id, deadline_ns)
            except _DeadlineReached:
                termination_reason = "deadline_reached"
                break
        sampled_ns = time.monotonic_ns()
        if sampled_ns >= deadline_ns:
            termination_reason = "deadline_reached"
            break
        if not any(identity in trusted for identity in current):
            termination_reason = "process_group_gone"
            break
        if len(set(identities) | set(current)) > MAX_REPORTED_IDENTITIES:
            raise ObserverError("process identity limit exceeded")

        sample_index = len(samples) + 1
        current_ticks = {identity: process.cpu_ticks for identity, process in current.items()}
        cpu_delta = _cpu_delta_ticks(current_ticks, previous)
        total_cpu_ticks += cpu_delta
        process_count, thread_count, aggregate_rss_bytes = _group_sample_stats(current, page_size)
        offset_ms = round((sampled_ns - started_ns) / 1_000_000, 3)
        samples.append(
            {
                "sample": sample_index,
                "offsetMs": offset_ms,
                "processCount": process_count,
                "threadCount": thread_count,
                "aggregateSampledRssBytes": aggregate_rss_bytes,
                "observedCpuTicksDelta": cpu_delta,
            }
        )
        for identity in current:
            if identity in identities:
                identities[identity] = (identities[identity][0], sample_index)
            else:
                identities[identity] = (sample_index, sample_index)
        trusted.update(current)
        previous = current_ticks
        if len(samples) >= MAX_SAMPLES:
            raise ObserverError("sample limit exceeded")
        next_sample_at = started_ns + len(samples) * interval_ms * 1_000_000

    if not samples:
        raise ObserverError("no process group samples were collected")
    return _report(
        leader,
        process_group_id,
        float(duration_seconds),
        interval_ms,
        samples,
        identities,
        total_cpu_ticks,
        ticks_per_second,
        termination_reason,
    )


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    """Разобрать только явные идентификаторы и bounded параметры наблюдения."""
    parser = argparse.ArgumentParser(description="Bounded Linux process-group resource observer")
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--process-group", required=True, type=int)
    parser.add_argument("--leader-start-ticks", required=True, type=int)
    parser.add_argument("--duration-seconds", required=True, type=float)
    parser.add_argument("--interval-ms", required=True, type=int)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Вывести один JSON resource report без process content и секретов."""
    try:
        args = _arguments(argv)
        result = observe(
            args.pid,
            args.process_group,
            args.leader_start_ticks,
            args.duration_seconds,
            args.interval_ms,
        )
    except (ObserverError, argparse.ArgumentError, SystemExit) as error:
        if isinstance(error, SystemExit):
            return int(error.code) if isinstance(error.code, int) else 2
        print("resources-observer: measurement failed", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
