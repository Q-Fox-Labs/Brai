# ABOUTME: Проверяет поставку системного навыка Book to Skill и извлечение текста.
# ABOUTME: Работает только с временной книгой и не обращается к сети.
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

EXTENSIONS = Path(__file__).resolve().parents[1]
PROJECT = EXTENSIONS.parents[2]
PROGRAM = EXTENSIONS / 'skill-scripts/research/book-to-skill'


class BookToSkillTests(unittest.TestCase):
    def test_runtime_package_contains_the_program(self):
        manifest = json.loads((EXTENSIONS / 'manifest.json').read_text())
        component = json.loads((PROJECT / 'services/hermes/component.json').read_text())
        scripts = sorted(path.relative_to(EXTENSIONS).as_posix() for path in PROGRAM.rglob('*.py'))
        self.assertTrue(scripts)
        for script in scripts:
            self.assertIn(script, manifest['runtimeFiles'])
            self.assertIn('services/hermes/extensions/' + script, component['delivery']['files'])
            self.assertIn('services/hermes/extensions/' + script, component['inputs']['runtime'])

    def test_extracts_private_text_without_installing_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / 'книга.txt'
            source.write_text('Первая глава\nСмысл и практические шаги.\n', encoding='utf-8')
            output = base / 'output'
            output.mkdir(mode=0o700)
            environment = dict(os.environ, BOOK_SKILL_WORKDIR=str(output))
            process = subprocess.run([sys.executable, '-B', str(PROGRAM / 'scripts/extract.py'), str(source),
                                      '--mode', 'text', '--no-install-missing'],
                                     env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIn('Смысл и практические шаги', (output / 'full_text.txt').read_text(encoding='utf-8'))
            self.assertTrue((output / 'metadata.json').is_file())

    def test_extracts_a_text_pdf_using_the_installed_reader(self):
        objects = [
            b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ]
        stream = b'BT /F1 16 Tf 40 120 Td (Book skill PDF content) Tj ET'
        objects.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
        data = bytearray(b'%PDF-1.4\n')
        offsets = [0]
        for number, content in enumerate(objects, 1):
            offsets.append(len(data))
            data.extend(f'{number} 0 obj\n'.encode() + content + b'\nendobj\n')
        xref = len(data)
        data.extend(f'xref\n0 {len(offsets)}\n'.encode() + b'0000000000 65535 f \n')
        for offset in offsets[1:]:
            data.extend(f'{offset:010} 00000 n \n'.encode())
        data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / 'book.pdf'
            source.write_bytes(data)
            output = base / 'output'
            output.mkdir(mode=0o700)
            environment = dict(os.environ, BOOK_SKILL_WORKDIR=str(output))
            process = subprocess.run([sys.executable, '-S', '-B', str(PROGRAM / 'scripts/extract.py'), str(source),
                                      '--mode', 'text', '--no-install-missing'],
                                     env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIn('Book skill PDF content', (output / 'full_text.txt').read_text(encoding='utf-8'))
            metadata = json.loads((output / 'metadata.json').read_text(encoding='utf-8'))
            self.assertEqual(metadata['extraction_method'], 'pdftotext')


if __name__ == '__main__':
    unittest.main()
