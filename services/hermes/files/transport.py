# ABOUTME: Сохраняет происхождение вложений в общем Telegram ingress.
# ABOUTME: Не создаёт FileStore и не открывает пользовательские файлы или publisher.
from contextlib import nullcontext
from hashlib import sha256
import json
from pathlib import Path

class FileError(Exception):
    """Ошибка попытки файловой операции до выбора владельца."""


async def capture(adapter, event):
    """Сохранить исходные ID и подписи перед native объединением альбома."""
    if hasattr(event, '_brai_identity_inputs'):
        return False
    message = str(event.message_id or '')
    paths = list(getattr(event, 'media_urls', []) or [])
    if paths and not message:
        raise FileError('SOURCE_MESSAGE_REQUIRED')
    raw = getattr(event, 'raw_message', None)
    metadata = getattr(event, 'metadata', None) or {}
    group = str(getattr(raw, 'media_group_id', None) or metadata.get('_brai_photo_group') or message)
    if any(not isinstance(path, str) or not Path(path).is_absolute() for path in paths):
        raise FileError('FILES_OWNER_REQUIRED')
    event._brai_identity_inputs = [{'path': path, 'itemId': message + ':' + str(index),
        'caption': event.text or '', 'groupId': group} for index, path in enumerate(paths)]
    return False


async def accept_event(event, admit=True):
    """Принять только transport metadata; личный worker выполнит ingest после owner prepare."""
    if (getattr(event, 'metadata', None) or {}).get('fileSetStatus') == 'incomplete':
        raise FileError('INCOMPLETE_FILE_SET')
    await capture(None, event)
    return True


def track_inbound(event):
    """Transport не создаёт FileStore leases и не регистрирует файловый cleanup."""


def inbound_events(event):
    """Сохранить native transport lifecycle без файловых side effects."""
    return nullcontext(event)


async def capture_authorized(adapter, event):
    """Продолжить transport после сохранения метаданных."""
    await capture(adapter, event)
    return True


def merge_events(existing, event):
    """Сохранить отдельные attachment IDs и подписи при native объединении."""
    existing._brai_identity_inputs = [*getattr(existing, '_brai_identity_inputs', []),
                                     *getattr(event, '_brai_identity_inputs', [])]


def prepare_photo_batch(adapter, event, message):
    """Связать фотографии с native batch без публикации."""
    batch = adapter._photo_batch_key(event, message)
    previous = adapter._pending_photo_batches.get(batch)
    event.metadata = dict(getattr(event, 'metadata', None) or {})
    event.metadata['_brai_photo_group'] = str((previous.metadata or {}).get('_brai_photo_group') or previous.message_id) if previous else str(event.message_id)
    return batch


def batch_key(event, group):
    """Разделить native albums по полному Telegram источнику."""
    source = event.source
    values = [str(getattr(source, name, '') or '') for name in ('platform', 'profile', 'chat_id', 'thread_id', 'user_id')]
    return sha256(json.dumps([values, str(group)], ensure_ascii=False).encode()).hexdigest()


async def steer_active_input(*args, **kwargs):
    """Передать обработку уточнения owner-bound dispatcher."""
    return False


async def wait_prior_media(*args, **kwargs):
    """Native FIFO сохраняет порядок ingress; FileStore существует только у worker."""


def reserve_steer_input(*args, **kwargs):
    """Общий ingress не резервирует состояние агентского хода."""
    return None


def install_adapter(adapter):
    """Не подключать общий FileStore к transport адаптеру."""


def schedule_recovery(adapter):
    """Личные FileStore восстанавливаются в своём worker."""


def __getattr__(name):
    """Закрыть неописанные агентские и файловые операции в общем процессе."""
    raise FileError('FILES_OWNER_REQUIRED')
