# ABOUTME: Наблюдает подтверждённые исходящие текстовые сообщения Telegram.
# ABOUTME: Не меняет результат отправки и не использует исходящие запросы других ботов.
from functools import wraps
import inspect
import logging
from types import SimpleNamespace


def install(bot, observer):
    """Охватить прямые вызовы Bot и вернуть функцию восстановления методов."""
    cls = type(bot)
    methods = {}

    def uninstall():
        for name, (original, wrapped, owned) in methods.items():
            if cls.__dict__.get(name) is wrapped:
                if owned:
                    setattr(cls, name, original)
                else:
                    delattr(cls, name)

    try:
        _install_methods(bot, observer, cls, methods)
    except Exception:
        uninstall()
        raise
    return uninstall


def _install_methods(bot, observer, cls, methods):
    for name in ("send_message", "edit_message_text"):
        original = getattr(cls, name, None)
        if original is None:
            continue
        signature = inspect.signature(original)

        @wraps(original)
        async def wrapped(instance, *args, __original=original, __signature=signature, **kwargs):
            result = await __original(instance, *args, **kwargs)
            if instance is not bot or observer.closed:
                return result
            try:
                values = __signature.bind(instance, *args, **kwargs).arguments
                chat = getattr(getattr(result, "chat", None), "id", None) or values.get("chat_id")
                mid = getattr(result, "message_id", None) or values.get("message_id")
                thread = getattr(result, "message_thread_id", None) or values.get("message_thread_id") or ""
                text = getattr(result, "text", None) or values.get("text") or ""
                if chat and mid and isinstance(text, str):
                    await observer.observe_send(chat, {"message_thread_id": thread}, text,
                        SimpleNamespace(success=True, message_id=mid))
            except Exception:
                logging.getLogger(__name__).warning("BRAI_TELEGRAM_OBSERVER_WRITE_FAILED")
            return result

        methods[name] = (original, wrapped, name in cls.__dict__)
        setattr(cls, name, wrapped)
