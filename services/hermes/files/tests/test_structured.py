import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zipfile
from xml.etree import ElementTree as ET

spec = importlib.util.spec_from_file_location('test_owner_files', Path(__file__).resolve().parents[1] / 'identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class StructuredTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.uid = os.getuid()
        self.stage = root / 'stage' / str(self.uid)
        self.stage.mkdir(parents=True, mode=0o700)
        self.profile = {'home': str(root / 'home'), 'userId': 'test-owner'}
        self.calls = []
        self.port = identity.OwnerFiles({'artifactCacheRoots': {str(self.uid): str(root / 'cache')}, 'stagingRoot': str(self.stage.parent)}, SimpleNamespace(call=self.publish))
        original = identity.open_directory
        directory = patch.object(identity, 'open_directory', side_effect=lambda path, uid: original(path, self.uid))
        directory.start()
        self.addCleanup(directory.stop)
        self.port.materialize = lambda uid, profile, result: result
        self.wrong_hash = False

    async def publish(self, method, params, **kwargs):
        self.calls.append((method, params))
        self.data = Path(params['path']).read_bytes()
        return {'artifactId': str(uuid.uuid4()), 'filename': Path(params['path']).name, 'sizeBytes': len(self.data), 'sha256': '0' * 64 if self.wrong_hash else hashlib.sha256(self.data).hexdigest()}

    async def test_document_published(self):
        result = await self.port.create_structured(self.uid, self.profile, {'filename': 'результат.docx', 'requestId': 'd1', 'document': {'paragraphs': ['Привет & мир']}}, 'document')
        self.assertTrue(result['markdown'].startswith('[результат.docx](artifact:'))
        self.assertEqual(self.calls[0][0], 'artifacts.publish')
        self.assertEqual(self.calls[0][1]['uid'], self.uid)
        self.assertEqual(self.calls[0][1]['requestId'], 'd1')
        with zipfile.ZipFile(io.BytesIO(self.data)) as z:
            self.assertIn('Привет &amp; мир', z.read('word/document.xml').decode())
        self.assertEqual(list(self.stage.iterdir()), [])

    async def test_workbook_is_literal_not_formula(self):
        await self.port.create_structured(self.uid, self.profile, {'filename': 'table.xlsx', 'requestId': 'w1', 'workbook': {'sheets': [{'name': 'Лист', 'rows': [['=1+1', 'Текст', 1, True, None]]}]}}, 'workbook')
        with zipfile.ZipFile(io.BytesIO(self.data)) as z:
            self.assertIsNone(z.testzip())
            sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
            ns = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            self.assertFalse(sheet.findall('.//x:f', ns))
            self.assertEqual(sheet.find('.//x:t', ns).text, '=1+1')
            self.assertFalse(any('vba' in n.lower() or 'external' in n.lower() for n in z.namelist()))
            for name in (n for n in z.namelist() if n.endswith('.rels')):
                self.assertFalse(any(r.get('TargetMode') == 'External' for r in ET.fromstring(z.read(name))))
        self.assertEqual(list(self.stage.iterdir()), [])

    async def test_rejects_paths_unknown_fields_and_limits_before_publish(self):
        cases = [({'filename': '../x.docx', 'requestId': 'a', 'document': {'paragraphs': []}}, 'document'),
                 ({'filename': 'x.txt', 'requestId': 'a', 'document': {'paragraphs': []}}, 'document'),
                 ({'filename': 'x.docx', 'requestId': 'a', 'document': {'paragraphs': []}, 'path': '/tmp/x'}, 'document'),
                 ({'filename': 'x.docx', 'requestId': 'a', 'document': {'paragraphs': ['\x00']}}, 'document'),
                 ({'filename': 'x.xlsx', 'requestId': 'a', 'workbook': {'sheets': [{'name': 'a', 'rows': [[1] * 101]}]}}, 'workbook'),
                 ({'filename': 'x.xlsx', 'requestId': 'a', 'workbook': {'sheets': [{'name': 'a', 'rows': [[1] * 100] * 201}]}}, 'workbook'),
                 ({'filename': 'x.xlsx', 'requestId': 'a', 'workbook': {'sheets': [{'name': 'a', 'rows': [[float('nan')]]}]}}, 'workbook')]
        for params, kind in cases:
            with self.subTest(kind=kind, filename=params['filename']), self.assertRaises(ValueError):
                await self.port.create_structured(self.uid, self.profile, params, kind)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.stage.iterdir()), [])

    async def test_retries_produce_identical_bytes(self):
        for kind, name, spec in [('document', 'x.docx', {'paragraphs': ['Текст']}), ('workbook', 'x.xlsx', {'sheets': [{'name': 'A', 'rows': [[1, 'x']]}]})]:
            params = {'filename': name, 'requestId': 'same', kind: spec}
            await self.port.create_structured(self.uid, self.profile, params, kind)
            first = self.data
            await self.port.create_structured(self.uid, self.profile, params, kind)
            self.assertEqual(first, self.data)

    async def test_bad_publisher_receipt_cleans_stage(self):
        self.wrong_hash = True
        with self.assertRaises(PermissionError):
            await self.port.create_structured(self.uid, self.profile, {'filename': 'x.docx', 'requestId': 'd1', 'document': {'paragraphs': []}}, 'document')
        self.assertEqual(list(self.stage.iterdir()), [])

class CatalogTests(unittest.TestCase):
    def test_catalog_and_broker_operations(self):
        path = Path(__file__).resolve().parents[2] / 'identity' / 'tool_client.py'
        module_spec = importlib.util.spec_from_file_location('test_tool_client', path)
        client = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(client)
        client.TOOL_POLICY = {'roles': {'guest': {}}, 'guestClient': ['create_document_file', 'create_spreadsheet_file']}
        calls = []
        def broker(method, params):
            calls.append((method, params))
            if method == 'tools.list':
                return {'role': 'guest', 'tools': []}
            return {'markdown': '[file](artifact:123)'}
        with patch.object(client, 'broker_call', side_effect=broker):
            catalog = client.handle('tools/list', {})['tools']
            self.assertEqual({x['name'] for x in catalog}, {'create_document_file', 'create_spreadsheet_file'})
            for tool, field, operation in [('create_document_file', 'document', 'files.create-document'), ('create_spreadsheet_file', 'workbook', 'files.create-spreadsheet')]:
                schema = next(x['inputSchema'] for x in catalog if x['name'] == tool)
                self.assertEqual(set(schema['required']), {'filename', 'requestId', field})
                self.assertFalse(schema['additionalProperties'])
                arguments = {'filename': 'x', 'requestId': 'a', field: {}}
                client.handle('tools/call', {'name': tool, 'arguments': arguments})
                self.assertEqual(calls[-1], (operation, arguments))
