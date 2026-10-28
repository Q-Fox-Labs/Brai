# ABOUTME: Проверяет отображение перегрузки в Telegram через патч движка.
# ABOUTME: Проверяет сохранение предупреждения и диагностики без раскрытия исходного текста.

import ast
import logging
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PATCH = Path(__file__).resolve().parents[1] / "patches/russian-failure-notice.patch"


def patched_source(path):
    text = PATCH.read_text().split(f"diff --git a/{path} b/{path}\n", 1)[1]
    text = text.split("\ndiff --git ", 1)[0]
    return "\n".join(line[1:] for line in text.splitlines()
                     if line.startswith("+") and not line.startswith("+++"))


class FailureNoticeTest(unittest.TestCase):
    def test_overload_hides_provider_and_keeps_partial_warning(self):
        module = types.ModuleType("gateway.russian_failure_notice")
        exec(patched_source("gateway/russian_failure_notice.py"), module.__dict__)
        logger = logging.getLogger("failure-test")
        original = "ChatGPT or Codex Subscription overloaded. hermes fallback add"
        with self.assertLogs(logger, "WARNING") as records:
            text = module.explain_failure(original, surface={"code": "overloaded", "layer": "provider"},
                diagnostic="provider diagnostic", logger=logger, redact=lambda value: value, partial=True)
        self.assertIn("Сервис временно недоступен", text)
        self.assertIn("Некоторые действия могли уже выполниться", text)
        self.assertNotIn("ChatGPT", text)
        self.assertNotIn("Codex", text)
        self.assertNotIn("hermes", text)
        self.assertIn("provider diagnostic", records.output[0])

    def test_other_errors_keep_original(self):
        module = types.ModuleType("gateway.russian_failure_notice")
        exec(patched_source("gateway/russian_failure_notice.py"), module.__dict__)
        text = module.explain_failure("original detail", surface={"code": "auth", "layer": "auth"},
            diagnostic="", logger=logging.getLogger("failure-test"), redact=lambda value: value)
        self.assertIn("original detail", text)

    def test_telegram_overload_is_handled_when_language_is_not_russian(self):
        module = types.ModuleType("gateway.russian_failure_notice")
        exec(patched_source("gateway/russian_failure_notice.py"), module.__dict__)
        lines = PATCH.read_text().splitlines()
        start = next(i for i, line in enumerate(lines) if line.startswith("+def _telegram_failure_explanation"))
        body = []
        for line in lines[start:]:
            if not line.startswith("+"):
                break
            body.append(line[1:])
        code = ast.parse("\n".join(body))
        function = next(node for node in code.body if isinstance(node, ast.FunctionDef)
                        and node.name == "_telegram_failure_explanation")
        scope = {"logger": logging.getLogger("failure-test"), "PARTIAL_FAILED_TURN_NOTICE": "partial"}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), "<patch>", "exec"), scope)
        fake_run = types.SimpleNamespace(_gateway_platform_value=lambda value: value,
            _redact_gateway_user_facing_secrets=lambda value: value)
        surface = types.SimpleNamespace(build_error_surface_from_result=lambda result: {"code": "overloaded", "layer": "provider"},
            build_error_surface_from_exception=lambda exception: None)
        fake_modules = {"gateway.run": fake_run, "gateway.russian_failure_notice": module,
            "agent.i18n": types.SimpleNamespace(get_language=lambda: "en"), "agent.error_surface": surface}
        with patch.dict("sys.modules", fake_modules):
            text = scope["_telegram_failure_explanation"]("Codex hermes fallback add",
                types.SimpleNamespace(platform="telegram"), result={"error": "overloaded"},
                failure_notice=lambda result: "partial")
        self.assertIn("Сервис временно недоступен", text)
        self.assertIn("Некоторые действия могли уже выполниться", text)
        self.assertNotIn("Codex", text)
        self.assertNotIn("hermes", text)


if __name__ == "__main__":
    unittest.main()
