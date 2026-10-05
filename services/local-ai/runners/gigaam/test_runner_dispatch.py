# ABOUTME: Проверяет выбор shortform и longform внутри единственного RPC transcribe.
# ABOUTME: Не загружает runtime-пакеты и не открывает сеть или модельные веса.

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import runner


class RunnerDispatchTests(unittest.TestCase):
    """Проверить границу 25 секунд и единый лимит длительности."""

    def test_short_audio_uses_existing_transcribe_shape(self) -> None:
        """Сохранить текущий результат `{text}` для короткой записи."""

        class Model:
            def transcribe(self, _path: str) -> str:
                return "Короткая речь."

        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "short.wav"
            audio.touch()
            with patch.object(runner, "_audio_duration", return_value=25.0), patch.object(
                runner, "transcribe_longform", side_effect=AssertionError("unexpected longform")
            ):
                self.assertEqual(
                    runner._transcribe({"audio_path": str(audio)}, Model(), 90.0),
                    {"text": "Короткая речь."},
                )

    def test_long_audio_uses_longform_and_forwards_segment_offsets(self) -> None:
        """При превышении короткого лимита вернуть сегменты с реальными границами."""

        class Model:
            def transcribe(self, _path: str) -> str:
                raise AssertionError("shortform must not receive long audio")

        expected = {
            "text": "Длинная речь.",
            "segments": [
                {"text": "Длинная речь.", "start_seconds": 1.0, "end_seconds": 5.0}
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "long.wav"
            audio.touch()
            model = Model()
            with patch.object(runner, "_audio_duration", return_value=30.0), patch.object(
                runner, "transcribe_longform", return_value=expected
            ) as longform:
                self.assertEqual(
                    runner._transcribe({"audio_path": str(audio)}, model, 90.0),
                    expected,
                )
                longform.assert_called_once_with(model, audio.resolve(), 30.0)


if __name__ == "__main__":
    unittest.main()
