# ABOUTME: Формирует PDF полного ответа через личный Chrome и прежний renderer brai-delivery.
# ABOUTME: Сеть документа отключена; файл остаётся в закрытой рабочей области профиля.
"""Восстановление текста, превышающего предел Telegram Rich Message."""
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

RICH_MAX_CHARS = 32768
RICH_MAX_BYTES = 128 * 1024
CAPTION_MAX_UNITS = 1024


def needs_pdf(adapter, content):
    """Проверить фактическое содержимое Rich Message после преобразования."""
    formatter = getattr(adapter, '_rich_message_payload', None)
    rich = formatter(content) if callable(formatter) else {'markdown': content}
    text = rich.get('markdown') if isinstance(rich, dict) else None
    if not isinstance(text, str):
        raise ValueError('RICH_MESSAGE_UNAVAILABLE')
    return len(text) > RICH_MAX_CHARS or len(text.encode('utf-8')) > RICH_MAX_BYTES


def excerpt(adapter, content):
    """Начало ответа и пометка о PDF помещаются в подпись Telegram."""
    notice = '\n\n… Полный ответ — в PDF.'
    formatter = getattr(adapter, 'format_message', lambda value: value)
    def fits(text):
        return len(formatter(text).encode('utf-16-le')) // 2 <= CAPTION_MAX_UNITS
    low, high = 0, min(len(content), CAPTION_MAX_UNITS)
    while low < high:
        middle = (low + high + 1) // 2
        if fits(content[:middle] + notice):
            low = middle
        else:
            high = middle - 1
    result = content[:low].rstrip() + notice
    while low and not fits(result):
        low -= 1
        result = content[:low].rstrip() + notice
    if not fits(result):
        raise ValueError('CAPTION_FORMAT_UNAVAILABLE')
    return result

class SafeHTML(HTMLParser):
    """Сохранить разметку, раскрыть детали и заменить видимые URL честными подписями."""
    allowed = set("p h1 h2 h3 h4 h5 h6 ul ol li strong em b i blockquote pre code table thead tbody tr th td hr br a del s sub sup".split())
    urls = re.compile(r"https?://[^\s<>]+")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.code_depth = 0
        self.links = []
        self.suppressed = 0

    @staticmethod
    def source_label(url):
        """Подписать неизвестную ссылку доменом, не выдумывая название страницы."""
        try:
            host = urlsplit(url).hostname or "источник"
        except ValueError:
            host = "источник"
        return "Источник — "+host.removeprefix("www.")

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.suppressed += 1
            return
        if self.suppressed or tag == "details":
            return
        tag = "h3" if tag == "summary" else tag
        if tag not in self.allowed:
            return
        attributes = ""
        if tag == "a":
            href = dict(attrs).get("href") or ""
            href = href if href.startswith(("https://", "http://", "#")) else ""
            self.links.append(href)
            if href:
                attributes = ' href="'+html.escape(href, quote=True)+'"'
        if tag in {"ol", "li"}:
            name = "start" if tag == "ol" else "value"
            value = dict(attrs).get(name, "")
            if str(value).isdigit() and len(str(value)) <= 6:
                attributes = " "+name+'="'+str(value)+'"'
        if tag in {"pre", "code"}:
            self.code_depth += 1
        self.parts.append("<"+tag+attributes+">")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.suppressed = max(0,self.suppressed-1)
            return
        if self.suppressed or tag == "details":
            return
        tag = "h3" if tag == "summary" else tag
        if tag == "a" and self.links:
            self.links.pop()
        if tag in {"pre", "code"}:
            self.code_depth = max(0,self.code_depth-1)
        if tag in self.allowed and tag not in {"br", "hr"}:
            self.parts.append("</"+tag+">")

    def handle_data(self, value):
        if self.suppressed:
            return
        if self.code_depth:
            self.parts.append(html.escape(value))
            return
        if self.links:
            href = self.links[-1]
            replace = href.startswith(("https://", "http://")) and value.strip() == href
            self.parts.append(html.escape(self.source_label(href) if replace else value))
            return
        position = 0
        for match in self.urls.finditer(value):
            self.parts.append(html.escape(value[position:match.start()]))
            original = match[0]
            url = original.rstrip(".,;:!?")
            while url and url[-1] in ")]}":
                opening = {")":"(","]":"[","}":"{"}[url[-1]]
                if url.count(url[-1]) <= url.count(opening):
                    break
                url = url[:-1]
            self.parts.append('<a href="'+html.escape(url,quote=True)+'">'+html.escape(self.source_label(url))+'</a>')
            self.parts.append(html.escape(original[len(url):]))
            position = match.end()
        self.parts.append(html.escape(value[position:]))


def formatted_markdown(content):
    """Восстановить разреженные разделы и списки, оставив fenced code дословным."""
    chunks = []
    lines = []
    fence = None
    for line in content.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})",line)
        if marker and fence is None:
            if lines:
                chunks.append((False,"".join(lines)))
            lines = [line]
            fence = marker[1]
        elif marker and fence and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
            lines.append(line)
            chunks.append((True,"".join(lines)))
            lines = []
            fence = None
        else:
            lines.append(line)
    if lines:
        chunks.append((fence is not None,"".join(lines)))
    prose = "\n".join(text for code,text in chunks if not code)
    sections = re.findall(r"(?m)^(\d{1,2})\. ([^\n]{4,120})\n(?=\n)",prose)
    legacy = len(sections) >= 3 and [int(x[0]) for x in sections] == list(range(1,len(sections)+1))
    output = []
    for code,text in chunks:
        if not code:
            if legacy:
                text = re.sub(r"(?m)^(\d{1,2}\. [^\n]{4,120})\n(?=\n)",r"## \1\n",text)
            text = re.sub(r"(?m)^—\s+", "- ",text)
            text = re.sub(r"(?m)^(Мой вывод:|Моя оценка:|Важно:|Оговорка:|Источник:)",r"**\1**",text)
        output.append(text)
    result = "".join(output)
    first = result.splitlines()[0] if result else ""
    if legacy and 0 < len(first) <= 180 and not first.startswith("#"):
        result = "# "+result
    return result


def render_body(content):
    """Собрать безопасный HTML с заголовками, выделениями и подписанными ссылками."""
    import markdown
    parser = SafeHTML()
    parser.feed(markdown.markdown(formatted_markdown(content), extensions=["tables", "fenced_code", "sane_lists"], output_format="html"))
    return "".join(parser.parts)


def report_html(content, title):
    """Сверстать печатный отчёт: кириллица, таблицы, ссылки, заголовки и номера страниц."""
    body = render_body(content)
    heading = "" if re.match(r"\s*<h1[ >]", body) else "<h1>"+html.escape(title)+"</h1>"
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8">'+(
        '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">'
        '<title>'+html.escape(title)+'</title><style>'
        '@page{size:A4;margin:18mm 17mm 20mm}*{box-sizing:border-box}'
        'body{font:11.2pt/1.56 Arial,"DejaVu Sans",sans-serif;color:#243347;overflow-wrap:anywhere}'
        '.brand{font-size:9pt;font-weight:bold;letter-spacing:2px;color:#187b80;margin:0 0 18px}'
        'h1{font-size:27pt;line-height:1.15;letter-spacing:-.7px;color:#142b45;margin:0 0 24px}'
        'h2{font-size:17pt;line-height:1.25;margin:27px 0 11px;padding-top:9px;border-top:2px solid #dce9eb;color:#164c5b}'
        'h3,h4{font-size:13pt;line-height:1.3;margin:21px 0 8px;color:#164c5b}'
        'h1,h2,h3,h4{break-after:avoid}p{margin:0 0 11px;orphans:3;widows:3}'
        'a{color:#116c86;text-decoration:none}ul,ol{padding-left:23px;margin:8px 0 14px}li{margin-bottom:6px}'
        'table{border-collapse:collapse;width:100%;font-size:9pt;line-height:1.4;margin:15px 0;table-layout:fixed}'
        'thead{display:table-header-group}tr{break-inside:avoid}th{background:#e9f2f3;text-align:left;color:#164c5b}'
        'th,td{border:1px solid #d5e0e4;padding:8px;vertical-align:top}tr:nth-child(even){background:#f6f9fa}'
        'blockquote{margin:15px 0;border-left:3px solid #208a8d;padding:10px 15px;background:#eff6f6}'
        'pre{white-space:pre-wrap;background:#f0f3f6;padding:12px;font-size:9pt;line-height:1.4}'
        'code{font-family:"DejaVu Sans Mono",monospace;font-size:.88em}hr{border:0;border-top:1px solid #d5e0e4;margin:20px 0}'
        '</style></head><body><div class="brand">BRAI · ОБЗОР</div>'+heading+body+'</body></html>')




def render_pdf(content, target):
    """Записать полный текст в PDF, используя существующий личный Chrome."""
    command = [os.environ.get('BRAI_HERMES_NODE_EXECUTABLE', '/usr/local/bin/node'),
               str(Path(__file__).with_name('render_long_reply.mjs'))]
    subprocess.run(command, input=json.dumps({'html': report_html(content, 'Полный ответ'), 'path': str(target)}),
                   text=True, capture_output=True, check=True, timeout=45)
    if not Path(target).read_bytes().startswith(b'%PDF-'):
        raise ValueError('REPORT_PDF_INVALID')
