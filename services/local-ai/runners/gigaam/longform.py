# ABOUTME: Загружает локальную PyAnnote VAD-модель и адаптирует ответ GigaAM longform.
# ABOUTME: Сегменты сохраняют реальные смещения VAD и проверяются в шкале исходной записи.

from __future__ import annotations

import inspect
import math
import os
import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any


class LongformUnavailable(RuntimeError):
    """Сообщает, что закреплённая модель не предоставляет путь VAD longform."""


class InvalidLongformResult(ValueError):
    """Сообщает, что результат longform содержит недостоверные смещения."""


VAD_REPOSITORY = "pyannote/segmentation-3.0"
VAD_FILES = {"config.yaml", "pytorch_model.bin", "LICENSE"}
VAD_MANIFEST = Path(__file__).with_name("vad_manifest.json")


def _manifest_at(path: Path) -> dict[str, Any]:
    """Прочитать manifest только с ожидаемой структурой."""
    if path.is_symlink() or not path.is_file():
        raise LongformUnavailable("манифест локальной VAD-модели недоступен")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LongformUnavailable("манифест локальной VAD-модели недоступен") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("repository") != VAD_REPOSITORY
        or not isinstance(manifest.get("revision"), str)
        or re.fullmatch(r"[0-9a-f]{40}", manifest["revision"]) is None
        or not isinstance(manifest.get("files"), list)
    ):
        raise LongformUnavailable("манифест локальной VAD-модели некорректен")

    entries: dict[str, dict[str, Any]] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise LongformUnavailable("манифест локальной VAD-модели некорректен")
        name = entry["path"]
        if name in entries or Path(name).name != name:
            raise LongformUnavailable("манифест локальной VAD-модели некорректен")
        expected_bytes = entry.get("bytes")
        expected_sha = entry.get("sha256")
        if (
            isinstance(expected_bytes, bool)
            or not isinstance(expected_bytes, int)
            or expected_bytes <= 0
            or not isinstance(expected_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_sha) is None
        ):
            raise LongformUnavailable("манифест локальной VAD-модели некорректен")
        entries[name] = entry
    if set(entries) != VAD_FILES:
        raise LongformUnavailable("манифест локальной VAD-модели неполон")
    return manifest


def verify_vad_snapshot(model_path: Path) -> str:
    """Сверить локальные файлы с неизменяемым манифестом gated VAD snapshot."""
    manifest_path = model_path / "manifest.json"
    if model_path.is_symlink():
        raise LongformUnavailable("манифест локальной VAD-модели недоступен")
    manifest = _manifest_at(manifest_path)
    pinned_manifest = _manifest_at(VAD_MANIFEST)
    if manifest != pinned_manifest:
        raise LongformUnavailable("локальный VAD snapshot не совпадает с закреплённой ревизией")

    for entry in manifest["files"]:
        name = entry["path"]
        expected_bytes = entry.get("bytes")
        expected_sha = entry.get("sha256")
        artifact = model_path / name
        if (
            isinstance(expected_bytes, bool)
            or not isinstance(expected_bytes, int)
            or expected_bytes <= 0
            or not isinstance(expected_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_sha) is None
            or artifact.is_symlink()
            or not artifact.is_file()
            or artifact.stat().st_size != expected_bytes
        ):
            raise LongformUnavailable("файл локальной VAD-модели не прошёл проверку")
        digest = hashlib.sha256()
        with artifact.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected_sha:
            raise LongformUnavailable("файл локальной VAD-модели не прошёл проверку")
    return manifest["revision"]


def configure_local_vad(model: Any, model_path: Path) -> str:
    """Загрузить закреплённую VAD-модель из проверенного локального каталога.

    Каталог должен содержать `config.yaml` и `pytorch_model.bin`, сверенные
    preparer'ом выпуска. Функция устанавливает пайплайн в кэш upstream GigaAM,
    чтобы его штатный сегментатор не обращался к Hugging Face или HF_TOKEN.
    """
    try:
        path = model_path.resolve(strict=True)
    except OSError as exc:
        raise LongformUnavailable("локальная VAD-модель недоступна") from exc
    if model_path.is_symlink() or not path.is_dir():
        raise LongformUnavailable("локальная VAD-модель недоступна")
    revision = verify_vad_snapshot(path)

    vad_namespace = _vad_namespace(model)

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    import torch
    from pyannote.audio import Model
    from pyannote.audio.core.task import Problem, Resolution, Specifications
    from pyannote.audio.pipelines import VoiceActivityDetection
    from torch._utils import _rebuild_tensor_v2
    from torch.torch_version import TorchVersion
    with torch.serialization.safe_globals(
        [
            TorchVersion,
            Problem,
            Specifications,
            Resolution,
            OrderedDict,
            _rebuild_tensor_v2,
            torch.FloatStorage,
        ]
    ):
        segmentation = Model.from_pretrained(str(path / "pytorch_model.bin"))
    pipeline = VoiceActivityDetection(segmentation=segmentation)
    pipeline.instantiate({"min_duration_on": 0.0, "min_duration_off": 0.0})
    pipeline = pipeline.to(torch.device("cpu"))

    def get_local_pipeline(device: Any, *_args: Any, **_kwargs: Any) -> Any:
        """Вернуть загруженный локальный VAD-пайплайн без Hub fallback."""
        return pipeline.to(device)

    vad_namespace["get_pipeline"] = get_local_pipeline
    return revision


def _vad_namespace(model: Any) -> dict[str, Any]:
    """Найти кэш `get_pipeline`, используемый штатным сегментатором модели."""
    candidates = (getattr(model, "model", None), model)
    for candidate in candidates:
        operation = getattr(candidate, "transcribe_longform", None)
        function = inspect.unwrap(getattr(operation, "__func__", operation))
        namespace = getattr(function, "__globals__", {})
        segment_audio_file = namespace.get("segment_audio_file")
        segment_globals = getattr(segment_audio_file, "__globals__", {})
        get_pipeline = segment_globals.get("get_pipeline")
        if callable(get_pipeline) and isinstance(segment_globals, dict):
            return segment_globals
    raise LongformUnavailable("закреплённая модель не предоставляет upstream VAD hook")


def transcribe_longform(
    model: Any, audio_path: Path, source_duration: float
) -> dict[str, Any]:
    """Распознать upstream VAD-сегменты и вернуть смещения в секундах от начала записи.

    HF-модель возвращает записи `{transcription, boundaries}`. В ответе API поля
    `start_seconds` и `end_seconds` содержат исходные границы VAD без пересчёта.
    """
    operation = getattr(model, "transcribe_longform", None)
    if not callable(operation):
        raise LongformUnavailable("закреплённая модель не поддерживает longform")
    if (
        isinstance(source_duration, bool)
        or not isinstance(source_duration, (int, float))
        or not math.isfinite(source_duration)
        or source_duration <= 0
    ):
        raise InvalidLongformResult("длительность аудио некорректна")

    upstream_segments = operation(str(audio_path))
    if not isinstance(upstream_segments, list):
        raise InvalidLongformResult("результат upstream longform некорректен")

    segments: list[dict[str, str | float]] = []
    previous_end = 0.0
    for item in upstream_segments:
        if not isinstance(item, dict) or not {"transcription", "boundaries"} <= set(item):
            raise InvalidLongformResult("сегмент upstream longform некорректен")
        text = item["transcription"]
        boundaries = item["boundaries"]
        if not isinstance(text, str) or not isinstance(boundaries, (tuple, list)) or len(boundaries) != 2:
            raise InvalidLongformResult("сегмент upstream longform некорректен")

        start, end = boundaries
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
        ):
            raise InvalidLongformResult("смещения upstream longform некорректны")
        start = float(start)
        end = float(end)
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < previous_end
            or end <= start
            or end > source_duration
        ):
            raise InvalidLongformResult("смещения upstream longform выходят за границы аудио")

        segments.append(
            {"text": text, "start_seconds": start, "end_seconds": end}
        )
        previous_end = end

    return {
        "text": " ".join(
            segment["text"].strip() for segment in segments if segment["text"].strip()
        ),
        "segments": segments,
    }
