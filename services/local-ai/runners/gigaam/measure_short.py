#!/usr/bin/env python3
# ABOUTME: Измеряет короткое RU распознавание GigaAM по локальному JSON-RPC.
# ABOUTME: Проверяет только закреплённый synthetic fixture и не выводит текст.

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import selectors
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


FIXTURE_MANIFEST_SHA256 = "91ab59878a946f2e70a51542bc50d2db3f7de435f7c945e08166f38418ddbcd9"
SHORT_AUDIO_NAME = "short.wav"
SHORT_AUDIO_SHA256 = "34fbaa763d69a32b8707e9285b1fcb943d51b491295f951179b25a142e3870dd"
MODEL_REVISION = "cec030b4c4f35d928e4a9044a3bdb29ebd499fac"
VAD_REVISION = "e66f3d3b9eb0873085418a7b813d3b369bf160bb"
EXPECTED_HEALTH = {
    "ready": True,
    "model_id": "gigaam-v3-e2e-ctc",
    "revision": MODEL_REVISION,
    "vad_repository": "pyannote/segmentation-3.0",
    "vad_revision": VAD_REVISION,
}


class MeasurementError(RuntimeError):
    """Сообщает о нарушении bounded acceptance harness."""


class RpcProcess:
    """Управляет одним локальным RPC-процессом и измеряет его RSS."""

    def __init__(self, command: list[str], env: dict[str, str], deadline: float) -> None:
        """Запустить модель в отдельном процессе и начать измерение памяти."""
        self.started_at = time.monotonic()
        self.deadline = deadline
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            bufsize=0,
            close_fds=True,
            start_new_session=True,
        )
        assert self.process.stdout is not None
        os.set_blocking(self.process.stdout.fileno(), False)
        self._stdout_buffer = bytearray()
        self.peak_rss_bytes = 0
        self._monitor_stop = threading.Event()
        self._monitor = threading.Thread(target=self._sample_rss, daemon=True)
        self._monitor.start()

    def _sample_rss(self) -> None:
        """Снимать VmRSS процесса без чтения журналов и памяти."""
        status_path = Path(f"/proc/{self.process.pid}/status")
        while not self._monitor_stop.is_set():
            try:
                for line in status_path.read_text(encoding="ascii").splitlines():
                    if line.startswith("VmRSS:"):
                        value_kib = int(line.split()[1])
                        self.peak_rss_bytes = max(self.peak_rss_bytes, value_kib * 1024)
                        break
            except (OSError, ValueError, IndexError):
                return
            self._monitor_stop.wait(0.025)

    def _remaining(self) -> float:
        """Вернуть время до общего deadline короткого acceptance run."""
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise MeasurementError("acceptance deadline expired")
        return remaining

    def call(self, method: str, params: dict[str, Any], request_id: str) -> dict[str, Any]:
        """Отправить JSON-RPC запрос и проверить ID и форму ответа."""
        if self.process.poll() is not None or self.process.stdin is None:
            raise MeasurementError("runner exited before its RPC response")
        request = {"jsonrpc": "2.0", "method": method, "params": params, "id": request_id}
        payload = (
            json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8", errors="strict")
        self.process.stdin.write(payload)
        self.process.stdin.flush()
        assert self.process.stdout is not None
        response_line = self._read_line()
        try:
            response = json.loads(response_line.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise MeasurementError("runner stdout is not one UTF-8 JSON response") from None
        if (
            not isinstance(response, dict)
            or response.get("jsonrpc") != "2.0"
            or response.get("id") != request_id
            or ("result" in response) == ("error" in response)
        ):
            raise MeasurementError("runner response violates JSON-RPC correlation")
        if "error" in response:
            error = response["error"]
            if not isinstance(error, dict) or not isinstance(error.get("code"), int):
                raise MeasurementError("runner returned a malformed JSON-RPC error")
            raise MeasurementError(f"runner returned JSON-RPC error {error['code']}")
        if not isinstance(response["result"], dict):
            raise MeasurementError("runner result is not an object")
        return response["result"]

    def _read_line(self) -> bytes:
        """Читать одну строку RPC без блокировки на неполном выводе."""
        assert self.process.stdout is not None
        descriptor = self.process.stdout.fileno()
        with selectors.DefaultSelector() as selector:
            selector.register(descriptor, selectors.EVENT_READ)
            while True:
                newline_at = self._stdout_buffer.find(b"\n")
                if newline_at >= 0:
                    if newline_at > 1024 * 1024:
                        raise MeasurementError("runner RPC response exceeds the line limit")
                    line = bytes(self._stdout_buffer[: newline_at + 1])
                    del self._stdout_buffer[: newline_at + 1]
                    return line
                if len(self._stdout_buffer) > 1024 * 1024:
                    raise MeasurementError("runner RPC response exceeds the line limit")
                if not selector.select(self._remaining()):
                    raise MeasurementError("runner RPC timed out")
                try:
                    chunk = os.read(descriptor, min(65536, 1024 * 1024 + 1 - len(self._stdout_buffer)))
                except BlockingIOError:
                    continue
                if not chunk:
                    raise MeasurementError("runner closed stdout before a complete response")
                self._stdout_buffer.extend(chunk)

    def _signal_group(self, signal_number: int) -> None:
        """Сигнализировать только выделенную сессию runner-процесса."""
        try:
            os.killpg(self.process.pid, signal_number)
        except ProcessLookupError:
            pass

    def _group_exists(self) -> bool:
        """Проверить, остались ли процессы в собственной process group."""
        try:
            os.killpg(self.process.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def stop(self) -> dict[str, Any]:
        """Закрыть stdin и измерить завершение процесса и освобождение PID."""
        stop_started = time.monotonic()
        if self.process.stdin is not None:
            self.process.stdin.close()
        remaining = max(0.0, min(5.0, self.deadline - time.monotonic()))
        graceful = True
        try:
            self.process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            graceful = False
            self._signal_group(signal.SIGTERM)
            try:
                remaining = max(0.0, min(2.0, self.deadline - time.monotonic()))
                self.process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                self._signal_group(signal.SIGKILL)
                self.process.wait(timeout=1.0)
        group_released = not self._group_exists()
        if not group_released:
            self._signal_group(signal.SIGTERM)
            group_deadline = time.monotonic() + 0.25
            while time.monotonic() < group_deadline and self._group_exists():
                time.sleep(0.01)
            if self._group_exists():
                self._signal_group(signal.SIGKILL)
                group_deadline = time.monotonic() + 0.5
                while time.monotonic() < group_deadline and self._group_exists():
                    time.sleep(0.01)
            group_released = not self._group_exists()
        self._monitor_stop.set()
        self._monitor.join(timeout=1.0)
        if self.process.stdout is not None:
            self.process.stdout.close()
        return {
            "exit_code": self.process.returncode,
            "graceful": graceful,
            "elapsed_ms": round((time.monotonic() - stop_started) * 1000, 2),
            "pid_released": not Path(f"/proc/{self.process.pid}").exists(),
            "process_group_released": group_released,
            "parent_peak_rss_bytes": self.peak_rss_bytes,
        }


def _sha256(path: Path) -> str:
    """Вычислить SHA-256 локального файла потоково."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _normalize(text: str) -> list[str]:
    """Нормализовать регистр и пунктуацию для подсчёта WER."""
    return re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"), flags=re.UNICODE)


def _wer_counts(reference: list[str], hypothesis: list[str]) -> tuple[int, int, int, int]:
    """Вернуть числа замен, удалений, вставок и слов эталона."""
    rows, cols = len(reference) + 1, len(hypothesis) + 1
    costs = [[0] * cols for _ in range(rows)]
    back = [[""] * cols for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0], back[i][0] = i, "D"
    for j in range(1, cols):
        costs[0][j], back[0][j] = j, "I"
    for i in range(1, rows):
        for j in range(1, cols):
            if reference[i - 1] == hypothesis[j - 1]:
                costs[i][j], back[i][j] = costs[i - 1][j - 1], "M"
            else:
                choices = (
                    (costs[i - 1][j - 1] + 1, "S"),
                    (costs[i - 1][j] + 1, "D"),
                    (costs[i][j - 1] + 1, "I"),
                )
                costs[i][j], back[i][j] = min(choices)
    substitutions = deletions = insertions = 0
    i, j = len(reference), len(hypothesis)
    while i or j:
        operation = back[i][j]
        if operation == "S":
            substitutions += 1
            i -= 1
            j -= 1
        elif operation == "D":
            deletions += 1
            i -= 1
        elif operation == "I":
            insertions += 1
            j -= 1
        else:
            i -= 1
            j -= 1
    return substitutions, deletions, insertions, len(reference)


def _fixture(manifest_path: Path, fixture_root: Path) -> tuple[Path, list[str]]:
    """Проверить закреплённый manifest и короткий русский WAV fixture."""
    if _sha256(manifest_path) != FIXTURE_MANIFEST_SHA256:
        raise MeasurementError("acceptance manifest checksum mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files, fixtures = manifest.get("files"), manifest.get("fixtures")
    if not isinstance(files, list) or not isinstance(fixtures, list):
        raise MeasurementError("acceptance manifest is incomplete")
    file_entry = next(
        (item for item in files if isinstance(item, dict) and item.get("path") == SHORT_AUDIO_NAME),
        None,
    )
    fixture = next(
        (
            item
            for item in fixtures
            if isinstance(item, dict)
            and item.get("kind") == "short"
            and item.get("path") == SHORT_AUDIO_NAME
        ),
        None,
    )
    if not isinstance(file_entry, dict) or not isinstance(fixture, dict):
        raise MeasurementError("short RU fixture is absent from manifest")
    if file_entry.get("sha256") != SHORT_AUDIO_SHA256:
        raise MeasurementError("short RU fixture digest does not match the pinned input")
    audio_path = fixture_root / SHORT_AUDIO_NAME
    if (
        audio_path.is_symlink()
        or not audio_path.is_file()
        or audio_path.stat().st_size != file_entry.get("bytes")
        or _sha256(audio_path) != SHORT_AUDIO_SHA256
    ):
        raise MeasurementError("short RU audio is missing or has the wrong checksum")
    expected = fixture.get("goldNormalized")
    if not isinstance(expected, str) or not expected.strip():
        raise MeasurementError("short RU gold text is absent")
    reference = _normalize(expected)
    if len(reference) != fixture.get("goldWords"):
        raise MeasurementError("short RU gold word count does not match the manifest")
    return audio_path, reference


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    """Проверить локальные пути и ограничения экспериментального запуска."""
    parser = argparse.ArgumentParser(description="Bounded local GigaAM short-RU measurement")
    parser.add_argument("--python", required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--vad-model-path", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--threads", required=True, type=int)
    parser.add_argument("--network-isolation", action="store_true")
    parser.add_argument("--total-timeout-seconds", type=float, default=180.0)
    parser.add_argument("--decode-timeout-seconds", type=float, default=30.0)
    args = parser.parse_args(argv)
    for name in ("python", "runner", "model_path", "vad_model_path", "fixture_root", "manifest"):
        if not Path(getattr(args, name)).is_absolute():
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    if (
        args.threads < 1
        or not math.isfinite(args.total_timeout_seconds)
        or not 1 <= args.total_timeout_seconds <= 180
        or not math.isfinite(args.decode_timeout_seconds)
        or not 1 <= args.decode_timeout_seconds <= 30
    ):
        parser.error("threads/timeouts exceed the bounded acceptance limits")
    return args


def _launch_command(args: argparse.Namespace) -> list[str]:
    """Собрать argv без shell для закреплённого дочернего runner."""
    command = [
        args.python,
        args.runner,
        "--model-path",
        args.model_path,
        "--vad-model-path",
        args.vad_model_path,
        "--longform-max-seconds",
        "180",
        "--audio-decode-timeout-seconds",
        str(args.decode_timeout_seconds),
        "--threads",
        str(args.threads),
    ]
    if not args.network_isolation:
        return command
    unshare = Path("/usr/bin/unshare")
    if not unshare.is_file() or not os.access(unshare, os.X_OK):
        raise MeasurementError("network isolation requested but unshare is unavailable")
    return [str(unshare), "--net", "--", *command]


def _run(args: argparse.Namespace) -> dict[str, Any]:
    """Выполнить cold/warm/reload распознавание в общем deadline."""
    audio_path, reference = _fixture(Path(args.manifest), Path(args.fixture_root))
    started = time.monotonic()
    deadline = started + args.total_timeout_seconds
    process_runs: list[dict[str, Any]] = []
    transcript: str | None = None
    with tempfile.TemporaryDirectory(prefix="brai-gigaam-measure-") as private_home:
        home = Path(private_home)
        private_fixture_dir = home / "fixture"
        private_fixture_dir.mkdir()
        private_audio = private_fixture_dir / SHORT_AUDIO_NAME
        shutil.copyfile(audio_path, private_audio)
        env = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "HOME": str(home),
            "XDG_CACHE_HOME": str(home / "cache"),
            "XDG_CONFIG_HOME": str(home / "config"),
            "HF_HOME": str(home / "hf"),
            "HF_HUB_CACHE": str(home / "hf" / "hub"),
            "HF_MODULES_CACHE": str(home / "transformers-modules"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "PYANNOTE_METRICS_ENABLED": "0",
            "OMP_NUM_THREADS": str(args.threads),
            "MKL_NUM_THREADS": str(args.threads),
            "OPENBLAS_NUM_THREADS": str(args.threads),
            "CUDA_VISIBLE_DEVICES": "",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TORCH_HOME": str(home / "torch"),
            "TMPDIR": str(home / "tmp"),
        }
        for private_dir in (
            home / "tmp",
            home / "cache",
            home / "config",
            home / "hf" / "hub",
            home / "transformers-modules",
            home / "torch",
        ):
            private_dir.mkdir(parents=True, exist_ok=True)
        for iteration in range(2):
            runner = RpcProcess(_launch_command(args), env, deadline)
            try:
                spawn_ms = round((time.monotonic() - runner.started_at) * 1000, 2)
                health_started = time.monotonic()
                health = runner.call("health", {}, f"health-{iteration}")
                ready_ms = round((time.monotonic() - health_started) * 1000, 2)
                if health != EXPECTED_HEALTH:
                    raise MeasurementError("runner health identity does not match pinned models")
                first_started = time.monotonic()
                result = runner.call(
                    "transcribe",
                    {"audio_path": str(private_audio)},
                    f"transcribe-{iteration}-cold",
                )
                first_ms = round((time.monotonic() - first_started) * 1000, 2)
                if set(result) != {"text"} or not isinstance(result.get("text"), str):
                    raise MeasurementError("short RPC result does not match the contract")
                if not _normalize(result["text"]):
                    raise MeasurementError("short RPC result has no recognizable words")
                if iteration == 0:
                    transcript = result["text"]
                elif result["text"] != transcript:
                    raise MeasurementError("reload transcription changed its result")
                warm_started = time.monotonic()
                warm_result = runner.call(
                    "transcribe",
                    {"audio_path": str(private_audio)},
                    f"transcribe-{iteration}-warm",
                )
                warm_ms = round((time.monotonic() - warm_started) * 1000, 2)
                if warm_result != result:
                    raise MeasurementError("repeated short transcription changed its result")
            except BaseException:
                runner.stop()
                raise
            stop = runner.stop()
            process_runs.append(
                {
                    "iteration": iteration + 1,
                    "processSpawnMs": spawn_ms,
                    "readyResponseMs": ready_ms,
                    "firstTranscriptionMs": first_ms,
                    "warmTranscriptionMs": warm_ms,
                    **stop,
                }
            )
            if not stop["pid_released"] or not stop["process_group_released"]:
                raise MeasurementError("runner process group remains after shutdown")
            if stop["exit_code"] != 0 or not stop["graceful"]:
                raise MeasurementError("runner did not stop cleanly after EOF")
            if any(private_fixture_dir.glob(".brai-audio-*")):
                raise MeasurementError("runner left an audio temporary directory")

    assert transcript is not None
    substitutions, deletions, insertions, word_count = _wer_counts(reference, _normalize(transcript))
    wer = (substitutions + deletions + insertions) / word_count if word_count else 0.0
    return {
        "fixture": SHORT_AUDIO_NAME,
        "audioSha256": SHORT_AUDIO_SHA256,
        "modelRevision": MODEL_REVISION,
        "vadRevision": VAD_REVISION,
        "networkIsolated": args.network_isolation,
        "threads": args.threads,
        "runs": process_runs,
        "wer": {
            "substitutions": substitutions,
            "deletions": deletions,
            "insertions": insertions,
            "referenceWords": word_count,
            "rate": round(wer, 6),
        },
        "temporaryAudioCleaned": True,
        "totalElapsedMs": round((time.monotonic() - started) * 1000, 2),
    }


def main(argv: list[str] | None = None) -> int:
    """Вывести структурированные метрики без текста распознавания."""
    try:
        result = _run(_arguments(argv))
    except (MeasurementError, OSError, subprocess.SubprocessError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
