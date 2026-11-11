# ABOUTME: Проверяет реальные байты XLSX и ограничения готового помощника.
# ABOUTME: Читает книгу независимым oracle, не использует writer для разбора.
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

SOURCE = Path(__file__).resolve().parents[1] / 'skill-scripts/office/spreadsheets/scripts/xlsx.py'
spec = importlib.util.spec_from_file_location('xlsx_writer', SOURCE)
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


class WorkbookTest(unittest.TestCase):
    def test_multiple_sheets_types_escaping_and_no_formulas(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.xlsx'
            receipt = writer.create_workbook({'sheets': [
                {'name': 'Тест & <1>', 'rows': [[' Имя & <x> ', 1.25, True, None, '=1+2', '😀'], [0, False]]},
                {'name': 'Second', 'rows': [[-10, 999999999999999]]}]}, path)
            self.assertEqual(receipt['bytes'], path.stat().st_size)
            self.assertEqual(receipt['sheets'], 2)
            with zipfile.ZipFile(path) as archive:
                self.assertIsNone(archive.testzip())
                names = archive.namelist()
                for name in names:
                    ET.fromstring(archive.read(name))
                book = ET.fromstring(archive.read('xl/workbook.xml'))
                self.assertEqual([s.get('name') for s in book.findall('s:sheets/s:sheet', NS)], ['Тест & <1>', 'Second'])
                sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
                cells = {c.get('r'): c for c in sheet.findall('s:sheetData/s:row/s:c', NS)}
                self.assertEqual(cells['A1'].find('s:is/s:t', NS).text, ' Имя & <x> ')
                self.assertEqual(cells['B1'].find('s:v', NS).text, '1.25')
                self.assertEqual(cells['C1'].get('t'), 'b')
                self.assertEqual(cells['C1'].find('s:v', NS).text, '1')
                self.assertNotIn('D1', cells)
                self.assertEqual(cells['E1'].find('s:is/s:t', NS).text, '=1+2')
                self.assertEqual(cells['F1'].find('s:is/s:t', NS).text, '😀')
                self.assertIsNone(sheet.find('.//s:f', NS))
                self.assertFalse(any('externalLink' in n or 'vbaProject' in n for n in names))

    def test_existing_file_and_symlink_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.xlsx'
            path.write_bytes(b'original')
            link = Path(directory) / 'link.xlsx'
            link.symlink_to(path)
            for target in (path, link):
                with self.assertRaises(FileExistsError):
                    writer.create_workbook({'sheets': [{'name': 'A', 'rows': [[1]]}]}, target)
            self.assertEqual(path.read_bytes(), b'original')

    def test_invalid_input_never_creates_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.xlsx'
            for sheets in ([], [{'name': 'A/B', 'rows': [[1]]}],
                           [{'name': 'A', 'rows': [[1]]}, {'name': 'a', 'rows': [[2]]}],
                           [{'name': 'A', 'rows': [[float('nan')]]}],
                           [{'name': 'A', 'rows': [[1000000000000000]]}],
                           [{'name': 'A', 'rows': [['\x00']]}],
                           [{'name': 'A', 'rows': [['😀' * 16384]]}],
                           [{'name': 'A', 'rows': [[]]}]):
                with self.subTest(sheets=str(sheets)[:60]), self.assertRaises(ValueError):
                    writer.create_workbook({'sheets': sheets}, path)
                self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
