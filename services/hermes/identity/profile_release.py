# ABOUTME: Удерживает один UID на границе фактической idle-проверки worker.
# ABOUTME: Сохраняет operation receipt в его защищённой SQLite и не владеет systemd.
import asyncio
from pathlib import Path
import socket
import struct

from .ordinary_admission import _replay_binding


class ProfileRelease:
    """Root выбирает exact operation/process; этот владелец удерживает только ingress."""
    def __init__(self, resolver, app):
        self.resolver, self.app = resolver, app
        self.mirror = resolver.mirror
        self.store = self.mirror.gate_store
        self.boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        self.tasks = {}
        self.task_lock = asyncio.Lock()
        self.reapers = set()

    def _track_task(self, key, binding, task, request):
        self.tasks[key] = (binding, task)
        def completed(done):
            async def release_receipt():
                if done.cancelled() or done.exception() is not None:
                    return
                try:
                    profile = await self._profile(request['profileId'])
                    row = await asyncio.to_thread(self.store.status,profile,request,self.boot)
                    if row is None or row['state'] not in ('ready','busy','resumed','unknown'):
                        return
                except Exception:
                    return
                async with self.task_lock:
                    if self.tasks.get(key) == (binding,done):
                        self.tasks.pop(key,None)
            reaper = asyncio.create_task(release_receipt())
            self.reapers.add(reaper)
            reaper.add_done_callback(self.reapers.discard)
        task.add_done_callback(completed)

    async def _profile(self, ident):
        result = await self.mirror.inventory()
        profiles = result.get('profiles') if isinstance(result, dict) else None
        if not isinstance(profiles, list):
            raise ValueError('PROFILE_INVENTORY_UNAVAILABLE')
        matches = [profile for profile in profiles if isinstance(profile, dict) and profile.get('profileId') == ident]
        if len(matches) != 1:
            raise ValueError('PROFILE_BINDING_UNAVAILABLE')
        return matches[0]

    @staticmethod
    def _request(operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        return {'operationId':operationId, 'attemptId':attemptId, 'profileId':profileId,
                'targetPayloadHash':targetPayloadHash, 'workerPid':workerPid, 'workerStartTime':workerStartTime}

    @staticmethod
    def _receipt(request, state, reason=None, **extra):
        return {**request, 'state':state, 'reason':reason, **extra}

    async def _peer(self, profile, pid, start):
        bridge = self.resolver._bridge(profile)
        peer = await bridge.connect()
        sock = peer.writer.get_extra_info('socket')
        if sock is None or sock.family != socket.AF_UNIX:
            raise PermissionError('PROFILE_PEER_UNAVAILABLE')
        actual_pid, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        stat = Path(f'/proc/{actual_pid}/stat').read_text()
        actual_start = stat.rsplit(')', 1)[1].split()[19]
        if uid != profile['uid'] or actual_pid != pid or actual_start != start:
            raise PermissionError('PROFILE_PEER_CHANGED')
        return peer

    async def try_profile(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime):
        request = self._request(operationId,attemptId,profileId,targetPayloadHash,workerPid,workerStartTime)
        key = (operationId,attemptId)
        async with self.task_lock:
            prior = self.tasks.get(key)
            if prior is None:
                task = asyncio.create_task(self._try_or_status(request))
                self._track_task(key,request,task,request)
            else:
                if prior[0] != request:
                    raise ValueError('PROFILE_GATE_BINDING_CHANGED')
                task = prior[1]
        if task.done():
            return await self.status(**request)
        return await asyncio.shield(task)

    async def _try_or_status(self, request):
        profile = await self._profile(request['profileId'])
        row = await asyncio.to_thread(self.store.status,profile,request,self.boot)
        if row is not None:
            return await self.status(**request)
        return await self._try(request)

    async def _try(self, request):
        profile = await self._profile(request['profileId'])
        self.store._binding(profile,request,self.boot)
        uid, op = profile['uid'], request['operationId']
        if (uid in self.mirror.transport_blocked or (self.mirror.transport is not None
                and await asyncio.to_thread(self.mirror.transport.blocked_for,uid))):
            return self._receipt(request,'blocked','transport_input_unknown')
        tracker = self.mirror.tracker
        batch = getattr(self.resolver, 'batch_ownership', None)
        try:
            # Проверить SO_PEERCRED до любого busy/ready receipt; до proof проверим повторно.
            await self._peer(profile, request['workerPid'], request['workerStartTime'])
            if (not self.mirror.hydrated or self.mirror.pending or batch is None
                    or batch.busy(uid) or not tracker.try_gate(uid,op)):
                await asyncio.to_thread(self.store.begin,profile,request,self.boot)
                peer = await self._peer(profile, request['workerPid'], request['workerStartTime'])
                result = await peer.call('release.reject_attempt', request, timeout=None)
                if (not isinstance(result, dict) or result.get('state') != 'busy'
                        or any(result.get(key) != request[key] for key in ('operationId','attemptId','profileId'))):
                    raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
                await asyncio.to_thread(self.store.transition,profile,request,self.boot,'arming','reopening')
                await asyncio.to_thread(self.store.transition,profile,request,self.boot,'reopening','busy')
                return self._receipt(request,'busy','ingress_work')
            await asyncio.to_thread(self.store.begin,profile,request,self.boot)
            await asyncio.to_thread(self.mirror.inbox.install_v2,profile)
            rows = await asyncio.to_thread(self.mirror.inbox.unsettled,profile)
            if any(row['state'] != 'held' or row['operationId'] != op for row in rows):
                peer = await self._peer(profile, request['workerPid'], request['workerStartTime'])
                result = await peer.call('release.reject_attempt', request, timeout=None)
                if (not isinstance(result, dict) or result.get('state') != 'busy'
                        or any(result.get(key) != request[key] for key in ('operationId','attemptId','profileId'))):
                    raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
                await asyncio.to_thread(self.store.transition,profile,request,self.boot,'arming','reopening')
                await self._reopen(profile,request,'reopening','busy')
                return self._receipt(request,'busy','ingress_work')
            peer = await self._peer(profile, request['workerPid'], request['workerStartTime'])
            result = await peer.call('release.try', request, timeout=None)
            if not isinstance(result,dict) or any(result.get(key) != request[key] for key in ('operationId','attemptId','profileId')):
                raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
            if result.get('state') == 'busy':
                await asyncio.to_thread(self.store.transition,profile,request,self.boot,'arming','reopening')
                await self._reopen(profile,request,'reopening','busy')
                return await self.status(**request)
            if result.get('state') != 'ready':
                raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
            await asyncio.to_thread(self.store.transition,profile,request,self.boot,'arming','ready')
            return self._receipt(request,'ready')
        except Exception:
            try:
                await asyncio.to_thread(self.store.transition,profile,request,self.boot,'arming','unknown')
            except Exception:
                pass
            return self._receipt(request,'blocked','attempt_unconfirmed')

    async def status(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime,
                     replacementPid=None, replacementStartTime=None):
        request = self._request(operationId,attemptId,profileId,targetPayloadHash,workerPid,workerStartTime)
        profile = await self._profile(profileId)
        try:
            row = await asyncio.to_thread(self.store.status,profile,request,self.boot)
        except Exception:
            return self._receipt(request,'unknown','attempt_binding_unconfirmed')
        if row is None:
            return self._receipt(request,'unknown','attempt_unavailable')
        state = row['state']
        if state == 'ready':
            if not self.mirror.hydrated or self.mirror.tracker.gates.get(profile['uid']) != operationId:
                return self._receipt(request,'unknown','ingress_gate_unconfirmed')
            try:
                outstanding = await asyncio.to_thread(self.mirror.inbox.unsettled, profile)
                if any(not row['bound'] or row['state'] in ('unknown', 'blocked', 'handing_off', 'captured')
                       or row['operationId'] != operationId for row in outstanding):
                    raise ValueError('PROFILE_INBOX_UNCONFIRMED')
                if self.mirror.transport is not None and await asyncio.to_thread(
                        self.mirror.transport.blocked_for,profile['uid']):
                    raise ValueError('PROFILE_TRANSPORT_UNCONFIRMED')
                peer = await self._peer(profile,workerPid,workerStartTime)
                result = await peer.call('release.try_status',request,timeout=None)
                if (not isinstance(result,dict) or result.get('state') != 'ready'
                        or any(result.get(key) != request[key] for key in ('operationId','attemptId','profileId'))):
                    raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
            except Exception:
                return self._receipt(request,'unknown','worker_unconfirmed')
            return self._receipt(request,'ready')
        if state == 'resumed':
            if profile['uid'] in self.mirror.tracker.gates:
                return self._receipt(request,'unknown','ingress_gate_unconfirmed')
            if replacementPid != row['replacement_pid'] or replacementStartTime != row['replacement_start']:
                return self._receipt(request,'unknown','replacement_changed')
            try:
                await self._peer(profile,replacementPid,replacementStartTime)
            except Exception:
                return self._receipt(request,'unknown','replacement_unconfirmed')
            return self._receipt(request,'resumed',replacementPid=replacementPid,replacementStartTime=replacementStartTime)
        if state == 'busy':
            if profile['uid'] in self.mirror.tracker.gates:
                return self._receipt(request,'unknown','ingress_gate_unconfirmed')
            try:
                peer = await self._peer(profile,workerPid,workerStartTime)
                result = await peer.call('release.try_status',request,timeout=None)
                if (not isinstance(result, dict) or result.get('state') != 'busy'
                        or any(result.get(key) != request[key] for key in ('operationId','attemptId','profileId'))):
                    raise ValueError('WORKER_ATTEMPT_UNCONFIRMED')
            except Exception:
                return self._receipt(request,'unknown','worker_unconfirmed')
            return self._receipt(request,'busy','native_work')
        if state == 'unknown':
            return self._receipt(request,'unknown','attempt_unavailable')
        return self._receipt(request,'pending',state)

    async def resume(self, operationId, attemptId, profileId, targetPayloadHash, workerPid, workerStartTime,
                     replacementPid, replacementStartTime):
        request = self._request(operationId,attemptId,profileId,targetPayloadHash,workerPid,workerStartTime)
        key = (operationId,attemptId,'resume')
        binding = (request,replacementPid,replacementStartTime)
        async with self.task_lock:
            prior = self.tasks.get(key)
            if prior is None:
                task = asyncio.create_task(self._resume(request,replacementPid,replacementStartTime))
                self._track_task(key,binding,task,request)
            else:
                if prior[0] != binding:
                    raise ValueError('PROFILE_GATE_REPLACEMENT_CHANGED')
                task = prior[1]
        return await asyncio.shield(task)

    async def _resume(self, request, replacement_pid, replacement_start):
        profile = await self._profile(request['profileId'])
        row = await asyncio.to_thread(self.store.status,profile,request,self.boot)
        if row is None or row['state'] not in ('ready','resuming','resumed'):
            return self._receipt(request,'blocked','attempt_unconfirmed')
        if row['state'] == 'resumed':
            return await self.status(**request,replacementPid=replacement_pid,replacementStartTime=replacement_start)
        if row['state'] == 'ready':
            await asyncio.to_thread(self.store.transition,profile,request,self.boot,'ready','resuming')
        try:
            peer = await self._peer(profile,replacement_pid,replacement_start)
            # A new worker exposes the socket before it claims the ingress peer or
            # finishes policy activation.  Resume is a primary-channel RPC, so
            # establish that exact channel and wait for policy readiness first.
            while True:
                health = await peer.call('health', {'require_tools':True}, timeout=None)
                if (not isinstance(health,dict) or health.get('userId') != profile['userId']
                        or health.get('ready') is not True or health.get('operational') is not True
                        or type(health.get('policyReady')) is not bool):
                    raise ValueError('WORKER_ACTIVATION_UNCONFIRMED')
                if health.get('policyReady') is True:
                    break
                await asyncio.sleep(.05)
            peer = await self._peer(profile,replacement_pid,replacement_start)
            result = await peer.call('release.resume', {'operationId':request['operationId']}, timeout=None)
            if not isinstance(result,dict) or result.get('state') != 'resumed' or result.get('operationId') != request['operationId']:
                raise ValueError('WORKER_RESUME_UNCONFIRMED')
            await self._reopen(profile,request,'resuming','resumed',replacement_pid,replacement_start)
            return self._receipt(request,'resumed',replacementPid=replacement_pid,replacementStartTime=replacement_start)
        except Exception:
            return self._receipt(request,'blocked','resume_unconfirmed')

    async def _reopen(self, profile, request, expected, target, replacement_pid=None, replacement_start=None):
        from telegram import Update
        uid, op = profile['uid'], request['operationId']
        tracker = self.mirror.tracker
        if tracker.gates.get(uid) != op:
            raise ValueError('PROFILE_GATE_UNAVAILABLE')
        while True:
            tracker.changed.clear()
            try:
                rows = await asyncio.to_thread(self.mirror.inbox.held,profile,op)
            except ValueError:
                unresolved = await asyncio.to_thread(self.mirror.inbox.unsettled,profile)
                if any(row['state'] in ('unknown','blocked','native_duplicate') or not row['bound'] for row in unresolved):
                    raise ValueError('PROFILE_INBOX_UNKNOWN')
                await tracker.changed.wait()
                continue
            if rows:
                row = rows[0]
                bot_id = self.app.bot.id
                if str(bot_id) != row['bot_id']:
                    raise ValueError('PROFILE_BOT_CHANGED')
                self.mirror.bot_id = bot_id
                replay_profile = {**profile, 'authorTelegramId':row['authorId'], 'telegramId':row['actorId'],
                                  'role':row['authRole'], 'generation':row['authGeneration']}
                key = f"{bot_id}:{row['update_id']}"
                self.mirror.register_snapshot(key, {'state':'known', 'profile':replay_profile})
                update = Update.de_json(row['update'], self.app.bot)
                token = _replay_binding.set((uid,op))
                try:
                    await self.app.update_processor.process_update(update,self.app.process_update(update))
                finally:
                    _replay_binding.reset(token)
                current = await asyncio.to_thread(self.mirror.inbox.observe, profile, bot_id, row['update_id'])
                if current['state'] == 'held':
                    # A native pending duplicate has not produced a receipt yet.
                    # Wait for the owner to finish instead of repeatedly dispatching it.
                    await tracker.changed.wait()
                continue
            batch = getattr(self.resolver,'batch_ownership',None)
            if (self.mirror.pending or tracker.counts.get(uid,0) or any(value is None for value in tracker.tickets.values())
                    or batch is None or batch.busy(uid)):
                await tracker.changed.wait()
                continue
            async with self.mirror.capture_lock:
                # Параллельная пачка не может пройти durable capture до открытия gate.
                if (self.mirror.pending or tracker.counts.get(uid,0)
                        or any(value is None for value in tracker.tickets.values()) or batch.busy(uid)):
                    continue
                # Предыдущий SELECT выполнялся в другом потоке и мог устареть,
                # пока capture завершал транзакцию. Перечитать под тем же lock,
                # который сериализует запись перед Telegram ack.
                try:
                    fresh = await asyncio.to_thread(self.mirror.inbox.held,profile,op)
                except ValueError:
                    continue
                if (fresh or self.mirror.pending or tracker.counts.get(uid,0)
                        or any(value is None for value in tracker.tickets.values()) or batch.busy(uid)):
                    continue
                if expected is not None:
                    await asyncio.to_thread(self.store.transition,profile,request,self.boot,expected,target,
                                            replacement_pid=replacement_pid,replacement_start=replacement_start)
                tracker.resume(uid,op)
                return

    async def recover_inbox(self, profile, operationId):
        """Вернуть только не переданные до crash inputs без повторения unknown."""
        await self._reopen(profile, {'operationId':operationId}, None, None)

    async def recover_external(self, update):
        """Replay only an original outsider input which was not handed off."""
        try:
            await self.app.update_processor.process_update(update,self.app.process_update(update))
        finally:
            row = await asyncio.to_thread(self.mirror.transport.observe,self.app.bot.id,update.update_id)
            if row['state'] == 'handing_off':
                await asyncio.to_thread(self.mirror.transport.transition,self.app.bot.id,update.update_id,
                                        'handing_off','unknown')
