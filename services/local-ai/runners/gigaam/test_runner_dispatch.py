# ABOUTME: Проверяет выбор shortform и longform внутри единственного RPC transcribe.
# ABOUTME: Не загружает runtime-пакеты и не открывает сеть или модельные веса.

from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import runner


def _write_normalized_fixture(path: Path, duration: float) -> None:
    """Подготовить PCM-кадры после подменённого декодера с точной длительностью."""
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * round(duration * 16000))


class RunnerDispatchTests(unittest.TestCase):
    """Проверить границу 25 секунд и единый лимит длительности."""

    def test_short_audio_uses_existing_transcribe_shape(self) -> None:
        """Сохранить текущий результат `{text}` для короткой записи."""

        class Model:
            received_path: str | None = None

            def transcribe(self, _path: str) -> str:
                self.received_path = _path
                return "Короткая речь."

        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "short.wav"
            audio.touch()
            model = Model()
            with patch.object(runner, "_audio_duration", return_value=25.0), patch.object(
                runner, "transcribe_longform", side_effect=AssertionError("unexpected longform")
            ), patch.object(runner, "_decode_audio_to_wav") as decode:
                decode.side_effect = lambda _src, dest, *_args: _write_normalized_fixture(dest, 25.0)
                self.assertEqual(
                    runner._transcribe({"audio_path": str(audio)}, model, 90.0, 15.0),
                    {"text": "Короткая речь."},
                )
                self.assertNotEqual(Path(model.received_path or ""), audio.resolve())
                self.assertEqual(Path(model.received_path or "").name, "audio.wav")
            self.assertEqual(list(Path(directory).glob(".brai-audio-*")), [])

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
            def check_normalized(_model: object, normalized: Path, duration: float) -> dict[str, object]:
                self.assertNotEqual(normalized, audio.resolve())
                self.assertTrue(normalized.parent.name.startswith(".brai-audio-"))
                self.assertTrue(normalized.is_file())
                self.assertEqual(duration, 25.000125)
                return expected

            with patch.object(runner, "_audio_duration", return_value=25.0), patch.object(
                runner, "transcribe_longform", side_effect=check_normalized
            ), patch.object(runner, "_decode_audio_to_wav") as decode:
                decode.side_effect = lambda _src, dest, *_args: _write_normalized_fixture(dest, 25.000125)
                self.assertEqual(
                    runner._transcribe({"audio_path": str(audio)}, model, 90.0, 15.0),
                    expected,
                )
            self.assertEqual(list(Path(directory).glob(".brai-audio-*")), [])


if __name__ == "__main__":
    unittest.main()
