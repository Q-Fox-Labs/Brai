# ABOUTME: Проверяет настройки GIF, подписочный маршрут и нативный формат ответа.
# ABOUTME: Использует временный профиль, подмену HTTP и генератора без сети и ключей.
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/context_gif.py'
SPEC = importlib.util.spec_from_file_location('context_gif', SCRIPT)
GIF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GIF)


def animation():
    """Двухкадровая GIF с самостоятельными LZW-блоками."""
    header = bytes.fromhex('47494638396101000100800000000000ffffff')
    frame = bytes.fromhex('21f904000a0000002c0000000001000100000202440100')
    return header + frame + frame + b';'


class ContextGifTests(unittest.TestCase):
    def setUp(self):
        """Создать отдельный пустой профиль для каждой проверки."""
        (ROOT / 'tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)

    def test_off_survives_restart_and_once_does_not_enable(self):
        calls = []
        generate = lambda *args: calls.append(args) or {'success': True}
        self.assertEqual(GIF.run(self.home, 'telegram:user:1', 'status')['mode'], 'rare')
        GIF.run(self.home, 'telegram:user:1', 'off')
        self.assertEqual(GIF.run(self.home, 'telegram:user:1', 'auto', 'кот', generate)['skipped'], 'disabled')
        self.assertTrue(GIF.run(self.home, 'telegram:user:1', 'once', 'кот', generate)['success'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(GIF.run(self.home, 'telegram:user:1', 'status')['mode'], 'off')
        self.assertEqual(GIF.run(self.home, 'telegram:user:2', 'status')['mode'], 'rare')
        GIF.run(self.home, 'telegram:user:1', 'rare')
        for _ in range(5):
            GIF.run(self.home, 'telegram:user:1', 'auto', 'кот', generate)
        self.assertEqual(len(calls), 6)

    def test_parallel_generation_is_skipped(self):
        def generate(*args):
            with self.assertRaises(BlockingIOError):
                GIF.run(self.home, 'same', 'auto', 'кот', lambda *args: None)
            return {'success': True}
        self.assertTrue(GIF.run(self.home, 'same', 'once', 'кот', generate)['success'])

    def test_invalid_state_fails_closed(self):
        GIF.run(self.home, 'same', 'off')
        path = next(self.home.rglob('*.json'))
        path.write_text('broken')
        with self.assertRaises(json.JSONDecodeError):
            GIF.run(self.home, 'same', 'auto', 'кот', lambda *args: self.fail('generated'))

    def test_gif_parser_rejects_static_fake_and_truncated_files(self):
        self.assertEqual(GIF.gif_frames(animation()), 2)
        for raw in (b'PNG', animation()[:-1], animation()[:20],
                    animation()[:19] + b';', animation() + b'extra'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                GIF.gif_frames(raw)

    def native(self, configured='openai-codex', raw=None, status_error=None):
        """Подменить транспорт, сохранив настоящий разбор запроса и ответа."""
        import base64
        self.requests = []
        encoded = base64.b64encode(animation() if raw is None else raw).decode()
        class Response:
            def __enter__(inner):
                return inner
            def __exit__(inner, *args):
                pass
            def raise_for_status(inner):
                if status_error:
                    raise status_error
            def iter_bytes(inner):
                yield json.dumps({'data': [{'b64_json': encoded}]}).encode()
        class Client:
            def __init__(inner, **kwargs):
                self.client_options = kwargs
            def __enter__(inner):
                return inner
            def __exit__(inner, *args):
                pass
            def stream(inner, *args, **kwargs):
                self.requests.append((args, kwargs))
                return Response()
        provider = SimpleNamespace(is_available=lambda: True)
        backend = SimpleNamespace(
            _read_codex_credential=lambda: ('test-credential', 'https://chatgpt.com/backend-api/codex'),
            _build_image_request=lambda **kwargs: ('images/generations', {'model': 'server-alias', **kwargs}))
        modules = {
            'tools.image_generation_tool': SimpleNamespace(_get_plugin_provider=lambda name: provider),
            'plugins.image_gen._common': SimpleNamespace(load_image_gen_config=lambda: {'provider': configured}),
            'agent.codex_headers': SimpleNamespace(codex_cloudflare_headers=lambda *args, **kwargs: {}),
            'httpx': SimpleNamespace(Client=Client, Timeout=lambda *args, **kwargs: None),
        }
        with patch.dict(sys.modules, modules), patch.object(GIF.importlib, 'import_module', return_value=backend):
            return GIF.native_generate(self.home, 'кот машет лапой')

    def test_native_subscription_request_and_exact_response_bytes(self):
        result = self.native()
        self.assertEqual(result['method'], 'native-gif')
        self.assertEqual(Path(result['image']).read_bytes(), animation())
        body = self.requests[0][1]['json']
        self.assertEqual((body['output_format'], body['frame_count'], body['frame_duration_ms']), ('gif', 9, 200))
        self.assertEqual((body['size'], body['quality']), ('auto', 'auto'))
        self.assertNotIn('sprite', body['prompt'])
        self.assertFalse(result['published'])

    def test_no_api_fallback(self):
        with self.assertRaisesRegex(ValueError, 'CODEX_SUBSCRIPTION_REQUIRED'):
            self.native(configured='openai')
        self.assertEqual(self.requests, [])

    def test_static_response_is_rejected_without_file(self):
        with self.assertRaises(ValueError):
            self.native(raw=b'PNG')
        self.assertFalse(list(self.home.rglob('*.gif')))

    def test_http_error_is_not_retried(self):
        with self.assertRaises(RuntimeError):
            self.native(status_error=RuntimeError('quota'))
        self.assertEqual(len(self.requests), 1)

    def api_settings(self):
        """Настроить только GIF на фиктивный ключ; native-профиль не менять."""
        key = self.home / 'gif-test.key'
        key.write_text('not-a-real-key')
        key.chmod(0o400)
        (self.home / 'context-gifs.json').write_text(json.dumps({'provider': 'openai', 'key_file': str(key)}))
        return key

    def test_only_gif_uses_api_with_explicit_configuration(self):
        self.api_settings()
        result = self.native()
        self.assertEqual(result['provider'], 'openai')
        self.assertEqual(result['model'], 'gpt-image-2.6-flare')
        self.assertEqual(self.requests[0][0][1], 'https://api.openai.com/v1/images/generations')
        body = self.requests[0][1]['json']
        self.assertEqual((body['output_format'], body['quality'], body['complexity']), ('gif', 'low', 'low'))
        self.assertEqual(Path(result['image']).read_bytes(), animation())
        self.assertEqual(self.client_options['headers']['Authorization'], 'Bearer not-a-real-key')

    def test_personal_worker_uses_shared_route_without_reading_a_key(self):
        with patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'):
            result = self.native()
        self.assertEqual(result['provider'], 'openai')
        self.assertEqual(self.requests[0][0][1], 'http://127.0.0.1:18080/gif/v1/images/generations')
        self.assertNotIn('Authorization', self.client_options['headers'])
        self.assertFalse((self.home / 'context-gifs.json').exists())
        self.assertEqual(Path(result['image']).read_bytes(), animation())

    def test_api_error_does_not_fall_back_to_subscription(self):
        self.api_settings()
        with self.assertRaises(RuntimeError):
            self.native(status_error=RuntimeError('quota'))
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][0][1], 'https://api.openai.com/v1/images/generations')

    def test_api_rejects_unprotected_secret(self):
        key = self.api_settings()
        key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'GIF_API_KEY_FILE_UNSAFE'):
            self.native()
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
