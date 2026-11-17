# ABOUTME: Проверяет разбиение длинного Telegram MarkdownV2 с сохранением текста.
# ABOUTME: Использует проверку синтаксиса тестового стенда и не обращается к Telegram.
from pathlib import Path
import re
import runpy
import unittest

from identity.telegram_markdown import split_bold

FIXTURE = Path(__file__).resolve().parent / 'fixtures/ordinary_release/gateway/mdv2_standin.py'
check_markdown = runpy.run_path(str(FIXTURE))['mdv2_error']


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


def split(text, limit=4085):
    parts = split_bold(text, limit, truncate=None, len_fn=utf16)
    return [re.sub(r' \((\d+)/(\d+)\)$', r' \\(\1/\2\\)', part) for part in parts]


def without_number(text):
    return re.sub(r' \\\(\d+/\d+\\\)$', '', text)


class TelegramMarkdownTests(unittest.TestCase):
    def assert_valid(self, parts, limit=4085):
        self.assertGreater(len(parts), 1)
        for part in parts:
            self.assertLessEqual(utf16(part), limit)
            self.assertIsNone(check_markdown(part), repr(part[:80]))

    def test_long_bold_preserves_spaces_newlines_and_emoji(self):
        for separator in ('  ', '\n\n'):
            with self.subTest(separator=repr(separator)):
                body = 'А🔥' * 1500 + separator + 'Б' * 3000
                parts = split('*' + body + '*')
                self.assert_valid(parts)
                restored = ''.join(without_number(part)[1:-1] for part in parts)
                self.assertEqual(restored, body)

    def test_escape_pair_on_boundary_stays_intact(self):
        text = '*' + 'А' * 4067 + r'\*' + 'Б' * 3000 + '*'
        parts = split(text)
        self.assert_valid(parts)
        self.assertEqual(''.join(without_number(part)[1:-1] for part in parts), text[1:-1])

    def test_nested_italic_and_underline_delimiters_remain_valid(self):
        text = '_курсив__курсив_[тест](https://example.org) два _курсив__курсив_'
        self.assertIsNone(check_markdown(text))
        self.assert_valid(split(text, 60), 60)

    def test_fenced_code_prefers_line_boundaries_and_keeps_lines(self):
        body = 'line=123456789\n' * 1000
        parts = split('```python\n' + body + '```')
        self.assert_valid(parts)
        restored = []
        for part in parts:
            content = without_number(part)
            self.assertTrue(content.startswith('```python\n') and content.endswith('```'))
            restored.append(content[len('```python\n'):-3])
        self.assertEqual(''.join(restored), body)

    def test_fenced_code_with_long_line_does_not_gain_line_breaks(self):
        body = 'A' * 9000 + '\n'
        parts = split('```python\n' + body + '```')
        self.assert_valid(parts)
        restored = ''.join(without_number(part)[len('```python\n'):-3] for part in parts)
        self.assertEqual(restored, body)

    def test_inline_code_and_short_links_stay_valid(self):
        text = '`' + 'код' * 2200 + '` [тест](https://example.org)'
        self.assert_valid(split(text))

    def test_long_atomic_link_can_use_space_without_numbering(self):
        link = '[тест](https://example.org/' + 'a' * 28 + ')'
        parts = split('*' + 'А' * 25 + '*' + link, 60)
        self.assert_valid(parts, 60)
        self.assertIn(link, parts)
