# ABOUTME: Проверяет строгие контейнеры FFmpeg и нормализацию входного аудио.
# ABOUTME: Проверки WAV/FLAC/MP3/OGG и playlist используют системный FFmpeg.

from __future__ import annotations

import math
import shutil
import struct
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from subprocess import DEVNULL, run
from threading import Event

import runner


def _write_wave(path: Path, duration_seconds: float = 30) -> None:
    """Создать PCM WAV-фрагмент для проверки контейнерных demuxer'ов."""
    rate = 16000
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = bytearray()
        for index in range(int(duration_seconds * rate)):
            sample = int(5000 * math.sin(2 * math.pi * 440 * index / rate))
            frames.extend(struct.pack("<h", sample))
        output.writeframes(frames)


@unittest.skipUnless(shutil.which("ffprobe") and shutil.which("ffmpeg"), "system FFmpeg is unavailable")
class AudioBoundaryTests(unittest.TestCase):
    """Проверить поддержанные контейнеры и запрет сетевых playlist input."""

    def test_supported_formats_normalize_to_bounded_mono_pcm_wav(self) -> None:
        """Декодировать WAV, FLAC, MP3 и OGG в ограниченный моно WAV 16 kHz."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_wav = root / "fixture.wav"
            _write_wave(original_wav)
            sources: dict[str, Path] = {"wav": original_wav}
            for extension, codec in (("flac", "flac"), ("mp3", "libmp3lame"), ("ogg", "libvorbis")):
                source = root / f"fixture.{extension}"
                run(
                    ["ffmpeg", "-nostdin", "-v", "error", "-i", str(original_wav), "-c:a", codec, "-y", str(source)],
                    check=True,
                    stdout=DEVNULL,
                    stderr=DEVNULL,
                    timeout=30,
                )
                sources[extension] = source

            for extension, source in sources.items():
                with self.subTest(extension=extension):
                    duration = runner._audio_duration(source, 60.0)
                    self.assertGreaterEqual(duration, 29.0)
                    self.assertLessEqual(duration, 31.0)
                    with tempfile.TemporaryDirectory(prefix=".brai-audio-", dir=root) as temporary:
                        normalized = Path(temporary) / "audio.wav"
                        runner._decode_audio_to_wav(source, normalized, 60.0, 30.0)
                        header = normalized.read_bytes()[:44]
                        self.assertEqual(header[:4], b"RIFF")
                        self.assertEqual(header[8:12], b"WAVE")
                        self.assertEqual(struct.unpack_from("<H", header, 20)[0], 1)
                        self.assertEqual(struct.unpack_from("<H", header, 22)[0], 1)
                        self.assertEqual(struct.unpack_from("<I", header, 24)[0], 16000)
                        self.assertEqual(struct.unpack_from("<H", header, 34)[0], 16)
                        self.assertLessEqual(
                            normalized.stat().st_size,
                            math.ceil(60 * 16000) * 2 + runner.DECODE_HEADER_BYTES,
                        )

    def test_longform_boundaries_follow_decoded_frames_instead_of_source_metadata(self) -> None:
        """Принять реальную границу PCM после resampling и округления исходного ffprobe."""
        class BoundaryModel:
            def transcribe_longform(self, path: str) -> list[dict[str, object]]:
                with wave.open(path, "rb") as audio:
                    duration = audio.getnframes() / audio.getframerate()
                return [{"transcription": "Фикстура.", "boundaries": (0.0, duration)}]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(22050)
                audio.writeframes(b"\0\0" * 664222)
            source_duration = runner._audio_duration(source, 120.0)
            result = runner._transcribe({"audio_path": str(source)}, BoundaryModel(), 120.0, 30.0)
            segment = result["segments"][0]
            self.assertGreater(segment["end_seconds"], source_duration)
            self.assertEqual(segment["end_seconds"] * 16000, round(segment["end_seconds"] * 16000))
            self.assertEqual(list(Path(directory).glob(".brai-audio-*")), [])

    def test_decoded_frame_duration_cannot_exceed_the_operation_limit(self) -> None:
        """Не принимать лишний PCM-кадр, даже если файл помещается в бюджет заголовка."""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            normalized = Path(directory) / "normalized.wav"

            def oversized_decode(argv: list[str], **_kwargs: object) -> None:
                with wave.open(argv[-1], "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16000)
                    audio.writeframes(b"\0\0" * 16001)

            with patch.object(runner.subprocess, "run", side_effect=oversized_decode):
                with self.assertRaises(runner.RpcFault) as caught:
                    runner._decode_audio_to_wav(source, normalized, 1.0, 30.0)
            self.assertEqual(caught.exception.code, -32001)
            self.assertIsInstance(caught.exception.__cause__, ValueError)

    def test_50ms_pcm_wav_is_accepted_below_header_budget(self) -> None:
        """Не путать допустимый WAV-заголовок с минимальным аудиосодержимым."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "short.wav"
            _write_wave(source, duration_seconds=0.05)
            self.assertEqual(runner._audio_duration(source, 2.0), 0.05)
            normalized = root / "normalized.wav"
            runner._decode_audio_to_wav(source, normalized, 2.0, 30.0)
            self.assertLess(normalized.stat().st_size, runner.DECODE_HEADER_BYTES)
            with wave.open(str(normalized), "rb") as audio:
                self.assertEqual(audio.getnframes(), 800)

    def test_playlist_reference_cannot_reach_loopback_listener(self) -> None:
        """Отклонить HLS/playlist demuxer без обращения к вложенному URL."""
        requested = Event()

        class SentinelHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                requested.set()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"not audio")

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), SentinelHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                playlist = Path(directory) / "hostile.m3u8"
                port = server.server_address[1]
                playlist.write_text(
                    f"#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:{port}/referenced.wav\n#EXT-X-ENDLIST\n",
                    encoding="ascii",
                )
                with self.assertRaises(runner.RpcFault):
                    runner._audio_duration(playlist, 60.0)
            self.assertFalse(requested.wait(0.2), "ffprobe requested a playlist reference")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
