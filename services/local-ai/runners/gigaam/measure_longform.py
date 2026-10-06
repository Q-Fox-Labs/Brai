#!/usr/bin/env python3
# ABOUTME: Измеряет закреплённые longform RU fixtures через локальный RPC GigaAM.
# ABOUTME: Выводит численные метрики и смещения, но не текст распознавания.

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any

import measure_short


FIXTURE_MANIFEST_SHA256 = measure_short.FIXTURE_MANIFEST_SHA256
FIXTURE_KINDS = ("long-pauses", "long-continuous", "silence")
SAMPLE_RATE = 16_000
MAX_LONGFORM_SECONDS = 180.0
DECODE_TIMEOUT_SECONDS = 30.0
THREADS = 4
TOTAL_TIMEOUT_SECONDS = 300.0
CLEANUP_RESERVE_SECONDS = 10.0


class MeasurementError(RuntimeError):
    """Сообщает о нарушении ограниченного измерительного запуска."""


class Fixture:
    """Хранит проверенные метаданные одного longform WAV."""

    def __init__(
        self,
        kind: str,
        source_path: Path,
        sha256: str,
        frames: int,
        duration_seconds: float,
        reference: tuple[str, ...],
        evidence: dict[str, Any],
    ) -> None:
        """Сохранить только верифицированные fixture metadata."""
        self.kind = kind
        self.source_path = source_path
        self.sha256 = sha256
        self.frames = frames
        self.duration_seconds = duration_seconds
        self.reference = reference
        self.evidence = evidence


def _numeric(value: Any) -> bool:
    """Проверить конечное числовое значение без принятия bool за число."""
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _gold_pause_frame_ranges(fragments: list[dict[str, Any]], total_frames: int) -> list[dict[str, int]]:
    """Вернуть тишинные интервалы из закреплённых frame annotations."""
    ranges: list[dict[str, int]] = []
    previous_end = 0
    for fragment in fragments:
        start = fragment.get("startFrame")
        end = fragment.get("endFrame")
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < previous_end
            or end <= start
            or end > total_frames
        ):
            raise MeasurementError("pinned pause annotations are invalid")
        if start > previous_end:
            ranges.append(
                {"startFrame": previous_end, "endFrame": start, "frameCount": start - previous_end}
            )
        previous_end = end
    if previous_end < total_frames:
        ranges.append(
            {
                "startFrame": previous_end,
                "endFrame": total_frames,
                "frameCount": total_frames - previous_end,
            }
        )
    return ranges


def _fixture_set(manifest_path: Path, fixture_root: Path) -> list[Fixture]:
    """Проверить манифест, WAV-файлы и reference для трёх закреплённых записей."""
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise MeasurementError("acceptance manifest is unavailable")
    if measure_short._sha256(manifest_path) != FIXTURE_MANIFEST_SHA256:
        raise MeasurementError("acceptance manifest checksum mismatch")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise MeasurementError("acceptance manifest is invalid") from None
    if not isinstance(manifest, dict):
        raise MeasurementError("acceptance manifest is incomplete")
    pcm = manifest.get("pcm")
    file_entries = manifest.get("files")
    definitions = manifest.get("fixtures")
    if (
        not isinstance(pcm, dict)
        or pcm.get("sampleRate") != SAMPLE_RATE
        or pcm.get("channels") != 1
        or pcm.get("sampleWidthBytes") != 2
        or pcm.get("encoding") != "PCM_S16LE"
        or not isinstance(file_entries, list)
        or not isinstance(definitions, list)
    ):
        raise MeasurementError("acceptance manifest is incomplete")

    root = fixture_root.resolve(strict=True)
    if fixture_root.is_symlink() or not root.is_dir():
        raise MeasurementError("fixture root is unavailable")
    files: dict[str, dict[str, Any]] = {}
    for entry in file_entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise MeasurementError("acceptance manifest file entry is invalid")
        name = entry["path"]
        if Path(name).name != name or name in files:
            raise MeasurementError("acceptance manifest file path is invalid")
        size, digest = entry.get("bytes"), entry.get("sha256")
        if (
            isinstance(size, bool)
            or not isinstance(size, int)
            or size <= 0
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise MeasurementError("acceptance manifest file checksum is invalid")
        files[name] = entry

    by_kind: dict[str, dict[str, Any]] = {}
    for entry in definitions:
        if not isinstance(entry, dict) or not isinstance(entry.get("kind"), str):
            raise MeasurementError("acceptance fixture entry is invalid")
        kind = entry["kind"]
        if kind in by_kind:
            raise MeasurementError("acceptance fixture kind is duplicated")
        by_kind[kind] = entry
    if set(by_kind) != {"short", *FIXTURE_KINDS}:
        raise MeasurementError("required acceptance fixtures are incomplete")

    result: list[Fixture] = []
    for kind in FIXTURE_KINDS:
        definition = by_kind[kind]
        name = definition.get("path")
        if not isinstance(name, str) or Path(name).name != name or name not in files:
            raise MeasurementError("acceptance audio path is invalid")
        entry = files[name]
        audio_path = root / name
        if (
            audio_path.is_symlink()
            or not audio_path.is_file()
            or audio_path.stat().st_size != entry["bytes"]
            or measure_short._sha256(audio_path) != entry["sha256"]
        ):
            raise MeasurementError("acceptance audio is missing or has the wrong checksum")
        frames = definition.get("frames")
        duration = definition.get("durationSeconds")
        gold = definition.get("goldNormalized")
        gold_words = definition.get("goldWords")
        if (
            isinstance(frames, bool)
            or not isinstance(frames, int)
            or frames <= 0
            or not _numeric(duration)
            or duration <= 25
            or duration > MAX_LONGFORM_SECONDS
            or not isinstance(gold, str)
            or isinstance(gold_words, bool)
            or not isinstance(gold_words, int)
            or gold_words < 0
        ):
            raise MeasurementError("acceptance fixture metadata is invalid")
        reference = tuple(measure_short._normalize(gold))
        if len(reference) != gold_words:
            raise MeasurementError("acceptance reference word count is invalid")
        try:
            with wave.open(str(audio_path), "rb") as source:
                if (
                    source.getnchannels() != 1
                    or source.getframerate() != SAMPLE_RATE
                    or source.getsampwidth() != 2
                    or source.getcomptype() != "NONE"
                    or source.getnframes() != frames
                    or abs(source.getnframes() / SAMPLE_RATE - duration) > 1 / SAMPLE_RATE
                ):
                    raise MeasurementError("acceptance WAV header does not match its manifest")
        except (EOFError, OSError, wave.Error):
            raise MeasurementError("acceptance WAV is invalid") from None

        evidence: dict[str, Any] = {}
        if kind == "long-pauses":
            fragments = definition.get("fragments")
            if not isinstance(fragments, list) or not fragments:
                raise MeasurementError("pinned pause annotations are missing")
            evidence["goldNonSpeechFrameRanges"] = _gold_pause_frame_ranges(fragments, frames)
        elif kind == "long-continuous":
            landmarks = definition.get("tokenLandmarks")
            inserted_silence = definition.get("insertedSilenceFrames")
            if (
                not isinstance(landmarks, list)
                or not landmarks
                or isinstance(inserted_silence, bool)
                or not isinstance(inserted_silence, int)
                or inserted_silence != 0
            ):
                raise MeasurementError("continuous fixture annotations are invalid")
            compact_landmarks: list[dict[str, int]] = []
            previous_token = 0
            for landmark in landmarks:
                if not isinstance(landmark, dict):
                    raise MeasurementError("continuous fixture token annotation is invalid")
                start, end = landmark.get("startToken"), landmark.get("endToken")
                if (
                    isinstance(start, bool)
                    or isinstance(end, bool)
                    or not isinstance(start, int)
                    or not isinstance(end, int)
                    or start != previous_token
                    or end <= start
                    or end > gold_words
                ):
                    raise MeasurementError("continuous fixture token annotation is invalid")
                compact_landmarks.append({"startToken": start, "endToken": end})
                previous_token = end
            if previous_token != gold_words:
                raise MeasurementError("continuous fixture token annotations are incomplete")
            evidence["insertedSilenceFrames"] = inserted_silence
            evidence["tokenLandmarks"] = compact_landmarks

        if kind == "silence" and gold_words != 0:
            raise MeasurementError("silence fixture unexpectedly has reference words")
        if kind != "silence" and gold_words <= 0:
            raise MeasurementError("speech fixture has no reference words")
        result.append(
            Fixture(
                kind=kind,
                source_path=audio_path,
                sha256=entry["sha256"],
                frames=frames,
                duration_seconds=float(duration),
                reference=reference,
                evidence=evidence,
            )
        )
    return result


def _validate_result(result: Any, fixture: Fixture) -> dict[str, Any]:
    """Проверить сегменты и вернуть только WER-метрики и временные смещения."""
    if not isinstance(result, dict) or set(result) != {"text", "segments"}:
        raise MeasurementError("longform RPC result has an invalid shape")
    text, segments = result["text"], result["segments"]
    if not isinstance(text, str) or not isinstance(segments, list):
        raise MeasurementError("longform RPC result has invalid field types")
    actual_segments: list[dict[str, Any]] = []
    joined_text: list[str] = []
    previous_end = 0.0
    for segment in segments:
        if not isinstance(segment, dict) or set(segment) != {
            "text",
            "start_seconds",
            "end_seconds",
        }:
            raise MeasurementError("longform RPC segment has an invalid shape")
        segment_text = segment["text"]
        start, end = segment["start_seconds"], segment["end_seconds"]
        if (
            not isinstance(segment_text, str)
            or not _numeric(start)
            or not _numeric(end)
            or start < previous_end
            or end <= start
            or end > fixture.duration_seconds
        ):
            raise MeasurementError("longform RPC segment has invalid offsets")
        clean_text = segment_text.strip()
        if clean_text:
            joined_text.append(clean_text)
        actual_segments.append(
            {"startSeconds": float(start), "endSeconds": float(end)}
        )
        previous_end = float(end)
    if " ".join(joined_text) != text:
        raise MeasurementError("longform response text does not match its segments")

    words = measure_short._normalize(text)
    if fixture.kind == "silence":
        if text or segments:
            raise MeasurementError("silence fixture returned speech")
        wer = None
        substitutions = deletions = insertions = 0
    else:
        if not text or not segments:
            raise MeasurementError("speech fixture returned no segments")
        substitutions, deletions, insertions, reference_words = measure_short._wer_counts(
            list(fixture.reference), words
        )
        wer = (substitutions + deletions + insertions) / reference_words
    return {
        "hypothesisWords": len(words),
        "segments": actual_segments,
        "wer": {
            "substitutions": substitutions,
            "deletions": deletions,
            "insertions": insertions,
            "referenceWords": len(fixture.reference),
            "rate": None if wer is None else round(wer, 6),
        },
    }


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    """Проверить пути и обязательный пределы измерительного запуска."""
    parser = argparse.ArgumentParser(description="Bounded local GigaAM longform measurement")
    parser.add_argument("--python", required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--vad-model-path", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--network-isolation", action="store_true")
    parser.add_argument(
        "--total-timeout-seconds", type=float, default=TOTAL_TIMEOUT_SECONDS
    )
    args = parser.parse_args(argv)
    for name in (
        "python",
        "runner",
        "model_path",
        "vad_model_path",
        "fixture_root",
        "manifest",
    ):
        if not Path(getattr(args, name)).is_absolute():
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    if not args.network_isolation:
        parser.error("--network-isolation is required")
    if (
        not math.isfinite(args.total_timeout_seconds)
        or not CLEANUP_RESERVE_SECONDS < args.total_timeout_seconds <= TOTAL_TIMEOUT_SECONDS
    ):
        parser.error("total timeout must be greater than cleanup reserve and at most 300 seconds")
    return args


def _private_environment(home: Path) -> dict[str, str]:
    """Собрать keyless offline environment с временными приватными кешами."""
    environment = {
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
        "OMP_NUM_THREADS": str(THREADS),
        "MKL_NUM_THREADS": str(THREADS),
        "OPENBLAS_NUM_THREADS": str(THREADS),
        "CUDA_VISIBLE_DEVICES": "",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "TORCH_HOME": str(home / "torch"),
        "TMPDIR": str(home / "tmp"),
    }
    for name in (
        "tmp",
        "cache",
        "config",
        "hf/hub",
        "transformers-modules",
        "torch",
    ):
        (home / name).mkdir(parents=True, exist_ok=True)
    return environment


def _run(args: argparse.Namespace) -> dict[str, Any]:
    """Запустить cold и warm вызовы в одном ограниченном CPU процессе."""
    started = time.monotonic()
    fixtures = _fixture_set(Path(args.manifest), Path(args.fixture_root))
    deadline = started + args.total_timeout_seconds - CLEANUP_RESERVE_SECONDS
    process_metrics: dict[str, Any] = {}
    measurement_rows: list[dict[str, Any]] = []
    private_home_path: Path
    with tempfile.TemporaryDirectory(prefix="brai-gigaam-longform-") as private_home:
        home = Path(private_home)
        private_home_path = home
        private_fixture_dir = home / "fixture"
        private_fixture_dir.mkdir()
        private_fixtures: dict[str, Path] = {}
        for fixture in fixtures:
            private_audio = private_fixture_dir / fixture.source_path.name
            shutil.copyfile(fixture.source_path, private_audio)
            private_fixtures[fixture.kind] = private_audio
        environment = _private_environment(home)
        process = measure_short.RpcProcess(
            measure_short._launch_command(
                argparse.Namespace(
                    python=args.python,
                    runner=args.runner,
                    model_path=args.model_path,
                    vad_model_path=args.vad_model_path,
                    threads=THREADS,
                    network_isolation=True,
                    decode_timeout_seconds=DECODE_TIMEOUT_SECONDS,
                )
            ),
            environment,
            deadline,
        )
        try:
            process_metrics["spawnMs"] = round(
                (time.monotonic() - process.started_at) * 1000, 2
            )
            health_started = time.monotonic()
            health = process.call("health", {}, "longform-health")
            if health != measure_short.EXPECTED_HEALTH:
                raise MeasurementError("runner health identity does not match pinned models")
            process_metrics["readyResponseMs"] = round(
                (time.monotonic() - health_started) * 1000, 2
            )

            for fixture in fixtures:
                request_params = {"audio_path": str(private_fixtures[fixture.kind])}
                first_started = time.monotonic()
                result = process.call(
                    "transcribe", request_params, f"longform-{fixture.kind}-cold"
                )
                first_ms = round((time.monotonic() - first_started) * 1000, 2)
                checked = _validate_result(result, fixture)
                warm_started = time.monotonic()
                warm = process.call(
                    "transcribe", request_params, f"longform-{fixture.kind}-warm"
                )
                warm_ms = round((time.monotonic() - warm_started) * 1000, 2)
                warm_checked = _validate_result(warm, fixture)
                if result != warm or checked != warm_checked:
                    raise MeasurementError("warm longform result changed")
                row: dict[str, Any] = {
                    "kind": fixture.kind,
                    "audioSha256": fixture.sha256,
                    "durationSeconds": fixture.duration_seconds,
                    "firstTranscriptionMs": first_ms,
                    "warmTranscriptionMs": warm_ms,
                    **checked,
                    **fixture.evidence,
                }
                measurement_rows.append(row)
                if any(private_fixture_dir.glob(".brai-audio-*")):
                    raise MeasurementError("runner left an audio temporary directory")
        except BaseException:
            process.stop()
            raise
        stop = process.stop()
        if not stop["pid_released"] or not stop["process_group_released"]:
            raise MeasurementError("runner process group remains after shutdown")
        if stop["exit_code"] != 0 or not stop["graceful"]:
            raise MeasurementError("runner did not stop cleanly after EOF")
        process_metrics.update(stop)
    if private_home_path.exists():
        raise MeasurementError("private measurement directory was not removed")

    return {
        "fixtureScope": "pinned-synthetic-tts-diagnostic",
        "qualityStatus": "diagnostic-only",
        "fixtureManifestSha256": FIXTURE_MANIFEST_SHA256,
        "modelRevision": measure_short.MODEL_REVISION,
        "vadRevision": measure_short.VAD_REVISION,
        "networkIsolated": True,
        "threads": THREADS,
        "longformMaximumSeconds": int(MAX_LONGFORM_SECONDS),
        "audioDecodeTimeoutSeconds": int(DECODE_TIMEOUT_SECONDS),
        "process": process_metrics,
        "fixtures": measurement_rows,
        "temporaryAudioCleaned": True,
        "totalElapsedMs": round((time.monotonic() - started) * 1000, 2),
    }


def main(argv: list[str] | None = None) -> int:
    """Вывести ограниченный отчёт с метриками, но без распознанного текста."""
    try:
        result = _run(_arguments(argv))
    except (
        MeasurementError,
        measure_short.MeasurementError,
        OSError,
        subprocess.SubprocessError,
        ValueError,
    ):
        print('{"error":"longform measurement failed"}', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
