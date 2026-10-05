# ABOUTME: Проверяет адаптер longform и локальный hook PyAnnote VAD.
# ABOUTME: Тесты не загружают пакеты, веса или аудио и не обращаются к сети.

from __future__ import annotations

import sys
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import longform


def get_pipeline(_device: object) -> object:
    """Завершить тест, если upstream вызывает сетевой путь VAD."""
    raise AssertionError("upstream HF pipeline loader was not replaced")


def segment_audio_file(_audio_path: str) -> None:
    """Дать фиктивной модели тот же global lookup, что и upstream сегментатор."""


class FakeInnerModel:
    """Представить внутреннюю модель с upstream методом longform."""

    def transcribe_longform(self, _audio_path: str) -> list[dict[str, object]]:
        return []


class FakeModel:
    """Представить HF-обёртку с внутренней моделью."""

    def __init__(self) -> None:
        self.model = FakeInnerModel()


class LongformTests(unittest.TestCase):
    """Проверить смещения сегментов и загрузку локального пайплайна."""

    def test_forwards_real_vad_offsets_in_service_seconds(self) -> None:
        """Сохранить реальные границы сегментов в исходной шкале секунд."""

        class Model:
            def transcribe_longform(self, _path: str) -> list[dict[str, object]]:
                return [
                    {"transcription": "Первый фрагмент.", "boundaries": (0.25, 4.5)},
                    {"transcription": "Второй фрагмент.", "boundaries": (9.75, 13.0)},
                ]

        result = longform.transcribe_longform(Model(), Path("/tmp/speech.wav"), 15.0)
        self.assertEqual(
            result,
            {
                "text": "Первый фрагмент. Второй фрагмент.",
                "segments": [
                    {
                        "text": "Первый фрагмент.",
                        "start_seconds": 0.25,
                        "end_seconds": 4.5,
                    },
                    {
                        "text": "Второй фрагмент.",
                        "start_seconds": 9.75,
                        "end_seconds": 13.0,
                    },
                ],
            },
        )

    def test_silence_returns_no_fabricated_segment(self) -> None:
        """Пустой результат VAD не должен создавать окно на всю запись."""

        class Model:
            def transcribe_longform(self, _path: str) -> list[dict[str, object]]:
                return []

        self.assertEqual(
            longform.transcribe_longform(Model(), Path("/tmp/silence.wav"), 61.0),
            {"text": "", "segments": []},
        )

    def test_rejects_overlapping_segments(self) -> None:
        """Отклонить результат, который повторно покрывает уже обработанную речь."""

        class Model:
            def transcribe_longform(self, _path: str) -> list[dict[str, object]]:
                return [
                    {"transcription": "Один.", "boundaries": (1.0, 5.0)},
                    {"transcription": "Два.", "boundaries": (4.9, 7.0)},
                ]

        with self.assertRaises(longform.InvalidLongformResult):
            longform.transcribe_longform(Model(), Path("/tmp/overlap.wav"), 8.0)

    def test_rejects_offsets_outside_source(self) -> None:
        """Не выдавать сегменты с отрицательными или превышающими длительность границами."""

        for boundaries in ((-0.1, 1.0), (1.0, 8.01)):
            with self.subTest(boundaries=boundaries):

                class Model:
                    def transcribe_longform(
                        self, _path: str
                    ) -> list[dict[str, object]]:
                        return [{"transcription": "Текст.", "boundaries": boundaries}]

                with self.assertRaises(longform.InvalidLongformResult):
                    longform.transcribe_longform(
                        Model(), Path("/tmp/outside.wav"), 8.0
                    )

    def test_installs_a_local_pipeline_before_upstream_transcription(self) -> None:
        """Подменить HF getter только локальным CPU-пайплайном без токена."""
        modules: dict[str, types.ModuleType] = {}
        torch = types.ModuleType("torch")
        torch.serialization = types.SimpleNamespace(safe_globals=lambda _items: _NullContext())
        torch.device = lambda value: value
        torch.FloatStorage = type("FloatStorage", (), {})
        modules["torch"] = torch
        torch_utils = types.ModuleType("torch._utils")
        torch_utils._rebuild_tensor_v2 = lambda *_args: None
        modules["torch._utils"] = torch_utils
        torch_version = types.ModuleType("torch.torch_version")
        torch_version.TorchVersion = type("TorchVersion", (), {})
        modules["torch.torch_version"] = torch_version

        audio = types.ModuleType("pyannote.audio")
        audio.Model = types.SimpleNamespace(
            from_pretrained=lambda path: self.assertTrue(Path(path).is_absolute())
        )
        pipelines = types.ModuleType("pyannote.audio.pipelines")

        class VoiceActivityDetection:
            def __init__(self, segmentation: object) -> None:
                self.segmentation = segmentation
                self.parameters: dict[str, float] | None = None

            def instantiate(self, parameters: dict[str, float]) -> None:
                self.parameters = parameters

            def to(self, device: str) -> "VoiceActivityDetection":
                self.device = device
                return self

        pipelines.VoiceActivityDetection = VoiceActivityDetection
        task = types.ModuleType("pyannote.audio.core.task")
        task.Problem = type("Problem", (), {})
        task.Resolution = type("Resolution", (), {})
        task.Specifications = type("Specifications", (), {})
        modules["pyannote"] = types.ModuleType("pyannote")
        modules["pyannote.audio"] = audio
        modules["pyannote.audio.core"] = types.ModuleType("pyannote.audio.core")
        modules["pyannote.audio.core.task"] = task
        modules["pyannote.audio.pipelines"] = pipelines
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory)
            with patch.dict(sys.modules, modules), patch.dict(
                "os.environ",
                {
                    "HF_HUB_OFFLINE": "1",
                    "TRANSFORMERS_OFFLINE": "1",
                    "PYANNOTE_METRICS_ENABLED": "0",
                },
            ), patch.object(
                longform, "verify_vad_snapshot", return_value="e66f3d3b9eb0873085418a7b813d3b369bf160bb"
            ) as verify:
                self.assertEqual(
                    longform.configure_local_vad(FakeModel(), model_path),
                    "e66f3d3b9eb0873085418a7b813d3b369bf160bb",
                )
                verify.assert_called_once_with(model_path.resolve())
                self.assertIsInstance(get_pipeline("cpu"), VoiceActivityDetection)
                self.assertEqual(get_pipeline("cpu").parameters, {"min_duration_on": 0.0, "min_duration_off": 0.0})
                self.assertEqual(get_pipeline("cpu").device, "cpu")

    def test_rejects_unpinned_vad_manifest(self) -> None:
        """Отклонить syntactically valid, но не совпадающий с source pin manifest."""
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory)
            files = []
            for name in ("config.yaml", "pytorch_model.bin", "LICENSE"):
                (model_path / name).write_bytes(b"actual")
                files.append({"path": name, "bytes": 6, "sha256": "0" * 64})
            (model_path / "manifest.json").write_text(
                json.dumps(
                    {
                        "repository": "pyannote/segmentation-3.0",
                        "revision": "b" * 40,
                        "files": files,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(longform.LongformUnavailable):
                longform.verify_vad_snapshot(model_path)

    def test_rejects_missing_vad_manifest(self) -> None:
        """Отказаться от непроверенного локального checkpoint без манифеста."""
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory)
            for name in ("config.yaml", "pytorch_model.bin", "LICENSE"):
                (model_path / name).write_bytes(b"fixture")
            with self.assertRaises(longform.LongformUnavailable):
                longform.verify_vad_snapshot(model_path)


class _NullContext:
    """Представить torch.serialization.safe_globals контекст для теста."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *_args: object) -> None:
        return None


if __name__ == "__main__":
    unittest.main()
