# ABOUTME: Запрашивает заголовок и значок через закрытый Unix-сокет Диалогов.
# ABOUTME: Оставляет адрес темы и custom emoji IDs в Telegram-плагине.
import asyncio
import json
import unicodedata


def topic_update(message, edited=False):
    """Выделить Telegram-событие создания, правки или первого входа темы."""
    created = getattr(message, 'forum_topic_created', None)
    thread = getattr(message, 'message_thread_id', None)
    if thread is None and created is not None:
        thread = getattr(message, 'message_id', None)
    if type(thread) is not int or thread <= 1:
        return None
    if getattr(message, 'forum_topic_edited', None) is not None:
        return thread, 'cancel', ''
    if created is not None:
        implicit = getattr(created, 'is_name_implicit', None)
        if implicit is None:
            implicit = (getattr(created, 'api_kwargs', None) or {}).get('is_name_implicit')
        return thread, 'create' if implicit is True else 'cancel', ''
    if edited:
        return None
    text = getattr(message, 'text', None) or getattr(message, 'caption', None)
    if not text:
        text = next((label for field, label in (('photo', 'Фотография'), ('voice', 'Голосовое сообщение'),
            ('audio', 'Аудиозапись'), ('video', 'Видео'), ('document', 'Документ'), ('sticker', 'Стикер'),
            ('location', 'Геопозиция'), ('venue', 'Место')) if getattr(message, field, None)), '')
    if not isinstance(text, str) or not text.strip():
        return None
    return thread, 'claim', text


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
    return validate_suggestion(result, icons)


def validate_suggestion(result, icons):
    """Сверить предложение и преобразовать индекс в фактический Telegram ID."""
    if not isinstance(result, dict) or set(result) != {'title', 'icon'}:
        raise ValueError('TOPIC_SUGGESTION_FAILED')
    title, icon = result['title'], result['icon']
    if (not isinstance(title, str) or not 1 <= len(title.strip()) <= 60
            or any(unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} for char in title)):
        raise ValueError('TOPIC_RESULT_INVALID')
    if not icons and icon is None:
        return {'title': title.strip()}
    if type(icon) is not int or not 0 <= icon < len(icons):
        raise ValueError('TOPIC_RESULT_INVALID')
    return {'title': title.strip(), 'iconId': icons[icon]['id']}
