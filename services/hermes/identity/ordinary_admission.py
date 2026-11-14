# ABOUTME: Учитывает native Telegram claim до и после разрешения UID.
# ABOUTME: Не паркует обработчики и не разрешает неизвестную принадлежность.
import asyncio
from contextvars import ContextVar

_replay_binding = ContextVar('brai_release_replay_binding', default=None)
class Tracker:
    def __init__(self, authorize, stage=None, on_release=None):
        self.authorize = authorize
        self.stage = stage
        self.on_release = on_release
        self.settled = set()
        self.postflight = set()
        self.tickets = {}
        self.counts = {}
        self.gates = {}
        self.last_final = None
        self.changed = asyncio.Event()

    def enter(self, key, update):
        # Called synchronously before the first await in native preflight.
        if key in self.tickets:
            raise ValueError('CLAIM_ALREADY_TRACKED')
        self.tickets[key] = None
        self.changed.set()
        return key

    async def classify(self, key, update):
        uid = await self.authorize(update)
        if self.tickets[key] is not None:
            raise ValueError('UNRESOLVED_BINDING')
        if uid is None:
            self.tickets[key] = 'outside'
            self.changed.set()
            return False
        if type(uid) is not int or uid <= 0:
            raise ValueError('UNRESOLVED_BINDING')
        # Нет await между закреплением UID и освобождением unclassified.
        self.counts[uid] = self.counts.get(uid, 0) + 1
        self.tickets[key] = uid
        self.changed.set()
        op = self.gates.get(uid)
        if self.stage is not None:
            return await self.stage(key, update, uid, op)
        return op is not None

    def finish(self, key, result):
        if key not in self.tickets:
            raise ValueError('CLAIM_NOT_TRACKED')
        uid = self.tickets[key]
        if uid is None:
            # Unknown binding stays fenced until explicit reconciliation.
            return
        if uid == 'outside':
            del self.tickets[key]
            if self.on_release is not None:
                self.on_release(key)
            self.changed.set()
            return
        if self.stage is not None and not result.get('deferred'):
            self.postflight.add(key)
            if key not in self.settled:
                return
        self._release(key, uid, result)

    def _release(self, key, uid, result):
        count = self.counts[uid]
        if count <= 0:
            raise ValueError('CLAIM_COUNT_INVALID')
        self.counts[uid] = count - 1
        del self.tickets[key]
        self.postflight.discard(key)
        self.settled.discard(key)
        self.last_final = (key,uid,result)
        if self.on_release is not None:
            self.on_release(key)
        self.changed.set()

    def settle(self, key):
        uid = self.tickets.get(key)
        if type(uid) is not int:
            raise ValueError('CLAIM_NOT_TRACKED')
        self.settled.add(key)
        if key in self.postflight:
            self._release(key, uid, {'settled': True})

    def try_gate(self, uid, operation):
        # Single event-loop turn: no await between checks and gate installation.
        if any(value is None for value in self.tickets.values()) or self.counts.get(uid, 0):
            return False
        if uid in self.gates and self.gates[uid] != operation:
            raise ValueError('FOREIGN_GATE')
        self.gates[uid] = operation
        self.changed.set()
        return True

    def resume(self, uid, operation):
        if self.gates.get(uid) != operation:
            raise ValueError('FOREIGN_GATE')
        del self.gates[uid]
        self.changed.set()


class Mirror:
    """Сохранить зарегистрированные Update до возврата всей Telegram-пачки."""
    def __init__(self, inbox, resolve, *, inventory=None, observe=None, gate_store=None, boot_id=None, transport=None):
        self.inbox = inbox
        self.restartable = getattr(inbox, 'restartable', False)
        self.transport = transport
        self.resolve = resolve
        self.inventory, self.observe, self.gate_store = inventory, observe, gate_store
        self.boot_id = boot_id
        self.hydrated = False
        self.hydration_lock = None
        self.rehydrated = {}
        self.recover = None
        self.recover_external = None
        self.app = None
        self.transport_unavailable = []
        self.transport_blocked = set()
        self.recovery_tasks = {}
        self.deferred_recovery = None
        self.snapshots = {}
        self.snapshot_refs = {}
        self.pending = False
        self._capturing = False
        self.capture_lock = asyncio.Lock()
        self.bot_id = None
        self.tracker = Tracker(self._authorize, self._stage, self._release_snapshot)

    def register_snapshot(self, key, snapshot):
        old = self.snapshots.get(key)
        if old is not None and old != snapshot:
            raise ValueError('INGRESS_BINDING_CHANGED')
        self.snapshots[key] = snapshot
        self.snapshot_refs[key] = self.snapshot_refs.get(key, 0) + 1

    def _release_snapshot(self, key):
        count = self.snapshot_refs.get(key, 0)
        if count <= 0:
            raise ValueError('INGRESS_CAPTURE_UNAVAILABLE')
        if count == 1:
            self.snapshots.pop(key, None)
            self.snapshot_refs.pop(key, None)
        else:
            self.snapshot_refs[key] = count - 1

    async def hydrate_held(self):
        """Восстановить journal и gates, отложив replay до открытия общего входа."""
        await self.hydrate(defer_recovery=True)

    async def hydrate(self, *, defer_recovery=False):
        """Восстановить все durable gates до первого Telegram poll."""
        import asyncio
        from pathlib import Path
        if self.hydrated:
            if not defer_recovery:
                self._start_recovery()
            return
        if self.inventory is None or self.gate_store is None:
            raise ValueError('INGRESS_HYDRATION_UNAVAILABLE')
        if self.hydration_lock is None:
            self.hydration_lock = asyncio.Lock()
        async with self.hydration_lock:
            if self.hydrated:
                if not defer_recovery:
                    self._start_recovery()
                return
            if self.restartable:
                await self._restart_inputs()
                return
            boot = self.boot_id or Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            result = await self.inventory()
            profiles = result.get('profiles') if isinstance(result, dict) else None
            if not isinstance(profiles, list):
                raise ValueError('INGRESS_HYDRATION_UNAVAILABLE')
            if self.transport is not None:
                all_ids = result.get('allProfileIds')
                if (not isinstance(all_ids,list) or any(not isinstance(value,str) for value in all_ids)
                        or '00000000-0000-0000-0000-000000000000' in all_ids):
                    raise ValueError('TRANSPORT_PROFILE_COLLISION')
            outsiders = []
            unbound_transport = False
            if self.transport is not None:
                import json
                from telegram import Update
                if self.app is None:
                    raise ValueError('TRANSPORT_RECOVERY_UNAVAILABLE')
                rows = await asyncio.to_thread(self.transport.pending)
                for row in rows:
                    state = row['state']
                    snapshot = json.loads(row['binding'])
                    original = snapshot.get('profile') if isinstance(snapshot,dict) else None
                    original_uid = original.get('uid') if isinstance(original,dict) else None
                    if state == 'handing_off':
                        await asyncio.to_thread(self.transport.transition,row['bot_id'],row['update_id'],
                                                'handing_off','unknown')
                        state = 'unknown'
                    if state != 'captured':
                        self.transport_unavailable.append(row)
                        if type(original_uid) is int:
                            self.transport_blocked.add(original_uid)
                        else:
                            unbound_transport = True
                        continue
                    if str(self.app.bot.id) != row['bot_id']:
                        raise ValueError('TRANSPORT_BOT_CHANGED')
                    update = Update.de_json(json.loads(row['payload']),self.app.bot)
                    actor = str(getattr(getattr(update,'effective_user',None),'id','') or '')
                    if actor != row['actor_id']:
                        raise ValueError('TRANSPORT_BINDING_CHANGED')
                    if snapshot.get('state') == 'unregistered':
                        outsiders.append((update,snapshot))
                    elif snapshot.get('state') == 'known':
                        original = snapshot.get('profile') or {}
                        candidates = [p for p in profiles if isinstance(p,dict)
                            and all(p.get(k) == original.get(k) for k in ('uid','profileId','userId'))]
                        if len(candidates) != 1:
                            self.transport_unavailable.append(row)
                            if type(original_uid) is int:
                                self.transport_blocked.add(original_uid)
                            else:
                                unbound_transport = True
                            continue
                        fresh = await self.resolve(original.get('telegramId'))
                        current = fresh.get('profile') if isinstance(fresh,dict) and fresh.get('state') == 'known' else None
                        if not isinstance(current,dict) or any(current.get(k) != original.get(k) for k in
                                ('uid','profileId','userId','telegramId','authorTelegramId','role','generation')):
                            await asyncio.to_thread(self.transport.transition,row['bot_id'],row['update_id'],'captured','blocked')
                            self.transport_unavailable.append(row)
                            self.transport_blocked.add(original_uid)
                            continue
                        # Recreate a profile row if crash followed the global commit.
                        await asyncio.to_thread(self.inbox.capture,current,update,self.app.bot.id)
                    else:
                        raise ValueError('TRANSPORT_STATE_INVALID')
            found = {}
            for profile in profiles:
                if (not isinstance(profile, dict) or type(profile.get('uid')) is not int
                        or profile['uid'] <= 0 or profile['uid'] in found):
                    raise ValueError('INGRESS_HYDRATION_BINDING_CHANGED')
                uid = profile['uid']
                await asyncio.to_thread(self.inbox.install_v2, profile)
                record = await asyncio.to_thread(self.gate_store.current, profile, boot)
                outstanding = await asyncio.to_thread(self.inbox.unsettled, profile)
                if record is not None:
                    state = record['state']
                    if state in ('busy', 'resumed'):
                        try:
                            if self.observe is None:
                                raise ValueError('INGRESS_PEER_UNAVAILABLE')
                            actual = await self.observe(profile)
                            expected = ((record['worker_pid'], record['worker_start']) if state == 'busy'
                                        else (record['replacement_pid'], record['replacement_start']))
                            if actual != expected:
                                completed = (state == 'resumed' and not outstanding
                                             and uid not in self.transport_blocked and not unbound_transport)
                                if not completed:
                                    state = 'unknown'
                        except Exception:
                            state = 'unknown'
                    if state not in ('busy', 'resumed'):
                        self.tracker.gates[uid] = record['operation_id']
                    record = {**record, 'state': state}
                if record is not None and record['state'] == 'resumed':
                    transport_unknown = (unbound_transport or uid in self.transport_blocked or
                        (self.transport is not None and await asyncio.to_thread(self.transport.blocked_for, uid)))
                    if transport_unknown or any(not item['bound'] or item['state'] in
                                                ('unknown','blocked','handing_off','native_duplicate')
                                                for item in outstanding):
                        self.tracker.gates[uid] = record['operation_id']
                for item in outstanding:
                    if item['state'] == 'handing_off':
                        await asyncio.to_thread(self.inbox.markunknown, profile, item['botId'], item['updateId'])
                        item['state'] = 'unknown'
                if uid in self.tracker.gates:
                    # Captured rows predate the crash and were never handed off.
                    # Keep them under the already durable gate before polling resumes.
                    for item in outstanding:
                        if item['state'] == 'captured':
                            await asyncio.to_thread(self.inbox.disposition, profile, item['botId'], item['updateId'],
                                                    'held', operation_id=self.tracker.gates[uid])
                            item['state'], item['operationId'] = 'held', self.tracker.gates[uid]
                if outstanding and uid not in self.tracker.gates:
                    # UUID определяется профилем: restart восстанавливает тот же внутренний gate.
                    import uuid
                    recovery = str(uuid.uuid5(uuid.UUID(profile['profileId']), 'brai-ingress-recovery'))
                    self.tracker.gates[uid] = recovery
                    for item in outstanding:
                        if item['state'] == 'captured':
                            await asyncio.to_thread(self.inbox.disposition, profile, item['botId'], item['updateId'],
                                                    'held', operation_id=recovery)
                            item['state'], item['operationId'] = 'held', recovery
                    if uid in self.transport_blocked or any(item['state'] != 'held' or item['operationId'] != recovery for item in outstanding):
                        record = {'state':'unknown', 'operation_id':recovery}
                    else:
                        if self.recover is None:
                            raise ValueError('INGRESS_RECOVERY_UNAVAILABLE')
                        found[uid] = {'profile':profile, 'record':record, 'recovery':recovery}
                        continue
                found[uid] = {'profile': profile, 'record': record}
            if outsiders and self.recover_external is None:
                raise ValueError('TRANSPORT_RECOVERY_UNAVAILABLE')
            self.rehydrated = found
            self.hydrated = True
            self.deferred_recovery = (outsiders, found)
            if not defer_recovery:
                self._start_recovery()

    async def _restart_inputs(self):
        """DEV: вернуть непереданные входы в обычную очередь без profile gates."""
        import json
        from telegram import Update
        if self.transport is None or self.app is None:
            raise ValueError('TRANSPORT_RECOVERY_UNAVAILABLE')
        inventory = await self.inventory()
        profiles = inventory.get('profiles') if isinstance(inventory, dict) else None
        if not isinstance(profiles, list):
            raise ValueError('INGRESS_HYDRATION_UNAVAILABLE')
        for profile in profiles:
            await asyncio.to_thread(self.inbox.prepare_restart, profile)
        pending = await asyncio.to_thread(self.transport.pending)
        replay = []
        for row in pending:
            if row['state'] == 'handing_off':
                await asyncio.to_thread(self.transport.transition, row['bot_id'], row['update_id'],
                                        'handing_off', 'unknown')
                continue
            if row['state'] != 'captured':
                continue
            if str(self.app.bot.id) != row['bot_id']:
                raise ValueError('TRANSPORT_BOT_CHANGED')
            snapshot = json.loads(row['binding'])
            update = Update.de_json(json.loads(row['payload']), self.app.bot)
            if str(getattr(getattr(update, 'effective_user', None), 'id', '')) != row['actor_id']:
                raise ValueError('TRANSPORT_BINDING_CHANGED')
            if snapshot.get('state') == 'known':
                original = snapshot['profile']
                fresh = await self.resolve(original['telegramId'])
                current = fresh.get('profile') if isinstance(fresh, dict) and fresh.get('state') == 'known' else None
                if (not isinstance(current, dict) or not any(all(p.get(k) == original.get(k)
                        for k in ('uid', 'profileId', 'userId')) for p in profiles)
                        or any(current.get(k) != original.get(k) for k in
                               ('uid','profileId','userId','telegramId','authorTelegramId','role','generation'))):
                    await asyncio.to_thread(self.transport.transition, row['bot_id'], row['update_id'],
                                            'captured', 'blocked')
                    continue
                receipt = await asyncio.to_thread(self.inbox.capture, current, update, self.app.bot.id)
                if receipt['state'] != 'captured':
                    continue
            elif snapshot.get('state') != 'unregistered':
                raise ValueError('TRANSPORT_STATE_INVALID')
            self.register_snapshot(f"{row['bot_id']}:{row['update_id']}", snapshot)
            replay.append(update)
        self.bot_id = self.app.bot.id
        self.hydrated = True
        # Только captured: неизвестные эффекты никогда не попадают в повтор.
        for update in replay:
            await self.app.update_queue.put(update)
        import logging
        logging.getLogger(__name__).info('DEV input queue ready: queued=%d, retained=%d',
                                         len(replay), len(pending) - len(replay))

    def _start_recovery(self):
        """Запустить отложенный replay один раз после снятия общего gate."""
        import asyncio
        if self.deferred_recovery is None:
            return
        outsiders, found = self.deferred_recovery
        self.deferred_recovery = None
        for update,snapshot in outsiders:
            key = f'{self.app.bot.id}:{update.update_id}'
            self.bot_id = self.app.bot.id
            self.register_snapshot(key,snapshot)
            task = asyncio.create_task(self.recover_external(update))
            self.recovery_tasks[key] = task
            def external_done(done):
                if not done.cancelled() and done.exception() is not None:
                    self.tracker.changed.set()
            task.add_done_callback(external_done)
        for uid, value in found.items():
            if 'recovery' in value:
                task = asyncio.create_task(self.recover(value['profile'], value['recovery']))
                self.recovery_tasks[uid] = task
                def completed(done, uid=uid):
                    if not done.cancelled() and done.exception() is not None:
                        self.tracker.changed.set()
                task.add_done_callback(completed)

    async def capture(self, updates, bot_id):
        import asyncio
        if self._capturing:
            raise RuntimeError('INGRESS_CAPTURE_CONCURRENT')
        self._capturing = True
        self.pending = True
        if self.bot_id is not None and self.bot_id != bot_id:
            self._capturing = False
            raise ValueError('INGRESS_BOT_CHANGED')
        self.bot_id = bot_id
        staged, known = [], []
        try:
            async with self.capture_lock:
                for update in updates:
                    user = getattr(update, 'effective_user', None)
                    actor = getattr(user, 'id', None)
                    if user is None or getattr(user, 'is_bot', False) or type(actor) is not int or actor <= 0:
                        staged.append((update, {'state':'outside'}))
                        continue
                    chat = getattr(update, 'effective_chat', None)
                    message = getattr(update, 'effective_message', None)
                    if ((chat is not None and (getattr(chat, 'type', None) != 'private' or getattr(chat, 'id', None) != actor))
                            or (message is not None and (getattr(message, 'sender_chat', None)
                                or getattr(message, 'business_connection_id', None)))):
                        staged.append((update, {'state':'outside'}))
                        continue
                    resolved = await self.resolve(str(actor))
                    if not isinstance(resolved, dict) or resolved.get('state') not in ('known','unregistered','forbidden'):
                        raise ValueError('INGRESS_IDENTITY_UNAVAILABLE')
                    snapshot = dict(resolved)
                    if snapshot['state'] == 'known':
                        profile = snapshot.get('profile')
                        if not isinstance(profile, dict) or str(profile.get('telegramId')) != str(actor):
                            raise ValueError('INGRESS_IDENTITY_UNAVAILABLE')
                        known.append((profile, update))
                    staged.append((update, snapshot))
                # Global binding precedes every profile insert and Telegram ack.
                if self.transport is not None:
                    global_states = await asyncio.to_thread(self.transport.capture_batch, staged, bot_id)
                    if len(global_states) != len(staged):
                        raise ValueError('TRANSPORT_CAPTURE_UNAVAILABLE')
                    filtered = []
                    for (update, snapshot), state in zip(staged,global_states):
                        if state in ('binding_changed','blocked','unknown','handing_off'):
                            snapshot = {'state':'binding_changed'}
                        filtered.append((update,snapshot))
                    staged = filtered
                    known = [(snapshot['profile'],update) for update,snapshot in staged
                             if snapshot.get('state') == 'known']
                # Ошибка частичной записи не разрешает updater продвинуть offset.
                receipts = await asyncio.to_thread(self.inbox.capture_batch, known, bot_id)
                if not isinstance(receipts, list) or len(receipts) != len(known):
                    raise ValueError('INGRESS_CAPTURE_UNAVAILABLE')
                for (profile, update), receipt in zip(known, receipts):
                    op = self.tracker.gates.get(profile['uid'])
                    if op is not None and receipt.get('state') in ('captured', 'held'):
                        await asyncio.to_thread(self.inbox.disposition, profile, bot_id, update.update_id,
                                                'held', operation_id=op)
                checked = {}
                for update, snapshot in staged:
                    key = f'{bot_id}:{update.update_id}'
                    old = checked.get(key, self.snapshots.get(key))
                    if old is not None and old != snapshot:
                        raise ValueError('INGRESS_BINDING_CHANGED')
                    checked[key] = snapshot
                for update, snapshot in staged:
                    self.register_snapshot(f'{bot_id}:{update.update_id}', snapshot)
                self.pending = False
                self.tracker.changed.set()
        except BaseException:
            # Профильные попытки остаются blocked до успешного повтора той же пачки.
            raise
        finally:
            self._capturing = False

    def enter(self, key, update):
        return self.tracker.enter(key, update)

    async def classify(self, ticket, update):
        return await self.tracker.classify(ticket, update)

    async def _authorize(self, update):
        import asyncio
        snapshot = self.snapshot(f'{self.bot_id}:{update.update_id}')
        if snapshot.get('state') == 'unregistered' and self.transport is not None:
            await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'captured','handing_off')
        if snapshot.get('state') in ('outside', 'unregistered', 'forbidden', 'binding_changed'):
            return None
        before = snapshot.get('profile')
        if snapshot.get('state') != 'known' or not isinstance(before, dict):
            raise ValueError('INGRESS_BINDING_UNAVAILABLE')
        fresh = await self.resolve(str(before['telegramId']))
        after = fresh.get('profile') if isinstance(fresh, dict) else None
        if (not isinstance(fresh, dict) or fresh.get('state') != 'known' or not isinstance(after, dict)
                or any(before.get(key) != after.get(key) for key in
                       ('uid','profileId','userId','telegramId','authorTelegramId','role','generation'))):
            await asyncio.to_thread(self.inbox.markblocked, before, self.bot_id, update.update_id)
            if self.transport is not None:
                await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'captured','blocked')
            snapshot['state'] = 'binding_changed'
            raise PermissionError('INGRESS_BINDING_CHANGED')
        return before['uid']

    async def _stage(self, key, update, uid, operation):
        import asyncio
        snapshot = self.snapshot(key)
        profile = snapshot['profile']
        if profile['uid'] != uid:
            raise PermissionError('INGRESS_BINDING_CHANGED')
        if operation is not None and _replay_binding.get() != (uid, operation):
            await asyncio.to_thread(self.inbox.disposition, profile, self.bot_id, update.update_id,
                                    'held', operation_id=operation)
            return True
        if self.transport is not None:
            await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'captured','handing_off')
        await asyncio.to_thread(self.inbox.claim_for_delivery, profile, self.bot_id, update.update_id,
                                operation_id=operation)
        return False

    def finish(self, key, result):
        self.tracker.finish(key, result)

    async def handled(self, update):
        import asyncio
        key = f'{self.bot_id}:{update.update_id}'
        snapshot = self.snapshot(key)
        if snapshot.get('state') == 'unregistered' and self.transport is not None:
            await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'handing_off','handled')
            return
        if snapshot.get('state') == 'outcome_unknown' and self.transport is not None:
            await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'handing_off','unknown')
            return
        if snapshot.get('state') != 'known':
            return
        await asyncio.to_thread(self.inbox.markhandled, snapshot['profile'], self.bot_id, update.update_id)
        if self.transport is not None:
            await asyncio.to_thread(self.transport.transition, self.bot_id, update.update_id, 'handing_off','handled')
        self.tracker.settle(key)

    async def accepted(self, event, receipt):
        import asyncio
        ids = getattr(event, '_brai_release_updates', None)
        if not isinstance(ids, list) or not ids:
            raise ValueError('INGRESS_UPDATE_ID_UNAVAILABLE')
        for update_id in ids:
            key = f'{self.bot_id}:{update_id}'
            snapshot = self.snapshot(key)
            if snapshot.get('state') != 'known':
                raise ValueError('INGRESS_BINDING_UNAVAILABLE')
            profile = snapshot['profile']
            if receipt.get('accepted') is True:
                await asyncio.to_thread(self.inbox.markaccepted, profile, self.bot_id, update_id, receipt)
                terminal = 'accepted'
            else:
                await asyncio.to_thread(self.inbox.markhandled, profile, self.bot_id, update_id)
                terminal = 'handled'
            if self.transport is not None:
                await asyncio.to_thread(self.transport.transition, self.bot_id, update_id, 'handing_off',terminal)
            self.tracker.settle(key)

    async def block_event(self, event):
        import asyncio
        ids = getattr(event, '_brai_release_updates', None)
        if not isinstance(ids, list) or not ids:
            raise ValueError('INGRESS_UPDATE_ID_UNAVAILABLE')
        for update_id in ids:
            key = f'{self.bot_id}:{update_id}'
            snapshot = self.snapshot(key)
            await asyncio.to_thread(self.inbox.markblocked, snapshot['profile'], self.bot_id, update_id)
            if self.transport is not None:
                await asyncio.to_thread(self.transport.transition, self.bot_id, update_id, 'handing_off','blocked')
            snapshot['state'] = 'binding_changed'

    async def duplicate(self, update, key, reason):
        import asyncio
        if reason not in ('seen', 'pending'):
            raise ValueError('INGRESS_DUPLICATE_INVALID')
        snapshot = self.snapshot(key)
        try:
            if reason == 'seen' and snapshot.get('state') == 'known':
                profile = snapshot['profile']
                row = await asyncio.to_thread(self.inbox.observe, profile, self.bot_id, update.update_id)
                if row['state'] == 'captured':
                    await asyncio.to_thread(self.inbox.disposition, profile, self.bot_id,
                                            update.update_id, 'native_duplicate')
                elif row['state'] not in ('accepted', 'handled', 'native_duplicate'):
                    if row['state'] in ('held', 'handing_off'):
                        await asyncio.to_thread(self.inbox.markblocked, profile, self.bot_id, update.update_id)
                    raise ValueError('INGRESS_DUPLICATE_OUTCOME_UNKNOWN')
        finally:
            self._release_snapshot(key)

    def snapshot(self, key):
        result = self.snapshots.get(key)
        if result is None:
            raise ValueError('INGRESS_CAPTURE_UNAVAILABLE')
        return result

class BatchOwnership:
    """Учитывать direct native flush tasks и перенос удержанных MessageEvent."""
    def __init__(self, adapter, mirror):
        self.adapter = adapter
        self.mirror = mirror
        self.tasks = {}
        self.detached = {}
        self.unknown = {}
        self.poisoned = False

    @staticmethod
    def binding(event):
        value = getattr(event, '_brai_release_binding', None)
        if (not isinstance(value, tuple) or len(value) != 7 or type(value[0]) is not int
                or value[0] <= 0 or any(not isinstance(item, str) or not item for item in value[1:6])
                or type(value[6]) is not int or value[6] < 0):
            raise ValueError('INGRESS_BINDING_UNAVAILABLE')
        return value

    def tag(self, event, update_id):
        if type(update_id) is not int or update_id < 0:
            self.poisoned = True
            raise ValueError('INGRESS_UPDATE_ID_UNAVAILABLE')
        snapshot = self.mirror.snapshot(f'{self.adapter._bot.id}:{update_id}')
        profile = snapshot.get('profile')
        if snapshot.get('state') != 'known' or not isinstance(profile, dict):
            self.poisoned = True
            raise ValueError('INGRESS_BINDING_UNAVAILABLE')
        value = (profile.get('uid'), profile.get('profileId'), profile.get('userId'),
                 profile.get('telegramId'), profile.get('authorTelegramId'), profile.get('role'), profile.get('generation'))
        event._brai_release_binding = value
        event._brai_release_updates = [update_id]
        self.binding(event)

    def merge(self, existing, event):
        if self.binding(existing) != self.binding(event):
            self.poisoned = True
            raise PermissionError('INGRESS_BATCH_BINDING_CHANGED')
        before = getattr(existing, '_brai_release_updates', None)
        after = getattr(event, '_brai_release_updates', None)
        if not isinstance(before, list) or not isinstance(after, list):
            self.poisoned = True
            raise ValueError('INGRESS_BATCH_UPDATES_UNAVAILABLE')
        existing._brai_release_updates = list(dict.fromkeys([*before, *after]))

    def track(self, task, event):
        try:
            value = self.binding(event)
            if task in self.tasks:
                raise ValueError('INGRESS_BATCH_TASK_DUPLICATE')
            self.tasks[task] = value
            def finished(done):
                self.tasks.pop(done, None)
                self.mirror.tracker.changed.set()
            task.add_done_callback(finished)
            self.mirror.tracker.changed.set()
        except Exception:
            self.poisoned = True
            raise

    def text(self, event, previous, stage):
        try:
            key = self.adapter._text_batch_key(event)
            existing = self.adapter._pending_text_batches.get(key)
            if stage == 'before':
                if existing is not None and self.binding(existing) != self.binding(event):
                    raise PermissionError('INGRESS_BATCH_BINDING_CHANGED')
            elif stage == 'after':
                if existing is None:
                    return
                if existing is not event:
                    self.merge(existing, event)
                task = self.adapter._pending_text_batch_tasks.get(key)
                if task is None or previous.get(key) is task:
                    raise ValueError('INGRESS_BATCH_TASK_UNAVAILABLE')
                self.track(task, event)
            else:
                raise ValueError('INGRESS_BATCH_STAGE_INVALID')
        except Exception:
            self.poisoned = True
            raise

    def take_held(self, events):
        try:
            values = [(event, self.binding(event)) for event in events]
            if len({id(event) for event, _ in values}) != len(values):
                raise ValueError('INGRESS_HELD_DUPLICATE')
            if any(id(event) in self.detached for event, _ in values):
                raise ValueError('INGRESS_HELD_ALREADY_OWNED')
            self.detached.update((id(event), (event, binding)) for event, binding in values)
            self.mirror.tracker.changed.set()
        except Exception:
            self.poisoned = True
            raise

    def finish_held(self, event):
        item = self.detached.get(id(event))
        if item is None or item[0] is not event:
            self.poisoned = True
            raise ValueError('INGRESS_HELD_NOT_OWNED')
        del self.detached[id(event)]
        self.mirror.tracker.changed.set()

    def rehold(self, events, reason):
        for index, event in enumerate(events):
            if index == 0 and reason in ('redispatch-failed', 'redispatch-cancelled'):
                self.preserve_held(event, reason)
            self.finish_held(event)

    def preserve_held(self, event, where):
        try:
            self.unknown[id(event)] = (event, self.binding(event))
            task = asyncio.create_task(self.mirror.block_event(event))
            def completed(done):
                if not done.cancelled() and done.exception() is not None:
                    self.poisoned = True
                self.mirror.tracker.changed.set()
            task.add_done_callback(completed)
            self.mirror.tracker.changed.set()
        except Exception:
            self.poisoned = True
            raise

    def can_redispatch(self, event):
        try:
            self.binding(event)
            return id(event) not in self.unknown
        except Exception:
            self.poisoned = True
            return False

    def busy(self, uid):
        if self.poisoned:
            return True
        if any(not task.done() and binding[0] == uid for task, binding in self.tasks.items()):
            return True
        if any(binding[0] == uid for _, binding in [*self.detached.values(), *self.unknown.values()]):
            return True
        try:
            events = []
            for name in ('_pending_text_batches', '_pending_photo_batches', '_media_group_events'):
                value = getattr(self.adapter, name)
                if not isinstance(value, dict):
                    return True
                events.extend(value.values())
            held = getattr(self.adapter, '_held_inbound_events')
            if not isinstance(held, list):
                return True
            events.extend(held)
            return any(self.binding(event)[0] == uid for event in events)
        except Exception:
            return True
