# ABOUTME: Проверяет сохранение безопасной причины STT через реальные Python RPC-порты.
# ABOUTME: Использует кадры в памяти и временное аудио; реальные профили и службы не затрагивает.
import asyncio
import contextlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity.broker import ControlPort, rpc_request
from identity.ipc import safe_failure
from identity.tool_client import broker_call
from identity.transcribe import transcribe_file

MODEL = {'modelId':'fixture','revision':'fixture','profileId':'fixture'}
AID = '11111111-1111-4111-8111-111111111111'


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_control_broker_client_preserve_only_safe_reason(self):
        reader = asyncio.StreamReader()
        reader.feed_data(json.dumps({'jsonrpc':'2.0','id':1,'error':{
            'code':-32603,'message':'secret audio and credentials',
            'data':{'reason':'OUTCOME_UNKNOWN','stage':'control','secret':'private'}}}).encode()+b'\n')
        reader.feed_eof()
        port = ControlPort(['unused'], 'unused')
        port.process = SimpleNamespace(stdout=reader)
        future = asyncio.get_running_loop().create_future()
        port.pending[1] = future
        await port.read()
        class Broker:
            async def call(self, uid, method, params):
                return await future
        request = {'jsonrpc':'2.0','id':'request','method':'tools.call',
            'params':{'name':'local_ai_invoke_transcribe','args':{}}}
        with contextlib.redirect_stderr(io.StringIO()):
            reply = await rpc_request(Broker(), 1001, request)
        self.assertEqual(reply['error']['data'], {'reason':'OUTCOME_UNKNOWN','stage':'control'})
        self.assertNotIn('secret', json.dumps(reply))
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.getsockopt.return_value = struct.pack('3i', 1, 0, 0)
        conn.sendall.side_effect = lambda raw: reply.update(id=json.loads(raw)['id'])
        conn.makefile.return_value.__enter__.return_value.readline.side_effect = (
            lambda size: json.dumps(reply).encode()+b'\n')
        with patch('identity.tool_client.socket.socket', return_value=conn):
            with self.assertRaises(ConnectionError) as raised:
                broker_call('tools.call', {}, path='/fixture.sock')
        self.assertEqual(raised.exception.diagnostic, reply['error']['data'])
        self.assertNotIn('secret', str(raised.exception))

    async def test_unknown_diagnostic_fields_are_not_forwarded(self):
        self.assertEqual(safe_failure('SECRET_VALUE', 'private-path'),
            {'reason':'INTERNAL','stage':'broker'})

    async def test_stt_logs_operation_without_audio_or_exception_text_or_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp)/'private.ogg', Path(tmp)/'result.txt'
            source.write_bytes(b'OggSprivateaudio')
            calls = []
            def call(method, params, **kwargs):
                calls.append((method, params))
                if method == 'files.publish':
                    return {'artifactId':AID,'mimeType':'audio/ogg'}
                error = ConnectionError('secret-token-and-audio')
                error.diagnostic = {'reason':'OUTCOME_UNKNOWN','stage':'control'}
                raise error
            with self.assertLogs('identity.transcribe', level='WARNING') as captured:
                with self.assertRaises(ConnectionError):
                    transcribe_file(source, output, MODEL, call=call)
            log = '\n'.join(captured.output)
            args = calls[-1][1]['args']
            self.assertIn(args['requestId'], log)
            self.assertIn(args['operationId'], log)
            self.assertIn('OUTCOME_UNKNOWN', log)
            self.assertNotIn('secret-token', log)
            self.assertNotIn(str(source), log)
            self.assertFalse(output.exists())
            self.assertEqual([m for m,_ in calls], ['files.publish','tools.call'])

    async def test_all_declared_local_ai_reasons_survive_the_python_boundary(self):
        schema = Path(__file__).resolve().parents[3]/'local-ai/schemas/messages.schema.json'
        reasons = json.loads(schema.read_text())['definitions']['ServiceErrorCode']['enum']
        for reason in reasons:
            self.assertEqual(safe_failure(reason,'control'),{'reason':reason,'stage':'control'})
