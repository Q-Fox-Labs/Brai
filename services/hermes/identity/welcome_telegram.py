# ABOUTME: Передаёт отдельному Welcome только приватные сообщения проверенного Telegram-отправителя.
# ABOUTME: Роут не передаёт фото, документы, подписи или credentials Telegram.
from base64 import urlsafe_b64encode
from io import BytesIO
import json
import os
from pathlib import Path
import re

from .ordinary_admission import message_thread


def enabled():
    """Проверить наличие настроенного оператором адреса Welcome."""
    return bool(os.environ.get('BRAI_WELCOME_URL'))


def dialogue_id(bot, route):
    """Получить стабильный ID личной темы Telegram для Welcome и гостя."""
    parts = (str(bot), str(route[0]), str(route[1] or 0))
    if all(re.fullmatch(r'[0-9]{1,20}', part) for part in parts):
        return 'telegram:' + ':'.join(parts)
    return None


def welcome_user(profile):
    """Распознать посетителя без предоставления доступа к штатному worker."""
    return profile.get('role') == 'welcome' and profile.get('status') == 'provisioning'


def filtered_payload(update, payload, snapshot):
    """Отбросить вложения и подписи Welcome до записи транспортного журнала."""
    if not enabled() or snapshot.get('state') != 'unregistered':
        return payload
    chat = getattr(update, 'effective_chat', None)
    user = getattr(update, 'effective_user', None)
    if getattr(chat, 'type', None) != 'private' or getattr(chat, 'id', None) != getattr(user, 'id', None):
        return payload

    retained = {'message_id', 'from', 'chat', 'date', 'message_thread_id', 'is_topic_message', 'text', 'entities'}

    def message_input(raw):
        sanitized = {key: value for key, value in raw.items() if key in retained}
        if not isinstance(raw.get('text'), str):
            for key in ('voice', 'audio'):
                audio = raw.get(key)
                if not isinstance(audio, dict):
                    continue
                seconds = audio.get('duration')
                sanitized[key] = (audio if isinstance(seconds, (int, float)) and 0 < seconds <= 600
                                  else {'duration': seconds})
                break
        return sanitized

    result = dict(payload)
    for key in ('message', 'edited_message'):
        if isinstance(result.get(key), dict):
            result[key] = message_input(result[key])
    callback = result.get('callback_query')
    if isinstance(callback, dict) and isinstance(callback.get('message'), dict):
        result['callback_query'] = {**callback, 'message': message_input(callback['message'])}
    return result


async def dispatch(update, adapter, reply, *, pending_guest=False):
    """Ответить через исходный Telegram bot только для личного update Welcome."""
    if not enabled():
        return False
    chat = getattr(update, 'effective_chat', None)
    user = getattr(update, 'effective_user', None)
    message = getattr(update, 'effective_message', None)
    if getattr(chat, 'type', None) != 'private' or getattr(chat, 'id', None) != getattr(user, 'id', None) or message is None:
        return False
    query = getattr(update, 'callback_query', None)
    text = getattr(message, 'text', None)
    if query is not None and getattr(query, 'data', None) != 'welcome.submit':
        return False
    incoming_audio = getattr(message, 'voice', None) or getattr(message, 'audio', None)
    raw_duration = getattr(incoming_audio, 'duration', None)
    duration = raw_duration.total_seconds() if hasattr(raw_duration, 'total_seconds') else raw_duration
    kind = 'callback' if query is not None else 'text' if text is not None else 'audio' if incoming_audio else 'file'
    if pending_guest:
        kind = 'pending'
    event = {'kind': kind, 'botId': str(adapter._bot.id), 'updateId': str(update.update_id),
             'telegramId': str(user.id), 'name': ''}
    if not pending_guest:
        event['name'] = str(getattr(user, 'full_name', None) or 'Посетитель')[:200]
        event['username'] = getattr(user, 'username', None)
    target_thread = message_thread(chat, message)
    thread = int(target_thread) if target_thread else None
    if thread is not None:
        event['threadId'] = str(thread)
    if kind == 'text' and re.match(r'^/start(?:@[\w]+)?(?:\s|$)', text):
        try:
            photos = await adapter._bot.get_user_profile_photos(user_id=user.id, limit=1)
            if photos.photos and photos.photos[0]:
                event['avatarFileId'] = photos.photos[0][0].file_id
        except Exception:
            pass
    if kind == 'callback':
        event['action'] = 'submit'
    elif kind == 'text':
        event['text'] = text
    elif kind == 'audio':
        event['duration'] = duration

    from httpx import AsyncClient
    url = os.environ['BRAI_WELCOME_URL'].rstrip('/')
    secret = Path(os.environ['BRAI_WELCOME_INGRESS_SECRET_FILE']).read_text().strip()
    headers = {'authorization': 'Bearer ' + secret}
    async with AsyncClient(timeout=None, follow_redirects=False) as client:
        if kind == 'audio' and isinstance(duration, (int, float)) and 0 < duration <= 600:
            file_obj = await incoming_audio.get_file()
            audio = bytes(await file_obj.download_as_bytearray())
            event['mimeType'] = getattr(incoming_audio, 'mime_type', None)
            sent = await client.post(url + '/telegram-audio', content=audio, headers={
                **headers, 'x-brai-welcome-event': urlsafe_b64encode(json.dumps(event).encode()).decode()})
        else:
            sent = await client.post(url + '/telegram', json=event, headers=headers)
        sent.raise_for_status()
        outcome = sent.json()
        if outcome.get('pass'):
            return False
        if query is not None:
            await query.answer()
        result = outcome.get('text')
        if not isinstance(result, str) or not result:
            raise ValueError('Invalid Welcome response')
        if outcome.get('button') == 'submit':
            from telegram import InlineKeyboardButton, InlineKeyboardMarkup
            await adapter._bot.send_message(chat_id=chat.id, text=result, message_thread_id=thread,
              reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton('Отправить заявку', callback_data='welcome.submit')]]))
        else:
            if await reply(adapter, str(chat.id), message, result, thread_override=thread or 0) is not True:
                raise RuntimeError('Welcome Telegram delivery unconfirmed')
        audio_artifacts = outcome.get('audio') or []
        media = [('image', outcome.get('image'))]
        media.extend(('audio', artifact) for artifact in audio_artifacts)
        for kind, artifact in media:
            if not isinstance(artifact, str) or not re.fullmatch(r'[0-9a-f-]{36}', artifact):
                continue
            downloaded = await client.get(url + '/media', params={
                'telegramId': str(user.id), 'artifactId': artifact
            }, headers=headers)
            downloaded.raise_for_status()
            data = BytesIO(downloaded.content)
            if kind == 'image':
                data.name = 'welcome.png'
                await adapter._bot.send_photo(chat_id=chat.id, message_thread_id=thread, photo=data)
            else:
                data.name = 'welcome.ogg'
                await adapter._bot.send_voice(chat_id=chat.id, message_thread_id=thread, voice=data)
    return True
