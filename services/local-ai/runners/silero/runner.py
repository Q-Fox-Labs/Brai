#!/usr/bin/env python3
# ABOUTME: Выполняет Silero TTS на CPU как приватный JSON-RPC процесс Local AI.
# ABOUTME: Принимает только текст и голос eugene; пишет один локальный OggOpus без сетевого API.

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, BinaryIO


MODEL_ID = "silero-tts-ru-v5_5"
MODEL_REVISION = "50081637b602126ee06cb3bc8a744d25651d2da1"
MODEL_SHA256 = "50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437"
MODEL_BYTES = 145_420_684
MODEL_FILE = "v5_5_ru.pt"
MAX_TEXT_CODEPOINTS = 900
MAX_LINE_BYTES = 65_536
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
ENCODE_TIMEOUT_SECONDS = 180
SAMPLE_RATE = 48_000


class InvalidParams(Exception):
    """Отметить недопустимые параметры без сохранения исходного текста."""


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _valid_id(value: Any) -> bool:
    if value is None or isinstance(value, str):
        return True
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return not isinstance(value, float) or math.isfinite(value)


def _request(value: Any, methods: dict[str, Any]) -> dict[str, Any] | None:
    if (
        not isinstance(value, dict)
        or set(value) - {"jsonrpc", "id", "method", "params"}
        or value.get("jsonrpc") != "2.0"
        or not isinstance(value.get("method"), str)
        or ("id" in value and not _valid_id(value["id"]))
    ):
        return _error(None, -32600, "Invalid Request")
    notification = "id" not in value
    request_id = value.get("id")
    method = methods.get(value["method"])
    if method is None:
        response = _error(request_id, -32601, "Method not found")
    else:
        try:
            params = value.get("params", {})
            if not isinstance(params, dict):
                raise InvalidParams()
            result = method(params)
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except InvalidParams:
            response = _error(request_id, -32602, "Invalid params")
        except Exception:
            response = _error(request_id, -32603, "Internal error")
    return None if notification else response


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def _invalid_constant(_: str) -> None:
    raise ValueError()


def process_line(line: bytes, methods: dict[str, Any]) -> bytes | None:
    """Обработать ограниченную строку JSON-RPC; уведомления не создают ответа."""
    try:
        if len(line) > MAX_LINE_BYTES:
            raise ValueError()
        payload = json.loads(
            line.decode("utf-8", errors="strict"),
            parse_constant=_invalid_constant,
            object_pairs_hook=_object,
        )
    except (ValueError, RecursionError):
        response: Any = _error(None, -32700, "Parse error")
    else:
        if isinstance(payload, list) and payload:
            response = [answer for item in payload if (answer := _request(item, methods)) is not None]
            if not response:
                return None
        else:
            response = _request(payload, methods)
            if response is None:
                return None
    # AIDEV-NOTE: Экранирование сохраняет допустимые строковые id даже с surrogate escape.
    return (json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def serve(source: BinaryIO, target: BinaryIO, methods: dict[str, Any]) -> None:
    """Обрабатывать строки последовательно до EOF; длинную строку целиком отбросить."""
    while line := source.readline(MAX_LINE_BYTES + 1):
        if len(line) > MAX_LINE_BYTES:
            while not line.endswith(b"\n"):
                line = source.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
            answer = process_line(b"", methods)
        else:
            answer = process_line(line, methods)
        if answer is not None:
            target.write(answer)
            target.flush()


def _write_wave(audio: Any, path: Path) -> None:
    """Сохранить конечный mono tensor как ограниченный PCM16 WAV 48 kHz."""
    import numpy as np

    samples = audio.detach().cpu().numpy()
    if samples.ndim != 1 or not 0 < samples.size <= MAX_OUTPUT_BYTES // 2 or not np.isfinite(samples).all():
        raise ValueError()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())


class SileroRunner:
    """Владеть загруженной моделью и последовательным выходом внутри private directory."""

    def __init__(
        self,
        model: Any,
        torch: Any,
        output_directory: Path,
        ffmpeg: str,
        *,
        run: Any = subprocess.run,
        write_wave: Any = _write_wave,
    ) -> None:
        """Принять модель с голосом eugene и существующий абсолютный выходной каталог."""
        if "eugene" not in model.speakers or not callable(model.apply_tts):
            raise ValueError()
        if not output_directory.is_absolute() or not output_directory.is_dir() or output_directory.is_symlink():
            raise ValueError()
        self.model = model
        self.torch = torch
        self.output_directory = output_directory.resolve(strict=True)
        self.ffmpeg = ffmpeg
        self.run = run
        self.write_wave = write_wave

    def health(self, params: dict[str, Any]) -> dict[str, Any]:
        """Вернуть готовность закреплённой модели; любые параметры отклонить."""
        if params:
            raise InvalidParams()
        return {"ready": True, "model_id": MODEL_ID, "revision": MODEL_REVISION}

    def synthesize(self, params: dict[str, Any]) -> dict[str, Any]:
        """Создать audio.ogg; следующий синтез заменяет его, уведомление тоже исполняется."""
        if set(params) != {"text", "voice"} or params["voice"] != "eugene":
            raise InvalidParams()
        text = params["text"]
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_TEXT_CODEPOINTS
            or "\0" in text
            or any(0xD800 <= ord(character) <= 0xDFFF for character in text)
        ):
            raise InvalidParams()
        output_path = self.output_directory / "audio.ogg"
        output_path.unlink(missing_ok=True)
        with TemporaryDirectory(prefix="silero-", dir=self.output_directory) as temporary:
            wav_path = Path(temporary) / "audio.wav"
            ogg_path = Path(temporary) / "audio.ogg"
            with self.torch.inference_mode():
                audio = self.model.apply_tts(text=text, speaker="eugene", sample_rate=SAMPLE_RATE)
            self.write_wave(audio, wav_path)
            # AIDEV-NOTE: Не создаём новую process group: parent останавливает runner и ffmpeg вместе.
            self.run(
                [
                    self.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-protocol_whitelist", "file", "-format_whitelist", "wav", "-i", str(wav_path),
                    "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "libopus",
                    "-b:a", "32k", "-vbr", "off", "-threads", "1", "-f", "ogg",
                    "-fs", str(MAX_OUTPUT_BYTES), str(ogg_path),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=ENCODE_TIMEOUT_SECONDS,
            )
            if ogg_path.is_symlink() or not 4 < ogg_path.stat().st_size <= MAX_OUTPUT_BYTES:
                raise ValueError()
            with ogg_path.open("rb") as encoded:
                if encoded.read(4) != b"OggS":
                    raise ValueError()
            ogg_path.replace(output_path)
        return {"audio_path": str(output_path), "mime_type": "audio/ogg"}


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError()


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = _Parser(add_help=False)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--threads", required=True, type=int)
    parser.add_argument("--output-directory", required=True)
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args(argv)
    if args.revision != MODEL_REVISION or args.threads != 4 or not Path(args.ffmpeg).is_absolute():
        raise ValueError()
    return args


def _load_model(model_path: Path, threads: int) -> tuple[Any, Any]:
    if not model_path.is_absolute() or not model_path.is_dir() or model_path.is_symlink():
        raise ValueError()
    weights = model_path / MODEL_FILE
    if weights.is_symlink() or weights.stat().st_size != MODEL_BYTES:
        raise ValueError()
    with weights.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != MODEL_SHA256:
            raise ValueError()
    import torch

    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    model = torch.package.PackageImporter(str(weights)).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    return model, torch


def main(argv: list[str] | None = None) -> int:
    """Загрузить проверенные веса и обслуживать RPC; любые сообщения модели отбросить."""
    # AIDEV-NOTE: dup2 закрывает также native stdout/stderr torch; сохранённый fd предназначен только RPC.
    with os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0) as output:
        diagnostic_fd = os.dup(sys.stderr.fileno())
        try:
            with open(os.devnull, "w") as muted:
                os.dup2(muted.fileno(), sys.stdout.fileno())
                os.dup2(muted.fileno(), sys.stderr.fileno())
            try:
                args = _arguments(argv)
                model, torch = _load_model(Path(args.model_path), args.threads)
                runner = SileroRunner(model, torch, Path(args.output_directory), args.ffmpeg)
            except Exception:
                os.write(diagnostic_fd, b"Silero runner failed to start\n")
                return 1
            serve(sys.stdin.buffer, output, {"health": runner.health, "synthesize": runner.synthesize})
            return 0
        finally:
            os.close(diagnostic_fd)


if __name__ == "__main__":
    raise SystemExit(main())
