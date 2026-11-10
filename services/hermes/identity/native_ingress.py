# ABOUTME: Подключает личные процессы к штатной Telegram factory Hermes.
# ABOUTME: Доверенная фабрика задаётся оператором; при её отсутствии вход закрыт.
"""Плагин не запускает polling и не создаёт пользовательский agent в ingress."""
import asyncio
import logging
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
    closing = set()

    def closed(task):
        closing.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logging.getLogger(__name__).warning('BRAI_IDENTITY_INGRESS_CLOSE_FAILED')

    def schedule_close(close, loop):
        def start():
            task = loop.create_task(close())
            closing.add(task)
            task.add_done_callback(closed)
        if loop.is_running():
            loop.call_soon_threadsafe(start)

    def factory(app, adapter):
        runner = getattr(adapter, 'gateway_runner', None)
        if runner is None or not callable(getattr(runner, '_hm_admit_event', None)):
            raise RuntimeError('Native gateway runner unavailable')
        resolver = build_resolver(adapter, runner)
        journal = getattr(resolver, 'journal', None)
        if journal is not None:
            journal.install(app.bot)
        if not callable(resolver):
            raise RuntimeError('Trusted ingress resolver unavailable')
        from telegram import Update
        from telegram.ext import ApplicationHandlerStop, TypeHandler
        async def guard(update, context):
            _admitted_message.set(None)
            if getattr(update, 'callback_query', None) is not None or getattr(update, 'inline_query', None) is not None:
                # AIDEV-NOTE: Сообщение callback отправлено ботом; Root проверяет
                # нажавшего, owner сообщения и свежий Auth до личной обработки.
                admit = getattr(adapter, '_brai_identity_interactive_admit', None)
                dispatch = getattr(adapter, '_brai_identity_interactive', None)
                if not callable(admit) or not callable(dispatch):
                    raise ApplicationHandlerStop
                try:
                    if await admit(update) is not True:
                        raise ApplicationHandlerStop
                    await dispatch(update)
                except Exception:
                    raise ApplicationHandlerStop from None
                raise ApplicationHandlerStop
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
        interactive_original = tuple(getattr(adapter, name, None) for name in (
            '_brai_identity_interactive_admit', '_brai_identity_interactive'))
        try:
            forward = install(runner, adapter, resolver)
        except Exception:
            app.remove_handler(handler, group=-100)
            raise
        adapter._brai_identity_ingress_ready = True
        installed.append((adapter, original, forward, app, handler, asyncio.get_running_loop(), interactive_original))

    def close():
        for adapter, original, forward, app, handler, loop, interactive_original in reversed(installed):
            app.remove_handler(handler, group=-100)
            if getattr(adapter, '_brai_identity_dispatch', None) is forward:
                adapter._brai_identity_dispatch = original
                adapter._brai_identity_ingress_ready = False
                for name, value in zip(('_brai_identity_interactive_admit', '_brai_identity_interactive'), interactive_original):
                    setattr(adapter, name, value)
            forward._brai_restore_authorize()
            retire_resolver = getattr(forward, '_brai_retire_resolver', None)
            if callable(retire_resolver):
                retire_resolver()
            close_resolver = getattr(forward, '_brai_close_resolver', None)
            if callable(close_resolver):
                schedule_close(close_resolver, loop)
        installed.clear()

    ctx.register_telegram_handler(factory)
    ctx.on_unload(close)
