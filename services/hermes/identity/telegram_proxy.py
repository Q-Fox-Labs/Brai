# ABOUTME: Передаёт ограниченные Telegram UI операции доверенному ingress по IPC.
# ABOUTME: Не создаёт Bot, HTTP-клиент, token или собственный polling.
"""Tokenless порт для native Telegram prompt и callback handlers."""
from datetime import datetime, timedelta
from enum import Enum
import math

from .scope import delivery_scope

TELEGRAM_API_METHODS = frozenset({
    'send_message', 'edit_message_text', 'edit_message_reply_markup',
    'delete_message', 'answer_callback_query', 'answer_inline_query',
})


def telegram_payload(value):
    """Преобразовать PTB значения в JSON без файлов и произвольных объектов."""
    from telegram import TelegramObject
    from telegram._utils.defaultvalue import DefaultValue
    if isinstance(value, DefaultValue):
        return telegram_payload(value.value)
    if isinstance(value, Enum):
        return telegram_payload(value.value)
    if isinstance(value, TelegramObject):
        return telegram_payload(value.to_dict())
    if isinstance(value, datetime):
        return int(value.timestamp())
    if isinstance(value, timedelta):
        return value.total_seconds()
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    if isinstance(value, (list, tuple)):
        return [telegram_payload(item) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: telegram_payload(item) for key, item in value.items()}
    raise ValueError('Unsupported Telegram payload')


class BotProxy:
    """PTB shortcuts используют только явные UI методы этого IPC-порта."""
    def __init__(self, peer):
        self._peer = peer

    async def _call(self, method, payload, *, message=False):
        if method not in TELEGRAM_API_METHODS:
            raise PermissionError('Telegram method denied')
        result = await self._peer.call('telegram_api', {
            'method': method, 'payload': telegram_payload(payload),
            'scope_id': delivery_scope.get()})
        if message:
            if not isinstance(result, dict):
                raise ValueError('Invalid Telegram message receipt')
            from telegram import Message
            return Message.de_json(result, self)
        if result is not True:
            raise ValueError('Invalid Telegram operation receipt')
        return True

    async def send_message(self, **payload):
        """Отправить native prompt; вернуть фактический Telegram Message."""
        return await self._call('send_message', payload, message=True)

    async def edit_message_text(self, **payload):
        """Изменить только подтверждённое Root сообщение пользователя."""
        return await self._call('edit_message_text', payload, message=True)

    async def edit_message_reply_markup(self, **payload):
        """Изменить кнопки только подтверждённого Root сообщения."""
        return await self._call('edit_message_reply_markup', payload, message=True)

    async def delete_message(self, **payload):
        """Удалить только подтверждённое Root сообщение."""
        return await self._call('delete_message', payload)

    async def answer_callback_query(self, **payload):
        """Подтвердить только проверенный Root callback query."""
        return await self._call('answer_callback_query', payload)

    async def answer_inline_query(self, **payload):
        """Ответить на проверенный Root inline query личным каталогом команд."""
        return await self._call('answer_inline_query', payload)
