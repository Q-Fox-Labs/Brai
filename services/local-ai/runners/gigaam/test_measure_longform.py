# ABOUTME: Проверяет longform измеритель на границах результата и cleanup.
# ABOUTME: Тесты не загружают модель и не выводят эталонные или распознанные тексты.

from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import measure_longform
import measure_short

NATURAL_FIXTURE_ROOT = Path(
    "/srv/projects/admin/tmp/local-ai-runtime/natural-long/7447938d791c4f3e643386ee22c33777004293a5"
)


def _fixture(kind: str = "long-pauses") -> measure_longform.Fixture:
    """Создать проверяемые метаданные без обращения к аудио."""
    reference = ("утро", "солнце") if kind != "silence" else ()
    return measure_longform.Fixture(
        kind=kind,
        source_path=Path("/fixtures/input.wav"),
        sha256="a" * 64,
        frames=1_200_000,
        duration_seconds=75.0,
        reference=reference,
        evidence={},
    )


class LongformMeasurementTests(unittest.TestCase):
    """Проверить метрики без допущений о желаемых сегментационных границах."""

    def test_valid_segments_preserve_actual_boundaries_and_word_metrics(self) -> None:
        """Сохранить фактические границы и посчитать WER без текста в отчёте."""
        result = measure_longform._validate_result(
            {
                "text": "Утро солнце.",
                "segments": [
                    {"text": "Утро", "start_seconds": 1.0, "end_seconds": 2.5},
                    {"text": "солнце.", "start_seconds": 12.0, "end_seconds": 14.0},
                ],
            },
            _fixture(),
        )
        self.assertEqual(
            result,
            {
                "hypothesisWords": 2,
                "segments": [
                    {"startSeconds": 1.0, "endSeconds": 2.5},
                    {"startSeconds": 12.0, "endSeconds": 14.0},
                ],
                "wer": {
                    "substitutions": 0,
                    "deletions": 0,
                    "insertions": 0,
                    "referenceWords": 2,
                    "rate": 0.0,
                },
            },
        )

    def test_malformed_overlap_nonfinite_negative_and_out_of_range_segments_fail(self) -> None:
        """Отклонить некорректные, пересекающиеся и выходящие за длительность интервалы."""
        invalid_results = (
            {"text": "x", "segments": [{"text": "x", "start_seconds": True, "end_seconds": 1.0}]},
            {"text": "x", "segments": [{"text": "x", "start_seconds": float("nan"), "end_seconds": 1.0}]},
            {
                "text": "x y",
                "segments": [
                    {"text": "x", "start_seconds": 1.0, "end_seconds": 3.0},
                    {"text": "y", "start_seconds": 2.5, "end_seconds": 4.0},
                ],
            },
            {"text": "x", "segments": [{"text": "x", "start_seconds": -0.01, "end_seconds": 1.0}]},
            {"text": "x", "segments": [{"text": "x", "start_seconds": 74.0, "end_seconds": 75.01}]},
            {"text": "wrong", "segments": [{"text": "x", "start_seconds": 1.0, "end_seconds": 2.0}]},
            {"text": "x", "segments": [{"text": "x", "start_seconds": 1.0, "end_seconds": 2.0, "extra": 1}]},
        )
        for result in invalid_results:
            with self.subTest(result_shape=str(result)[:60]):
                with self.assertRaises(measure_longform.MeasurementError):
                    measure_longform._validate_result(result, _fixture())

    def test_empty_silence_result_is_valid_without_fabricated_timing(self) -> None:
        """Принять тишину без текста и отклонить выдуманный речевой сегмент."""
        self.assertEqual(
            measure_longform._validate_result(
                {"text": "", "segments": []}, _fixture("silence")
            ),
            {
                "hypothesisWords": 0,
                "segments": [],
                "wer": {
                    "substitutions": 0,
                    "deletions": 0,
                    "insertions": 0,
                    "referenceWords": 0,
                    "rate": None,
                },
            },
        )
        with self.assertRaises(measure_longform.MeasurementError):
            measure_longform._validate_result(
                {
                    "text": "голос",
                    "segments": [
                        {"text": "голос", "start_seconds": 1.0, "end_seconds": 2.0}
                    ],
                },
                _fixture("silence"),
            )

    def test_pause_evidence_is_reported_as_manifest_frames(self) -> None:
        """Показать паузы в закреплённых кадрах без оценки желаемых VAD-границ."""
        ranges = measure_longform._gold_pause_frame_ranges(
            [
                {"startFrame": 100, "endFrame": 200},
                {"startFrame": 350, "endFrame": 450},
            ],
            500,
        )
        self.assertEqual(
            ranges,
            [
                {"startFrame": 0, "endFrame": 100, "frameCount": 100},
                {"startFrame": 200, "endFrame": 350, "frameCount": 150},
                {"startFrame": 450, "endFrame": 500, "frameCount": 50},
            ],
        )

    def test_natural_reference_metrics_never_include_text(self) -> None:
        """Сравнить обе альтернативные версии, возвращая только счётчики и смещения."""
        fixture = measure_longform.NaturalFixture(
            Path("/private/long_example.wav"),
            [
                {
                    "label": "v3_ctc",
                    "normalizedSha256": "a" * 64,
                    "wordCount": 2,
                    "tokens": ("утро", "солнце"),
                    "segments": [
                        {"startSeconds": 0.5, "endSeconds": 2.0, "wordCount": 2}
                    ],
                },
                {
                    "label": "v3_e2e_rnnt",
                    "normalizedSha256": "b" * 64,
                    "wordCount": 2,
                    "tokens": ("утро", "дождь"),
                    "segments": [
                        {"startSeconds": 0.5, "endSeconds": 2.0, "wordCount": 2}
                    ],
                },
            ],
            [],
        )
        report = measure_longform._natural_result_metrics(
            {
                "text": "утро солнце",
                "segments": [
                    {"text": "утро солнце", "start_seconds": 0.75, "end_seconds": 2.25}
                ],
            },
            fixture,
        )
        self.assertEqual(report["hypothesisWords"], 2)
        self.assertEqual(
            [row["wer"]["rate"] for row in report["referenceComparisons"]],
            [0.0, 0.5],
        )
        self.assertEqual(
            report["actualSegments"],
            [{"startSeconds": 0.75, "endSeconds": 2.25, "hypothesisWords": 2}],
        )
        serialized = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("утро", serialized)
        self.assertNotIn("солнце", serialized)
        self.assertNotIn("дождь", serialized)

    def test_optional_natural_mode_adds_diagnostic_without_changing_default_receipt(self) -> None:
        """Добавить natural диагностический блок лишь при явном парном input."""
        class FakeRpcProcess:
            """Представить JSON-RPC worker без запуска модели."""

            def __init__(self, *_args: Any, **_kwargs: Any) -> None:
                self.started_at = time.monotonic()

            def call(self, method: str, params: dict[str, str], _request_id: str) -> dict[str, Any]:
                if method == "health":
                    return measure_short.EXPECTED_HEALTH
                if Path(params["audio_path"]).name == "long_example.wav":
                    return {
                        "text": "утро солнце",
                        "segments": [
                            {"text": "утро солнце", "start_seconds": 0.75, "end_seconds": 2.25}
                        ],
                    }
                return {
                    "text": "утро солнце",
                    "segments": [
                        {"text": "утро солнце", "start_seconds": 0.75, "end_seconds": 2.25}
                    ],
                }

            def stop(self) -> dict[str, Any]:
                return {
                    "exit_code": 0,
                    "graceful": True,
                    "elapsed_ms": 1.0,
                    "pid_released": True,
                    "process_group_released": True,
                    "parent_peak_rss_bytes": 123_456,
                }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_audio = root / "long-pauses.wav"
            source_audio.write_bytes(b"fixture")
            natural_audio = root / "long_example.wav"
            natural_audio.write_bytes(b"natural")
            tts_fixture = measure_longform.Fixture(
                "long-pauses", source_audio, "c" * 64, 1_200_000, 75.0,
                ("утро", "солнце"), {},
            )
            natural_fixture = measure_longform.NaturalFixture(
                natural_audio,
                [
                    {
                        "label": "v3_ctc",
                        "normalizedSha256": "a" * 64,
                        "wordCount": 2,
                        "tokens": ("утро", "солнце"),
                        "segments": [],
                    },
                    {
                        "label": "v3_e2e_rnnt",
                        "normalizedSha256": "b" * 64,
                        "wordCount": 2,
                        "tokens": ("утро", "дождь"),
                        "segments": [],
                    },
                ],
                [{"path": "gigaam/utils.py", "bytes": 14_044, "sha256": "d" * 64}],
            )
            common = {
                "manifest": root / "tts-manifest.json",
                "fixture_root": root,
                "total_timeout_seconds": 300.0,
                "python": sys.executable,
                "runner": "/runner.py",
                "model_path": "/models/gigaam",
                "vad_model_path": "/models/vad",
            }
            with (
                patch.object(measure_longform, "_fixture_set", return_value=[tts_fixture]),
                patch.object(measure_longform, "_load_natural_fixture", return_value=natural_fixture),
                patch.object(measure_short, "_launch_command", return_value=[sys.executable]),
                patch.object(measure_short, "RpcProcess", FakeRpcProcess),
            ):
                default = measure_longform._run(SimpleNamespace(**common))
                optional = measure_longform._run(
                    SimpleNamespace(
                        **common,
                        natural_manifest=root / "natural-manifest.json",
                        natural_root=root,
                    )
                )
        self.assertNotIn("naturalLongDiagnostic", default)
        self.assertEqual(default["fixtureScope"], "pinned-synthetic-tts-diagnostic")
        self.assertEqual(
            set(default),
            {
                "fixtureScope",
                "qualityStatus",
                "fixtureManifestSha256",
                "modelRevision",
                "vadRevision",
                "networkIsolated",
                "threads",
                "longformMaximumSeconds",
                "audioDecodeTimeoutSeconds",
                "process",
                "fixtures",
                "temporaryAudioCleaned",
                "totalElapsedMs",
            },
        )
        natural_report = optional["naturalLongDiagnostic"]
        self.assertFalse(natural_report["exactGoldForV3E2eCtc"])
        self.assertEqual(natural_report["qualityStatus"], "diagnostic-only")
        self.assertEqual(
            [item["wer"]["rate"] for item in natural_report["referenceComparisons"]],
            [0.0, 0.5],
        )
        self.assertEqual(optional["process"]["parent_peak_rss_bytes"], 123_456)

    def test_pinned_natural_bundle_verifies_without_model_loading(self) -> None:
        """Проверить настоящий natural bundle по manifest и source pin read-only."""
        manifest_path = NATURAL_FIXTURE_ROOT / "manifest.json"
        if not manifest_path.is_file():
            self.skipTest("prepared pinned natural fixture is unavailable")
        fixture = measure_longform._load_natural_fixture(
            manifest_path, NATURAL_FIXTURE_ROOT
        )
        self.assertEqual(len(fixture.sources), 2)
        self.assertEqual(
            [(item["label"], item["wordCount"], len(item["segments"])) for item in fixture.references],
            [("v3_ctc", 124, 5), ("v3_e2e_rnnt", 124, 5)],
        )

    def test_natural_manifest_rejects_bad_digest_provenance_pcm_source_and_schema(self) -> None:
        """Отклонить изменённые pins даже при пересчитанном manifest hash."""
        original_path = NATURAL_FIXTURE_ROOT / "manifest.json"
        if not original_path.is_file():
            self.skipTest("prepared pinned natural fixture is unavailable")
        original = json.loads(original_path.read_text(encoding="utf-8"))
        mutations = (
            ("provenance", lambda data: data.update(revision="0" * 40)),
            (
                "exact_gold_claim",
                lambda data: data["references"].update(exactGoldForV3E2eCtc=True),
            ),
            ("pcm", lambda data: data["audio"]["pcm"].update(frames=1_139_999)),
            (
                "source_pin",
                lambda data: data["sources"][0].update(sha256="0" * 64),
            ),
            (
                "reference_schema",
                lambda data: data["references"]["labels"]["v3_ctc"]["segments"][0].pop(
                    "normalizedText"
                ),
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            manifest_path = Path(directory) / "manifest.json"
            for name, mutate in mutations:
                with self.subTest(case=name):
                    manifest = copy.deepcopy(original)
                    mutate(manifest)
                    manifest_path.write_text(
                        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
                    )
                    with patch.object(
                        measure_longform,
                        "NATURAL_MANIFEST_SHA256",
                        measure_short._sha256(manifest_path),
                    ), self.assertRaises(measure_longform.MeasurementError):
                        measure_longform._load_natural_fixture(
                            manifest_path, NATURAL_FIXTURE_ROOT
                        )
            manifest_path.write_text(
                json.dumps(original, ensure_ascii=False), encoding="utf-8"
            )
            with self.assertRaisesRegex(
                measure_longform.MeasurementError, "manifest pin mismatch"
            ):
                measure_longform._load_natural_fixture(
                    manifest_path, NATURAL_FIXTURE_ROOT
                )

    def test_arguments_require_network_isolation_and_cap_total_deadline(self) -> None:
        """Требовать network namespace и ограничивать полный срок эксперимента."""
        base = [
            "measure_longform.py",
            "--python", "/opt/python",
            "--runner", "/opt/runner.py",
            "--model-path", "/models/gigaam",
            "--vad-model-path", "/models/vad",
            "--fixture-root", "/fixtures",
            "--manifest", "/fixtures/manifest.json",
        ]
        with patch("sys.argv", base), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                measure_longform._arguments(None)
        with patch(
            "sys.argv",
            [*base, "--network-isolation", "--total-timeout-seconds", "301"],
        ), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                measure_longform._arguments(None)
        with patch("sys.argv", [*base, "--network-isolation"]):
            default_args = measure_longform._arguments(None)
        self.assertEqual(default_args.total_timeout_seconds, 300.0)
        self.assertIsNone(default_args.natural_root)
        self.assertIsNone(default_args.natural_manifest)
        with patch(
            "sys.argv",
            [
                *base,
                "--network-isolation",
                "--natural-root",
                "/fixtures/natural",
                "--natural-manifest",
                "/fixtures/natural/manifest.json",
            ],
        ):
            natural_args = measure_longform._arguments(None)
        self.assertEqual(natural_args.natural_root, "/fixtures/natural")

    def test_runtime_environment_is_offline_keyless_and_uses_four_threads(self) -> None:
        """Передавать runner только локальные cache paths без токена HF."""
        with tempfile.TemporaryDirectory() as directory:
            environment = measure_longform._private_environment(Path(directory))
        self.assertEqual(environment["HF_HUB_OFFLINE"], "1")
        self.assertEqual(environment["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(environment["OMP_NUM_THREADS"], "4")
        self.assertEqual(environment["MKL_NUM_THREADS"], "4")
        self.assertNotIn("HF_TOKEN", environment)

    def test_module_loads_without_being_registered_in_sys_modules(self) -> None:
        """Оставаться совместимым с release wrapper на importlib exec_module."""
        path = Path(measure_longform.__file__)
        spec = importlib.util.spec_from_file_location("longform_measure_probe", path)
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        self.assertNotIn("longform_measure_probe", sys.modules)
        spec.loader.exec_module(module)
        self.assertEqual(module.FIXTURE_MANIFEST_SHA256, measure_short.FIXTURE_MANIFEST_SHA256)

    def test_rpc_failure_returns_generic_json_without_traceback_or_detail(self) -> None:
        """Скрыть детали frozen RPC exception в безопасном stderr JSON."""
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.object(measure_longform, "_arguments", return_value=object()),
            patch.object(
                measure_longform,
                "_run",
                side_effect=measure_short.MeasurementError("private transcript detail"),
            ),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            exit_code = measure_longform.main([])
        self.assertEqual(exit_code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), '{"error":"longform measurement failed"}\n')
        self.assertNotIn("private transcript detail", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_timeout_stops_process_group_and_removes_private_fixture_copy(self) -> None:
        """Остановить дочернюю группу после timeout и удалить временную копию WAV."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_runner = root / "fake_runner.py"
            fake_runner.write_text(
                "import json,subprocess,sys,time\n"
                "health = "
                + repr(measure_short.EXPECTED_HEALTH)
                + "\n"
                "for line in sys.stdin:\n"
                " request=json.loads(line)\n"
                " if request['method']=='health':\n"
                "  print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':health}),flush=True)\n"
                " else:\n"
                "  subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'])\n"
                "  sys.stdout.write('{');sys.stdout.flush();time.sleep(20)\n",
                encoding="utf-8",
            )
            source = root / "source.wav"
            source.write_bytes(b"local fixture")
            fixture = measure_longform.Fixture(
                kind="long-pauses",
                source_path=source,
                sha256="b" * 64,
                frames=1_200_000,
                duration_seconds=75.0,
                reference=("утро",),
                evidence={},
            )
            args = SimpleNamespace(
                manifest=root / "manifest.json",
                fixture_root=root,
                total_timeout_seconds=0.4,
                python=sys.executable,
                runner=str(fake_runner),
                model_path="/models/gigaam",
                vad_model_path="/models/vad",
                network_isolation=True,
            )
            captured_homes: list[Path] = []
            stop_results: list[dict[str, Any]] = []
            original_tempdir = tempfile.TemporaryDirectory
            original_stop = measure_short.RpcProcess.stop

            def capture_tempdir(*call_args: Any, **call_kwargs: Any) -> Any:
                context = original_tempdir(*call_args, **call_kwargs)
                captured_homes.append(Path(context.name))
                return context

            def capture_stop(process: measure_short.RpcProcess) -> dict[str, Any]:
                stopped = original_stop(process)
                stop_results.append(stopped)
                return stopped

            with (
                patch.object(measure_longform, "_fixture_set", return_value=[fixture]),
                patch.object(measure_short, "_launch_command", return_value=[sys.executable, str(fake_runner)]),
                patch.object(measure_longform.tempfile, "TemporaryDirectory", capture_tempdir),
                patch.object(measure_longform, "CLEANUP_RESERVE_SECONDS", 0.1),
                patch.object(measure_short.RpcProcess, "stop", capture_stop),
            ):
                started = time.monotonic()
                with self.assertRaisesRegex(measure_short.MeasurementError, "timed out"):
                    measure_longform._run(args)
            self.assertLess(time.monotonic() - started, 3.0)
            self.assertEqual(len(stop_results), 1)
            self.assertTrue(stop_results[0]["pid_released"])
            self.assertTrue(stop_results[0]["process_group_released"])
            self.assertEqual(len(captured_homes), 1)
            self.assertFalse(captured_homes[0].exists())


if __name__ == "__main__":
    unittest.main()
