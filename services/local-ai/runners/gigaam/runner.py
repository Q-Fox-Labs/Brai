#!/usr/bin/env python3
# ABOUTME: Запускает закреплённую GigaAM-v3 e2e CTC как приватный дочерний RPC-процесс.
# ABOUTME: Принимает локальное короткое аудио и выполняет распознавание offline.

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import subprocess
import sys
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from prepare import verify_snapshot
from rpc import Method, RpcFault, process_line
from longform import (
    InvalidLongformResult,
    LongformUnavailable,
    configure_local_vad,
    transcribe_longform,
)


MODEL_ID = "gigaam-v3-e2e-ctc"
MODEL_REVISION = "cec030b4c4f35d928e4a9044a3bdb29ebd499fac"
MAX_AUDIO_SECONDS = 25.0
PINNED_MODEL_SOURCE_SHA256 = "269be43b635b1e510115baa2a843c5cbaa052e8adf0be30dc133a2ba5b5f2d86"
ALLOWED_AUDIO_FORMATS = "wav,flac,mp3,ogg"
DECODE_SAMPLE_RATE = 16_000
DECODE_CHANNELS = 1
DECODE_SAMPLE_BYTES = 2
DECODE_HEADER_BYTES = 4096
REQUIRED_FILES = ("config.json", "modeling_gigaam.py", "pytorch_model.bin", "tokenizer.model")
_RUNNER_SOURCE = Path(__file__).resolve()
_LONGFORM_SOURCE = Path(__file__).with_name("longform.py").resolve()
_DIAGNOSTIC_FRAME_LIMIT = 8
_DIAGNOSTIC_CAUSE_LIMIT = 3
_DIAGNOSTIC_LINE_LIMIT = 1_000_000


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    """Разобрать обязательный путь к модели и число CPU-потоков."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--vad-model-path", required=True)
    parser.add_argument("--longform-max-seconds", type=float, required=True)
    parser.add_argument("--audio-decode-timeout-seconds", type=float, required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--private-diagnostics", action="store_true")
    parser.add_argument("--help", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if args.help:
        print(
            "Usage: runner.py --model-path ABSOLUTE_DIR --vad-model-path ABSOLUTE_DIR "
            "--longform-max-seconds N --audio-decode-timeout-seconds N --threads N "
            "[--private-diagnostics]",
            file=sys.stderr,
        )
        raise SystemExit(0)
    if (
        unknown
        or args.threads < 1
        or not math.isfinite(args.longform_max_seconds)
        or args.longform_max_seconds <= 0
        or not math.isfinite(args.audio_decode_timeout_seconds)
        or args.audio_decode_timeout_seconds <= 0
        or not Path(args.model_path).is_absolute()
        or not Path(args.vad_model_path).is_absolute()
    ):
        print("Runner requires absolute model paths and positive --threads", file=sys.stderr)
        raise SystemExit(2)
    return args


def _load_model(model_path: Path, threads: int) -> Any:
    """Проверить закреплённый snapshot и загрузить его на CPU без сети."""
    for filename in REQUIRED_FILES:
        path = model_path / filename
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("required model artifact is unavailable")
    with Path(__file__).with_name("model_manifest.json").open(
        "r", encoding="utf-8"
    ) as manifest_file:
        verify_snapshot(model_path, json.load(manifest_file))

    with (model_path / "config.json").open("r", encoding="utf-8") as config_file:
        config = json.load(config_file)
    model_name = config.get("cfg", {}).get("model", {}).get("cfg", {}).get("model_name")
    if model_name != "v3_e2e_ctc":
        raise RuntimeError("model snapshot is not the pinned e2e CTC variant")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import torch
    from transformers import AutoModel

    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    model = AutoModel.from_pretrained(
        str(model_path),
        local_files_only=True,
        trust_remote_code=True,
    )
    model.to("cpu")
    model.eval()
    if not callable(getattr(model, "transcribe", None)):
        raise RuntimeError("pinned model has no transcribe operation")
    return model


def _pinned_model_source(model: Any) -> Path | None:
    """Разрешить кадры модели только из файла с хешем закреплённого snapshot."""
    operation = getattr(model, "transcribe", None)
    function = getattr(operation, "__func__", operation)
    code = getattr(function, "__code__", None)
    if code is None:
        return None
    try:
        source = Path(code.co_filename).resolve(strict=True)
        if (
            source.name != "modeling_gigaam.py"
            or source.is_symlink()
            or not source.is_file()
            or source.stat().st_size > 2_000_000
        ):
            return None
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
    except OSError:
        return None
    return source if digest == PINNED_MODEL_SOURCE_SHA256 else None


def _diagnostic_component(filename: str, model_source: Path | None) -> str | None:
    """Сопоставить точный источник стека одному из фиксированных имён."""
    try:
        source = Path(filename).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if source == _RUNNER_SOURCE:
        return "runner"
    if source == _LONGFORM_SOURCE:
        return "longform"
    if model_source is not None and source == model_source:
        return "pinned_model"
    return None


def _diagnostic_class(exception: BaseException) -> str:
    """Возвратить только один из явно разрешённых классов ошибки."""
    safe_classes = (
        (LongformUnavailable, "LongformUnavailable"),
        (InvalidLongformResult, "InvalidLongformResult"),
        (AttributeError, "AttributeError"),
        (KeyError, "KeyError"),
        (ImportError, "ImportError"),
        (ValueError, "ValueError"),
        (TypeError, "TypeError"),
        (TimeoutError, "TimeoutError"),
        (subprocess.TimeoutExpired, "TimeoutExpired"),
        (subprocess.CalledProcessError, "CalledProcessError"),
        (OSError, "OSError"),
        (RuntimeError, "RuntimeError"),
        (RpcFault, "RpcFault"),
    )
    for exception_type, label in safe_classes:
        if isinstance(exception, exception_type):
            return label
    return "OtherError"


def _diagnostic_data(
    stage: str, exception: BaseException, model_source: Path | None
) -> dict[str, Any]:
    """Собрать ограниченные имена и номера строк без сообщений и локальных данных."""
    allowed_stages = {
        "audio_probe",
        "audio_decode",
        "short_transcribe",
        "longform_upstream",
        "longform_normalize",
        "result_normalize",
    }
    if stage not in allowed_stages:
        stage = "audio_probe"
    frames: list[dict[str, int | str]] = []
    current: BaseException | None = exception
    for _ in range(_DIAGNOSTIC_CAUSE_LIMIT):
        if current is None:
            break
        traceback = current.__traceback__
        while traceback is not None and len(frames) < _DIAGNOSTIC_FRAME_LIMIT:
            component = _diagnostic_component(
                traceback.tb_frame.f_code.co_filename, model_source
            )
            line = traceback.tb_lineno
            if component is not None and 0 < line <= _DIAGNOSTIC_LINE_LIMIT:
                frames.append({"component": component, "line": line})
            traceback = traceback.tb_next
        next_exception = current.__cause__
        if next_exception is None and not current.__suppress_context__:
            next_exception = current.__context__
        current = next_exception
    return {
        "diagnostic": {
            "stage": stage,
            "errorClass": _diagnostic_class(exception),
            "frames": frames,
        }
    }


def _annotate_fault(
    fault: RpcFault,
    exception: BaseException,
    stage: str,
    private_diagnostics: bool,
    model_source: Path | None,
) -> RpcFault:
    """Сохранить обычный fault и добавить безопасные данные только в private режиме."""
    if not private_diagnostics:
        return fault
    return RpcFault(
        fault.code,
        fault.message,
        _diagnostic_data(stage, exception, model_source),
    )


def _audio_duration(path: Path, maximum_seconds: float) -> float:
    """Проверить контейнер, единственный аудиопоток и длительность через ffprobe."""
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                ALLOWED_AUDIO_FORMATS,
                "-max_streams",
                "1",
                "-show_entries",
                "format=format_name,duration:stream=codec_type",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        if not completed.stdout or len(completed.stdout) > 4096:
            raise ValueError("invalid ffprobe metadata")
        metadata = json.loads(completed.stdout)
        format_names = set(str(metadata["format"]["format_name"]).split(","))
        streams = metadata.get("streams")
        if (
            not format_names
            or not format_names <= set(ALLOWED_AUDIO_FORMATS.split(","))
            or not isinstance(streams, list)
            or len(streams) != 1
            or streams[0].get("codec_type") != "audio"
        ):
            raise ValueError("unsupported audio container or stream layout")
        duration = float(metadata["format"]["duration"])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RpcFault(-32001, "Audio file is unavailable or invalid") from exc
    if not math.isfinite(duration) or not 0 < duration <= maximum_seconds:
        raise RpcFault(-32001, "Audio file is unavailable, invalid, or exceeds the operation limit")
    return duration


def _decode_audio_to_wav(
    source: Path,
    destination: Path,
    maximum_seconds: float,
    timeout_seconds: float,
) -> None:
    """Декодировать ограниченный моно PCM WAV и проверить точную длительность кадров."""
    maximum_output_bytes = (
        math.ceil(maximum_seconds * DECODE_SAMPLE_RATE)
        * DECODE_CHANNELS
        * DECODE_SAMPLE_BYTES
        + DECODE_HEADER_BYTES
    )
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                ALLOWED_AUDIO_FORMATS,
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-map_metadata",
                "-1",
                "-ac",
                str(DECODE_CHANNELS),
                "-ar",
                str(DECODE_SAMPLE_RATE),
                "-c:a",
                "pcm_s16le",
                "-fs",
                str(maximum_output_bytes + 1),
                "-f",
                "wav",
                "-n",
                str(destination),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RpcFault(-32001, "Audio file is unavailable or invalid") from exc
    if (
        destination.is_symlink()
        or not destination.is_file()
        or destination.stat().st_size > maximum_output_bytes
    ):
        raise RpcFault(-32001, "Audio file is unavailable or exceeds the decode limit")
    try:
        with wave.open(str(destination), "rb") as decoded:
            if (
                decoded.getnchannels() != DECODE_CHANNELS
                or decoded.getframerate() != DECODE_SAMPLE_RATE
                or decoded.getsampwidth() != DECODE_SAMPLE_BYTES
                or decoded.getcomptype() != "NONE"
                or decoded.getnframes() < 1
            ):
                raise ValueError("normalized WAV parameters are invalid")
            if len(decoded.readframes(1)) != DECODE_CHANNELS * DECODE_SAMPLE_BYTES:
                raise ValueError("normalized WAV has no complete audio frame")
            decoded_duration = decoded.getnframes() / decoded.getframerate()
            if decoded_duration > maximum_seconds:
                raise ValueError("normalized WAV exceeds the operation limit")
    except (EOFError, OSError, wave.Error, ValueError) as exc:
        raise RpcFault(-32001, "Audio file is unavailable or invalid") from exc


def _health(
    _params: dict[str, Any],
    revision: str = MODEL_REVISION,
    vad_revision: str | None = None,
) -> dict[str, Any]:
    """Сообщить готовность после успешной загрузки закреплённой модели."""
    if _params:
        raise RpcFault(-32602, "Invalid params")
    if vad_revision is None:
        raise RpcFault(-32603, "VAD model is unavailable")
    return {
        "ready": True,
        "model_id": MODEL_ID,
        "revision": revision,
        "vad_repository": "pyannote/segmentation-3.0",
        "vad_revision": vad_revision,
    }


def _transcribe(
    params: dict[str, Any],
    model: Any,
    longform_max_seconds: float,
    audio_decode_timeout_seconds: float,
    private_diagnostics: bool = False,
    model_source: Path | None = None,
) -> dict[str, Any]:
    """Распознать запись короткой моделью или VAD longform по её длительности."""
    if set(params) != {"audio_path"} or not isinstance(params["audio_path"], str):
        raise RpcFault(-32602, "Invalid params")
    supplied_path = Path(params["audio_path"])
    if not supplied_path.is_absolute():
        raise RpcFault(-32602, "audio_path must be absolute")
    try:
        path = supplied_path.resolve(strict=True)
    except OSError as exc:
        raise RpcFault(-32001, "Audio file is unavailable or invalid") from exc
    if not path.is_file():
        raise RpcFault(-32001, "Audio file is unavailable or invalid")
    try:
        _audio_duration(path, longform_max_seconds)
    except RpcFault as fault:
        cause = fault.__cause__ or fault
        raise _annotate_fault(
            fault, cause, "audio_probe", private_diagnostics, model_source
        ) from fault.__cause__
    stage = "audio_decode"

    def record_stage(value: str) -> None:
        nonlocal stage
        stage = value

    try:
        with TemporaryDirectory(prefix=".brai-audio-", dir=path.parent) as temp_dir:
            normalized_path = Path(temp_dir) / "audio.wav"
            _decode_audio_to_wav(
                path,
                normalized_path,
                longform_max_seconds,
                audio_decode_timeout_seconds,
            )
            with wave.open(str(normalized_path), "rb") as decoded:
                decoded_duration = decoded.getnframes() / decoded.getframerate()
            if decoded_duration > MAX_AUDIO_SECONDS:
                stage = "longform_upstream"
                try:
                    if private_diagnostics:
                        result = transcribe_longform(
                            model,
                            normalized_path,
                            decoded_duration,
                            diagnostic_stage=record_stage,
                        )
                    else:
                        result = transcribe_longform(model, normalized_path, decoded_duration)
                except LongformUnavailable as exc:
                    fault = RpcFault(-32603, "Longform is unavailable")
                    raise _annotate_fault(
                        fault, exc, stage, private_diagnostics, model_source
                    ) from exc
                except InvalidLongformResult as exc:
                    fault = RpcFault(-32603, "Inference failed")
                    raise _annotate_fault(
                        fault,
                        exc,
                        "longform_normalize",
                        private_diagnostics,
                        model_source,
                    ) from exc
                except Exception as exc:
                    fault = RpcFault(-32603, "Inference failed")
                    raise _annotate_fault(
                        fault, exc, stage, private_diagnostics, model_source
                    ) from exc
                return result
            stage = "short_transcribe"
            text = model.transcribe(str(normalized_path))
    except LongformUnavailable as exc:
        fault = RpcFault(-32603, "Longform is unavailable")
        raise _annotate_fault(
            fault, exc, stage, private_diagnostics, model_source
        ) from exc
    except RpcFault as fault:
        cause = fault.__cause__ or fault
        raise _annotate_fault(
            fault, cause, stage, private_diagnostics, model_source
        ) from fault.__cause__
    except Exception as exc:
        fault = RpcFault(-32603, "Inference failed")
        raise _annotate_fault(
            fault, exc, stage, private_diagnostics, model_source
        ) from exc
    if not isinstance(text, str):
        fault = RpcFault(-32603, "Inference failed")
        raise _annotate_fault(
            fault,
            TypeError("short transcription result must be text"),
            "result_normalize",
            private_diagnostics,
            model_source,
        )
    return {"text": text}


def _methods(
    model: Any,
    vad_revision: str,
    longform_max_seconds: float,
    audio_decode_timeout_seconds: float,
    private_diagnostics: bool = False,
    model_source: Path | None = None,
) -> dict[str, Method]:
    """Связать RPC-методы с экземпляром модели, принадлежащим процессу."""
    return {
        "health": lambda params: _health(params, vad_revision=vad_revision),
        "transcribe": lambda params: _transcribe(
            params,
            model,
            longform_max_seconds,
            audio_decode_timeout_seconds,
            private_diagnostics,
            model_source,
        ),
    }


def _serve(
    model: Any,
    vad_revision: str,
    longform_max_seconds: float,
    audio_decode_timeout_seconds: float,
    private_diagnostics: bool = False,
    model_source: Path | None = None,
) -> int:
    """Читать UTF-8 JSON-документы и писать только ответы JSON-RPC."""
    methods = _methods(
        model,
        vad_revision,
        longform_max_seconds,
        audio_decode_timeout_seconds,
        private_diagnostics,
        model_source,
    )
    rpc_stdout = sys.stdout.buffer
    for line in sys.stdin.buffer:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                response = process_line(line.rstrip(b"\r\n"), methods)
            if response is not None:
                rpc_stdout.write(response)
                rpc_stdout.flush()
        except Exception:
            # Unexpected implementation failures must not leak request or audio data.
            rpc_stdout.write(
                b'{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}\n'
            )
            rpc_stdout.flush()
            print("GigaAM runner protocol failure", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    """Загрузить offline-модель до приёма приватных RPC-запросов."""
    args = _arguments(argv)
    try:
        model_path = Path(args.model_path).resolve(strict=True)
        vad_model_path = Path(args.vad_model_path).resolve(strict=True)
        if not model_path.is_dir():
            raise RuntimeError("model directory unavailable")
        if not vad_model_path.is_dir():
            raise RuntimeError("VAD model directory unavailable")
        with contextlib.redirect_stdout(sys.stderr):
            model = _load_model(model_path, args.threads)
            vad_revision = configure_local_vad(model, vad_model_path)
    except Exception:
        print("GigaAM model load failed", file=sys.stderr)
        return 1
    print(f"GigaAM runner ready: {MODEL_ID} {MODEL_REVISION}; VAD {vad_revision}", file=sys.stderr)
    try:
        return _serve(
            model,
            vad_revision,
            args.longform_max_seconds,
            args.audio_decode_timeout_seconds,
            args.private_diagnostics,
            _pinned_model_source(model) if args.private_diagnostics else None,
        )
    finally:
        del model


if __name__ == "__main__":
    raise SystemExit(main())
