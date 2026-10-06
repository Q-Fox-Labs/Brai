#!/usr/bin/env python3
# ABOUTME: Сравнивает два коротких RU эталона с закреплённым GigaAM runner.
# ABOUTME: Выводит только хэши, метрики, PCM и безопасные счётчики загрузки весов.

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any, Callable

MODEL_REVISION = "cec030b4c4f35d928e4a9044a3bdb29ebd499fac"
VAD_REVISION = "e66f3d3b9eb0873085418a7b813d3b369bf160bb"
UPSTREAM_REPOSITORY = "salute-developers/GigaAM"
UPSTREAM_REVISION = "7447938d791c4f3e643386ee22c33777004293a5"
SOURCE_FILES = {"tests/test_loading.py", "gigaam/utils.py"}
SOURCE_BASENAMES = {"tests/test_loading.py": "tests_test_loading.py", "gigaam/utils.py": "gigaam_utils.py"}
FIXTURE_FILES = {"official_short": "example.wav", "synthetic_short": "short.wav"}
OFFICIAL_MANIFEST_SHA256 = "10a859d467a3411d0f243f9e05c1e1c4a41fb9c5a4016788457ce13f2245900f"
SYNTHETIC_MANIFEST_SHA256 = "91ab59878a946f2e70a51542bc50d2db3f7de435f7c945e08166f38418ddbcd9"
SYNTHETIC_AUDIO_SHA256 = "34fbaa763d69a32b8707e9285b1fcb943d51b491295f951179b25a142e3870dd"
EXPERIMENT_THREADS = 4
EXPERIMENT_LONG_MAX_SECONDS = 180.0
EXPERIMENT_DECODE_TIMEOUT_SECONDS = 30.0
EXPERIMENT_DEADLINE_SECONDS = 180.0
MAX_MANIFEST_BYTES = 128 * 1024
MAX_FIXTURE_BYTES = 32 * 1024 * 1024
MAX_AUDIO_SECONDS = 25.0


class DiagnosticError(RuntimeError):
    """Сообщает о некорректных диагностических входах безопасным кодом ошибки."""


@contextlib.contextmanager
def _quiet_vendor_output() -> Any:
    """Спрятать Python- и native-печать модели, включая запись напрямую в FD."""
    try:
        sys.stdout.flush()
        sys.stderr.flush()
        saved_stdout, saved_stderr = os.dup(1), os.dup(2)
    except OSError:
        raise DiagnosticError("stdio_isolation_failed") from None
    try:
        with open(os.devnull, "w", encoding="utf-8") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                yield
    finally:
        try:
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
        finally:
            os.close(saved_stdout)
            os.close(saved_stderr)


def _sha256(path: Path) -> str:
    """Вычислить SHA-256 небольшого локального manifest или аудио."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _normalize(text: str) -> list[str]:
    """Нормализовать слова для подсчёта WER без вывода текста."""
    return re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"), flags=re.UNICODE)


def _wer_counts(reference: list[str], hypothesis: list[str]) -> tuple[int, int, int, int]:
    """Подсчитать замены, удаления, вставки и число слов эталона."""
    rows, columns = len(reference) + 1, len(hypothesis) + 1
    costs = [[0] * columns for _ in range(rows)]
    back = [[""] * columns for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0], back[i][0] = i, "D"
    for j in range(1, columns):
        costs[0][j], back[0][j] = j, "I"
    for i in range(1, rows):
        for j in range(1, columns):
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


def summarize_loading_info(info: Any, model: Any) -> dict[str, Any]:
    """Свернуть Transformers loading info до ключей и dtype-счётчиков."""
    if not isinstance(info, dict):
        raise DiagnosticError("invalid_loading_info")
    counts: dict[str, int] = {}
    for name in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"):
        entries = info.get(name)
        if not isinstance(entries, (list, tuple)):
            raise DiagnosticError("invalid_loading_info")
        counts[name] = len(entries)

    parameter_tensors: dict[str, int] = {}
    parameter_elements: dict[str, int] = {}
    try:
        for parameter in model.parameters():
            dtype = str(parameter.dtype)
            if not dtype.startswith("torch."):
                raise DiagnosticError("invalid_parameter_dtype")
            dtype = dtype.removeprefix("torch.")
            parameter_tensors[dtype] = parameter_tensors.get(dtype, 0) + 1
            elements = int(parameter.numel())
            if elements < 0:
                raise DiagnosticError("invalid_parameter_count")
            parameter_elements[dtype] = parameter_elements.get(dtype, 0) + elements
    except DiagnosticError:
        raise
    except Exception:
        raise DiagnosticError("invalid_model_parameters") from None
    return {
        "missingKeyCount": counts["missing_keys"],
        "unexpectedKeyCount": counts["unexpected_keys"],
        "mismatchedKeyCount": counts["mismatched_keys"],
        "errorMessageCount": counts["error_msgs"],
        "parameterTensorCountsByDtype": dict(sorted(parameter_tensors.items())),
        "parameterElementCountsByDtype": dict(sorted(parameter_elements.items())),
    }


def loading_info_wrapper(original: Callable[..., Any], sink: dict[str, Any]) -> Callable[..., Any]:
    """Запросить отчёт о загрузке и вернуть вызывающему коду только модель."""
    def load_with_report(*args: Any, **kwargs: Any) -> Any:
        kwargs["output_loading_info"] = True
        loaded = original(*args, **kwargs)
        if not isinstance(loaded, tuple) or len(loaded) != 2:
            raise DiagnosticError("loading_info_not_returned")
        model, info = loaded
        sink.clear()
        sink.update(summarize_loading_info(info, model))
        return model

    return load_with_report


def pcm_summary(path: Path) -> dict[str, Any]:
    """Вернуть краткие PCM-метрики готового WAV без сохранения семплов."""
    try:
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frames = audio.getnframes()
            if channels != 1 or sample_width != 2 or sample_rate != 16_000 or not 1 <= frames <= int(MAX_AUDIO_SECONDS * sample_rate):
                raise DiagnosticError("invalid_normalized_pcm")
            samples = audio.readframes(frames)
            if len(samples) != frames * sample_width * channels:
                raise DiagnosticError("invalid_normalized_pcm")
    except DiagnosticError:
        raise
    except (OSError, EOFError, wave.Error):
        raise DiagnosticError("invalid_normalized_pcm") from None

    values = struct.unpack(f"<{frames}h", samples)
    peak = max(abs(value) for value in values)
    square_sum = sum(value * value for value in values)
    window_frames = sample_rate // 50
    silent_windows = 0
    window_count = 0
    for offset in range(0, frames, window_frames):
        window = values[offset : offset + window_frames]
        if not window:
            continue
        window_count += 1
        if math.sqrt(sum(value * value for value in window) / len(window)) < 50:
            silent_windows += 1
    return {
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBytes": sample_width,
        "frames": frames,
        "durationSeconds": round(frames / sample_rate, 6),
        "peak": peak,
        "rms": round(math.sqrt(square_sum / frames), 2),
        "clippedSampleCount": sum(abs(value) >= 32760 for value in values),
        "nearSilent20msWindows": silent_windows,
        "windows20ms": window_count,
    }


def input_wav_metadata(path: Path) -> dict[str, Any]:
    """Прочитать размерность исходного WAV до штатной нормализации runner."""
    try:
        with wave.open(str(path), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frames = audio.getnframes()
    except (OSError, EOFError, wave.Error):
        raise DiagnosticError("fixture_wav_invalid") from None
    duration = frames / sample_rate if sample_rate > 0 else math.inf
    if (
        channels not in (1, 2)
        or sample_width not in (1, 2, 3, 4)
        or sample_rate < 8_000
        or frames < 1
        or not math.isfinite(duration)
        or duration > MAX_AUDIO_SECONDS
    ):
        raise DiagnosticError("fixture_wav_invalid")
    return {
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBytes": sample_width,
        "frames": frames,
        "durationSeconds": round(duration, 6),
    }


def _read_json_manifest(path: Path, expected_sha256: str) -> dict[str, Any]:
    """Проверить размер, UTF-8 JSON и ожидаемый SHA-256 manifest."""
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise DiagnosticError("invalid_expected_manifest_digest")
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise DiagnosticError("manifest_unavailable")
    if _sha256(path) != expected_sha256:
        raise DiagnosticError("manifest_digest_mismatch")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise DiagnosticError("manifest_invalid") from None
    if not isinstance(manifest, dict):
        raise DiagnosticError("manifest_invalid")
    return manifest


def _load_official_fixture(
    manifest_path: Path, expected_sha256: str, audio_root: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Сверить immutable upstream source/audio/gold и собрать natural short fixture."""
    manifest = _read_json_manifest(manifest_path, expected_sha256)
    if manifest.get("protocol") != "brai-official-natural-short-v1":
        raise DiagnosticError("official_manifest_invalid")
    if manifest.get("repository") != UPSTREAM_REPOSITORY:
        raise DiagnosticError("source_pin_invalid")
    revision = manifest.get("revision")
    if revision != UPSTREAM_REVISION:
        raise DiagnosticError("source_pin_invalid")
    if audio_root.is_symlink() or not audio_root.is_absolute() or not audio_root.is_dir():
        raise DiagnosticError("fixture_root_invalid")
    sources = manifest.get("sources")
    if not isinstance(sources, list) or len(sources) != len(SOURCE_FILES):
        raise DiagnosticError("source_pin_invalid")
    source_entries: list[dict[str, Any]] = []
    observed_source_paths: set[str] = set()
    for item in sources:
        if not isinstance(item, dict) or item.get("path") not in SOURCE_FILES:
            raise DiagnosticError("source_pin_invalid")
        source_path, filename, digest = item["path"], item.get("file"), item.get("sha256")
        if (
            source_path in observed_source_paths
            or not isinstance(filename, str)
            or Path(filename).name != filename
            or filename != SOURCE_BASENAMES[source_path]
            or not isinstance(item.get("bytes"), int)
            or isinstance(item.get("bytes"), bool)
            or item["bytes"] < 1
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise DiagnosticError("source_pin_invalid")
        local_source = audio_root / filename
        if (
            local_source.is_symlink()
            or not local_source.is_file()
            or local_source.stat().st_size != item["bytes"]
            or _sha256(local_source) != digest
        ):
            raise DiagnosticError("source_digest_mismatch")
        observed_source_paths.add(source_path)
        source_entries.append({
            "path": source_path,
            "bytes": item["bytes"],
            "sha256": digest,
        })
    if observed_source_paths != SOURCE_FILES:
        raise DiagnosticError("source_pin_invalid")
    audio, gold = manifest.get("audio"), manifest.get("gold")
    if (
        not isinstance(audio, dict)
        or audio.get("file") != FIXTURE_FILES["official_short"]
        or not isinstance(gold, dict)
        or gold.get("referenceKey") != "v3_e2e_ctc"
    ):
        raise DiagnosticError("official_manifest_invalid")
    audio_bytes, audio_sha = audio.get("bytes"), audio.get("sha256")
    gold_text, gold_sha, gold_words = (
        gold.get("goldNormalized"),
        gold.get("goldNormalizedSha256"),
        gold.get("goldWords"),
    )
    if (
        isinstance(audio_bytes, bool)
        or not isinstance(audio_bytes, int)
        or not 1 <= audio_bytes <= MAX_FIXTURE_BYTES
        or not isinstance(audio_sha, str)
        or not re.fullmatch(r"[0-9a-f]{64}", audio_sha)
        or not isinstance(gold_text, str)
        or not 1 <= len(gold_text) <= 2048
        or not isinstance(gold_sha, str)
        or hashlib.sha256(gold_text.encode("utf-8")).hexdigest() != gold_sha
        or not isinstance(gold_words, int)
        or isinstance(gold_words, bool)
        or not 1 <= gold_words <= 512
        or len(_normalize(gold_text)) != gold_words
    ):
        raise DiagnosticError("official_reference_invalid")
    audio_path = audio_root / audio["file"]
    pcm = audio.get("pcm")
    duration = pcm.get("durationSeconds") if isinstance(pcm, dict) else None
    if (
        audio.get("file") != FIXTURE_FILES["official_short"]
        or
        audio_path.is_symlink()
        or not audio_path.is_file()
        or audio_path.stat().st_size != audio_bytes
        or _sha256(audio_path) != audio_sha
        or not isinstance(pcm, dict)
        or pcm.get("sampleRate") != 16_000
        or pcm.get("channels") != 1
        or pcm.get("sampleWidthBytes") != 2
        or isinstance(pcm.get("frames"), bool)
        or not isinstance(pcm.get("frames"), int)
        or pcm.get("frames", 0) < 1
        or isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(duration)
        or not 0 < duration <= MAX_AUDIO_SECONDS
        or round(pcm.get("frames", 0) / 16_000, 6) != round(duration, 6)
    ):
        raise DiagnosticError("official_audio_mismatch")
    wav = input_wav_metadata(audio_path)
    if (
        wav["sampleRate"] != pcm["sampleRate"]
        or wav["channels"] != pcm["channels"]
        or wav["sampleWidthBytes"] != pcm["sampleWidthBytes"]
        or wav["frames"] != pcm["frames"]
    ):
        raise DiagnosticError("official_pcm_mismatch")
    fixture = {
        "kind": "official_short",
        "sourcePath": audio_path,
        "sha256": audio_sha,
        "bytes": audio_bytes,
        "durationSeconds": float(duration),
        "inputWav": wav,
        "goldNormalized": gold_text,
    }
    return {
        "repository": UPSTREAM_REPOSITORY,
        "commit": revision,
        "files": source_entries,
    }, fixture


def _load_synthetic_fixture(
    manifest_path: Path, expected_sha256: str, audio_root: Path
) -> dict[str, Any]:
    """Проверить прежний synthetic manifest и его короткий RU gold fixture."""
    manifest = _read_json_manifest(manifest_path, expected_sha256)
    if not isinstance(manifest.get("files"), list) or not isinstance(manifest.get("fixtures"), list):
        raise DiagnosticError("synthetic_manifest_invalid")
    audio_entry = next(
        (item for item in manifest["files"] if isinstance(item, dict) and item.get("path") == "short.wav"),
        None,
    )
    fixture = next(
        (
            item for item in manifest["fixtures"]
            if isinstance(item, dict) and item.get("kind") == "short" and item.get("path") == "short.wav"
        ),
        None,
    )
    if (
        not isinstance(audio_entry, dict)
        or audio_entry.get("sha256") != SYNTHETIC_AUDIO_SHA256
        or not isinstance(fixture, dict)
        or not isinstance(fixture.get("goldNormalized"), str)
        or not 1 <= len(fixture["goldNormalized"]) <= 2048
        or fixture.get("goldWords") != len(_normalize(fixture["goldNormalized"]))
    ):
        raise DiagnosticError("synthetic_reference_invalid")
    audio_path = audio_root / "short.wav"
    if (
        audio_root.is_symlink()
        or not audio_root.is_absolute()
        or not audio_root.is_dir()
        or audio_path.is_symlink()
        or not audio_path.is_file()
        or audio_path.stat().st_size != audio_entry.get("bytes")
        or _sha256(audio_path) != SYNTHETIC_AUDIO_SHA256
    ):
        raise DiagnosticError("synthetic_audio_mismatch")
    duration = fixture.get("durationSeconds")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_AUDIO_SECONDS:
        raise DiagnosticError("synthetic_reference_invalid")
    return {
        "kind": "synthetic_short",
        "sourcePath": audio_path,
        "sha256": SYNTHETIC_AUDIO_SHA256,
        "bytes": audio_entry["bytes"],
        "durationSeconds": float(duration),
        "inputWav": input_wav_metadata(audio_path),
        "goldNormalized": fixture["goldNormalized"],
    }


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Проверить локальные входные пути и обязательный manifest pin."""
    parser = argparse.ArgumentParser(description="Short GigaAM source/fixture diagnostic")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--vad-model-path", required=True)
    parser.add_argument("--official-audio-root", required=True)
    parser.add_argument("--synthetic-audio-root", required=True)
    parser.add_argument("--official-manifest", required=True)
    parser.add_argument("--official-manifest-sha256", required=True)
    parser.add_argument("--synthetic-manifest", required=True)
    parser.add_argument("--synthetic-manifest-sha256", required=True)
    args = parser.parse_args(argv)
    for name in (
        "model_path", "vad_model_path", "official_audio_root", "synthetic_audio_root",
        "official_manifest", "synthetic_manifest",
    ):
        if not Path(getattr(args, name)).is_absolute():
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    if args.official_manifest_sha256 != OFFICIAL_MANIFEST_SHA256:
        parser.error("--official-manifest-sha256 does not match the accepted fixture pin")
    if args.synthetic_manifest_sha256 != SYNTHETIC_MANIFEST_SHA256:
        parser.error("--synthetic-manifest-sha256 does not match the accepted fixture pin")
    return args


def _check_model_revisions(model_revision: str, vad_revision: str) -> None:
    """Отклонить запуск с другой закреплённой моделью или VAD."""
    if model_revision != MODEL_REVISION:
        raise DiagnosticError("model_revision_mismatch")
    if vad_revision != VAD_REVISION:
        raise DiagnosticError("vad_revision_mismatch")


def _private_environment(root: Path) -> None:
    """Заменить окружение allowlist и изолировать пользовательские кеши."""
    env = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": str(root),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "HF_HOME": str(root / "hf"),
        "HF_HUB_CACHE": str(root / "hf" / "hub"),
        "HF_MODULES_CACHE": str(root / "transformers-modules"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "PYANNOTE_METRICS_ENABLED": "0",
        "OMP_NUM_THREADS": str(EXPERIMENT_THREADS),
        "MKL_NUM_THREADS": str(EXPERIMENT_THREADS),
        "OPENBLAS_NUM_THREADS": str(EXPERIMENT_THREADS),
        "CUDA_VISIBLE_DEVICES": "",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "TORCH_HOME": str(root / "torch"),
        "TMPDIR": str(root / "tmp"),
    }
    os.environ.clear()
    os.environ.update(env)
    for name in ("cache", "config", "hf/hub", "transformers-modules", "torch", "tmp"):
        (root / name).mkdir(parents=True, exist_ok=True)


def _run(args: argparse.Namespace) -> dict[str, Any]:
    """Загрузить runner и измерить оба коротких эталона в одном процессе."""
    source, official_fixture = _load_official_fixture(
        Path(args.official_manifest), args.official_manifest_sha256, Path(args.official_audio_root)
    )
    synthetic_fixture = _load_synthetic_fixture(
        Path(args.synthetic_manifest), args.synthetic_manifest_sha256, Path(args.synthetic_audio_root)
    )
    fixtures = [official_fixture, synthetic_fixture]
    started = time.monotonic()
    deadline = started + EXPERIMENT_DEADLINE_SECONDS
    loading_summary: dict[str, Any] = {}
    pcm_by_kind: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory(prefix="brai-gigaam-quality-") as private_root:
        private = Path(private_root)
        _private_environment(private / "home")
        staged_roots: dict[str, Path] = {}
        for fixture in fixtures:
            kind = fixture["kind"]
            staged_root = private / "fixtures" / kind
            staged_root.mkdir(parents=True)
            staged = staged_root / FIXTURE_FILES[kind]
            shutil.copyfile(fixture["sourcePath"], staged)
            if _sha256(staged) != fixture["sha256"]:
                raise DiagnosticError("staged_fixture_digest_mismatch")
            staged_roots[kind] = staged_root
        staged_fixtures = [
            {**item, "sourcePath": staged_roots[item["kind"]] / FIXTURE_FILES[item["kind"]]}
            for item in fixtures
        ]

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        try:
            with _quiet_vendor_output():
                import transformers
                import runner
        except DiagnosticError:
            raise
        except Exception:
            raise DiagnosticError("runner_import_failed") from None
        original_from_pretrained = transformers.AutoModel.from_pretrained
        transformers.AutoModel.from_pretrained = loading_info_wrapper(original_from_pretrained, loading_summary)
        current_kind: str | None = None
        original_decode = runner._decode_audio_to_wav

        def decode_and_measure(source_path: Path, destination: Path, *decode_args: Any, **decode_kwargs: Any) -> None:
            original_decode(source_path, destination, *decode_args, **decode_kwargs)
            if current_kind is None:
                raise DiagnosticError("unexpected_audio_decode")
            pcm_by_kind[current_kind] = pcm_summary(destination)

        runner._decode_audio_to_wav = decode_and_measure
        try:
            with _quiet_vendor_output():
                model = runner._load_model(Path(args.model_path), EXPERIMENT_THREADS)
                actual_vad_revision = runner.configure_local_vad(model, Path(args.vad_model_path))
                _check_model_revisions(runner.MODEL_REVISION, actual_vad_revision)
                if not loading_summary:
                    raise DiagnosticError("loading_info_not_captured")
                for fixture in staged_fixtures:
                    if time.monotonic() >= deadline:
                        raise DiagnosticError("experiment_deadline_exceeded")
                    current_kind = fixture["kind"]
                    result = runner._transcribe(
                        {"audio_path": str(fixture["sourcePath"])},
                        model,
                        EXPERIMENT_LONG_MAX_SECONDS,
                        EXPERIMENT_DECODE_TIMEOUT_SECONDS,
                    )
                    hypothesis = result.get("text") if isinstance(result, dict) else None
                    if not isinstance(hypothesis, str) or not hypothesis.strip() or len(hypothesis) > 10_000:
                        raise DiagnosticError("transcription_result_invalid")
                    reference = _normalize(fixture["goldNormalized"])
                    predicted = _normalize(hypothesis)
                    if len(predicted) > 1024:
                        raise DiagnosticError("transcription_result_invalid")
                    substitutions, deletions, insertions, words = _wer_counts(reference, predicted)
                    normalized_pcm = pcm_by_kind.get(current_kind)
                    if (
                        not isinstance(normalized_pcm, dict)
                        or abs(normalized_pcm["durationSeconds"] - fixture["durationSeconds"]) > 0.01
                    ):
                        raise DiagnosticError("normalized_audio_duration_mismatch")
                    rows.append({
                        "fixture": fixture["kind"],
                        "audioSha256": fixture["sha256"],
                        "audioBytes": fixture["bytes"],
                        "goldWords": words,
                        "recognizedWords": len(predicted),
                        "wer": {
                            "substitutions": substitutions,
                            "deletions": deletions,
                            "insertions": insertions,
                            "referenceWords": words,
                            "rate": round((substitutions + deletions + insertions) / words, 6) if words else None,
                        },
                        "inputWav": fixture["inputWav"],
                        "normalizedPcm": normalized_pcm,
                    })
                    del hypothesis, predicted, result
                del model
        except DiagnosticError:
            raise
        except Exception as exc:
            error_name = type(exc).__name__
            raise DiagnosticError(f"inference_{error_name}") from None
        finally:
            transformers.AutoModel.from_pretrained = original_from_pretrained
            runner._decode_audio_to_wav = original_decode

    elapsed = time.monotonic() - started
    if elapsed > EXPERIMENT_DEADLINE_SECONDS:
        raise DiagnosticError("experiment_deadline_exceeded")
    return {
        "ok": True,
        "experimentOnly": True,
        "modelRevision": MODEL_REVISION,
        "vadRevision": VAD_REVISION,
        "upstreamSource": {
            "repository": source["repository"],
            "commit": source["commit"],
            "files": sorted(source["files"], key=lambda item: item["path"]),
        },
        "experiment": {
            "threads": EXPERIMENT_THREADS,
            "deadlineSeconds": EXPERIMENT_DEADLINE_SECONDS,
            "decodeTimeoutSeconds": EXPERIMENT_DECODE_TIMEOUT_SECONDS,
            "networkIsolationExpectedFromWrapper": True,
            "transcriptsEmitted": False,
            "elapsedMs": round(elapsed * 1000, 2),
        },
        "checkpointLoad": loading_summary,
        "fixtures": rows,
    }


def main(argv: list[str] | None = None) -> int:
    """Вывести числовую диагностику, не печатая транскрипты или тексты ошибок."""
    try:
        result = _run(_parse_args(argv))
    except DiagnosticError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError):
        print(json.dumps({"ok": False, "error": "diagnostic_input_invalid"}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": "diagnostic_failed"}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
