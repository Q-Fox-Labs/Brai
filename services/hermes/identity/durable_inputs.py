# ABOUTME: Возвращает ожидающие DEV-входы в native очередь при готовности владельца.
# ABOUTME: Не переисполняет legacy unknown; потерянный RPC сверяет по durable ID worker.
import asyncio
import json

from .ordinary_admission import message_thread


def ordinary(update):
    """Обычные сообщения допускают отложенную передачу; команды и callbacks сохраняют свой контракт."""
    message = getattr(update, 'message', None)
    if message is None:
        return False
    text = getattr(message, 'text', None)
    if isinstance(text, str):
        return bool(text.strip()) and not text.lstrip().startswith('/')
    return any(getattr(message, name, None) for name in ('voice', 'audio', 'photo', 'document', 'video', 'sticker', 'location', 'venue'))


async def pump(mirror):
    """Один проход existing supervisor; неподтверждённая попытка остаётся в SQLite."""
    from telegram import Update
    if not mirror.hydrated or mirror.app is None or mirror.pump_lock.locked():
        return
    async with mirror.pump_lock:
        rows = await asyncio.to_thread(mirror.transport.pending)
        async def process(row):
            key = f"{row['bot_id']}:{row['update_id']}"
            if key in mirror.snapshots or row['state'] not in ('captured', 'handing_off'):
                return
            snapshot = json.loads(row['binding'])
            update = Update.de_json(json.loads(row['payload']), mirror.app.bot)
            if row['bot_id'] != str(mirror.app.bot.id):
                raise ValueError('TRANSPORT_BOT_CHANGED')
            from .ordinary_admission import disabled_command
            if disabled_command(getattr(getattr(update, 'message', None), 'text', None)):
                if snapshot.get('state') == 'known':
                    profile = snapshot['profile']
                    await asyncio.to_thread(mirror.inbox.capture, profile, update, mirror.app.bot.id)
                    seen = await asyncio.to_thread(mirror.inbox.observe, profile, row['bot_id'], row['update_id'])
                    if seen['state'] in ('captured', 'held', 'handing_off'):
                        await asyncio.to_thread(mirror.inbox.markblocked, profile, row['bot_id'], row['update_id'])
                await asyncio.to_thread(mirror.transport.transition, row['bot_id'], row['update_id'], row['state'], 'blocked')
                return
            if snapshot.get('state') == 'known':
                profile = snapshot['profile']
                try:
                    fresh = await mirror.resolve(profile['telegramId'])
                    current = fresh.get('profile') if isinstance(fresh, dict) and fresh.get('state') == 'known' else None
                    if not isinstance(current, dict):
                        return
                    if any(current.get(k) != profile.get(k) for k in ('uid', 'profileId', 'userId', 'telegramId', 'authorTelegramId', 'role', 'generation')):
                        if row['state'] == 'captured':
                            await asyncio.to_thread(mirror.transport.transition, row['bot_id'], row['update_id'], 'captured', 'blocked')
                        return
                    profile = current
                    from .update_inbox import ignored_reaction
                    if row['state'] == 'captured' and ignored_reaction(update.to_dict()):
                        # AIDEV-NOTE: Резервирование охватывает обе SQLite-записи,
                        # даже если отменён ожидающий их supervisor.
                        reservation = object()
                        mirror.tracker.enter(reservation, update)
                        try:
                            async with mirror.capture_lock:
                                operation = mirror.tracker.gates.get(profile['uid'])
                                def dispose_reaction():
                                    mirror.inbox.capture(profile, update, mirror.app.bot.id)
                                    observed = mirror.inbox.observe(profile, row['bot_id'], row['update_id'])
                                    if operation is not None:
                                        if observed['state'] == 'captured':
                                            mirror.inbox.disposition(profile, row['bot_id'], row['update_id'],
                                                                     'held', operation_id=operation)
                                        return
                                    mirror.inbox.ignore_reaction(profile, row['bot_id'], row['update_id'])
                                    mirror.transport.ignore_reaction(profile, row['bot_id'], row['update_id'])
                                import threading
                                done = threading.Event()
                                errors = []
                                def run_disposition():
                                    try:
                                        dispose_reaction()
                                    except BaseException as error:
                                        errors.append(error)
                                    finally:
                                        done.set()
                                threading.Thread(target=run_disposition, daemon=True).start()
                                cancelled = False
                                while not done.is_set():
                                    try:
                                        await asyncio.sleep(0.01)
                                    except asyncio.CancelledError:
                                        # Поток SQLite нельзя отменить; защита остаётся
                                        # до его завершения и при повторной отмене.
                                        cancelled = True
                                if cancelled:
                                    if errors:
                                        import logging
                                        logging.getLogger(__name__).warning('DURABLE_REACTION_CANCELLED_WRITE_FAILED class=%s',
                                                                           type(errors[0]).__name__)
                                    raise asyncio.CancelledError
                                if errors:
                                    raise errors[0]
                        finally:
                            mirror.tracker.release_reservation(reservation)
                        return
                    await asyncio.to_thread(mirror.inbox.capture, profile, update, mirror.app.bot.id)
                    observed = await asyncio.to_thread(mirror.inbox.observe, profile, row['bot_id'], row['update_id'])
                    binding = await asyncio.to_thread(mirror.inbox.delivery_for, profile, row['bot_id'], row['update_id'])
                    if row['state'] == 'handing_off' or observed['state'] == 'handing_off' or binding is not None:
                        if binding is None or mirror.reconcile_delivery is None:
                            return
                        result = await mirror.reconcile_delivery(profile, binding)
                        if result.get('state') in ('accepted', 'completed', 'interrupted'):
                            receipt = result['receipt']
                            accepted = receipt.get('accepted') is True
                            method = mirror.inbox.markaccepted if accepted else mirror.inbox.markhandled
                            args = (profile, row['bot_id'], row['update_id'], receipt) if accepted else (profile, row['bot_id'], row['update_id'])
                            await asyncio.to_thread(method, *args)
                            await asyncio.to_thread(mirror.transport.transition, row['bot_id'], row['update_id'], 'handing_off', 'accepted' if accepted else 'handled')
                            return
                        if result.get('state') != 'not_received':
                            return
                        await asyncio.to_thread(mirror.transport.not_received, row['bot_id'], row['update_id'], row['digest'])
                        await asyncio.to_thread(mirror.inbox.not_received, profile, row['bot_id'], row['update_id'])
                    observed = await asyncio.to_thread(mirror.inbox.observe, profile, row['bot_id'], row['update_id'])
                    if observed['state'] != 'captured':
                        return
                    route = (observed['chat'], message_thread(update.effective_chat, update.effective_message))
                    state = await asyncio.to_thread(mirror.inbox.journal.chat_state, profile,
                                                    (observed['chat'], observed['thread']))
                    if state['paused'] or state['generation'] != observed['chat_generation']:
                        return
                    if mirror.input_ready is not None and not await mirror.input_ready(profile, route):
                        return
                except (ConnectionError, TimeoutError, OSError):
                    return
            elif snapshot.get('state') != 'unregistered' or row['state'] != 'captured':
                return
            mirror.register_snapshot(key, snapshot)
            await mirror.app.update_queue.put(update)
        groups = {}
        for row in rows:
            profile = json.loads(row['binding']).get('profile', {})
            groups.setdefault(profile.get('uid', row['actor_id']), []).append(row)
        async def owner_rows(values):
            for row in values:
                try:
                    await process(row)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    import logging
                    logging.getLogger(__name__).warning('DURABLE_INPUT_WAITING update=%s', row['update_id'])
        await asyncio.gather(*(owner_rows(values) for values in groups.values()))
