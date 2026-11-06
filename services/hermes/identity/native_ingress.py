# ABOUTME: Подключает личные процессы к штатной Telegram factory Hermes.
# ABOUTME: Доверенная фабрика задаётся оператором; при её отсутствии вход закрыт.
"""Плагин не запускает polling и не создаёт пользовательский agent в ingress."""
from contextvars import ContextVar
from .ingress import install

_admitted_message = ContextVar('brai_identity_admitted_message', default=None)


def _message_identity(message):
    if message is None:
        return None
    user, chat = getattr(message, 'from_user', None), getattr(message, 'chat', None)
    sender, chat_id = str(getattr(user, 'id', '') or ''), str(getattr(chat, 'id', '') or '')
    message_id = str(getattr(message, 'message_id', '') or '')
    if not sender.isascii() or not sender.isdecimal() or not chat_id or not message_id or getattr(user, 'is_bot', False):
        return None
    return sender, chat_id, message_id


def message_admitted(message):
    """Проверить совпадение update, уже допущенного broker в текущем контексте."""
    identity = _message_identity(message)
    return identity is not None and identity == _admitted_message.get()


def register(ctx, *, build_resolver=None, admit_update=None):
    """Зарегистрировать заводской hook до native Telegram polling.

    `build_resolver(adapter, runner)` возвращает async функцию `resolve_bridge(source)`;
    последняя подтверждает привязку и возвращает Bridge. Ошибки закрывают вход.
    """
    if build_resolver is None:
        from .telegram_runtime import create_resolver
        build_resolver = create_resolver
    if admit_update is None:
        from .telegram_runtime import admit_update
    installed = []

    def factory(app, adapter):
        runner = getattr(adapter, 'gateway_runner', None)
        if runner is None or not callable(getattr(runner, '_hm_admit_event', None)):
            raise RuntimeError('Native gateway runner unavailable')
        resolver = build_resolver(adapter, runner)
        if not callable(resolver):
            raise RuntimeError('Trusted ingress resolver unavailable')
        from telegram import Update
        from telegram.ext import ApplicationHandlerStop, TypeHandler
        async def guard(update, context):
            _admitted_message.set(None)
            message = getattr(update, 'effective_message', None)
            identity = _message_identity(message)
            if identity is None:
                raise ApplicationHandlerStop
            try:
                admitted = await admit_update(update, adapter)
            except Exception:
                raise ApplicationHandlerStop from None
            if admitted is not True:
                raise ApplicationHandlerStop
            _admitted_message.set(identity)
        handler = TypeHandler(Update, guard)
        app.add_handler(handler, group=-100)
        original = getattr(adapter, '_brai_identity_dispatch', None)
        try:
            forward = install(runner, adapter, resolver)
        except Exception:
            app.remove_handler(handler, group=-100)
            raise
        adapter._brai_identity_ingress_ready = True
        installed.append((adapter, original, forward, app, handler))

    def close():
        for adapter, original, forward, app, handler in reversed(installed):
            app.remove_handler(handler, group=-100)
            if getattr(adapter, '_brai_identity_dispatch', None) is forward:
                adapter._brai_identity_dispatch = original
                adapter._brai_identity_ingress_ready = False
            forward._brai_restore_authorize()
        installed.clear()

    ctx.register_telegram_handler(factory)
    ctx.on_unload(close)
