# ABOUTME: Распознаёт и нормализует голосовые сообщения через Groq.
# ABOUTME: Читает ключ только из защищённого файла целевого профиля.
"""Groq Whisper + gpt-oss-120b; no logging of credentials or speech."""
import json
import os
from pathlib import Path
import re
import ssl
import stat
import urllib.request
import urllib.error
import uuid
from agent.transcription_provider import TranscriptionProvider
from hermes_constants import get_hermes_home

PROFILE_HOME = Path(__file__).resolve().parents[2]
SECRET_FILE = Path('/etc/.secrets/groq.env')
MODEL = 'openai/gpt-oss-120b'
MAX_AUDIO = 25 * 1024 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
MAX_TEXT = 120000

class SafeFailure(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def read_key_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) != 0o600:
            raise SafeFailure()
        content = f.read(4097)
    if len(content) > 4096:
        raise SafeFailure()
    match = re.fullmatch(rb'GROQ_API_KEY=(gsk_[A-Za-z0-9_-]{32,124})\n?', content)
    if not match:
        raise SafeFailure()
    return match.group(1).decode('ascii')

def read_key():
    if Path(get_hermes_home()).resolve() != PROFILE_HOME:
        raise SafeFailure()
    # AIDEV-NOTE: Путь задаёт окружение службы; прежний путь остаётся значением по умолчанию.
    secret_file = Path(os.environ.get("GROQ_VOICE_SECRET_FILE", str(SECRET_FILE)))
    if not secret_file.is_absolute():
        raise SafeFailure()
    return read_key_file(secret_file)

def post(path, key, body, kind):
    if path not in ('/audio/transcriptions', '/chat/completions'):
        raise SafeFailure()
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request('https://api.groq.com/openai/v1' + path, data=body,
        headers={'Authorization': 'Bearer ' + key, 'User-Agent': 'Hermes-Groq-Voice/1.0',
                 'Content-Type': kind, 'Accept': 'application/json'}, method='POST')
    try:
        with opener.open(request, timeout=60) as response:
            if response.status != 200:
                raise SafeFailure()
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise SafeFailure()
            return json.loads(raw)
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        raise SafeFailure() from None

def audio_body(file_path, model, language, prompt):
    suffix = Path(file_path).suffix.lower()
    media = {'.ogg':'audio/ogg', '.oga':'audio/ogg', '.wav':'audio/wav', '.mp3':'audio/mpeg',
             '.m4a':'audio/mp4', '.mp4':'audio/mp4', '.webm':'audio/webm', '.flac':'audio/flac'}
    if suffix not in media or model not in ('whisper-large-v3-turbo', 'whisper-large-v3'):
        raise SafeFailure()
    fd = os.open(file_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        size = os.fstat(stream.fileno()).st_size
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or not 0 < size <= MAX_AUDIO:
            raise SafeFailure()
        audio = stream.read(MAX_AUDIO + 1)
    if len(audio) > MAX_AUDIO:
        raise SafeFailure()
    boundary = 'HermesVoice' + uuid.uuid4().hex
    fields = {'model':model, 'response_format':'json'}
    if language:
        if not re.fullmatch(r'[A-Za-z-]{2,16}', language):
            raise SafeFailure()
        fields['language'] = language
    if isinstance(prompt, str) and prompt.strip():
        fields['prompt'] = prompt[:896]
    parts = []
    for name, value in fields.items():
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode())
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio{suffix}"\r\nContent-Type: {media[suffix]}\r\n\r\n').encode())
    parts.extend([audio, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary

class GroqVoice(TranscriptionProvider):
    name = 'groq-normalized'
    display_name = 'Groq — распознавание и нормализация'
    def __init__(self, key_reader=read_key, sender=post):
        self.key_reader, self.sender = key_reader, sender
    def list_models(self):
        return [{'id':'whisper-large-v3-turbo', 'display':'Groq Whisper large v3 turbo'},
                {'id':'whisper-large-v3', 'display':'Groq Whisper large v3'}]
    def is_available(self):
        try:
            self.key_reader()
            return True
        except Exception:
            return False
    def normalize(self, text, key=None):
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise SafeFailure()
        system = Path(__file__).with_name('normalization.txt').read_text(encoding='utf-8')
        payload = {'model':MODEL, 'temperature':0, 'max_completion_tokens':8192,
                   'reasoning_effort':'low', 'stream':False,
                   'messages':[{'role':'system','content':system}, {'role':'user','content':text}]}
        result = self.sender('/chat/completions', key or self.key_reader(),
                             json.dumps(payload,ensure_ascii=False).encode(), 'application/json')
        cleaned = result['choices'][0]['message']['content']
        if not isinstance(cleaned, str) or not cleaned.strip() or len(cleaned) > MAX_TEXT:
            raise SafeFailure()
        cleaned = cleaned.strip()
        if cleaned.startswith('```') or re.match(r"(?i)^(here(?:'s| is)|cleaned (?:text|transcript):|вот (?:очищенный|исправленный)|исправленный текст:)", cleaned):
            raise SafeFailure()
        choice = result['choices'][0]
        if choice.get('finish_reason') in ('length', 'content_filter'):
            raise SafeFailure()
        return cleaned
    def transcribe(self, file_path, *, model=None, language=None, **extra):
        try:
            body, kind = audio_body(file_path, model or self.default_model(), language or 'ru', extra.get('prompt'))
            key = self.key_reader()
            result = self.sender('/audio/transcriptions', key, body, kind)
            raw = result['text']
            if not isinstance(raw, str) or len(raw) > MAX_TEXT:
                raise SafeFailure()
            raw = raw.strip()
        except Exception:
            return {'success':False, 'transcript':'', 'provider':self.name,
                    'error':'Не удалось распознать аудио через Groq. Попробуйте ещё раз.'}
        normalized = False
        transcript = raw
        if raw:
            try:
                transcript = self.normalize(raw, key)
                normalized = True
            except Exception:
                pass
        return {'success':True, 'transcript':transcript, 'provider':self.name,
                'normalized':normalized, 'normalization_model':MODEL}
