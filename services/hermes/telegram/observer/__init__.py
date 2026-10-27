# ABOUTME: Предоставляет локальный журнал Telegram для интерфейса наблюдения.
# ABOUTME: Не отправляет сообщения и не запускает агента.
from .journal import TelegramJournal

__all__ = ["TelegramJournal"]
