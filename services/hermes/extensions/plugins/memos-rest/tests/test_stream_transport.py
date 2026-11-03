# ABOUTME: Проверяет полноту и отказ при обрыве versioned MemOS-потока.
# ABOUTME: Использует только синтетические ответы транспорта без сетевого сервиса.
import importlib.util
import io
import json
import sys
import unittest
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

path = Path(__file__).parents[1] / 'client.py'
if not path.exists():
    path = Path(__file__).parent / 'client.py'
spec = importlib.util.spec_from_file_location('stream_client', path)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class Response(io.BytesIO):
    def __init__(self, content, kind='application/json'):
        super().__init__(content)
        self.headers = Message()
        self.headers['Content-Type'] = kind


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.client = client_module.Client({'base_url':'http://127.0.0.1:8001','user_id':'owner','cube_id':'cube'})
        self.paths = []
        self.version = 1
        self.frames = [{'type':'header','version':1,'cube_id':'cube','user_id':'owner'},
                       {'type':'memory','memory':{'id':'one','memory':'Свидетельство','metadata':{'user_id':'owner'}}},
                       {'type':'end','count':1}]
        self.raw = None
        self.closed = []
        self.client.opener.open = self.open

    def open(self, request, timeout):
        path = request.full_url.split(':8001')[-1]
        self.paths.append(path)
        if path == '/product/memory_capabilities':
            if self.version == 'missing':
                raise HTTPError(request.full_url,404,'Not found',{},None)
            if self.version == 'error':
                raise HTTPError(request.full_url,503,'Unavailable',{},None)
            return Response(json.dumps({'code':200,'data':{'memory_stream':self.version}}).encode())
        if path == '/product/get_memory':
            return Response(json.dumps({'code':200,'data':{'text_mem':[{'cube_id':'cube','memories':[
                {'id':str(i),'metadata':{'user_id':'owner'}} for i in range(31)]}]}}).encode())
        self.assertEqual(path,'/product/get_memory_stream')
        response = Response(self.raw if self.raw is not None else b''.join(
            json.dumps(frame,ensure_ascii=False).encode()+b'\n' for frame in self.frames),'application/x-ndjson')
        self.closed.append(response)
        return response

    def test_complete_stream_and_cached_handshake(self):
        self.assertEqual([r['id'] for r in self.client.get({})],['one'])
        self.assertEqual(self.client.get({})[0]['_cube_id'],'cube')
        self.assertEqual(self.paths.count('/product/memory_capabilities'),1)
        self.assertNotIn('/product/get_memory',self.paths)
        self.assertTrue(all(r.closed for r in self.closed))

    def test_old_server_returns_all_records_without_pagination(self):
        self.version = 'missing'
        self.assertEqual(len(self.client.get({})),31)
        self.assertEqual(len(self.client.get({})),31)
        self.assertEqual(self.paths.count('/product/memory_capabilities'),1)
        self.assertNotIn('/product/get_memory_stream',self.paths)

    def test_new_protocol_does_not_fallback_after_stream_failure(self):
        for frames in [self.frames[:-1], self.frames[1:], self.frames+[self.frames[-1]],
                       [self.frames[0],self.frames[1],{'type':'end','count':2}],
                       [self.frames[0],self.frames[1],self.frames[1],{'type':'end','count':2}],
                       [{**self.frames[0],'cube_id':'foreign'},*self.frames[1:]],
                       [self.frames[0],{'type':'memory','memory':{'id':'foreign','metadata':{'user_id':'foreign'}}},self.frames[2]]]:
            with self.subTest(frames=frames):
                self.frames=frames
                with self.assertRaises(client_module.MemOSError): self.client.get({})
        self.assertNotIn('/product/get_memory',self.paths)
        self.assertTrue(all(r.closed for r in self.closed))

    def test_bad_json_and_oversized_record_fail_closed(self):
        for raw in [b'{}',b'not-json\n',b'"'+b'a'*8388608+b'"\n']:
            self.raw=raw
            with self.assertRaises(client_module.MemOSError): self.client.get({})

    def test_timeout_and_incomplete_chunk_close_without_fallback(self):
        from http.client import IncompleteRead
        original = self.open
        for error in [TimeoutError(), IncompleteRead(b'private untrusted bytes')]:
            self.client._stream_version = 1
            def failed(request, timeout):
                response = original(request, timeout)
                def read1(size):
                    raise error
                response.read1 = read1
                return response
            self.client.opener.open = failed
            with self.assertRaises(client_module.MemOSError) as caught:
                self.client.get({})
            self.assertNotIn('private untrusted bytes', str(caught.exception))
            self.assertTrue(self.closed[-1].closed)
        self.assertNotIn('/product/get_memory', self.paths)

    def test_negotiation_and_stream_share_time_budget(self):
        self.client.timeout = 1
        with patch.object(client_module.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaisesRegex(client_module.MemOSError, 'timed out'):
                self.client.get({})
        self.assertNotIn('/product/get_memory_stream', self.paths)
        self.client._stream_version = 1
        with patch.object(client_module.time, 'monotonic', side_effect=[0, 0, 2]):
            with self.assertRaises(client_module.MemOSError): self.client.get({})
        self.assertTrue(self.closed[-1].closed)

    def test_unsupported_or_failed_negotiation_does_not_guess(self):
        for version in [2,True,'1','error']:
            self.client._stream_version=None
            self.version=version
            with self.assertRaises(client_module.MemOSError): self.client.get({})
        self.assertNotIn('/product/get_memory',self.paths)
        self.assertNotIn('/product/get_memory_stream',self.paths)


if __name__ == '__main__': unittest.main(verbosity=2)
