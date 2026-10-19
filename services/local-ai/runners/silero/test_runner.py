# ABOUTME: Проверяет закрытый RPC и lifecycle файлов Silero без настоящих весов и PyTorch.
# ABOUTME: Подменяет модель и ffmpeg; проверяет ошибки, Unicode, пакетные запросы и уведомления.

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import runner


class FakeModel:
    """Запомнить параметры синтеза и вернуть непрозрачный тестовый tensor."""

    speakers = ["eugene", "xenia"]

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def apply_tts(self, **kwargs: object) -> object:
        """Отметить ровно одно вычисление модели."""
        self.calls.append(kwargs)
        return object()


class RpcTests(unittest.TestCase):
    """Проверить протокол через bytes-вход без загрузки аудиозависимостей."""

    def setUp(self) -> None:
        """Создать маленький метод с наблюдаемыми побочными эффектами."""
        self.calls = []

        def method(params: dict) -> dict:
            self.calls.append(params)
            if params:
                raise runner.InvalidParams()
            return {"ready": True}

        self.methods = {"health": method}

    def request(self, value: object) -> object:
        """Выполнить сериализуемый запрос и разобрать ответ либо отсутствие строки."""
        answer = runner.process_line(json.dumps(value).encode(), self.methods)
        return None if answer is None else json.loads(answer)

    def test_ids_and_closed_response(self) -> None:
        """Сохранить допустимые id; успех не содержит error."""
        for request_id in ["rpc-1", 12, 1.5, None, "\ud800"]:
            with self.subTest(request_id=repr(request_id)):
                self.assertEqual(self.request({"jsonrpc": "2.0", "id": request_id, "method": "health"}),
                                 {"jsonrpc": "2.0", "id": request_id, "result": {"ready": True}})

    def test_invalid_envelopes(self) -> None:
        """Нераспознанные конверты возвращают Invalid Request и id null."""
        valid = {"jsonrpc": "2.0", "id": "x", "method": "health"}
        cases = [[], None, 3, "text", {}, {**valid, "extra": 1},
                 {**valid, "jsonrpc": "1.0"}, {**valid, "method": 3}]
        cases += [{**valid, "id": invalid_id} for invalid_id in [True, [], {}]]
        for value in cases:
            with self.subTest(value=value):
                result = self.request(value)
                self.assertEqual(result["error"]["code"], -32600)
                self.assertIsNone(result["id"])
                self.assertNotIn("result", result)
        self.assertEqual(self.calls, [])

    def test_parse_errors_and_safe_output(self) -> None:
        """Отбросить не-JSON, повтор ключа и неправильный UTF-8 без исходного ввода."""
        for line in [b"{private text", b"\xff", b'{"id":1,"id":2}', b"NaN", b"Infinity",
                     b"[" * 2000, b" " * (runner.MAX_LINE_BYTES + 1)]:
            result = json.loads(runner.process_line(line, self.methods))
            self.assertEqual(result, {"jsonrpc": "2.0", "id": None,
                                      "error": {"code": -32700, "message": "Parse error"}})

    def test_method_and_params_errors_preserve_id(self) -> None:
        """Сохранить id для распознанного запроса с неверным методом или параметрами."""
        for method, params, expected in [("missing", {}, -32601), ("health", [], -32602),
                                         ("health", {"extra": 1}, -32602), ("health", None, -32602)]:
            result = self.request({"jsonrpc": "2.0", "id": "known", "method": method, "params": params})
            self.assertEqual(result["id"], "known")
            self.assertEqual(result["error"]["code"], expected)
            self.assertNotIn("result", result)

    def test_notification_and_batch_order(self) -> None:
        """Исполнить уведомление, но выдать ответы только на запросы и невалидный элемент."""
        self.assertIsNone(self.request({"jsonrpc": "2.0", "method": "health"}))
        self.assertEqual(self.calls, [{}])
        result = self.request([
            {"jsonrpc": "2.0", "method": "health"},
            {"jsonrpc": "2.0", "id": "first", "method": "health"},
            {"jsonrpc": "2.0", "method": "missing"},
            4,
            {"jsonrpc": "2.0", "id": "last", "method": "health", "params": []},
        ])
        self.assertEqual([entry["id"] for entry in result], ["first", None, "last"])
        self.assertEqual(result[1]["error"]["code"], -32600)
        self.assertEqual(result[2]["error"]["code"], -32602)
        self.assertEqual(self.calls, [{}, {}, {}])

    def test_all_notification_batch_and_failed_notification(self) -> None:
        """Даже ошибочное уведомление не создаёт строку ответа."""
        self.assertIsNone(self.request([
            {"jsonrpc": "2.0", "method": "health"},
            {"jsonrpc": "2.0", "method": "health", "params": [1]},
            {"jsonrpc": "2.0", "method": "health", "params": {"extra": 1}},
        ]))
        self.assertEqual(self.calls, [{}, {"extra": 1}])

    def test_serve_discards_entire_oversized_line_then_resumes(self) -> None:
        """Не интерпретировать хвост длинного документа как новый запрос."""
        valid = b'{"jsonrpc":"2.0","id":"after","method":"health"}\n'
        source = io.BytesIO(b" " * (runner.MAX_LINE_BYTES * 3) + valid + valid)
        target = io.BytesIO()
        runner.serve(source, target, self.methods)
        answers = [json.loads(line) for line in target.getvalue().splitlines()]
        self.assertEqual(len(answers), 2)
        self.assertEqual(answers[0]["error"]["code"], -32700)
        self.assertEqual(answers[1]["id"], "after")
        self.assertEqual(self.calls, [{}])


class SynthesisTests(unittest.TestCase):
    """Проверить модель, кодировщик и очистку через реальный файловый каталог."""

    def setUp(self) -> None:
        """Собрать независимый runner с фальшивыми внешними операциями."""
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.model = FakeModel()
        self.encodes: list[tuple] = []
        self.writes: list[Path] = []

        def write_wave(audio: object, path: Path) -> None:
            self.writes.append(path)
            path.write_bytes(b"fake wave")

        def encode(args: list[str], **kwargs: object) -> None:
            self.encodes.append((args, kwargs))
            Path(args[-1]).write_bytes(b"OggSfake encoded audio")

        self.encoder = encode
        self.runtime = runner.SileroRunner(
            self.model, SimpleNamespace(inference_mode=contextlib.nullcontext), self.directory,
            "/usr/bin/ffmpeg", run=encode, write_wave=write_wave,
        )

    def rpc(self, params: object) -> dict:
        """Выполнить synthesize через внешний RPC-контракт."""
        return json.loads(runner.process_line(json.dumps({"jsonrpc": "2.0", "id": "synth", "method": "synthesize",
                                                         "params": params}).encode(),
                                               {"synthesize": self.runtime.synthesize}))

    def test_health_confirms_pinned_voice_and_revision(self) -> None:
        """Готовность доступна только модели с обязательным голосом."""
        self.assertEqual(self.runtime.health({}), {"ready": True, "model_id": runner.MODEL_ID, "revision": runner.MODEL_REVISION})
        with self.assertRaises(runner.InvalidParams):
            self.runtime.health({"extra": 1})
        with self.assertRaises(ValueError):
            runner.SileroRunner(SimpleNamespace(speakers=["xenia"], apply_tts=lambda **kw: None),
                                None, self.directory, "/usr/bin/ffmpeg")

    def test_success_uses_fixed_path_and_safe_ffmpeg(self) -> None:
        """Передать модели исходный текст, закодировать локальный WAV и оставить только Ogg."""
        text = "  Привет, мир! 😀  "
        result = self.rpc({"text": text, "voice": "eugene"})
        self.assertEqual(result["result"], {"audio_path": str(self.directory / "audio.ogg"), "mime_type": "audio/ogg"})
        self.assertEqual(self.model.calls, [{"text": text, "speaker": "eugene", "sample_rate": 48000}])
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["audio.ogg"])
        self.assertFalse(self.writes[0].exists())
        args, kwargs = self.encodes[0]
        for name, value in [("-protocol_whitelist", "file"), ("-format_whitelist", "wav"),
                            ("-c:a", "libopus"), ("-ac", "1"), ("-ar", "48000"), ("-b:a", "32k")]:
            self.assertEqual(args[args.index(name) + 1], value)
        self.assertIn("-nostdin", args)
        self.assertNotIn(text, args)
        self.assertEqual(kwargs, {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                                  "stderr": subprocess.DEVNULL, "check": True, "timeout": 180})

    def test_validation_covers_unicode_boundaries_and_closed_fields(self) -> None:
        """Невалидный ввод не вызывает модель или кодировщик."""
        invalid = [{}, {"text": "x"}, {"text": "x", "voice": "xenia"},
                   {"text": "x", "voice": "eugene", "audio_path": "/tmp/requested"}]
        invalid += [{"text": value, "voice": "eugene"} for value in
                    ["", " \t\r\n", "\u00a0", "a" * 901, "😀" * 901, "a\0b", "\ud800", "\udfff", None, 5, []]]
        for params in invalid:
            with self.subTest(params=repr(params)):
                self.assertEqual(self.rpc(params)["error"]["code"], -32602)
        self.assertEqual(self.model.calls, [])
        self.assertEqual(self.encodes, [])
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertIn("result", self.rpc({"text": "😀" * 900, "voice": "eugene"}))

    def test_ffmpeg_failures_remove_previous_and_temporary_files(self) -> None:
        """Сбой или timeout не оставляет старый успех и не раскрывает детали."""
        failures = [subprocess.CalledProcessError(1, ["private-path"], stderr=b"private text"),
                    subprocess.TimeoutExpired("private command", 180), OSError("private-path")]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                (self.directory / "audio.ogg").write_bytes(b"old output")

                def fail(args: list[str], **kwargs: object) -> None:
                    Path(args[-1]).write_bytes(b"partial")
                    raise failure

                self.runtime.run = fail
                result = self.rpc({"text": "private text", "voice": "eugene"})
                self.assertEqual(result, {"jsonrpc": "2.0", "id": "synth", "error": {"code": -32603, "message": "Internal error"}})
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_model_and_writer_failures_are_safe_and_clean(self) -> None:
        """Ошибки вычисления и WAV не достигают кодировщика и очищают каталог."""
        for target in ["model", "writer"]:
            with self.subTest(target=target):
                with contextlib.ExitStack() as stack:
                    if target == "model":
                        stack.enter_context(patch.object(self.model, "apply_tts", side_effect=RuntimeError("private text")))
                    else:
                        stack.enter_context(patch.object(self.runtime, "write_wave", side_effect=OSError("private-path")))
                    self.assertEqual(self.rpc({"text": "x", "voice": "eugene"})["error"]["code"], -32603)
                self.assertEqual(list(self.directory.iterdir()), [])
        self.assertEqual(self.encodes, [])

    def test_invalid_and_oversized_encoded_output_is_rejected(self) -> None:
        """Не вернуть повреждённый или слишком большой результат кодировщика."""
        for content in [b"", b"invalid"]:
            self.runtime.run = lambda args, **kw: Path(args[-1]).write_bytes(content)
            self.assertEqual(self.rpc({"text": "x", "voice": "eugene"})["error"]["code"], -32603)
            self.assertEqual(list(self.directory.iterdir()), [])

        def large_file(args: list[str], **kwargs: object) -> None:
            with Path(args[-1]).open("wb") as output:
                output.write(b"OggS")
                output.truncate(runner.MAX_OUTPUT_BYTES + 1)

        self.runtime.run = large_file
        self.assertEqual(self.rpc({"text": "x", "voice": "eugene"})["error"]["code"], -32603)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_next_synthesis_replaces_output_and_symlink_does_not_escape(self) -> None:
        """Удалить старую ссылку, не меняя её цель за пределами фиксированного пути."""
        outside = self.directory / "untouched"
        outside.write_bytes(b"original")
        (self.directory / "audio.ogg").symlink_to(outside)
        self.rpc({"text": "first", "voice": "eugene"})
        self.assertEqual(outside.read_bytes(), b"original")
        self.assertFalse((self.directory / "audio.ogg").is_symlink())
        self.rpc({"text": "second", "voice": "eugene"})
        self.assertEqual(len(self.model.calls), 2)
        self.assertEqual((self.directory / "audio.ogg").read_bytes(), b"OggSfake encoded audio")

    def test_notification_synthesizes_without_response(self) -> None:
        """Уведомление имеет такой же побочный эффект, как обычный синтез."""
        self.assertIsNone(runner.process_line(
            b'{"jsonrpc":"2.0","method":"synthesize","params":{"text":"hello","voice":"eugene"}}',
            {"synthesize": self.runtime.synthesize}))
        self.assertEqual(len(self.model.calls), 1)
        self.assertTrue((self.directory / "audio.ogg").is_file())


class ProfileTests(unittest.TestCase):
    """Согласовать профиль, CLI и машинный контракт без сторонних библиотек."""

    def test_profile_agrees_with_arguments_and_pins(self) -> None:
        """Разобрать аргументы профиля тем же parser, что использует runtime."""
        path = Path(__file__).resolve().parents[2] / "profiles" / "silero_pytorch.json"
        profile = json.loads(path.read_text())
        substitutions = {"modelPath": "/private/model", "revision": runner.MODEL_REVISION, "threads": "4",
                         "outputDirectory": "/private/output", "ffmpegExecutable": "/usr/bin/ffmpeg"}
        args = [substitutions.get(arg[2:-2], arg) if arg.startswith("{{") else arg for arg in profile["engine"]["args"][1:]]
        parsed = runner._arguments(args)
        self.assertEqual(parsed.revision, runner.MODEL_REVISION)
        self.assertEqual(len(runner.MODEL_REVISION), 40)
        self.assertTrue(runner.MODEL_SHA256.startswith(runner.MODEL_REVISION))
        self.assertEqual(profile["source"]["revision"], runner.MODEL_REVISION)
        self.assertEqual(profile["source"]["files"][0]["sha256"], runner.MODEL_SHA256)
        self.assertEqual(profile["source"]["files"][0]["bytes"], runner.MODEL_BYTES)
        self.assertEqual(profile["source"]["files"][0]["path"], runner.MODEL_FILE)
        self.assertEqual(profile["limits"]["maximumTextCodepoints"], runner.MAX_TEXT_CODEPOINTS)
        self.assertEqual(profile["limits"]["maximumOutputBytes"], runner.MAX_OUTPUT_BYTES)

    def test_openrpc_refs_resolve_and_objects_are_closed(self) -> None:
        """Проверить локальные ссылки и закрытые схемы фактических операций."""
        directory = Path(__file__).parent
        rpc = json.loads((directory / "openrpc.json").read_text())
        schemas = json.loads((directory / "schemas.json").read_text())
        self.assertEqual({method["name"] for method in rpc["methods"]}, {"health", "synthesize"})

        def visit(value: object) -> None:
            if isinstance(value, list):
                for item in value:
                    visit(item)
            elif isinstance(value, dict):
                if "$ref" in value:
                    filename, pointer = value["$ref"].split("#")
                    self.assertEqual(filename, "schemas.json")
                    resolved = schemas
                    for segment in pointer.strip("/").split("/"):
                        resolved = resolved[segment]
                for item in value.values():
                    visit(item)

        visit(rpc)
        for schema in schemas["definitions"].values():
            self.assertIs(schema["additionalProperties"], False)

    def test_cli_rejects_unpinned_revision_threads_and_relative_executable(self) -> None:
        """Не запускать модель с неоговорёнными параметрами окружения."""
        base = ["--model-path", "/model", "--revision", runner.MODEL_REVISION,
                "--threads", "4", "--output-directory", "/output", "--ffmpeg", "/usr/bin/ffmpeg"]
        for flag, value in [("--revision", "untrusted"), ("--threads", "8"), ("--ffmpeg", "ffmpeg")]:
            args = base.copy()
            args[args.index(flag) + 1] = value
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                runner._arguments(args)
        with self.assertRaises(ValueError):
            runner._arguments(base + ["--unknown", "private"])

    def test_loader_rejects_invalid_weights_before_importing_torch(self) -> None:
        """Недоверенный файл не попадает в PackageImporter."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / runner.MODEL_FILE).write_bytes(b"untrusted pickle")
            with patch.dict("sys.modules", {"torch": None}):
                with self.assertRaises(ValueError):
                    runner._load_model(path, 4)
                with patch.object(runner, "MODEL_BYTES", (path / runner.MODEL_FILE).stat().st_size):
                    with self.assertRaises(ValueError):
                        runner._load_model(path, 4)


if __name__ == "__main__":
    unittest.main()
