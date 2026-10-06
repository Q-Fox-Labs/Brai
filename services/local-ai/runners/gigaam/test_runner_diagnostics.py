# ABOUTME: Проверяет закрытые безопасные runtime-диагностические поля GigaAM.
# ABOUTME: Подтверждает неизменный RPC по умолчанию и отсутствие текста исключений.

from __future__ import annotations

import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import runner
from rpc import RpcFault, process_line


def _write_decoded_fixture(path: Path, seconds: float) -> None:
    """Подменить успешный decode валидным PCM, который затем читает runner."""
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * round(seconds * 16000))


class RunnerDiagnosticTests(unittest.TestCase):
    """Проверить необязательную классификацию внутренних ошибок по стадиям."""

    def _call(self, path: Path, *, private: bool) -> dict[str, object]:
        model = type("FakeModel", (), {})()

        def fail(_normalized_path: str) -> str:
            raise RuntimeError("SECRET transcript and local detail")

        model.transcribe = fail
        with patch.object(runner, "_audio_duration", return_value=5.0), patch.object(
            runner, "_decode_audio_to_wav", side_effect=lambda _source, dest, *_: _write_decoded_fixture(dest, 5.0)
        ):
            methods = {
                "transcribe": lambda params: runner._transcribe(
                    params,
                    model,
                    90.0,
                    15.0,
                    private_diagnostics=private,
                )
            }
            response = process_line(
                json.dumps(
                    {"jsonrpc": "2.0", "method": "transcribe", "params": {"audio_path": str(path)}, "id": 8}
                ).encode(),
                methods,
            )
        self.assertIsNotNone(response)
        return json.loads(response or b"{}")

    def test_default_rpc_error_shape_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            audio.touch()
            response = self._call(audio, private=False)
        self.assertEqual(
            response,
            {
                "jsonrpc": "2.0",
                "id": 8,
                "error": {"code": -32603, "message": "Inference failed"},
            },
        )

    def test_private_short_failure_has_only_closed_diagnostic_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            audio.touch()
            response = self._call(audio, private=True)
        error = response["error"]
        diagnostic = error["data"]["diagnostic"]
        self.assertEqual((error["code"], error["message"]), (-32603, "Inference failed"))
        self.assertEqual(diagnostic["stage"], "short_transcribe")
        self.assertEqual(diagnostic["errorClass"], "RuntimeError")
        self.assertLessEqual(len(diagnostic["frames"]), runner._DIAGNOSTIC_FRAME_LIMIT)
        self.assertTrue(all(set(frame) == {"component", "line"} for frame in diagnostic["frames"]))
        self.assertTrue(all(frame["component"] in {"runner", "longform", "pinned_model"} for frame in diagnostic["frames"]))
        self.assertNotIn("SECRET", json.dumps(response))
        self.assertNotIn(str(audio), json.dumps(response))

    def test_probe_failure_keeps_fault_but_adds_safe_classification(self) -> None:
        def probe_failure(*_args: object) -> float:
            try:
                raise ValueError("SECRET probe data")
            except ValueError as cause:
                raise RpcFault(-32001, "Audio file is unavailable or invalid") from cause

        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            audio.touch()
            with patch.object(
                runner,
                "_audio_duration",
                side_effect=probe_failure,
            ):
                with self.assertRaises(RpcFault) as raised:
                    runner._transcribe(
                        {"audio_path": str(audio)},
                        object(),
                        90.0,
                        15.0,
                        private_diagnostics=True,
                    )
        self.assertEqual((raised.exception.code, raised.exception.message), (-32001, "Audio file is unavailable or invalid"))
        diagnostic = raised.exception.data["diagnostic"]
        self.assertEqual((diagnostic["stage"], diagnostic["errorClass"]), ("audio_probe", "ValueError"))
        self.assertNotIn("SECRET", json.dumps(raised.exception.data))

    def test_decode_failure_is_attributed_to_audio_decode(self) -> None:
        def decode_failure(*_args: object) -> None:
            raise RpcFault(-32001, "Audio file is unavailable or invalid") from OSError(
                "SECRET decoder detail"
            )

        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            audio.touch()
            with patch.object(runner, "_audio_duration", return_value=5.0), patch.object(
                runner, "_decode_audio_to_wav", side_effect=decode_failure
            ):
                with self.assertRaises(RpcFault) as raised:
                    runner._transcribe(
                        {"audio_path": str(audio)}, object(), 90.0, 15.0, private_diagnostics=True
                    )
        diagnostic = raised.exception.data["diagnostic"]
        self.assertEqual((diagnostic["stage"], diagnostic["errorClass"]), ("audio_decode", "OSError"))
        self.assertNotIn("SECRET", json.dumps(raised.exception.data))

    def test_longform_operation_failure_is_attributed_to_upstream(self) -> None:
        def fail(_self: object, _path: str) -> list[object]:
            raise AttributeError("SECRET upstream response")

        model = type("FakeModel", (), {"transcribe_longform": fail})()
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "long.wav"
            audio.touch()
            with patch.object(runner, "_audio_duration", return_value=26.0), patch.object(
                runner, "_decode_audio_to_wav", side_effect=lambda _source, dest, *_: _write_decoded_fixture(dest, 26.0)
            ):
                with self.assertRaises(RpcFault) as raised:
                    runner._transcribe(
                        {"audio_path": str(audio)}, model, 90.0, 15.0, private_diagnostics=True
                    )
        diagnostic = raised.exception.data["diagnostic"]
        self.assertEqual((diagnostic["stage"], diagnostic["errorClass"]), ("longform_upstream", "AttributeError"))
        self.assertNotIn("SECRET", json.dumps(raised.exception.data))

    def test_longform_normalization_failure_is_not_mislabeled_upstream(self) -> None:
        model = type(
            "FakeModel",
            (),
            {"transcribe_longform": lambda _self, _path: [{"transcription": "secret", "boundaries": [2.0, 1.0]}]},
        )()
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "long.wav"
            audio.touch()
            with patch.object(runner, "_audio_duration", return_value=26.0), patch.object(
                runner, "_decode_audio_to_wav", side_effect=lambda _source, dest, *_: _write_decoded_fixture(dest, 26.0)
            ):
                with self.assertRaises(RpcFault) as raised:
                    runner._transcribe(
                        {"audio_path": str(audio)}, model, 90.0, 15.0, private_diagnostics=True
                    )
        diagnostic = raised.exception.data["diagnostic"]
        self.assertEqual(diagnostic["stage"], "longform_normalize")
        self.assertEqual(diagnostic["errorClass"], "InvalidLongformResult")
        self.assertNotIn("secret", json.dumps(raised.exception.data))

    def test_diagnostic_bounds_and_unknown_exception_names(self) -> None:
        dynamic_error = type("TokenLikePrivateName", (Exception,), {})

        def nested(depth: int) -> None:
            if depth:
                nested(depth - 1)
            else:
                raise dynamic_error("PRIVATE MESSAGE")

        try:
            nested(20)
        except Exception as exc:
            data = runner._diagnostic_data("short_transcribe", exc, None)
        diagnostic = data["diagnostic"]
        self.assertEqual(diagnostic["errorClass"], "OtherError")
        self.assertLessEqual(len(diagnostic["frames"]), runner._DIAGNOSTIC_FRAME_LIMIT)
        self.assertNotIn("TokenLikePrivateName", json.dumps(data))
        self.assertNotIn("PRIVATE MESSAGE", json.dumps(data))


if __name__ == "__main__":
    unittest.main()
