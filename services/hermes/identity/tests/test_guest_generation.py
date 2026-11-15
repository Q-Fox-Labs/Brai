# ABOUTME: Tests the installed SDK producer seams with local fake producers.
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.guest_generation import install, trusted_silero


def sdk_function(root, file, names, namespace):
    """Execute the selected unmodified SDK functions with dependency stubs."""
    tree = ast.parse((root / file).read_text())
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != set(names):
        raise AssertionError('SDK seam changed')
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)] + selected, type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(root / file), 'exec'), namespace)


@unittest.skipUnless(os.environ.get('BRAI_ENGINE_TEST_ROOT'), 'BRAI_ENGINE_TEST_ROOT required')
class GuestBindingsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        engine = Path(os.environ['BRAI_ENGINE_TEST_ROOT'])
        self.user_role, self.name, self.mode = 'guest', 'image_generate', 'normal'
        self.calls, self.issued, self.artifacts = [], {}, {}
        agent = types.ModuleType('agent')
        provider = types.ModuleType('agent.provider_media')
        provider.__dict__.update(Path=Path, base64=base64, cache_path=lambda *a: self.root / 'ordinary.png')
        sdk_function(engine, 'agent/provider_media.py', ['save_bytes', 'save_b64'], provider.__dict__)
        provider.save_url = lambda *a, **k: 'ordinary-url'
        agent.provider_media = provider
        toolpkg = types.ModuleType('tools')
        tts = types.ModuleType('tools.tts_tool')
        class Logger:
            def info(self, *a, **k): pass
        def produce(text, path, provider, config, settings):
            Path(path).write_bytes(b'OggS-fake')
            return path if self.mode != 'tts_redirect' else str(self.root / 'other.ogg')
        tts.__dict__.update(os=os, json=json, logger=Logger(), BUILTIN_TTS_PROVIDERS=set(),
            _generate_command_tts=produce, _repair_ogg_container=lambda x: x,
            _finalize_voice_delivery=lambda path, *a: (path, True),
            _media_tag=lambda paths, voice: '\n'.join('MEDIA:' + p for p in paths),
            _tool_failure=lambda *args: json.dumps({'success': False}),
            _error_json=lambda error: json.dumps({'success': False, 'error': error}))
        sdk_function(engine, 'tools/tts_tool.py', ['_text_to_speech_single', '_synthesize_chunks', 'text_to_speech_tool'], tts.__dict__)
        tts.__dict__.update(Path=Path, _ChunkFailed=type('_ChunkFailed', (Exception,), {}),
            _load_tts_config=lambda: {}, _apply_call_overrides=lambda config, speed, provider: (config, 'silero'),
            _resolve_command_provider_config=lambda provider, config: self.config,
            _resolve_max_text_length=lambda *a: 900,
            _split_text_for_tts=lambda text, limit: [text[i:i+limit] for i in range(0, len(text), limit)],
            _session_platform=lambda: ('telegram', True), _resolve_audio_delivery_profile=lambda *a: types.SimpleNamespace(platform='telegram', max_file_bytes=1000, target_file_bytes=900),
            _build_audio_delivery_files=lambda paths, *a, **k: (paths, False), _remove_quietly=lambda p: None)
        tts._resolve_output_base = lambda *a: (self.root / 'ordinary.ogg', None)
        browser = types.ModuleType('tools.browser_tool')
        def run(task, command, args, **kwargs):
            path = args[-1]
            Path(path).write_bytes(b'png screenshot')
            data = {} if self.mode == 'no_receipt' else {'path': path}
            if self.mode == 'browser_redirect': data['path'] = str(self.root / 'foreign.png')
            return {'success': True, 'data': data}
        session = types.SimpleNamespace(sandbox_screenshot_path=lambda path: None, _run_browser_command=run)
        cloud = types.SimpleNamespace(_get_browser_engine=lambda: 'chrome', _get_cloud_provider=lambda: None)
        vision = types.SimpleNamespace(_cloud=cloud, _vision_mode_label=lambda: 'local',
                                      _lightpanda_vision_preroute=lambda *a: ('ordinary', None, a[2]))
        browser.__dict__.update(Path=Path, _session=session, _vision=vision, _LP_VISION_FALLBACK_REASON='',
                                _json_with_fallback=lambda x, y: x, _err=lambda x: x, _dumps=str)
        sdk_function(engine, 'tools/browser_tool.py', ['_capture_vision_screenshot'], browser.__dict__)
        toolpkg.tts_tool, toolpkg.browser_tool = tts, browser
        normalize = types.ModuleType('tools.tts_text_normalize')
        normalize.prepare_spoken_text = lambda text, max_chars=None: text.strip()
        self.provider, self.tts, self.browser = provider, tts, browser
        self.modules = patch.dict(sys.modules, {'agent': agent, 'agent.provider_media': provider,
            'tools': toolpkg, 'tools.tts_tool': tts, 'tools.browser_tool': browser,
            'tools.tts_text_normalize': normalize})
        self.modules.start()
        install(role=lambda: self.user_role, allowed=lambda name: self.name == name,
                operation=lambda: 'op', broker_call=self.broker, resolve_artifact=self.resolve,
                trusted_tts=trusted_silero('/opt/brai-profile/runtime'))
        self.config = {'type': 'command', 'command': 'PYTHONPATH=/opt/brai-profile/runtime/services/hermes /usr/bin/python3 '
                       '-s -P -B -m identity.synthesize --input {input_path} --output {output_path}',
                       'output_format': 'ogg', 'voice_compatible': True, 'timeout': 200, 'max_text_length': 900}

    def tearDown(self):
        self.modules.stop()
        self.temp.cleanup()

    def broker(self, method, params):
        self.calls.append((method, dict(params)))
        if method == 'generated.begin':
            ticket = str(len(self.issued))
            folder = self.root / ticket
            folder.mkdir()
            path = folder / {'image': 'image.png', 'audio': 'audio.ogg', 'screenshot': 'screenshot.png'}[params['kind']]
            self.issued[ticket] = path
            return {'ticket': ticket, 'path': str(path)}
        if method == 'generated.finish':
            raw = self.issued[params['ticket']].read_bytes()
            assert (len(raw), hashlib.sha256(raw).hexdigest()) == (params['sizeBytes'], params['sha256'])
            self.artifacts[params['ticket']] = raw
            return {'artifactId': params['ticket']}
        return {'aborted': True}

    def resolve(self, artifact_id, operation):
        assert operation == 'op'
        path = self.root / ('alias-' + artifact_id)
        path.write_bytes(self.artifacts[artifact_id])
        return {'localPath': str(path)}

    def test_image_save_b64_actual_seam(self):
        result = self.provider.save_b64('generated/images', base64.b64encode(b'png').decode(), prefix='x', extension='png')
        self.assertEqual(result.read_bytes(), b'png')
        with self.assertRaises(PermissionError): self.provider.save_url('url')
        self.user_role = 'user'
        self.assertEqual(self.provider.save_bytes('other', b'x', prefix='x', extension='x').read_bytes(), b'x')

    def test_tts_single_actual_seam_and_rejections(self):
        self.name = 'text_to_speech'
        self.assertTrue(trusted_silero('/opt/brai-profile/runtime')('silero', self.config))
        with self.assertRaises(PermissionError): self.tts._resolve_output_base('/tmp/out', 'silero', self.config, True)
        with self.assertRaises(PermissionError): self.tts._resolve_output_base(None, 'silero', {**self.config, 'command': 'evil'}, True)
        path, error = self.tts._resolve_output_base(None, 'silero', self.config, True)
        self.assertIsNone(error)
        result = json.loads(self.tts._text_to_speech_single('hello', str(path), provider='silero', tts_config={},
            command_provider_config=self.config, want_opus=True, instructions=None))
        self.assertEqual(Path(result['file_path']).read_bytes(), b'OggS-fake')
        self.assertIn(result['file_path'], result['media_tag'])
        path, _ = self.tts._resolve_output_base(None, 'silero', self.config, True)
        with self.assertRaises(PermissionError):
            self.tts._text_to_speech_single('x'*901, str(path), provider='silero', tts_config={},
                command_provider_config=self.config, want_opus=True, instructions=None)
        result = json.loads(self.tts.text_to_speech_tool('say hello'))
        self.assertEqual(Path(result['file_path']).read_bytes(), b'OggS-fake')
        self.assertEqual(result['chunk_count'], 1)
        before = len(self.calls)
        with self.assertRaises(PermissionError): self.tts.text_to_speech_tool('x'*901)
        self.assertEqual(len(self.calls), before)
        self.mode = 'tts_redirect'
        path, _ = self.tts._resolve_output_base(None, 'silero', self.config, True)
        with self.assertRaises(PermissionError):
            self.tts._text_to_speech_single('hello', str(path), provider='silero', tts_config={},
                command_provider_config=self.config, want_opus=True, instructions=None)

    def test_browser_actual_seam_and_receipts(self):
        self.name = 'browser_vision'
        self.mode = 'no_receipt'
        result, path, error = self.browser._capture_vision_screenshot('t', False, self.root / 'ignored', False)
        self.assertIsNone(error)
        self.assertEqual(path.read_bytes(), b'png screenshot')
        self.assertEqual(result['data']['path'], str(path))
        self.mode = 'browser_redirect'
        with self.assertRaises(PermissionError): self.browser._capture_vision_screenshot('t', False, self.root / 'ignored', False)
        self.browser._vision._cloud._get_browser_engine = lambda: 'lightpanda'
        with self.assertRaises(PermissionError): self.browser._vision._lightpanda_vision_preroute('t', False, self.root / 'ignored')

    def test_invocation_context_required(self):
        self.name = 'other'
        with self.assertRaises(PermissionError): self.provider.save_bytes('generated/images', b'x', prefix='x', extension='png')
