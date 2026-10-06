#!/usr/bin/env python3
# ABOUTME: Проверяет безопасную диагностику GigaAM на временных данных и заглушках.
# ABOUTME: Не загружает модель и не обращается к сети.

from __future__ import annotations

import hashlib
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

import diagnose_quality as diagnostic


def _write_wav(path: Path, rate: int = 16_000, frames: int = 8_000) -> None:
    """Создать короткий PCM WAV для проверки локального формата."""
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00\x00" * frames)


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fixture_roots(root: Path) -> tuple[Path, Path, Path, Path]:
    """Создать оба fixture manifest и их файлы в изолированном temp-каталоге."""
    official_root = root / "official"
    synthetic_root = root / "synthetic"
    official_root.mkdir()
    synthetic_root.mkdir()
    official_wav = official_root / "example.wav"
    synthetic_wav = synthetic_root / "short.wav"
    _write_wav(official_wav)
    _write_wav(synthetic_wav)
    source_data = {
        "tests_test_loading.py": b"test source\n",
        "gigaam_utils.py": b"utility source\n",
    }
    sources = []
    for relpath, filename in (
        ("tests/test_loading.py", "tests_test_loading.py"),
        ("gigaam/utils.py", "gigaam_utils.py"),
    ):
        content = source_data[filename]
        (official_root / filename).write_bytes(content)
        sources.append({
            "path": relpath,
            "file": filename,
            "bytes": len(content),
            "sha256": _digest(content),
        })
    official_manifest = {
        "protocol": "brai-official-natural-short-v1",
        "repository": diagnostic.UPSTREAM_REPOSITORY,
        "revision": diagnostic.UPSTREAM_REVISION,
        "sources": sources,
        "audio": {
            "file": "example.wav",
            "bytes": official_wav.stat().st_size,
            "sha256": diagnostic._sha256(official_wav),
            "pcm": {
                "sampleRate": 16_000,
                "channels": 1,
                "sampleWidthBytes": 2,
                "frames": 8_000,
                "durationSeconds": 0.5,
            },
        },
        "gold": {
            "referenceKey": "v3_e2e_ctc",
            "goldNormalized": "эталонная речь",
            "goldNormalizedSha256": _digest("эталонная речь".encode("utf-8")),
            "goldWords": 2,
        },
    }
    official_manifest_path = root / "official-manifest.json"
    official_manifest_path.write_text(json.dumps(official_manifest, ensure_ascii=False), encoding="utf-8")

    synthetic_manifest = {
        "schemaVersion": 1,
        "files": [{
            "path": "short.wav",
            "bytes": synthetic_wav.stat().st_size,
            "sha256": diagnostic._sha256(synthetic_wav),
        }],
        "fixtures": [{
            "kind": "short",
            "path": "short.wav",
            "durationSeconds": 0.5,
            "goldNormalized": "синтетическая речь",
            "goldWords": 2,
        }],
    }
    synthetic_manifest_path = root / "synthetic-manifest.json"
    synthetic_manifest_path.write_text(json.dumps(synthetic_manifest, ensure_ascii=False), encoding="utf-8")
    return official_manifest_path, official_root, synthetic_manifest_path, synthetic_root


@contextlib.contextmanager
def _capture_process_fds() -> object:
    """Перехватить native FD 1/2, не оставляя тестовые дескрипторы подменёнными."""
    with tempfile.TemporaryFile() as stdout_capture, tempfile.TemporaryFile() as stderr_capture:
        saved_stdout, saved_stderr = os.dup(1), os.dup(2)
        os.dup2(stdout_capture.fileno(), 1)
        os.dup2(stderr_capture.fileno(), 2)
        try:
            yield stdout_capture, stderr_capture
        finally:
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
            os.close(saved_stdout)
            os.close(saved_stderr)


def _fake_run_modules(fail_transcription: bool = False) -> tuple[types.ModuleType, types.ModuleType, list[object]]:
    """Создать ограниченные Transformers/runner заглушки для _run."""
    class FakeParameter:
        dtype = "torch.float32"

        def numel(self) -> int:
            return 11

    class FakeModel:
        def parameters(self) -> list[FakeParameter]:
            return [FakeParameter()]

    model = FakeModel()
    calls: list[object] = []

    def from_pretrained(*args: object, **kwargs: object) -> object:
        calls.append((args, kwargs))
        return model, {
            "missing_keys": [],
            "unexpected_keys": [],
            "mismatched_keys": [],
            "error_msgs": [],
        }

    transformers = types.ModuleType("transformers")
    transformers.AutoModel = types.SimpleNamespace(from_pretrained=from_pretrained)
    runner = types.ModuleType("runner")
    runner.MODEL_REVISION = diagnostic.MODEL_REVISION
    original_decode = lambda source, destination, *args, **kwargs: _write_wav(destination)
    runner._decode_audio_to_wav = original_decode

    def load_model(model_path: Path, threads: int) -> object:
        print("PYTHON_VENDOR_SENTINEL")
        os.write(1, b"FD1_VENDOR_SENTINEL")
        os.write(2, b"FD2_VENDOR_SENTINEL")
        return transformers.AutoModel.from_pretrained(
            str(model_path), local_files_only=True
        )

    runner._load_model = load_model
    runner.configure_local_vad = lambda loaded_model, vad_path: diagnostic.VAD_REVISION

    def transcribe(request: dict[str, str], loaded_model: object, *args: object) -> dict[str, str]:
        if fail_transcription:
            raise RuntimeError("private fake failure text")
        normalized = Path(request["audio_path"]).with_name("normalized.wav")
        runner._decode_audio_to_wav(Path(request["audio_path"]), normalized)
        normalized.unlink()
        return {"text": "модель распознала речь"}

    runner._transcribe = transcribe
    return transformers, runner, [model, calls, original_decode]


class DiagnoseQualityTest(unittest.TestCase):
    """Проверить gate, WER и безопасную проекцию loading_info."""

    def _run_with_fake_worker(self, root: Path, fail_transcription: bool = False) -> tuple[dict[str, object], list[object], object, object, list[object]]:
        official_root = root / "official-worker"
        synthetic_root = root / "synthetic-worker"
        official_root.mkdir()
        synthetic_root.mkdir()
        official_audio = official_root / "example.wav"
        synthetic_audio = synthetic_root / "short.wav"
        _write_wav(official_audio)
        _write_wav(synthetic_audio)
        fixtures = [
            {
                "kind": "official_short",
                "sourcePath": official_audio,
                "sha256": diagnostic._sha256(official_audio),
                "bytes": official_audio.stat().st_size,
                "durationSeconds": 0.5,
                "inputWav": diagnostic.input_wav_metadata(official_audio),
                "goldNormalized": "эталонная речь",
            },
            {
                "kind": "synthetic_short",
                "sourcePath": synthetic_audio,
                "sha256": diagnostic._sha256(synthetic_audio),
                "bytes": synthetic_audio.stat().st_size,
                "durationSeconds": 0.5,
                "inputWav": diagnostic.input_wav_metadata(synthetic_audio),
                "goldNormalized": "синтетическая речь",
            },
        ]
        source = {"repository": diagnostic.UPSTREAM_REPOSITORY, "commit": diagnostic.UPSTREAM_REVISION, "files": []}
        transformers, runner, fake_state = _fake_run_modules(fail_transcription)
        original_from_pretrained = transformers.AutoModel.from_pretrained
        original_decode = runner._decode_audio_to_wav
        args = types.SimpleNamespace(
            model_path="/model",
            vad_model_path="/vad",
            official_audio_root=str(official_root),
            synthetic_audio_root=str(synthetic_root),
            official_manifest="/unused/official-manifest.json",
            official_manifest_sha256=diagnostic.OFFICIAL_MANIFEST_SHA256,
            synthetic_manifest="/unused/synthetic-manifest.json",
            synthetic_manifest_sha256=diagnostic.SYNTHETIC_MANIFEST_SHA256,
        )
        directory_factory = tempfile.TemporaryDirectory
        directories: list[object] = []

        def record_directory(*positional: object, **named: object) -> object:
            directory = directory_factory(*positional, **named)
            directories.append(directory)
            return directory

        original_environment = dict(os.environ)
        with (
            patch.dict(os.environ, original_environment, clear=True),
            patch.dict(sys.modules, {"transformers": transformers, "runner": runner}),
            patch.object(diagnostic, "_load_official_fixture", return_value=(source, fixtures[0])),
            patch.object(diagnostic, "_load_synthetic_fixture", return_value=fixtures[1]),
            patch.object(diagnostic.tempfile, "TemporaryDirectory", side_effect=record_directory),
        ):
            try:
                result = diagnostic._run(args)
            except diagnostic.DiagnosticError as error:
                if not fail_transcription:
                    raise
                self.assertEqual(str(error), "inference_RuntimeError")
                result = {}
        self.assertIs(transformers.AutoModel.from_pretrained, original_from_pretrained)
        self.assertIs(runner._decode_audio_to_wav, original_decode)
        self.assertTrue(directories)
        self.assertTrue(all(not Path(directory.name).exists() for directory in directories))
        return result, fake_state[1], original_from_pretrained, original_decode, directories

    def test_loading_info_reports_counts_and_dtypes_without_key_names(self) -> None:
        class FakeParameter:
            dtype = "torch.float32"

            def numel(self) -> int:
                return 7

        class FakeModel:
            def parameters(self) -> list[FakeParameter]:
                return [FakeParameter(), FakeParameter()]

        summary = diagnostic.summarize_loading_info(
            {
                "missing_keys": ["private.weight"],
                "unexpected_keys": [],
                "mismatched_keys": [("private.bias", (2,), (3,))],
                "error_msgs": [],
            },
            FakeModel(),
        )
        self.assertEqual(summary["missingKeyCount"], 1)
        self.assertEqual(summary["unexpectedKeyCount"], 0)
        self.assertEqual(summary["mismatchedKeyCount"], 1)
        self.assertEqual(summary["parameterTensorCountsByDtype"], {"float32": 2})
        self.assertEqual(summary["parameterElementCountsByDtype"], {"float32": 14})
        self.assertNotIn("private.weight", json.dumps(summary))

    def test_pretrained_wrapper_requests_loading_info_and_returns_model_only(self) -> None:
        class FakeParameter:
            dtype = "torch.float32"

            def numel(self) -> int:
                return 3

        class FakeModel:
            def parameters(self) -> list[FakeParameter]:
                return [FakeParameter()]

        model = FakeModel()
        original = Mock(return_value=(model, {
            "missing_keys": [],
            "unexpected_keys": [],
            "mismatched_keys": [],
            "error_msgs": [],
        }))
        sink: dict[str, object] = {}
        wrapped = diagnostic.loading_info_wrapper(original, sink)
        self.assertIs(wrapped("model-path", local_files_only=True), model)
        original.assert_called_once_with(
            "model-path", local_files_only=True, output_loading_info=True
        )
        self.assertEqual(sink["missingKeyCount"], 0)

    def test_fake_worker_suppresses_output_reports_only_metrics_and_cleans_private_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with _capture_process_fds() as (stdout_capture, stderr_capture):
                result, calls, _, _, directories = self._run_with_fake_worker(Path(temporary))
                stdout_capture.seek(0)
                stderr_capture.seek(0)
                captured = stdout_capture.read() + stderr_capture.read()
            serialized = json.dumps(result, ensure_ascii=False)
            self.assertEqual(len(result["fixtures"]), 2)
            self.assertEqual(result["checkpointLoad"]["parameterTensorCountsByDtype"], {"float32": 1})
            self.assertEqual(result["fixtures"][0]["wer"]["referenceWords"], 2)
            self.assertEqual(calls[0][1]["output_loading_info"], True)
            self.assertNotIn("модель распознала речь", serialized)
            self.assertNotIn("эталонная речь", serialized)
            self.assertNotIn(b"VENDOR_SENTINEL", captured)
            self.assertTrue(all(not Path(directory.name).exists() for directory in directories))

    def test_fake_worker_failure_restores_patches_and_main_hides_exception_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with _capture_process_fds() as (stdout_capture, stderr_capture):
                result, calls, _, _, _ = self._run_with_fake_worker(Path(temporary), fail_transcription=True)
                stdout_capture.seek(0)
                stderr_capture.seek(0)
                captured = stdout_capture.read() + stderr_capture.read()
            self.assertEqual(result, {})
            self.assertEqual(calls[0][1]["output_loading_info"], True)
            self.assertNotIn(b"VENDOR_SENTINEL", captured)
        generic_stderr = io.StringIO()
        with (
            patch.object(diagnostic, "_parse_args", return_value=types.SimpleNamespace()),
            patch.object(diagnostic, "_run", side_effect=RuntimeError("private failure text")),
        ):
            with contextlib.redirect_stderr(generic_stderr):
                self.assertEqual(diagnostic.main([]), 1)
        self.assertIn("diagnostic_failed", generic_stderr.getvalue())
        self.assertNotIn("private failure text", generic_stderr.getvalue())

    def test_fixture_gates_verify_both_pinned_manifest_shapes_and_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            official_manifest, official_root, synthetic_manifest, synthetic_root = _fixture_roots(root)
            source, official = diagnostic._load_official_fixture(
                official_manifest, diagnostic._sha256(official_manifest), official_root
            )
            with patch.object(diagnostic, "SYNTHETIC_AUDIO_SHA256", diagnostic._sha256(synthetic_root / "short.wav")):
                synthetic = diagnostic._load_synthetic_fixture(
                    synthetic_manifest, diagnostic._sha256(synthetic_manifest), synthetic_root
                )
            self.assertEqual(source["commit"], diagnostic.UPSTREAM_REVISION)
            self.assertEqual(sorted(item["path"] for item in source["files"]), sorted(diagnostic.SOURCE_FILES))
            self.assertEqual(official["kind"], "official_short")
            self.assertEqual(official["inputWav"]["sampleRate"], 16_000)
            self.assertEqual(synthetic["kind"], "synthetic_short")
            self.assertEqual(synthetic["goldNormalized"], "синтетическая речь")

    def test_fixture_gate_rejects_mutated_digest_and_pcm_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            official_manifest, official_root, synthetic_manifest, synthetic_root = _fixture_roots(root)
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "manifest_digest_mismatch"):
                diagnostic._load_official_fixture(official_manifest, "0" * 64, official_root)
            payload = json.loads(official_manifest.read_text(encoding="utf-8"))
            payload["audio"]["pcm"]["frames"] += 1
            official_manifest.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "official_audio_mismatch"):
                diagnostic._load_official_fixture(
                    official_manifest, diagnostic._sha256(official_manifest), official_root
                )
            with patch.object(diagnostic, "SYNTHETIC_AUDIO_SHA256", diagnostic._sha256(synthetic_root / "short.wav")):
                synthetic_audio = synthetic_root / "short.wav"
                synthetic_audio.write_bytes(synthetic_audio.read_bytes() + b"x")
                with self.assertRaisesRegex(diagnostic.DiagnosticError, "synthetic_audio_mismatch"):
                    diagnostic._load_synthetic_fixture(
                        synthetic_manifest, diagnostic._sha256(synthetic_manifest), synthetic_root
                    )

    def test_revisions_and_manifest_cli_pins_are_exact(self) -> None:
        diagnostic._check_model_revisions(diagnostic.MODEL_REVISION, diagnostic.VAD_REVISION)
        with self.assertRaisesRegex(diagnostic.DiagnosticError, "model_revision_mismatch"):
            diagnostic._check_model_revisions("f" * 40, diagnostic.VAD_REVISION)
        valid_args = [
            "--model-path", "/model", "--vad-model-path", "/vad",
            "--official-audio-root", "/official", "--synthetic-audio-root", "/synthetic",
            "--official-manifest", "/official/manifest.json",
            "--official-manifest-sha256", diagnostic.OFFICIAL_MANIFEST_SHA256,
            "--synthetic-manifest", "/synthetic/manifest.json",
            "--synthetic-manifest-sha256", diagnostic.SYNTHETIC_MANIFEST_SHA256,
        ]
        self.assertEqual(diagnostic._parse_args(valid_args).official_manifest_sha256,
                         diagnostic.OFFICIAL_MANIFEST_SHA256)
        invalid_args = valid_args.copy()
        invalid_args[invalid_args.index("--official-manifest-sha256") + 1] = "0" * 64
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                diagnostic._parse_args(invalid_args)

    def test_pcm_metrics_reject_wrong_sample_rate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.wav"
            _write_wav(path)
            metrics = diagnostic.pcm_summary(path)
            self.assertEqual(metrics["sampleRate"], 16_000)
            self.assertEqual(metrics["channels"], 1)
            self.assertEqual(metrics["frames"], 8_000)
            self.assertEqual(metrics["clippedSampleCount"], 0)
            self.assertNotIn("samples", metrics)
            _write_wav(path, rate=8_000, frames=100)
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "invalid_normalized_pcm"):
                diagnostic.pcm_summary(path)

    def test_normalization_and_wer_are_deterministic(self) -> None:
        reference = diagnostic._normalize("Ёж, говорит!")
        hypothesis = diagnostic._normalize("еж")
        self.assertEqual(reference, ["еж", "говорит"])
        self.assertEqual(diagnostic._wer_counts(reference, hypothesis), (0, 1, 0, 2))


if __name__ == "__main__":
    unittest.main()
