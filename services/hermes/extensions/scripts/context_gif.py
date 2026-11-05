# ABOUTME: Запрашивает готовую GIF через подписочный Images endpoint Codex.
# ABOUTME: Сохраняет настройку собеседника без API-ключей, сборки кадров и дневной квоты.
import argparse
import base64
import fcntl
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import uuid
from urllib.parse import urlsplit


class GifError(ValueError):
    """Безопасный код ошибки GIF без содержимого HTTP и секретов."""


def gif_frames(raw):
    """Проверить структуру GIF и вернуть число кадров без перекодирования."""
    if len(raw) > 10 * 1024 * 1024 or raw[:6] not in (b'GIF87a', b'GIF89a') or len(raw) < 13:
        raise GifError('INVALID_GIF')
    width = int.from_bytes(raw[6:8], 'little')
    height = int.from_bytes(raw[8:10], 'little')
    if not width or not height or width * height > 16_000_000:
        raise GifError('INVALID_GIF_SIZE')
    offset = 13 + (3 * 2 ** ((raw[10] & 7) + 1) if raw[10] & 128 else 0)
    count = 0

    def subblocks(position):
        while position < len(raw):
            size = raw[position]
            position += 1
            if not size:
                return position
            position += size
        raise GifError('TRUNCATED_GIF')

    while offset < len(raw):
        tag = raw[offset]
        offset += 1
        if tag == 0x3b:
            if 2 <= count <= 16 and offset == len(raw):
                return count
            break
        if tag == 0x21:
            if offset >= len(raw):
                break
            offset = subblocks(offset + 1)  # Метка расширения, затем блоки.
        elif tag == 0x2c:
            if offset + 9 > len(raw):
                break
            flags = raw[offset + 8]
            offset += 9
            if flags & 128:
                offset += 3 * 2 ** ((flags & 7) + 1)
            if offset >= len(raw):
                break
            offset = subblocks(offset + 1)  # Размер LZW-кода, затем данные.
            count += 1
        else:
            break
    raise GifError('NOT_AN_ANIMATED_GIF')


def native_generate(home, prompt):
    """Получить готовые GIF-байты Codex; не менять профиль и способ авторизации."""
    from tools.image_generation_tool import _get_plugin_provider
    from plugins.image_gen._common import load_image_gen_config
    from agent.codex_headers import codex_cloudflare_headers
    import httpx

    if load_image_gen_config().get('provider') != 'openai-codex':
        raise GifError('CODEX_SUBSCRIPTION_REQUIRED')
    provider = _get_plugin_provider('openai-codex')
    if provider is None or not provider.is_available():
        raise GifError('SUBSCRIPTION_UNAVAILABLE')
    backend = importlib.import_module(type(provider).__module__)
    token, base_url = backend._read_codex_credential()
    if not token:
        raise GifError('SUBSCRIPTION_UNAVAILABLE')
    # Поля output соответствуют codex-rs/codex-api/src/images.rs (Images 2.6).
    path, body = backend._build_image_request(
        prompt=prompt, size='auto', quality='auto')
    body.update(output_format='gif', frame_count=9, frame_duration_ms=200)
    base_url = base_url.rstrip('/')
    endpoint = urlsplit(base_url)
    if (endpoint.scheme != 'https' or endpoint.hostname != 'chatgpt.com'
            or endpoint.path != '/backend-api/codex' or endpoint.query or endpoint.fragment
            or endpoint.username or endpoint.password or endpoint.port not in (None, 443)):
        raise GifError('CODEX_SUBSCRIPTION_ENDPOINT_REQUIRED')
    headers = codex_cloudflare_headers(token, base_url=base_url)
    headers.update({'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                    'x-codex-image-turn-id': str(uuid.uuid4())})
    # Без автоматических повторов: даже потерянный ответ мог расходовать подписку.
    with httpx.Client(timeout=httpx.Timeout(180, connect=30), headers=headers) as client:
        with client.stream('POST', base_url + '/' + path, json=body) as response:
            response.raise_for_status()
            chunks, total = [], 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > 14 * 1024 * 1024:
                    raise GifError('GIF_RESPONSE_TOO_LARGE')
                chunks.append(chunk)
            payload = json.loads(b''.join(chunks))
    encoded = payload['data'][0]['b64_json']
    raw = base64.b64decode(encoded, validate=True)
    frames = gif_frames(raw)  # PNG с расширением .gif не проходит.
    cache = home / 'cache/generated/images'
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (uuid.uuid4().hex + '.gif')
    with target.open('xb') as output:
        output.write(raw)
    return {'success': True, 'image': str(target), 'provider': 'openai-codex',
            'model': 'server-managed', 'method': 'native-gif', 'frames': frames,
            'mime_type': 'image/gif', 'published': False}


def run(home, scope, action, prompt='', generate=native_generate):
    """Изменить настройку или выполнить одну попытку под блокировкой собеседника.

    off запрещает только auto; once не включает автоматические GIF обратно.
    scope берётся из доверенного контекста, а не из текста чужого сообщения.
    """
    if not scope.strip() or len(scope) > 512:
        raise GifError('SCOPE_REQUIRED')
    if action not in ('status', 'rare', 'off', 'auto', 'once'):
        raise GifError('INVALID_ACTION')
    if action in ('auto', 'once') and (not prompt.strip() or len(prompt) > 4000):
        raise GifError('PROMPT_REQUIRED_MAX_4000')
    root = home / 'usercustom/userdata/settings/context-gifs'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = hashlib.sha256(scope.encode()).hexdigest()
    path = root / (key + '.json')
    with (root / (key + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(path.read_text()) if path.exists() else {'mode': 'rare'}
        if state.get('mode') not in ('rare', 'off'):
            raise GifError('INVALID_SETTINGS')
        if action in ('rare', 'off'):
            state['mode'] = action
            pending = path.with_suffix('.pending')
            pending.write_text(json.dumps(state), encoding='utf-8')
            pending.chmod(0o600)
            pending.replace(path)
        if action == 'auto' and state['mode'] == 'off':
            return {'success': False, 'skipped': 'disabled'}
        if action in ('auto', 'once'):
            return generate(home, prompt)
        return {'success': True, 'mode': state['mode']}


def main():
    """Выдать JSON без секретов и исходных исключений библиотек."""
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('status', 'rare', 'off', 'auto', 'once'))
    parser.add_argument('--scope', required=True)
    parser.add_argument('--prompt', default='')
    parser.add_argument('--engine-root', type=Path)
    args = parser.parse_args()
    try:
        if args.engine_root:
            sys.path.insert(0, str(args.engine_root.resolve(strict=True)))
        home = Path(os.environ['HERMES_HOME']).resolve(strict=True)
        result = run(home, args.scope, args.action, args.prompt)
    except GifError as exc:
        result = {'success': False, 'error': str(exc)}
    except BlockingIOError:
        result = {'success': False, 'skipped': 'busy'}
    except Exception as exc:
        result = {'success': False, 'error': 'GIF_OPERATION_FAILED', 'error_type': type(exc).__name__}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('success') or result.get('skipped') else 1


if __name__ == '__main__':
    sys.exit(main())
