# ABOUTME: Подключает личные процессы к штатной Telegram factory Hermes.
# ABOUTME: Доверенная фабрика задаётся оператором; при её отсутствии вход закрыт.
"""Плагин не запускает polling и не создаёт пользовательский agent в ingress."""
import asyncio
import hashlib
import logging
import os
from pathlib import Path
import uuid
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



class ReleaseGate:
    """Удерживать следующий Telegram poll до явного завершения операции."""
    def __init__(self, app):
        self.app = app
        self.operation = None
        self.held = asyncio.Event()
        self.unlocked = asyncio.Event()
        self.unlocked.set()
        self.drain = None
        self.restore = None
        self.resolver = None
        self.committed = False
        self.lock = asyncio.Lock()

    def install(self):
        """Установить gate на Bot данного приложения до начала polling."""
        bot = self.app.bot
        cls = type(bot)
        original = cls.get_updates
        owned = 'get_updates' in cls.__dict__
        async def gated(instance, *args, **kwargs):
            cleanup = False
            if instance is bot and self.operation is not None:
                timeout = kwargs.get('timeout')
                seconds = timeout.total_seconds() if callable(getattr(timeout, 'total_seconds', None)) else timeout
                updater = getattr(self.app, 'updater', None)
                # PTB stop отменяет удержанный action и отдельно подтверждает обработанный offset.
                cleanup = self.committed and updater is not None and updater.running is False and seconds == 0
                if not cleanup:
                    self.held.set()
                    await self.unlocked.wait()
            mirror = getattr(self.resolver, 'mirror', None)
            hydrate = getattr(mirror, 'hydrate', None)
            if instance is bot and callable(hydrate) and not cleanup:
                await hydrate()
            updates = await original(instance, *args, **kwargs)
            if instance is bot and mirror is not None and updates:
                # PTB меняет offset после возврата: все profile commits должны успеть раньше.
                await mirror.capture(updates, bot.id)
                if cleanup:
                    # PTB cleanup не помещает возвращённые updates в очередь.
                    # При отмене остановки следующий poll обязан восстановить их.
                    mirror.hydrated = False
            return updates
        cls.get_updates = gated
        def restore():
            self.operation = None
            self.unlocked.set()
            if self.drain is not None:
                self.drain.cancel()
            if cls.__dict__.get('get_updates') is gated:
                if owned:
                    cls.get_updates = original
                else:
                    delattr(cls, 'get_updates')
        self.restore = restore

    @staticmethod
    def _validate(operationId):
        if not isinstance(operationId, str) or not operationId:
            from .ipc import RpcError
            raise RpcError(-32602, 'Invalid release operation')

    async def _drain(self):
        await self.held.wait()
        await self.app.update_queue.join()

    def hold(self, operationId):
        """Закрыть poll синхронно до startup; worker barrier запрашивается отдельно."""
        from .ipc import RpcError
        self._validate(operationId)
        if self.operation is not None and self.operation != operationId:
            raise RpcError(-32602, 'Another release operation holds ingress')
        if self.operation is None:
            self.operation = operationId
            self.committed = False
            self.held.clear()
            self.unlocked.clear()
            self.drain = asyncio.create_task(self._drain())

    async def begin(self, operationId):
        """Зафиксировать операцию и ждать границу следующего polling без отмены запросов."""
        self.hold(operationId)
        return await self.status(operationId)

    async def status(self, operationId):
        """Сообщить границу транспорта; неподтверждённые worker блокируют release."""
        from .ipc import RpcError
        self._validate(operationId)
        if self.operation is None:
            return {'operationId': operationId, 'state': 'resumed', 'reason': None}
        if self.operation != operationId:
            raise RpcError(-32602, 'Release operation does not own ingress')
        if self.drain is None or not self.drain.done():
            return {'operationId': operationId, 'state': 'draining', 'reason': 'telegram_polling'}
        if self.drain.cancelled() or self.drain.exception() is not None:
            return {'operationId': operationId, 'state': 'blocked', 'reason': 'telegram_drain_failed'}
        if self.resolver is None:
            return {'operationId': operationId, 'state': 'blocked', 'reason': 'worker_control_unavailable'}
        async with self.lock:
            if self.operation != operationId:
                raise RpcError(-32602, 'Release operation does not own ingress')
            return await self.resolver.release_status(operationId)

    async def profile_try(self, **params):
        owner = getattr(self.resolver, 'profile_release', None)
        if owner is None:
            raise ValueError('PROFILE_RELEASE_UNAVAILABLE')
        return await owner.try_profile(**params)

    async def profile_status(self, **params):
        owner = getattr(self.resolver, 'profile_release', None)
        if owner is None:
            raise ValueError('PROFILE_RELEASE_UNAVAILABLE')
        return await owner.status(**params)

    async def profile_resume(self, **params):
        owner = getattr(self.resolver, 'profile_release', None)
        if owner is None:
            raise ValueError('PROFILE_RELEASE_UNAVAILABLE')
        return await owner.resume(**params)

    async def commit(self, operationId):
        """Разрешить только завершающий PTB cleanup после полной проверки drain."""
        from .ipc import RpcError
        drain = self.drain
        result = await self.status(operationId)
        if result['state'] != 'ready':
            return result
        async with self.lock:
            if self.operation != operationId or self.drain is not drain:
                raise RpcError(-32602, 'Release operation changed')
            self.committed = True
            return {'operationId': operationId, 'state': 'committed', 'reason': None}

    async def resume(self, operationId):
        """Снять gate только владельцу операции; не отменять текущую обработку."""
        from .ipc import RpcError
        self._validate(operationId)
        if self.operation is None:
            return {'operationId': operationId, 'state': 'resumed', 'reason': None}
        if self.operation != operationId:
            raise RpcError(-32602, 'Release operation does not own ingress')
        async with self.lock:
            if self.operation != operationId:
                raise RpcError(-32602, 'Release operation does not own ingress')
            if self.resolver is not None and not await self.resolver.release_resume(operationId):
                return {'operationId': operationId, 'state': 'blocked', 'reason': 'worker_resume_unconfirmed'}
            drain, self.drain = self.drain, None
            if drain is not None:
                drain.cancel()
                await asyncio.gather(drain, return_exceptions=True)
            self.operation = None
            self.committed = False
            self.unlocked.set()
        return {'operationId': operationId, 'state': 'resumed', 'reason': None}

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
        # Identity restart сохраняет Telegram backlog, включая сообщения во время release gate.
        adapter._drop_pending_on_cold_boot = False
        gate = ReleaseGate(app)
        gate.resolver = resolver
        mirror = getattr(resolver, 'mirror', None)
        hooks = {}
        if mirror is not None:
            if (getattr(app, '_brai_identity_admission_protocol', None) != 1
                    or getattr(adapter, '_brai_identity_batch_protocol', None) != 1
                    or getattr(adapter, '_brai_identity_held_protocol', None) != 1):
                raise RuntimeError('Native ordinary release hooks unavailable')
            from .ordinary_admission import BatchOwnership
            batch = BatchOwnership(adapter, mirror)
            resolver.batch_ownership = batch
            from .profile_release import ProfileRelease
            resolver.profile_release = ProfileRelease(resolver, app)
            mirror.recover = resolver.profile_release.recover_inbox
            mirror.recover_external = resolver.profile_release.recover_external
            mirror.app = app
            hooks = {'_brai_identity_preflight': mirror,
                     '_brai_identity_disposition': mirror.finish,
                     '_brai_identity_duplicate': mirror.duplicate,
                     '_brai_identity_tag_event': batch.tag,
                     '_brai_identity_text_batch': batch.text,
                     '_brai_identity_merge_batch': batch.merge,
                     '_brai_identity_track_batch': batch.track,
                     '_brai_identity_take_held': batch.take_held,
                     '_brai_identity_finish_held': batch.finish_held,
                     '_brai_identity_rehold_held': batch.rehold,
                     '_brai_identity_preserve_held': batch.preserve_held,
                     '_brai_identity_can_redispatch': batch.can_redispatch}
            originals = {name: (hasattr(adapter, name), getattr(adapter, name, None)) for name in hooks}
            for name, value in hooks.items():
                setattr(adapter, name, value)
        bootstrap_operation = os.environ.get('BRAI_IDENTITY_RELEASE_HOLD_OPERATION')
        bootstrap_source = os.environ.get('BRAI_IDENTITY_RELEASE_HOLD_SOURCE_SHA256')
        if bootstrap_operation is not None or bootstrap_source is not None:
            source = Path(__file__)
            if (not bootstrap_operation or not bootstrap_source
                    or str(uuid.UUID(bootstrap_operation)) != bootstrap_operation
                    or source != Path('/opt/brai-profile/runtime/services/hermes/identity/native_ingress.py')
                    or hashlib.sha256(source.read_bytes()).hexdigest() != bootstrap_source):
                raise RuntimeError('Root startup release binding unavailable')
            gate.hold(bootstrap_operation)
        gate.install()
        resolver.release_gate = gate
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
                if mirror is not None:
                    await mirror.handled(update)
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
            gate.restore()
            raise
        adapter._brai_identity_ingress_ready = True
        installed.append((adapter, original, forward, app, handler, asyncio.get_running_loop(), interactive_original, gate, hooks, originals if hooks else {}))

    def close():
        for adapter, original, forward, app, handler, loop, interactive_original, gate, hooks, originals in reversed(installed):
            for name, value in hooks.items():
                if getattr(adapter, name, None) is value:
                    existed, prior = originals[name]
                    if existed:
                        setattr(adapter, name, prior)
                    else:
                        delattr(adapter, name)
            gate.restore()
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
