#!/usr/bin/env python3
"""Strict Cyrillic input adapter for local Silero; outputs Telegram Opus."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import shutil
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--input', required=True)
p.add_argument('--output', required=True)
p.add_argument('--voice', default='aidar', choices=['aidar', 'baya', 'kseniya', 'eugene', 'xenia'])
a = p.parse_args()
text = Path(a.input).read_text(encoding='utf-8').strip()
# Fail rather than silently drop numbers, foreign words or meaningful symbols.
if not text or re.search(r'[^А-Яа-яЁё\s.,!?;:—–\-…«»\"\'()]', text):
    raise SystemExit('Подготовьте кириллический текст: числа английскими словами в кириллице; иностранные слова переведите или транскрибируйте; символы раскройте словами.')
text = re.sub(r'[«»\"\'()]', '', text)
out = Path(a.output).expanduser()
out.parent.mkdir(parents=True, exist_ok=True)
scratch = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))) / 'cache' / 'scratch'
scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='silero-', dir=scratch) as tmp:
    wav = str(Path(tmp) / 'speech.wav')
    env = dict(os.environ, TMPDIR=str(scratch))
    subprocess.run([shutil.which('silero-tts') or 'silero-tts', text, '--speaker', a.voice, '--sample-rate', '48000', '-o', wav], check=True, env=env)
    if out.suffix.lower() == '.wav':
        out.write_bytes(Path(wav).read_bytes())
    else:
        subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-f', 'ogg', str(out)], check=True, env=env)
print(str(out))
