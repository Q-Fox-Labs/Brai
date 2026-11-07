# ABOUTME: Проверяет личный STT через broker без настоящей модели и Telegram.
# ABOUTME: Проверяет одну попытку, привязку результата и сохранность output при отказе.
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.profiles import stt_config
from identity.transcribe import transcribe_file

MODEL = {'modelId': 'selected-model', 'revision': 'selected-revision', 'profileId': 'selected-profile'}
AID = '11111111-1111-4111-8111-111111111111'


class TranscriptionTests(unittest.TestCase):
    """Проверить результат command provider и его границы."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'voice.ogg'
        self.source.write_bytes(b'OggSfixture')
        self.output = Path(self.temp.name) / 'transcript.txt'
        self.calls = []

    def call(self, method, params, **kwargs):
        self.calls.append((method, params, kwargs))
        if method == 'files.publish':
            return {'artifactId': AID, 'mimeType': 'audio/ogg'}
        args = params['args']
        return {'requestId': args['requestId'], 'operationId': args['operationId'],
                'model': MODEL, 'text': 'Проверка голоса.\nТочные слова.'}

    def test_exact_text_and_ids_without_owner_credentials_or_repeat(self):
        transcribe_file(self.source, self.output, MODEL, call=self.call)
        self.assertEqual(self.output.read_text(), 'Проверка голоса.\nТочные слова.')
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual([m for m, _, _ in self.calls], ['files.publish', 'tools.call'])
        args = self.calls[1][1]['args']
        self.assertEqual(args['audioArtifactId'], AID)
        self.assertEqual(args['model'], MODEL)
        self.assertNotEqual(args['requestId'], args['operationId'])
        self.assertNotIn('ownerId', args)
        self.assertNotIn('token', json.dumps(self.calls))
        self.assertGreater(self.calls[0][2]['timeout'], self.calls[1][2]['timeout'])

    def test_native_ingest_artifact_is_owner_checked_without_another_upload(self):
        source = Path(self.temp.name) / 'results' / AID / 'voice.ogg'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'OggSfixture')
        def fetched(method, params, **kwargs):
            if method == 'files.fetch':
                self.calls.append((method, params, kwargs))
                return {'artifactId': AID, 'mimeType': 'audio/ogg', 'localPath': str(source)}
            return self.call(method, params, **kwargs)
        with patch.dict(os.environ, {'HERMES_HOME': self.temp.name}):
            transcribe_file(source, self.output, MODEL, call=fetched)
        self.assertEqual([m for m, _, _ in self.calls], ['files.fetch', 'tools.call'])
        self.assertEqual(self.calls[1][1]['args']['audioArtifactId'], AID)

    def test_unknown_invoke_never_retries_or_creates_output(self):
        def fail(method, params, **kwargs):
            if method == 'tools.call':
                self.calls.append((method, params, kwargs))
                raise TimeoutError('unknown')
            return self.call(method, params, **kwargs)
        with self.assertRaises(TimeoutError):
            transcribe_file(self.source, self.output, MODEL, call=fail)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(self.output.exists())

    def test_mismatched_response_and_broker_denial_never_create_output(self):
        for field, value in [('requestId', 'wrong'), ('operationId', 'wrong'), ('model', {}),
                             ('text', ''), ('text', ' '), ('text', None)]:
            def changed(method, params, **kwargs):
                result = self.call(method, params, **kwargs)
                if method == 'tools.call':
                    result[field] = value
                return result
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                transcribe_file(self.source, self.output, MODEL, call=changed)
            self.assertFalse(self.output.exists())
        with self.assertRaises(PermissionError):
            transcribe_file(self.source, self.output, MODEL,
                            call=lambda *a, **k: (_ for _ in ()).throw(PermissionError('denied')))
        with self.assertRaises(ValueError):
            transcribe_file(self.source, self.output, MODEL,
                            call=lambda *a, **k: {'artifactId': AID, 'mimeType': 'text/plain'})

    def test_existing_file_and_symlink_are_not_overwritten(self):
        self.output.write_text('keep')
        with self.assertRaises(ValueError):
            transcribe_file(self.source, self.output, MODEL, call=self.call)
        self.assertEqual(self.output.read_text(), 'keep')
        self.output.unlink()
        self.output.symlink_to(self.source)
        with self.assertRaises(ValueError):
            transcribe_file(self.source, self.output, MODEL, call=self.call)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.source.read_bytes(), b'OggSfixture')

    def test_shared_deadline_prevents_invoke_after_slow_publication(self):
        with patch('identity.transcribe.time.monotonic', side_effect=[0, 0, 181]):
            with self.assertRaises(TimeoutError):
                transcribe_file(self.source, self.output, MODEL, call=self.call)
        self.assertEqual([m for m, _, _ in self.calls], ['files.publish'])

    def test_native_command_uses_explicit_selector_and_no_stt_defaults(self):
        self.assertEqual(stt_config(None), {'enabled': False})
        cfg = stt_config(MODEL)
        self.assertTrue(cfg['enabled'])
        self.assertEqual(cfg['provider'], 'brai_local_ai')
        provider = cfg['providers']['brai_local_ai']
        argv = shlex.split(provider['command'])
        self.assertIn('identity.transcribe', argv)
        for flag, key in [('model-id', 'modelId'), ('revision', 'revision'), ('profile-id', 'profileId')]:
            self.assertEqual(argv[argv.index('--' + flag) + 1], MODEL[key])
        self.assertEqual(provider['timeout'], 200)
        self.assertFalse(provider['normalize'])
        with self.assertRaises(ValueError):
            stt_config({'modelId': 'incomplete'})


if __name__ == '__main__':
    unittest.main()
