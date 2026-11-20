# ABOUTME: Запрашивает заголовок и значок через закрытый Unix-сокет Диалогов.
# ABOUTME: Оставляет адрес темы и custom emoji IDs в Telegram-плагине.
import asyncio
import json
import unicodedata


async def suggest(socket, request, icons):
    reader, writer = await asyncio.open_unix_connection(socket)
    try:
        body = {'request': request, 'icons': [icon['emoji'] for icon in icons]}
        writer.write(json.dumps(body, ensure_ascii=False).encode())
        await writer.drain()
        writer.write_eof()
        result = json.loads(await reader.read())
    finally:
        writer.close()
        await writer.wait_closed()
    if not isinstance(result, dict) or set(result) != {'title', 'icon'}:
        raise ValueError('TOPIC_SUGGESTION_FAILED')
    title, icon = result['title'], result['icon']
    if (not isinstance(title, str) or not 1 <= len(title.strip()) <= 60
            or any(unicodedata.category(char) in {'Cc', 'Zl', 'Zp'} for char in title)
            or type(icon) is not int or not 0 <= icon < len(icons)):
        raise ValueError('TOPIC_RESULT_INVALID')
    return {'title': title.strip(), 'iconId': icons[icon]['id']}
