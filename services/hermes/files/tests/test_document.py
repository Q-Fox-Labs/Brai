import io
import unittest
import zipfile
from xml.etree import ElementTree as ET

from files.document import docx_bytes


class DocumentTests(unittest.TestCase):
    def test_document_contents_and_package(self):
        data = docx_bytes({'title': 'Заголовок & <тест>', 'paragraphs': ['Привет, мир!', '  пробелы  '],
                           'tables': [{'headers': ['Имя', 'Значение'], 'rows': [['Ёж', 12], [True, None], [3.5, '<&>']]}]})
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(set(z.namelist()), {'[Content_Types].xml', '_rels/.rels', 'word/document.xml'})
            content_types = ET.fromstring(z.read('[Content_Types].xml'))
            self.assertTrue(any(e.get('PartName') == '/word/document.xml' and 'document.main+xml' in e.get('ContentType', '') for e in content_types))
            rels = ET.fromstring(z.read('_rels/.rels'))
            self.assertEqual(len(rels), 1)
            self.assertEqual(rels[0].get('Target'), 'word/document.xml')
            self.assertIsNone(rels[0].get('TargetMode'))
            raw = z.read('word/document.xml')
            self.assertIn(b'&amp;', raw)
            self.assertIn(b'&lt;', raw)
            doc = ET.fromstring(raw)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            self.assertEqual([t.text for t in doc.findall('.//w:t', ns)], ['Заголовок & <тест>', 'Привет, мир!', '  пробелы  ', 'Имя', 'Значение', 'Ёж', '12', 'true', 'null', '3.5', '<&>'])
            self.assertEqual(len(doc.findall('.//w:tbl/w:tr', ns)), 4)
            self.assertEqual(len(doc.findall('.//w:tc', ns)), 8)

    def test_invalid_shapes_and_types(self):
        invalid = [None, {}, {'paragraphs': (), 'x': 1}, {'paragraphs': [], 'html': '<b>x</b>'},
                   {'title': 1, 'paragraphs': []}, {'paragraphs': [1]},
                   {'paragraphs': [], 'tables': [{'rows': [], 'template': 'x'}]},
                   {'paragraphs': [], 'tables': [{'rows': [[{}]]}]},
                   {'paragraphs': [], 'tables': [{'headers': [1], 'rows': []}]},
                   {'paragraphs': [], 'tables': [{'rows': ['abc']}]},
                   {'paragraphs': [], 'tables': [{'rows': [[float('nan'), float('inf')]]}]}]
        for spec in invalid:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                docx_bytes(spec)

    def test_invalid_xml_characters(self):
        for value in ['a\x00b', '\x01', '\ufffe', '\ud800']:
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                docx_bytes({'paragraphs': [value]})

    def test_limits(self):
        invalid = [ {'paragraphs': ['x' * 65537]}, {'paragraphs': ['я' * 32769]},
                    {'paragraphs': [''] * 1001}, {'paragraphs': [], 'tables': [{'rows': []}] * 21},
                    {'paragraphs': [], 'tables': [{'rows': [[]] * 1001}]},
                    {'paragraphs': [], 'tables': [{'rows': [[''] * 101]}]},
                    {'paragraphs': [], 'tables': [{'rows': [[''] * 100] * 201}]},
                    {'paragraphs': ['x' * 65536] * 16} ]
        for spec in invalid:
            with self.subTest(spec_type=str(type(spec))), self.assertRaises(ValueError):
                docx_bytes(spec)

    def test_boundary_values(self):
        data = docx_bytes({'paragraphs': ['я' * 32768], 'tables': [{'rows': [['x'] * 100] * 200}]})
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertIsNone(z.testzip())
            ET.fromstring(z.read('word/document.xml'))


if __name__ == '__main__':
    unittest.main()
