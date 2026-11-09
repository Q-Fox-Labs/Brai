# ABOUTME: Создаёт домашнюю тему Telegram только для доверенной фоновой доставки.
# ABOUTME: Сохраняет неопределённые исходы и не повторяет создание вслепую.
"""Автоматическая тема личного аккаунта; Telegram token остаётся в ingress."""
import asyncio
import re


def topic_missing(error):
    """Распознать только точные ответы Telegram об отсутствующей теме."""
    return str(error).strip().lower().removeprefix('bad request: ') in {
        'message thread not found', 'topic_deleted', 'topic not found', 'topic_id_invalid'}


def rejected(error):
    """Отличить явный отказ Bot API от неизвестного сетевого исхода."""
    from telegram.error import BadRequest, Forbidden, RetryAfter
    return isinstance(error, (BadRequest, Forbidden, RetryAfter))


class NotificationTopics:
    """Одна тема на owner/chat; запись pending запрещает повтор после crash/timeout."""

    def __init__(self, ledger, bot, authorize=None):
        self.ledger, self.bot, self.authorize = ledger, bot, authorize
        self.lock = asyncio.Lock()
        ledger.db.execute('CREATE TABLE IF NOT EXISTS notification_topics ('
            'owner TEXT, chat TEXT, thread TEXT, state TEXT NOT NULL, PRIMARY KEY(owner,chat))')

    async def ensure(self, profile, chat, *, replace=None, validate=False):
        """Получить тему или создать её после атомарной резервации; unknown не повторять."""
        if not re.fullmatch(r'[1-9][0-9]{0,19}', chat):
            raise PermissionError('Notifications require a private account')
        owner, db = self.ledger.owner(profile), self.ledger.db
        async with self.lock:
            row = db.execute('SELECT thread,state FROM notification_topics WHERE owner=? AND chat=?',
                             (owner, chat)).fetchone()
            if row and row[1] != 'ready':
                raise RuntimeError('Notification topic creation outcome unknown')
            if row and (replace is None or row[0] != replace):
                if not validate:
                    return row[0]
                try:
                    confirmed = await self.bot().edit_forum_topic(chat_id=int(chat),
                        message_thread_id=int(row[0]), name='Уведомления',
                        connect_timeout=5, read_timeout=15, write_timeout=15, pool_timeout=5)
                    if confirmed is not True:
                        raise ValueError('Unconfirmed notification topic probe')
                    return row[0]
                except Exception as error:
                    if not rejected(error):
                        raise
                    if str(error).strip().lower() == 'topic_not_modified':
                        return row[0]
                    if not topic_missing(error):
                        raise
            create = getattr(self.bot(), 'create_forum_topic', None)
            if not callable(create):
                raise RuntimeError('Notification topic transport unavailable')
            if self.authorize is not None:
                await self.authorize(profile, chat)
            if row:
                reserved = db.execute("UPDATE notification_topics SET thread=NULL,state='pending' "
                    "WHERE owner=? AND chat=? AND thread=? AND state='ready'",
                    (owner, chat, row[0])).rowcount
            else:
                reserved = db.execute("INSERT OR IGNORE INTO notification_topics VALUES (?,?,NULL,'pending')",
                                      (owner, chat)).rowcount
            if reserved != 1:
                raise RuntimeError('Notification topic creation already reserved')
            try:
                topic = await create(chat_id=int(chat), name='Уведомления',
                    connect_timeout=5, read_timeout=15, write_timeout=15, pool_timeout=5)
            except BaseException as error:
                if isinstance(error, Exception) and rejected(error):
                    db.execute("DELETE FROM notification_topics WHERE owner=? AND chat=? AND state='pending'",
                               (owner, chat))
                # AIDEV-NOTE: Telegram не имеет idempotency key для createForumTopic.
                # Pending сохраняется до сверки, даже после перезапуска, чтобы не плодить темы.
                raise
            thread = getattr(topic, 'message_thread_id', None)
            if type(thread) is not int or thread < 1:
                raise ValueError('Missing notification topic receipt')
            thread = str(thread)
            metadata = self.metadata(thread)
            self.ledger.admit(profile, (chat, thread), metadata)
            db.execute("UPDATE notification_topics SET thread=?,state='ready' WHERE owner=? AND chat=?",
                       (thread, owner, chat))
            return thread

    @staticmethod
    def metadata(thread):
        """Сохранить номер темы и запретить native fallback в корень лички."""
        return {'thread_id': thread, 'telegram_dm_topic_created_for_send': True}

    async def deliver(self, profile, chat, operation, *, text):
        """Повторить текст только после явного отказа без доставленных частей."""
        thread = await self.ensure(profile, chat, validate=not text)
        for attempt in range(2):
            try:
                result = await operation((chat, thread), self.metadata(thread))
            except Exception as error:
                if not rejected(error) or not topic_missing(error):
                    raise
                # Файлы могут иметь уже доставленные подписи: весь набор не повторяем.
                if not text:
                    raise
                result = {'success': False, 'error': str(error)}
            partial = result.get('raw_response') or {}
            missing = (result.get('success') is False and topic_missing(result.get('error', ''))
                       and not result.get('message_id') and not result.get('continuation_message_ids')
                       and not partial.get('partial_overflow') and not partial.get('delivered_chunks')
                       and not partial.get('delivered_message_ids'))
            if not text or not missing or attempt:
                return result
            thread = await self.ensure(profile, chat, replace=thread)
