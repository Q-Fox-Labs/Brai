#!/usr/bin/env python3
# ABOUTME: Создаёт настоящие XLSX с листами и типизированными значениями из JSON.
# ABOUTME: Использует только stdlib, не исполняет формулы и не перезаписывает файлы.
"""Writer обычных таблиц; не редактор существующих книг Excel."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types'
MAX_INPUT = 16 * 1024 * 1024
BAD_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]')


def xml(root):
    """Сериализовать XML с декларацией UTF-8."""
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def column(index):
    """Вернуть Excel-имя колонки по номеру, начиная с единицы."""
    result = ''
    while index:
        index, digit = divmod(index - 1, 26)
        result = chr(65 + digit) + result
    return result


def worksheet(sheet):
    """Проверить лист; вернуть XML и число явно заданных ячеек."""
    rows = sheet['rows']
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100000:
        raise ValueError('ROWS_REQUIRED_OR_LIMIT')
    root = ET.Element('worksheet', xmlns=NS)
    data = ET.SubElement(root, 'sheetData')
    count = 0
    for row_number, values in enumerate(rows, 1):
        if not isinstance(values, list) or len(values) > 16384:
            raise ValueError('INVALID_ROW')
        count += len(values)
        if count > 100000:
            raise ValueError('CELL_LIMIT')
        row = ET.SubElement(data, 'row', r=str(row_number))
        for number, value in enumerate(values, 1):
            if value is None:
                continue
            cell = ET.SubElement(row, 'c', r=column(number) + str(row_number))
            if type(value) is bool:
                cell.set('t', 'b')
                ET.SubElement(cell, 'v').text = '1' if value else '0'
            elif type(value) in (int, float):
                if (type(value) is int and abs(value) > 999999999999999) or not math.isfinite(value):
                    raise ValueError('NUMBER_OUT_OF_RANGE_USE_TEXT')
                ET.SubElement(cell, 'v').text = str(value)
            elif isinstance(value, str):
                if BAD_XML.search(value) or len(value.encode('utf-16-le')) // 2 > 32767:
                    raise ValueError('INVALID_CELL_TEXT')
                # AIDEV-NOTE: Даже =, +, - и @ остаются текстом, не формулами.
                cell.set('t', 'inlineStr')
                text = ET.SubElement(ET.SubElement(cell, 'is'), 't')
                text.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                text.text = value
            else:
                raise ValueError('CELL_MUST_BE_TEXT_NUMBER_BOOLEAN_OR_NULL')
    if not count:
        raise ValueError('EMPTY_SHEET')
    return xml(root), count


def create_workbook(spec, destination):
    """Создать новый XLSX; до записи проверить все листы, существующий путь не менять.

    Вход: sheets [{name, rows}], до 20 листов и 100000 ячеек.
    Текст, конечные числа, bool и null; формул, макросов и внешних связей нет.
    Возвращает path, filename, bytes, sha256 и число листов; ошибки ValueError/OSError.
    """
    if not isinstance(spec, dict) or set(spec) != {'sheets'}:
        raise ValueError('EXPECTED_SHEETS')
    sheets = spec['sheets']
    if not isinstance(sheets, list) or not 1 <= len(sheets) <= 20:
        raise ValueError('SHEET_LIMIT')
    path = Path(destination)
    if path.suffix.lower() != '.xlsx':
        raise ValueError('XLSX_EXTENSION_REQUIRED')
    workbook = ET.Element('workbook', xmlns=NS, **{'xmlns:r': DOC_REL[:-1]})
    listing = ET.SubElement(workbook, 'sheets')
    relations = ET.Element('Relationships', xmlns=REL)
    types = ET.Element('Types', xmlns=CONTENT)
    ET.SubElement(types, 'Default', Extension='rels', ContentType='application/vnd.openxmlformats-package.relationships+xml')
    ET.SubElement(types, 'Default', Extension='xml', ContentType='application/xml')
    kind = 'application/vnd.openxmlformats-officedocument.spreadsheetml.'
    ET.SubElement(types, 'Override', PartName='/xl/workbook.xml', ContentType=kind + 'sheet.main+xml')
    files, names, total = {}, set(), 0
    for index, sheet in enumerate(sheets, 1):
        if not isinstance(sheet, dict) or set(sheet) != {'name', 'rows'}:
            raise ValueError('INVALID_SHEET')
        name = sheet['name']
        if (not isinstance(name, str) or not name.strip() or BAD_XML.search(name) or len(name) > 31
                or re.search(r'[\[\]:*?/\\]', name) or name.startswith("'") or name.endswith("'")
                or name.casefold() in names):
            raise ValueError('INVALID_OR_DUPLICATE_SHEET_NAME')
        names.add(name.casefold())
        raw, count = worksheet(sheet)
        total += count
        if total > 100000:
            raise ValueError('CELL_LIMIT')
        filename = 'worksheets/sheet' + str(index) + '.xml'
        files['xl/' + filename] = raw
        ET.SubElement(listing, 'sheet', name=name, sheetId=str(index), **{'r:id': 'rId' + str(index)})
        ET.SubElement(relations, 'Relationship', Id='rId' + str(index), Type=DOC_REL + 'worksheet', Target=filename)
        ET.SubElement(types, 'Override', PartName='/xl/' + filename, ContentType=kind + 'worksheet+xml')
    outer = ET.Element('Relationships', xmlns=REL)
    ET.SubElement(outer, 'Relationship', Id='book', Type=DOC_REL + 'officeDocument', Target='xl/workbook.xml')
    files.update({'[Content_Types].xml': xml(types), '_rels/.rels': xml(outer),
                  'xl/workbook.xml': xml(workbook), 'xl/_rels/workbook.xml.rels': xml(relations)})
    with path.open('xb') as output:
        try:
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name, raw in files.items():
                    archive.writestr(name, raw)
        except BaseException:
            path.unlink()
            raise
    raw = path.read_bytes()
    return {'path': str(path.resolve()), 'filename': path.name, 'bytes': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(), 'sheets': len(sheets)}


def main():
    """Принять JSON через --input либо stdin, вывести квитанцию нового --output XLSX."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.input:
        with args.input.open('rb') as stream:
            raw = stream.read(MAX_INPUT + 1)
    else:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError('INPUT_LIMIT')
    print(json.dumps(create_workbook(json.loads(raw), args.output), ensure_ascii=False))


if __name__ == '__main__':
    main()
