# ABOUTME: Создаёт ограниченный DOCX из текста и таблиц без внешних связей.
# ABOUTME: Использует только стандартную библиотеку, без шаблонов и исполнения кода.
"""Build a small DOCX document from validated plain text data."""

import io
import json
import math
import zipfile
from xml.etree import ElementTree as ET

_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
ET.register_namespace('w', _W)


def _text(value):
    if type(value) is not str:
        raise ValueError('expected a string')
    try:
        size = len(value.encode('utf-8'))
    except UnicodeEncodeError as exc:
        raise ValueError('invalid Unicode') from exc
    if size > 65536 or any(
        (ord(c) < 32 and c not in '\t\n\r') or ord(c) in (0xfffe, 0xffff)
        for c in value
    ):
        raise ValueError('invalid or oversized string')
    return value


def _object(value, required, optional):
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise ValueError('invalid object fields')


def _array(value, limit):
    if type(value) is not list or len(value) > limit:
        raise ValueError('invalid or oversized array')
    return value


def _cell(value):
    if type(value) is str:
        return _text(value)
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        try:
            return _text(str(value))
        except ValueError as exc:
            raise ValueError('invalid number') from exc
    raise ValueError('invalid cell')


def _paragraph(parent, value):
    paragraph = ET.SubElement(parent, f'{{{_W}}}p')
    run = ET.SubElement(paragraph, f'{{{_W}}}r')
    text = ET.SubElement(run, f'{{{_W}}}t', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
    text.text = value


def docx_bytes(spec):
    """Return DOCX bytes, or raise ValueError for invalid or oversized input."""
    _object(spec, {'paragraphs'}, {'title', 'tables'})
    if 'title' in spec:
        _text(spec['title'])
    paragraphs = _array(spec['paragraphs'], 1000)
    for paragraph in paragraphs:
        _text(paragraph)
    tables = _array(spec.get('tables', []), 20)
    cell_count = 0
    for table in tables:
        _object(table, {'rows'}, {'headers'})
        headers = _array(table.get('headers', []), 100)
        for header in headers:
            _text(header)
        cell_count += len(headers)
        for row in _array(table['rows'], 1000):
            _array(row, 100)
            cell_count += len(row)
            if cell_count > 20000:
                raise ValueError('too many cells')
            for cell in row:
                _cell(cell)
        if cell_count > 20000:
            raise ValueError('too many cells')
    try:
        encoded = json.dumps(spec, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    except (ValueError, TypeError, UnicodeEncodeError, OverflowError) as exc:
        raise ValueError('invalid JSON data') from exc
    if len(encoded) > 1024 * 1024:
        raise ValueError('input is too large')

    document = ET.Element(f'{{{_W}}}document')
    body = ET.SubElement(document, f'{{{_W}}}body')
    if 'title' in spec:
        _paragraph(body, spec['title'])
    for paragraph in paragraphs:
        _paragraph(body, paragraph)
    for table in tables:
        element = ET.SubElement(body, f'{{{_W}}}tbl')
        rows = ([table['headers']] if 'headers' in table else []) + table['rows']
        for row in rows:
            tr = ET.SubElement(element, f'{{{_W}}}tr')
            for value in row:
                cell = ET.SubElement(tr, f'{{{_W}}}tc')
                _paragraph(cell, _cell(value))
    ET.SubElement(body, f'{{{_W}}}sectPr')
    content_types = b'''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
    relationships = b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('_rels/.rels', relationships)
        archive.writestr('word/document.xml', ET.tostring(document, encoding='utf-8', xml_declaration=True))
    result = output.getvalue()
    if len(result) > 8 * 1024 * 1024:
        raise ValueError('output is too large')
    return result
