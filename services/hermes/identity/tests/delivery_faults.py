# ABOUTME: Проверяет автоматическую доставку при настоящем SIGKILL личного native worker.
# ABOUTME: Создаёт только отдельные synthetic UID/HOME; Telegram и backend заменены тестовыми портами.
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from types import SimpleNamespace as NS
import uuid
from unittest.mock import patch


async def eventually(check, label, watch=None):
    """Дождаться наблюдаемого исхода; срок относится только к исполнению fixture."""
    async with asyncio.timeout(180):
        while not check():
            if watch is not None and watch.returncode is not None:
                raise ValueError('WORKER_EXITED')
            await asyncio.sleep(.05)


async def run(config, fixture, native, receipt):
    """Root fixture с sealed candidate и штатными Worker, Resolver, Mirror и SQLite."""
    from telegram import Bot, Update, User
    from identity.ordinary_admission import BatchOwnership
    from identity.chat_journal import IdentityJournal
    from identity.routes import RouteLedger
    from identity import telegram_runtime
    from gateway.config import Platform
    from gateway.session import SessionSource
    from gateway.platforms.event import MessageType

    source = Path(config['sourceRoot'])
    root = fixture.RUN_BASE / str(uuid.uuid4())
    root.parent.mkdir(mode=0o711, parents=True, exist_ok=True)
    root.mkdir(mode=0o711)
    identity = root.stat().st_dev, root.stat().st_ino
    workers, servers, log_tasks = [], [], []
    deliveries = []
    consumer = supervisor = None
    resolver = None
    proof = {'kind': 'hermes-durable-delivery-faults', 'sourceSha': config['sourceSha'],
             'realNativeWorker': True, 'realTelegram': False, 'realInference': False,
             'backend': 'synthetic', 'scenarios': []}
    stage = 'prepare'
    try:
        runtime = root / 'candidate'
        stage = 'candidate-archive'
        fixture.stage_archive(fixture.candidate_archive(source, config['sourceSha']), runtime)
        stage = 'software-compose'
        # Current accepted FileStore includes its private runtime reader.
        # Extend the fixture catalog explicitly; admission still verifies every manifest byte.
        if 'runtime_reads.py' not in fixture.FILES_PAYLOAD:
            fixture.FILES_PAYLOAD = (*fixture.FILES_PAYLOAD, 'runtime_reads.py')
        software, _instructions, _files = fixture.prepare_software(root, runtime, native, receipt)
        import system_instructions
        stable_instructions = root / 'system-instructions'
        system_instructions.publish(software / 'instructions', stable_instructions)
        stage = 'profile-prepare'
        uid = fixture.unused_uid()
        home = root / 'profiles/personal'
        home.parent.mkdir(mode=0o711)
        configuration = fixture.prepare_home(home, uid, 0, runtime, root / 'broker.sock')
        # Streaming has its separate boundary tests. This stand exercises durable final replies.
        settings = json.loads((home / 'config.yaml').read_text())
        settings['display']['platforms']['telegram']['streaming'] = False
        (home / 'config.yaml').write_text(json.dumps(settings))
        lock = root / 'pm.lock'; lock.touch(mode=0o600); os.chown(lock, uid, uid)
        launcher = home.parent / 'worker_launcher.py'
        launcher.write_text(fixture.WORKER_LAUNCHER)
        launcher.chmod(0o444)
        broker = fixture.FixtureBroker(uid, configuration)
        broker_runs = [broker]
        async def broker_port(reader, writer):
            await broker.handle(reader, writer)
        model = fixture.FixtureModel(None, uid)
        for name, handler in (('broker.sock', broker_port), ('model.sock', model.handle)):
            path = root / name
            servers.append(await asyncio.start_unix_server(handler, path=path, limit=65537))
            path.chmod(0o666)
        profile = {'profileId': str(uuid.uuid4()), 'userId': fixture.OWNER, 'uid': uid,
                   'telegramId': fixture.TELEGRAM, 'authorTelegramId': fixture.TELEGRAM,
                   'role': 'user', 'generation': 0, 'workerSocket': str(home / 'control/worker.sock')}
        bot = Bot('123:fixture'); bot._bot_user = User(123, 'fixture', True)
        deliveries, consumed, dispatches = [], [], []
        fail_send = False
        batch_mode = False
        batch_owner = None
        batch_popped, batch_send = asyncio.Event(), asyncio.Event()
        batch_tasks = []
        class TelegramPort:
            _bot = bot
            async def send(self, **payload):
                nonlocal fail_send
                if fail_send:
                    return {'success': False, 'error': 'fixture-offline'}
                deliveries.append(dict(payload))
                return {'success': True, 'message_id': str(len(deliveries) + 1000)}
            async def send_typing(self, **payload):
                return None
            async def send_draft(self, **payload):
                return {'success': True}
            async def edit_message(self, **payload):
                return {'success': True, 'message_id': str(payload['message_id'])}

        async def auth(method, params, **kwargs):
            if method in ('ingress.profiles', 'ingress.profiles-strict'):
                return {'profiles': [profile], 'allProfileIds': [profile['profileId']]}
            if method == 'ingress.resolve-known':
                return {'state': 'known', 'profile': profile}
            if method == 'identity.resolve': return profile
            if method in ('ingress.admit', 'ingress.close', 'ingress.status'): return {}
            raise AssertionError('Unexpected fixture Auth operation: ' + method)

        ingress = root / 'ingress'; ingress.mkdir(mode=0o700)
        def create():
            value = telegram_runtime.Resolver(TelegramPort(), ledger=RouteLedger(ingress / 'delivery.sqlite3'),
                                              journal=IdentityJournal(ingress / 'chats'))
            value.mirror.app = NS(bot=bot, update_queue=asyncio.Queue())
            return value
        def item(ident, thread=11):
            return Update.de_json({'update_id': ident, 'message': {'message_id': ident, 'date': 1,
                'message_thread_id': thread, 'chat': {'id': 123, 'type': 'private'},
                'from': {'id': 123, 'is_bot': False, 'first_name': 'Fixture'},
                'text': 'Reply with SYNTHETIC_OK.'}}, bot)
        async def consume_batch(event, ident):
            adapter = batch_owner.adapter
            key = 'restart-topic'
            previous = dict(adapter._pending_text_batch_tasks)
            existing = adapter._pending_text_batches.get(key)
            batch_owner.tag(event, ident)
            if existing is None:
                adapter._pending_text_batches[key] = event
            else:
                existing.text += '\n' + event.text
                previous[key].cancel()
            async def flush():
                # Native debounce rearms a task and mutates the SAME MessageEvent.
                # Force pop before dispatch so the lifetime regression is observable.
                await batch_ready.wait()
                combined = adapter._pending_text_batches.pop(key)
                batch_popped.set()
                await batch_send.wait()
                dispatches.extend(combined._brai_release_updates)
                await resolver._bridge(profile).dispatch(combined)
                consumed.extend(combined._brai_release_updates)
            task = asyncio.create_task(flush()); batch_tasks.append(task)
            adapter._pending_text_batch_tasks[key] = task
            batch_owner.text(event, previous, 'after')

        async def consume():
            while True:
                raw = await resolver.mirror.app.update_queue.get()
                key = f'123:{raw.update_id}'
                resolver.mirror.enter(key, raw)
                deferred = await resolver.mirror.classify(key, raw)
                if not deferred:
                    message = raw.message
                    source = SessionSource(platform=Platform.TELEGRAM, chat_id='123', chat_type='dm',
                                           user_id='123', thread_id=str(message.message_thread_id), is_bot=False)
                    event = NS(source=source, message_id=str(message.message_id), text=message.text,
                               message_type=MessageType.TEXT, _brai_release_updates=[raw.update_id])
                    try:
                        dispatches.append(raw.update_id)
                        if batch_mode:
                            await consume_batch(event, raw.update_id)
                        else:
                            await resolver._bridge(profile).dispatch(event)
                    except (ConnectionError, OSError):
                        pass
                    consumed.append(raw.update_id)
                resolver.mirror.finish(key, {'completed': True, 'deferred': deferred})
                if batch_mode and raw.update_id == 8:
                    batch_ready.set()

        async def launch():
            nonlocal broker
            # Each process gets the unchanged fixture backend contract and its
            # own bounded diagnostic transcript. Product queues stay untouched.
            if workers:
                broker = fixture.FixtureBroker(uid, configuration)
                broker_runs.append(broker)
            unit = 'brai-native-fixture-' + uuid.uuid4().hex
            args = fixture.worker_unit_args(unit, uid, 0, home, software, runtime, root / 'broker.sock',
                root / 'model.sock', receipt['paths']['python'], lock, launcher,
                dependency_paths={'venv': receipt['paths']['venv'], 'site-packages': receipt['paths']['sitePackages']})
            args.insert(args.index('/usr/bin/env'), '--property=BindReadOnlyPaths=' + str(stable_instructions) + ':/opt/brai-profile/system-instructions')
            process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
            workers.append((unit, process))
            log_tasks.append(asyncio.create_task(fixture.capture(process.stdout, 8 * 1024 * 1024)))
            return unit, process

        async def kill_worker(unit, process):
            status = await asyncio.to_thread(subprocess.check_output,
                ['/usr/bin/systemctl', 'show', unit, '--property=MainPID', '--value'])
            pid = int(status.strip())
            fixture.require(pid > 1 and Path('/proc', str(pid)).stat().st_uid == uid, 'FAULT_TARGET_CHANGED')
            pidfd = os.pidfd_open(pid)
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            finally:
                os.close(pidfd)
            await process.wait()
            proof.setdefault('signals', []).append({'signal': 'SIGKILL', 'uid': uid, 'pid': pid,
                                                    'unitExit': process.returncode})

        async def stop_owned(unit, process):
            try:
                await fixture.stop_unit(unit, process)
            except ValueError:
                # --collect can remove a transient unit between show and stop.
                # Accept only independently verified terminal state and empty own cgroup.
                response = await asyncio.to_thread(subprocess.run, ['/usr/bin/systemctl', 'show', unit,
                    '--property=LoadState,ActiveState,MainPID,ControlGroup'], stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, check=False)
                state = fixture.parse_unit_state(response)
                fixture.require(state['ActiveState'] in ('inactive', 'failed') and state['MainPID'] == '0', 'CLEANUP_UNIT_SURVIVED')
                fixture.require(not fixture.cgroup_pids(state['ControlGroup'], unit), 'CLEANUP_CGROUP_SURVIVED')
                await process.wait()

        with patch.dict(os.environ, {'BRAI_IDENTITY_INSTANCE': 'dev'}), patch.object(telegram_runtime, 'broker_call', auth):
            resolver = create()
            await resolver.mirror.hydrate()
            supervisor = asyncio.create_task(resolver._supervise())
            consumer = asyncio.create_task(consume())
            stage = 'worker-absent'
            raw = item(1)
            await resolver.mirror.capture([raw], 123)
            # Polling ordinarily queues this same captured Update once.
            await resolver.mirror.app.update_queue.put(raw)
            await eventually(lambda: not resolver.mirror.snapshots, 'deferred')
            fixture.require(resolver.mirror.inbox.observe(profile, 123, 1)['state'] == 'captured', 'EARLY_ACK')
            stage = 'first-worker-start'
            unit, process = await launch()
            stage = 'first-automatic-reply'
            await eventually(lambda: len(deliveries) >= 1, 'first-delivery', watch=process)
            await eventually(lambda: not resolver.turns, 'first-idle')
            fixture.require(resolver.mirror.inbox.observe(profile, 123, 1)['state'] == 'accepted', 'INPUT_NOT_ACCEPTED')
            proof['scenarios'].append('worker-absent-automatic-admission')

            stage = 'sigkill-and-queue'
            await kill_worker(unit, process)
            await eventually(lambda: profile['uid'] not in resolver.ready_profiles, 'offline-observed')
            for ident, thread in ((2, 11), (3, 12)):
                raw = item(ident, thread)
                await resolver.mirror.capture([raw], 123)
                await resolver.mirror.app.update_queue.put(raw)
            await eventually(lambda: not resolver.mirror.snapshots, 'offline-deferred')
            unit, process = await launch()
            await eventually(lambda: len(deliveries) >= 3, 'two-queued-replies')
            await eventually(lambda: not resolver.turns, 'second-idle')
            fixture.require([p.get('metadata', {}).get('thread_id') for p in deliveries[:3]] == ['11', '11', '12'], 'TOPIC_ORDER_CHANGED')
            proof['scenarios'].append('sigkill-then-two-topics-automatic-admission')

            stage = 'lost-dispatch-receipt'
            bridge = resolver._bridge(profile)
            peer = await bridge.connect()
            original_call = peer.call
            lost = False
            async def lose_ack(method, params, **kwargs):
                nonlocal lost
                value = await original_call(method, params, **kwargs)
                if method == 'dispatch' and not lost:
                    lost = True
                    raise ConnectionError('fixture-lost-receipt')
                return value
            peer.call = lose_ack
            raw = item(4)
            await resolver.mirror.capture([raw], 123)
            await resolver.mirror.app.update_queue.put(raw)
            await eventually(lambda: len(deliveries) >= 4, 'lost-ack-reply')
            await eventually(lambda: resolver.mirror.inbox.observe(profile, 123, 4)['state'] == 'accepted', 'lost-ack-reconciled')
            fixture.require(dispatches.count(4) == 1, 'LOST_ACK_REEXECUTED')
            proof['scenarios'].append('lost-dispatch-receipt-status-reconciliation')
            peer.call = original_call
            await eventually(lambda: not resolver.turns, 'lost-ack-idle')

            stage = 'saved-reply-retry'
            fail_send = True
            raw = item(5)
            await resolver.mirror.capture([raw], 123)
            await resolver.mirror.app.update_queue.put(raw)
            await eventually(lambda: 5 in consumed and not resolver.turns, 'reply-generated')
            requests_before = len(model.requests)
            await kill_worker(unit, process)
            fail_send = False
            unit, process = await launch()
            await eventually(lambda: len(deliveries) >= 5, 'saved-reply-delivered')
            fixture.require(len(model.requests) == requests_before, 'OUTBOX_RERAN_MODEL')
            proof['scenarios'].append('reply-transport-failure-worker-sigkill-saved-bytes-retry')

            stage = 'pause'
            resolver.journal.set_chat_pause(profile, ('123', '13'), True)
            raw = item(6, 13)
            await resolver.mirror.capture([raw], 123)
            await resolver.mirror.app.update_queue.put(raw)
            await eventually(lambda: not resolver.mirror.snapshots, 'paused-deferred')
            fixture.require(6 not in dispatches, 'PAUSED_INPUT_EXECUTED')
            proof['scenarios'].append('pause-preserved')
            fixture.require(not consumer.done() and not supervisor.done(), 'AUTOMATIC_PROCESSOR_DIED')
            stage = 'ingress-restart-and-merged-batch'
            await kill_worker(unit, process)
            for task in (consumer, supervisor):
                task.cancel()
            await asyncio.gather(consumer, supervisor, return_exceptions=True)
            for bridge in resolver.bridges.values():
                if bridge.peer is not None: bridge.peer.writer.close()
                if bridge.task is not None: bridge.task.cancel()
            await asyncio.gather(*(b.task for b in resolver.bridges.values() if b.task), return_exceptions=True)
            for ident in (7, 8):
                await resolver.mirror.capture([item(ident, 14)], 123)
            resolver.ledger.close()
            resolver = create()
            await resolver.mirror.hydrate()
            batch_mode = True
            batch_ready = asyncio.Event()
            adapter = NS(_bot=bot, _pending_text_batches={}, _pending_text_batch_tasks={},
                         _pending_photo_batches={}, _media_group_events={}, _held_inbound_events=[],
                         _text_batch_key=lambda event: 'restart-topic')
            batch_owner = BatchOwnership(adapter, resolver.mirror)
            supervisor = asyncio.create_task(resolver._supervise())
            consumer = asyncio.create_task(consume())
            requests_before = len(model.requests)
            unit, process = await launch()
            await eventually(batch_popped.is_set, 'merged-pop', watch=process)
            fixture.require(all(f'123:{ident}' in resolver.mirror.snapshots for ident in (7, 8)), 'MERGED_ADMISSION_LOST')
            batch_send.set()
            await eventually(lambda: len(deliveries) == 6, 'merged-delivery', watch=process)
            await eventually(lambda: not resolver.turns, 'merged-idle')
            await asyncio.gather(*batch_tasks, return_exceptions=True)
            for ident in (7, 8):
                fixture.require(resolver.mirror.inbox.observe(profile, 123, ident)['state'] == 'accepted', 'MERGED_INPUT_NOT_ACCEPTED')
            fixture.require(len(model.requests) == requests_before + 1, 'MERGED_INPUT_RERAN_MODEL')
            fixture.require(resolver.journal.chat_state(profile, ('123', '13'))['paused'], 'PAUSE_LOST_ON_RESTART')
            proof['scenarios'].append('ingress-and-worker-restart-two-messages-one-native-turn')
            fixture.require(len(deliveries) == 6 and all('SYNTHETIC_OK' in p.get('content', '') for p in deliveries), 'REPLIES_UNPROVEN')
            proof.update(state='verified', delivered=len(deliveries), uniqueInputs=len(set(consumed)),
                         processKills=3, mergedInputs=2, mergedModelRequests=1, modelRequests=len(model.requests), manualQueueResets=0)
    except BaseException as error:
        proof.update(state='failed', stage=stage, errorType=type(error).__name__, code=fixture.safe_error_code(error))
        if str(error) in {'FAULT_KILL_FAILED', 'FAULT_NOT_OBSERVED', 'TOPIC_ORDER_CHANGED', 'WORKER_EXITED',
                          'EARLY_ACK', 'INPUT_NOT_ACCEPTED', 'LOST_ACK_REEXECUTED', 'OUTBOX_RERAN_MODEL',
                          'PAUSED_INPUT_EXECUTED', 'AUTOMATIC_PROCESSOR_DIED', 'REPLIES_UNPROVEN'}:
            proof['code'] = str(error)
        proof['workerExitCodes'] = [process.returncode for _unit, process in workers]
        proof['controllerUid'] = os.geteuid()
        proof['deliverySummary'] = [{'syntheticMarker': 'SYNTHETIC_OK' in p.get('content', ''),
                                     'thread': p.get('metadata', {}).get('thread_id')} for p in deliveries]
        if consumer is not None and consumer.done() and not consumer.cancelled():
            proof['consumerError'] = type(consumer.exception()).__name__ if consumer.exception() else None
    finally:
        for task in (consumer, supervisor, *locals().get('batch_tasks', [])):
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        if resolver is not None:
            for bridge in resolver.bridges.values():
                if bridge.peer is not None: bridge.peer.writer.close()
                if bridge.task is not None: bridge.task.cancel()
            await asyncio.gather(*(b.task for b in resolver.bridges.values() if b.task), return_exceptions=True)
            resolver.ledger.close()
        cleanup_errors = []
        for unit, process in workers:
            try:
                await stop_owned(unit, process)
            except Exception as error:
                cleanup_errors.append({'unit': unit, 'type': type(error).__name__, 'code': fixture.safe_error_code(error)})
        for server in servers:
            server.close()
            server.abort_clients()
            await server.wait_closed()
        for task in log_tasks:
            if not task.done(): task.cancel()
        logs = await asyncio.gather(*log_tasks, return_exceptions=True)
        proof['workerExceptions'] = [row for raw in logs if isinstance(raw, bytes)
                                     for row in fixture.worker_exception_diagnostics(raw)]
        if cleanup_errors:
            proof.update(state='failed', cleaned=False, cleanupErrors=cleanup_errors, fixtureRoot=str(root))
        else:
            fixture.remove_owned_root(root, identity)
            proof['cleaned'] = True
    return proof
