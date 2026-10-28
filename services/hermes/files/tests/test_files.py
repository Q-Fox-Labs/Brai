# ABOUTME: Проверяет файловую границу Hermes с настоящими временными файлами и SQLite.
# ABOUTME: Моделирует Artifacts/Bot API без сети, включая перезапуск и неизвестный результат отправки.
import asyncio
from hashlib import sha256
import json
import mimetypes
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from files.store import FileStore, FileError, deliver, delivery_plan
from files import native, install


class Backend:
    """Имитация owner-bound publisher с восстановлением байтов из удалённого хранилища."""
    def __init__(self, cache):
        self.cache, self.requests, self.remote, self.calls = cache, {}, {}, []
        self.fail_publish = False
        self.fail_fetch = set()
        self.corrupt = False

    def call(self, method, args, **kwargs):
        self.calls.append((method, dict(args)))
        if method == 'files.publish':
            if self.fail_publish:
                raise RuntimeError('unavailable')
            data, name = Path(args['path']).read_bytes(), Path(args['path']).name
            aid = self.requests.setdefault(args['requestId'], str(uuid.uuid4()))
            if aid in self.remote and self.remote[aid][0] != data:
                raise RuntimeError('request conflict')
            self.remote[aid] = (data, name)
        elif method == 'files.fetch':
            aid = args['artifactId']
            if aid in self.fail_fetch or aid not in self.remote:
                raise RuntimeError('owner/not-ready/unavailable')
            data, name = self.remote[aid]
        else:
            raise AssertionError(method)
        path = self.cache / aid / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data + (b'corrupt' if self.corrupt else b''))
        return {'artifactId': aid, 'filename': name, 'localPath': str(path),
                'mimeType': mimetypes.guess_type(name)[0] or 'application/octet-stream',
                'sizeBytes': len(data), 'sha256': sha256(data).hexdigest()}


class FilesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp_root = Path(__file__).resolve().parents[4] / 'tmp'
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.root = Path(self.temp.name)
        self._asyncioTestLoop = None
        self.cache = self.root / 'cache'
        self.input = self.root / 'input'
        self.input.mkdir()
        self.backend = Backend(self.cache)
        self.config = {'ownerId': 'owner', 'stateRoot': str(self.root / 'state'),
                       'resultRoot': str(self.cache), 'readRoots': [str(self.input)], 'account': 'instance-1'}
        self.store = native.configure(self.config, self.backend)
        self.source = {'platform': 'telegram', 'account': 'instance-1', 'chat': '1', 'thread': '', 'sender': '2'}

    def tearDown(self):
        self.temp.cleanup()

    def file(self, index=0, suffix='.jpg'):
        path = self.input / ('file-' + str(index) + suffix)
        path.write_bytes(('fixture-' + str(index)).encode())
        return path

    def items(self, count, suffix='.jpg'):
        values = []
        for i in range(count):
            value = self.store.publish(self.file(i, suffix), ['generated', i, suffix])
            values.append({'file': self.store.checked(value), 'caption': str(i), 'presentation': native.presentation(value)})
        return values

    def event(self, message='10', group='album', source=None, path=None):
        s = SimpleNamespace(platform='telegram', chat_id='1', thread_id=None, user_id='2', profile=None)
        if source:
            vars(s).update(source)
        return SimpleNamespace(message_id=message, raw_message=SimpleNamespace(media_group_id=group), source=s,
                               text='подпись ' + message, media_urls=[str(path or self.file(message))],
                               media_types=['image/jpeg'], metadata={})

    def test_installation_plans_bind_two_separate_engines_and_nodes(self):
        plans = []
        for account in ('dev', 'prod'):
            root = self.root / account
            for name in ('engine', 'profile', 'runtime/services/hermes/files', 'config'):
                (root / name).mkdir(parents=True, exist_ok=True)
            (root / 'runtime/services/hermes/files/bootstrap.py').write_text("CONFIG = '__BRAI_FILES_CONFIG__'\\n")
            publisher_path = root / 'config/publisher.json'
            publisher_path.write_text('{}')
            tools = root / 'config/tools.json'
            tools.write_text(json.dumps({'publisher': {'configPath': str(publisher_path)}}))
            publisher = {'resultRoot': str(root / 'profile/results'), 'allowedReadRoots': []}
            identity = SimpleNamespace(pw_uid=123, pw_gid=456)
            plan = install.configuration_plan(root / 'engine', root / 'profile', root / 'runtime',
                root / 'config/files.json', tools, account, 'owner-' + account, 'brai-' + account,
                str(root / 'private/node'), account == 'dev', publisher, identity)
            config = json.loads(plan[1][1])
            self.assertEqual(config['engineRoot'], str(root / 'engine'))
            self.assertEqual(config['node'], str(root / 'private/node'))
            self.assertEqual(config['ownerId'], 'owner-' + account)
            self.assertEqual(plan[0][0], root / 'engine/brai_files.py')
            self.assertEqual(plan[0][-1], 0o440 if account == 'dev' else 0o644)
            self.assertIn(str(root / 'config/files.json').encode(), plan[0][1])
            plans.append({str(row[0]) for row in plan})
        self.assertFalse(plans[0].intersection(plans[1]))

    async def test_sizes_receive_send_and_restore(self):
        for count in [1, 2, 10, 11]:
            with self.subTest(count=count):
                refs = [self.store.ingest(self.source, str(count) + ':' + str(i), self.file(i), i, 'подпись ' + str(i), 'g' + str(count)) for i in range(count)]
                admitted = self.store.admit(refs[0]['groupId'])
                self.assertEqual(len(admitted['items']), count)
                self.assertEqual([item['caption'] for item in admitted['items']], ['подпись ' + str(i) for i in range(count)])
                items = [{'file': ref['file'], 'caption': str(i), 'presentation': 'photo'} for i, ref in enumerate(refs)]
                calls = []
                async def sender(kind, prepared, fallback):
                    calls.append((kind, len(prepared)))
                    self.assertTrue(all(Path(item['localPath']).is_file() for item in prepared))
                    return list(range(1, len(prepared) + 1))
                value = await deliver(self.store, 'out' + str(count), items, sender, 'album')
                self.assertEqual(value['state'], 'sent')
                self.assertEqual(len(value['receipts']), count)
                expected = [('single', 1)] if count == 1 else [('album', min(count, 10))] + ([('single', 1)] if count == 11 else [])
                self.assertEqual(calls, expected)
                self.store.cleanup('out' + str(count))
                self.assertFalse(Path(self.cache / refs[0]['file']['artifactId']).exists())
                self.assertEqual(Path(self.store.fetch(refs[0]['file']['artifactId'])['localPath']).read_bytes(), b'fixture-0')

    async def test_repeat_late_and_restart(self):
        first = self.store.ingest(self.source, '10', self.file(10), 10, 'a', 'album')
        second = self.store.ingest(self.source, '11', self.file(11), 11, 'b', 'album')
        count = len([c for c in self.backend.calls if c[0] == 'files.publish'])
        repeated = self.store.ingest(self.source, '10', self.file(10), 10, 'a', 'album')
        self.assertEqual(repeated['file']['artifactId'], first['file']['artifactId'])
        self.assertEqual(len([c for c in self.backend.calls if c[0] == 'files.publish']), count)
        # Все принятые элементы восстановлены по сохранённым IDs после удаления кэша.
        shutil.rmtree(self.cache)
        restored = FileStore(self.store.root, self.cache, 'owner', self.backend, [self.input])
        self.assertEqual(len(restored.admit(first['groupId'])['items']), 2)
        self.assertTrue(restored.admit(first['groupId'])['duplicate'])
        late = restored.ingest(self.source, '12', self.file(12), 12, 'c', 'album')
        supplement = restored.admit(late['groupId'])
        self.assertTrue(supplement['supplement'])
        self.assertEqual([i['caption'] for i in supplement['items']], ['c'])

    async def test_routes_do_not_merge(self):
        groups = []
        for changes in [{}, {'chat': '2'}, {'thread': '3'}, {'sender': '4'}, {'account': 'other'}, {'platform': 'api'}]:
            groups.append(self.store.ingest({**self.source, **changes}, '1', self.file(1), 1, '', 'same')['groupId'])
        self.assertEqual(len(set(groups)), len(groups))

    async def test_inbound_failure_and_restart_before_handoff_do_not_lose_set(self):
        event = self.event('91')
        await native.accept_event(event, admit=False)
        original = self.store.fetch
        calls = 0
        def fail_second(artifact):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise FileError('ARTIFACTS_UNAVAILABLE')
            return original(artifact)
        with patch.object(self.store, 'fetch', side_effect=fail_second):
            with self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
                await native.accept_event(event)
        group = event.metadata['_brai_artifacts'][0]['groupId']
        with self.store.db() as db:
            self.assertIsNone(db.execute('SELECT admitted FROM groups WHERE identity=?', (group,)).fetchone()[0])
        self.assertTrue(await native.accept_event(event))
        with self.store.db() as db:
            self.assertIsNone(db.execute('SELECT admitted FROM groups WHERE identity=?', (group,)).fetchone()[0])
        native.release_event(event)
        native.configure(self.config, self.backend)
        replay = self.event('91')
        self.assertTrue(await native.accept_event(replay))
        self.assertTrue(native.commit_inbound(replay.source, replay.message_id))
        with self.assertRaisesRegex(FileError, 'ALREADY_ADMITTED'):
            native.commit_inbound(replay.source, replay.message_id)
        native.release_event(replay)
        duplicate = self.event('91')
        self.assertFalse(await native.accept_event(duplicate))

    async def test_pending_album_with_late_element_after_restart(self):
        first = self.event('10')
        self.assertTrue(await native.accept_event(first))
        old_ticket = native._prepared_inbound.get()[2]
        native.release_event(first)
        late = self.event('11')
        await native.accept_event(late, admit=False)
        native.configure(self.config, self.backend)
        recovered = self.event('10')
        self.assertTrue(await native.accept_event(recovered))
        group = recovered.metadata['fileSets'][0]
        self.assertEqual(len(group['items']), 2)
        new_ticket = native._prepared_inbound.get()[2]
        self.assertNotEqual(old_ticket, new_ticket)
        with native.inbound_handoff(recovered.source, recovered.message_id):
            with native.conversation(SimpleNamespace(session_id='recovery'), recovered.text):
                pass
        with self.assertRaisesRegex(FileError, 'ALREADY_ADMITTED'):
            native.commit_inbound(first.source, first.message_id, old_ticket)
        native.release_event(recovered)
        self.assertFalse(await native.accept_event(self.event('11')))

    async def test_conflicting_pending_album_schedules_recovery_without_restart(self):
        first = self.event('10')
        await native.accept_event(first)
        first_ticket = native._prepared_inbound.get()[2]
        late = self.event('11')
        await native.accept_event(late, admit=False)
        combined = self.event('10')
        await native.accept_event(combined)
        combined_ticket = native._prepared_inbound.get()[2]
        recovered = asyncio.Event()
        async def fake_recover(adapter):
            recovered.set()
        adapter = SimpleNamespace(platform='telegram')
        try:
            with patch.object(native, 'recover', side_effect=fake_recover):
                native.schedule_recovery(adapter)
                await asyncio.wait_for(recovered.wait(), 2)
                await adapter._brai_recovery_task
                recovered.clear()
                native.commit_inbound(first.source, first.message_id, first_ticket)
                with self.assertRaisesRegex(FileError, 'ADMISSION_CONFLICT'):
                    native.commit_inbound(combined.source, combined.message_id, combined_ticket)
                await asyncio.wait_for(recovered.wait(), 2)
                await adapter._brai_recovery_task
        finally:
            native._recovery_targets.pop(id(adapter), None)
            native.release_event(first)
            native.release_event(combined)

    async def test_conflict_recovery_processes_only_late_item(self):
        first = self.event('10')
        await native.accept_event(first)
        first_ticket = native._prepared_inbound.get()[2]
        late = self.event('11')
        await native.accept_event(late, admit=False)
        combined = self.event('10')
        await native.accept_event(combined)
        combined_ticket = native._prepared_inbound.get()[2]
        observed = []
        class Adapter:
            platform = 'telegram'
            async def handle_message(self, event):
                if await native.accept_event(event):
                    observed.extend(event.metadata['fileSets'][0]['items'])
                    with native.inbound_handoff(event.source, event.message_id):
                        with native.conversation(SimpleNamespace(session_id='recovery'), event.text):
                            pass
                    native.release_event(event)
        adapter = Adapter()
        config = ModuleType('gateway.config'); config.Platform = lambda value: value
        session = ModuleType('gateway.session'); session.SessionSource = lambda **kwargs: SimpleNamespace(**kwargs)
        event = ModuleType('gateway.platforms.event')
        event.MessageType = SimpleNamespace(DOCUMENT='document')
        event.MessageEvent = lambda **kwargs: SimpleNamespace(**kwargs, raw_message=SimpleNamespace(media_group_id='album'))
        ports = {'gateway.config': config, 'gateway.session': session, 'gateway.platforms.event': event}
        native._recovery_targets[id(adapter)] = (asyncio.get_running_loop(), adapter)
        try:
            native.commit_inbound(first.source, first.message_id, first_ticket)
            with patch.dict(sys.modules, ports):
                with self.assertRaisesRegex(FileError, 'ADMISSION_CONFLICT'):
                    native.commit_inbound(combined.source, combined.message_id, combined_ticket)
                await asyncio.sleep(0)
                await adapter._brai_recovery_task
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0]['source']['messageId'], '11')
            with self.store.db() as db:
                admitted = json.loads(db.execute('SELECT admitted FROM groups').fetchone()[0])
            self.assertEqual(len(admitted), 2)
        finally:
            native._recovery_targets.pop(id(adapter), None)
            native.release_event(first)
            native.release_event(combined)

    async def test_partial_storage_never_uses_raw_cache(self):
        one = self.event('10')
        await native.accept_event(one, admit=False)
        self.backend.fail_publish = True
        two = self.event('11')
        with self.assertRaisesRegex(FileError, 'INCOMPLETE'):
            await native.accept_event(two, admit=False)
        self.assertEqual(two.media_urls, [])
        with self.assertRaisesRegex(FileError, 'INCOMPLETE'):
            self.store.admit(one.metadata['_brai_artifacts'][0]['groupId'])

    async def test_outbound_preflight_covers_last_file(self):
        items = self.items(11)
        self.backend.fail_fetch.add(items[-1]['file']['artifactId'])
        calls = []
        async def send(*args):
            calls.append(args)
        with self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
            await deliver(self.store, 'preflight', items, send, 'album')
        self.assertEqual(calls, [])

    async def test_corrupt_and_owner_cache_cannot_bypass_fetch(self):
        item = self.items(1)[0]
        self.backend.corrupt = True
        with self.assertRaisesRegex(FileError, 'HASH_MISMATCH'):
            self.store.fetch(item['file']['artifactId'])
        self.backend.corrupt = False
        self.backend.fail_fetch.add(item['file']['artifactId'])
        with self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
            self.store.resolve(self.cache / item['file']['artifactId'] / item['file']['filename'], 'again')
        with self.assertRaisesRegex(FileError, 'OWNER_MISMATCH'):
            FileStore(self.store.root, self.cache, 'other-owner', self.backend)

    async def test_unknown_never_replays_or_falls_back(self):
        items, sent = self.items(2), []
        async def sender(kind, prepared, fallback):
            sent.append(kind)
            raise TimeoutError('response lost after Telegram accepted album')
        result = await deliver(self.store, 'unknown', items, sender, 'album')
        self.assertEqual(result['state'], 'unknown')
        restored = FileStore(self.store.root, self.cache, 'owner', self.backend)
        again = await deliver(restored, 'unknown', items, sender, 'album')
        self.assertEqual(again['state'], 'unknown')
        self.assertTrue(again['repeated'])
        self.assertEqual(sent, ['album'])

    async def test_partial_ack_keeps_first_ten_receipts(self):
        items, calls = self.items(11), []
        async def sender(kind, prepared, fallback):
            calls.append(kind)
            if len(calls) == 2:
                raise TimeoutError()
            return list(range(10))
        value = await deliver(self.store, 'partial', items, sender, 'album')
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(len(value['receipts']), 10)
        self.assertEqual(calls, ['album', 'single'])

    async def test_telegram_observer_retains_each_file_of_partial_album(self):
        base = ModuleType('gateway.platforms.base')
        base.SendResult = SimpleNamespace
        observed, calls = [], []
        class Observer:
            async def observe_send(self, chat_id, metadata, text, result, attachments, identity):
                observed.append((identity, result.success, attachments[0]['artifactId']))
        async def sender(*args):
            calls.append(True)
            if len(calls) == 2:
                raise TimeoutError()
            return list(range(100, 110))
        items = self.items(11)
        native.register_telegram_observer(Observer())
        try:
            with patch.dict(sys.modules, {'gateway.platforms.base': base}), patch.object(native, 'telegram_sender', side_effect=sender):
                result = await native.send_set(SimpleNamespace(platform='telegram'), '42', items, 'album', identity='fixture')
            self.assertFalse(result.success)
            self.assertEqual(len(observed), 11)
            self.assertEqual(len({row[0] for row in observed}), 11)
            self.assertEqual(sum(row[1] for row in observed), 10)
            self.assertEqual({row[2] for row in observed}, {item['file']['artifactId'] for item in items})
        finally:
            native.register_telegram_observer(None)

    async def test_direct_send_unknown_is_reused_after_restart_and_success_allows_new_send(self):
        class Result(SimpleNamespace):
            pass
        base = ModuleType('gateway.platforms.base')
        base.SendResult = Result
        items = self.items(1)
        adapter = SimpleNamespace(platform='telegram')
        calls = []
        async def lost(*args):
            calls.append('sent')
            raise TimeoutError('accepted but acknowledgement lost')
        with patch.dict(sys.modules, {'gateway.platforms.base': base}), patch.object(native, 'telegram_sender', side_effect=lost):
            first = await native.send_set(adapter, '42', items, 'files')
            self.assertFalse(first.success)
            native.configure(self.config, self.backend)
            second = await native.send_set(adapter, '42', items, 'files')
            self.assertFalse(second.success)
            self.assertEqual(first.raw_response['deliveryId'], second.raw_response['deliveryId'])
            self.assertEqual(calls, ['sent'])
        async def sent(*args):
            calls.append('confirmed')
            return [123]
        other = self.items(1, '.png')
        with patch.dict(sys.modules, {'gateway.platforms.base': base}), patch.object(native, 'telegram_sender', side_effect=sent):
            one = await native.send_set(adapter, '42', other, 'files')
            two = await native.send_set(adapter, '42', other, 'files')
            self.assertTrue(one.success and two.success)
            self.assertNotEqual(one.raw_response['deliveryId'], two.raw_response['deliveryId'])
            self.assertEqual(calls.count('confirmed'), 2)

    async def test_non_telegram_adapter_records_partial_receipts(self):
        class Result(SimpleNamespace):
            pass
        base = ModuleType('gateway.platforms.base')
        base.SendResult = Result
        calls = []
        async def notice(*args, **kwargs):
            return Result(success=True)
        async def send_image_file(*args, **kwargs):
            calls.append(kwargs['image_path'])
            if len(calls) == 2:
                raise TimeoutError('ack lost')
            return Result(success=True, message_id='first')
        adapter = SimpleNamespace(platform='matrix', send=notice, send_image_file=send_image_file)
        items = self.items(3)
        with patch.dict(sys.modules, {'gateway.platforms.base': base}):
            result = await native.send_set(adapter, '42', items, 'album', identity='partial-matrix')
        self.assertFalse(result.success)
        self.assertEqual(result.raw_response['state'], 'unknown')
        self.assertEqual(result.raw_response['receipts'], [{'artifactId': items[0]['file']['artifactId'], 'messageId': 'first'}])
        self.assertEqual(len(calls), 2)

    async def test_partial_non_album_channel_persists_each_confirmed_receipt(self):
        items, calls = self.items(3), []
        async def sender(kind, prepared, fallback):
            calls.append((kind, len(prepared), fallback))
            if len(calls) == 2:
                raise TimeoutError('second response lost')
            return ['confirmed-1']
        result = await deliver(self.store, 'non-album-partial', items, sender, 'album', supports_album=False)
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['receipts'], [{'artifactId': items[0]['file']['artifactId'], 'messageId': 'confirmed-1'}])
        self.assertEqual(calls, [('single', 1, True), ('single', 1, True)])
        restored = FileStore(self.store.root, self.cache, 'owner', self.backend)
        repeated = await deliver(restored, 'non-album-partial', items, sender, 'album', supports_album=False)
        self.assertTrue(repeated['repeated'])
        self.assertEqual(repeated['receipts'], result['receipts'])
        self.assertEqual(len(calls), 2)

    async def test_concurrent_delivery_does_not_block_event_loop(self):
        items = self.items(2)
        started, finish = asyncio.Event(), asyncio.Event()
        async def sender(*args):
            started.set()
            await finish.wait()
            return [1, 2]
        pending = asyncio.create_task(deliver(self.store, 'concurrent', items, sender, 'album'))
        await started.wait()
        with self.assertRaisesRegex(FileError, 'OPERATION_IN_PROGRESS'):
            await deliver(self.store, 'concurrent', items, sender, 'album')
        finish.set()
        self.assertEqual((await pending)['state'], 'sent')

    async def test_leases_protect_nested_readers(self):
        items = self.items(1)
        path = self.cache / items[0]['file']['artifactId'] / items[0]['file']['filename']
        with self.store.materialize([items[0]['file']], 'same'):
            with self.store.materialize([items[0]['file']], 'same'):
                self.store.cleanup('other')
                self.assertTrue(path.exists())
            self.store.cleanup('other')
            self.assertTrue(path.exists())
        self.store.cleanup('other')
        self.assertFalse(path.exists())

    async def test_mixed_visual_and_incompatible_sets(self):
        items = self.items(2)
        visual = [items[0], {**items[1], 'presentation': 'video'}]
        self.assertEqual(delivery_plan(visual, 'album')['batches'][0]['kind'], 'album')
        incompatible = [items[0], {**items[1], 'presentation': 'audio'}]
        plan = delivery_plan(incompatible, 'album')
        self.assertTrue(plan['fallback'])
        self.assertEqual([b['items'][0]['caption'] for b in plan['batches']], ['0', '1'])

    async def test_native_provenance_supplement_and_no_reupload(self):
        first, second = self.event('10'), self.event('11')
        await native.accept_event(first, False)
        await native.accept_event(second, False)
        native.merge_events(first, second)
        first.media_urls.extend(second.media_urls)
        self.assertTrue(await native.accept_event(first))
        self.assertEqual(len(first.metadata['fileSets'][0]['items']), 2)
        origin = first.metadata['fileSets'][0]['items'][0]['source']
        self.assertEqual(origin['mediaGroupId'], 'album')
        self.assertEqual(origin['messageId'], '10')
        self.assertEqual(origin['attachmentId'], '0')
        native.commit_inbound(first.source, first.message_id)
        native.release_event(first)
        late = self.event('12')
        self.assertTrue(await native.accept_event(late))
        self.assertEqual(len(late.metadata['fileSets'][0]['items']), 1)
        self.assertIn('Дополнение', late.text)
        native.commit_inbound(late.source, late.message_id)
        native.release_event(late)
        repeated = self.event('12')
        self.assertFalse(await native.accept_event(repeated))

    async def test_cli_api_background_child_and_service_files(self):
        service = self.root / 'service'
        service.mkdir()
        (service / 'config').write_text('служебный')
        self.store.service_roots = (service,)
        for channel in ['cli', 'api', 'background', 'child']:
            agent = SimpleNamespace(session_id=channel)
            original = self.file(channel, '.txt')
            with native.conversation(agent, '@file:' + str(original), channel) as message:
                self.assertIn('artifactId=', message)
                work = Path(agent._brai_workspace)
                self.assertEqual(native.before_tool('terminal', {})['workdir'], str(work))
                args = native.before_tool('write_file', {'path': 'result.txt'})
                Path(args['path']).write_text(channel)
                response = native.final_text('MEDIA:' + args['path'], channel)
                self.assertIn(str(self.cache), response)
                envelope = native.result_envelope({'final_response': response}, agent)
                aid = envelope['fileSets'][0]['items'][0]['file']['artifactId']
                self.assertIn('artifact:' + aid, envelope['final_response'])
                self.assertIn(aid, self.backend.remote)
                self.assertEqual(native.before_tool('read_file', {'path': str(service / 'config')})['path'], str(service / 'config'))
                with self.assertRaisesRegex(FileError, 'TEMPORARY_OUTPUT_REQUIRED'):
                    native.before_tool('write_file', {'path': str(self.input / 'persistent.txt')})
            self.assertFalse(work.exists())
            self.store.cleanup(channel)
            self.assertEqual(Path(self.store.fetch(aid)['localPath']).read_text(), channel)

    async def test_explicit_set_retains_caption_mode_and_duplicates(self):
        items = self.items(2)
        data = {'mode': 'album', 'items': [{'artifactId': item['file']['artifactId'], 'caption': item['caption']} for item in items]}
        text = native.final_text('BRAI_FILES:' + json.dumps(data), 'turn')
        paths = [json.loads(line.removeprefix('MEDIA:')) for line in text.splitlines()]
        restored, mode = native.output_items(paths)
        self.assertEqual(mode, 'album')
        self.assertEqual([i['caption'] for i in restored], ['0', '1'])

    async def test_telegram_long_captions_topic_and_mixed_types(self):
        items = self.items(2)
        items[0]['caption'] = 'Я' * 5300
        items[1]['presentation'] = 'video'
        calls = []
        class Media:
            def __init__(self, media, caption=None, parse_mode=None):
                self.media, self.caption = media, caption
        class Bot:
            async def send_message(self, **kwargs):
                calls.append(('text', kwargs))
                return SimpleNamespace(message_id=len(calls))
            async def send_media_group(self, **kwargs):
                calls.append(('album', kwargs))
                self.paths = [m.media.name for m in kwargs['media']]
                self.captions = [m.caption for m in kwargs['media']]
                self.bytes = [m.media.read() for m in kwargs['media']]
                return [SimpleNamespace(message_id=100), SimpleNamespace(message_id=101)]
        module = ModuleType('telegram')
        for name in ['Photo', 'Video', 'Audio', 'Document']:
            setattr(module, 'InputMedia' + name, Media)
        adapter = SimpleNamespace(_bot=Bot())
        with self.store.materialize([i['file'] for i in items], 'tg') as values:
            prepared = [{**i, 'localPath': v['localPath']} for i, v in zip(items, values)]
            with patch.dict(sys.modules, {'telegram': module}):
                result = await native.telegram_sender(adapter, '123', {'thread_id': '77'}, 'album', prepared, False)
        self.assertEqual(result, [100, 101])
        self.assertEqual(''.join(c[1]['text'] for c in calls if c[0] == 'text'), 'Я' * 5300)
        self.assertTrue(all(c[1]['chat_id'] == 123 and c[1]['message_thread_id'] == 77 for c in calls))
        self.assertEqual(adapter._bot.captions, [None, '1'])
        self.assertEqual(adapter._bot.bytes, [b'fixture-0', b'fixture-1'])

    async def test_parallel_outgoing_sets_keep_their_own_captions_and_copies(self):
        item = self.items(1)[0]
        def response(caption, turn):
            return native.final_text('BRAI_FILES:' + json.dumps({'mode': 'album', 'items': [
                {'artifactId': item['file']['artifactId'], 'caption': caption},
                {'artifactId': item['file']['artifactId'], 'caption': caption + ' 2'}]}), turn)
        first, second = response('первый', 'a'), response('второй', 'b')
        paths_a = [json.loads(line.removeprefix('MEDIA:')) for line in first.splitlines()]
        paths_b = [json.loads(line.removeprefix('MEDIA:')) for line in second.splitlines()]
        self.assertFalse(set(paths_a) & set(paths_b))
        a, _ = native.output_items(paths_a)
        b, _ = native.output_items(paths_b)
        self.assertEqual([item['caption'] for item in a], ['первый', 'первый 2'])
        self.assertEqual([item['caption'] for item in b], ['второй', 'второй 2'])
        native.release_set(a[0]['_setId'])
        self.assertTrue(all(Path(path).is_file() for path in paths_b))
        self.assertFalse(any(Path(path).exists() for path in paths_a))

    async def test_examples_are_not_file_operations(self):
        text = 'Пример: ' + chr(96) + 'MEDIA:/missing/file.pdf' + chr(96)
        text += '\n' + chr(96)*3 + '\nMEDIA:/missing/photo.jpg\n' + chr(96)*3
        self.assertEqual(native.final_text(text, 'examples'), text)
        self.assertEqual(self.backend.calls, [])

    async def test_intermediate_files_are_not_published(self):
        agent = SimpleNamespace(session_id='intermediate')
        with native.conversation(agent, 'text'):
            path = Path(agent._brai_workspace) / 'scratch.txt'
            path.write_text('temporary')
            args = native.before_tool('read_file', {'path': str(path)})
            self.assertEqual(args['path'], str(path))
            self.assertEqual(self.backend.calls, [])
        self.assertFalse(path.exists())

    async def test_unknown_publication_retains_bytes_and_reuses_exact_key(self):
        operation = 'uncertain'
        path = self.store.workspace(operation) / 'result.txt'
        path.write_text('recover me')
        original = self.backend.call
        first = [True]
        def lose(method, args, **kwargs):
            value = original(method, args, **kwargs)
            if method == 'files.publish' and first[0]:
                first[0] = False
                raise TimeoutError('lost after ready')
            return value
        self.backend.call = lose
        with self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
            self.store.publish(path, ['output', operation])
        self.store.cleanup(operation)
        self.assertTrue(path.is_file())
        self.store.resume_publications()
        publications = [args['requestId'] for method, args in self.backend.calls if method == 'files.publish']
        self.assertEqual(publications, [publications[0], publications[0]])
        self.assertEqual(len(self.backend.remote), 1)
        self.store.cleanup(operation)
        self.assertFalse(path.exists())

    async def test_worker_uses_the_parent_task_workspace(self):
        from concurrent.futures import ThreadPoolExecutor
        agent = SimpleNamespace(session_id='worker')
        with native.conversation(agent, 'text', task_id='worker-task'):
            with ThreadPoolExecutor(1) as pool:
                args = pool.submit(native.before_tool, 'terminal', {}, task_id='worker-task').result()
            self.assertEqual(args['workdir'], agent._brai_workspace)

    async def test_reference_checksum_is_checked_before_send(self):
        items = self.items(1)
        items[0]['file']['sha256'] = '0' * 64
        called = []
        async def sender(*args):
            called.append(args)
        with self.assertRaisesRegex(FileError, 'FILE_REFERENCE_MISMATCH'):
            await deliver(self.store, 'wrong-ref', items, sender)
        self.assertEqual(called, [])

    async def test_migration_excludes_service_files_and_verifies_restore(self):
        from files.migrate import inventory, migrate
        secret = self.input / '.env'
        secret.write_text('must stay local')
        service = self.input / 'skills'
        service.mkdir()
        (service / 'SKILL.md').write_text('service')
        material = self.file(99, '.txt')
        self.store.legacy_roots = (self.input,)
        manifest = inventory([self.input])
        self.assertEqual([item['path'] for item in manifest['items']], [str(material)])
        value = migrate(self.store, manifest, retire=True)
        self.assertEqual(value['filesVerified'], 1)
        self.assertFalse(material.exists())
        self.assertTrue(secret.exists())
        self.assertTrue((service / 'SKILL.md').exists())
        restored = self.store.resolve(material, 'legacy-path')
        self.assertEqual(Path(restored['localPath']).read_bytes(), b'fixture-99')

    async def test_migration_partial_failure_never_retires_sources(self):
        from files.migrate import inventory, migrate
        paths = [self.file(1, '.txt'), self.file(2, '.txt')]
        self.store.legacy_roots = (self.input,)
        manifest = inventory([self.input])
        original = self.backend.call
        def fail_second(method, args, **kwargs):
            if method == 'files.publish' and args['path'] == str(paths[1]):
                raise TimeoutError()
            return original(method, args, **kwargs)
        self.backend.call = fail_second
        with self.assertRaisesRegex(FileError, 'ARTIFACTS_UNAVAILABLE'):
            migrate(self.store, manifest, retire=True)
        self.assertTrue(all(path.is_file() for path in paths))

    async def test_telegram_preflight_rejects_wrong_type_and_last_oversize(self):
        items = self.items(2)
        invalid = [items[0], {**items[1], 'presentation': 'audio'}]
        with self.assertRaisesRegex(FileError, 'FILE_SET_INCOMPATIBLE'):
            native.validate_telegram(invalid)
        items[1]['file']['sizeBytes'] = 11 * 1024**2
        with self.assertRaisesRegex(FileError, 'CHANNEL_FILE_TOO_LARGE'):
            native.validate_telegram(items)
        text = '😀' * 6000
        chunks = list(native.text_chunks(text, 4096))
        self.assertEqual(''.join(chunks), text)
        self.assertTrue(all(native.text_units(chunk) <= 4096 for chunk in chunks))

    async def test_api_accepts_artifact_references_and_rejects_direct_remote_bytes(self):
        item = self.items(1)[0]
        value = native.input_text([{'type': 'image_url', 'image_url': {'url': 'artifact:' + item['file']['artifactId']}}], 'api')
        self.assertTrue(value[0]['image_url']['url'].startswith('file://'))
        with self.assertRaisesRegex(FileError, 'ARTIFACT_REQUIRED'):
            native.input_text([{'type': 'image_url', 'image_url': {'url': 'https://example.test/raw.jpg'}}], 'api')


    async def test_background_terminal_scope_lives_until_process_completion(self):
        import subprocess
        agent = SimpleNamespace(session_id='background-terminal')
        process = None
        try:
            with native.conversation(agent, 'background'):
                path = Path(agent._brai_workspace)
                process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=path)
                native.after_tool('terminal', {'background': True}, json.dumps({'session_id': 'job', 'status': 'running'}))
            self.assertTrue(path.is_dir())
            process.terminate()
            process.wait(timeout=5)
            (path / 'result.txt').write_text('background output')
            with native.conversation(SimpleNamespace(session_id='collector'), 'collect'):
                native.after_tool('process', {'session_id': 'job'}, json.dumps({'exit_code': 0}))
                self.assertEqual((path / 'result.txt').read_text(), 'background output')
                result = native.final_text('MEDIA:' + str(path / 'result.txt'), 'collect')
                self.assertIn('MEDIA:', result)
            self.assertFalse(path.exists())
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)


    async def test_text_cleanup_cannot_delete_a_file_being_fetched(self):
        from concurrent.futures import ThreadPoolExecutor, TimeoutError
        import threading
        value = self.store.publish(self.file('download', '.ogg'), 'download')
        path = Path(value['localPath'])
        body = path.read_bytes()
        entered, release = threading.Event(), threading.Event()
        def fetching(method, args, **kwargs):
            self.assertEqual(method, 'files.fetch')
            staged = path.parent / '.download'
            path.unlink(missing_ok=True)
            staged.write_bytes(body)
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test fetch was not released')
            staged.replace(path)
            return value
        with patch.object(self.backend, 'call', side_effect=fetching), ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.store.fetch, value['artifactId'])
            self.assertTrue(entered.wait(5))
            cleanup = pool.submit(self.store.cleanup, 'unrelated-text')
            try:
                with self.assertRaises(TimeoutError):
                    cleanup.result(timeout=0.1)
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=5)['artifactId'], value['artifactId'])
            cleanup.result(timeout=5)

    async def test_plain_text_never_needs_artifacts(self):
        event = self.event('plain')
        event.media_urls = []
        event.media_types = []
        event.text = 'ordinary text'
        with patch.object(self.store, 'call', side_effect=AssertionError('text must not call Artifacts')):
            self.assertTrue(await native.accept_event(event))
            agent = SimpleNamespace(session_id='plain-text')
            with native.conversation(agent, event.text) as text:
                self.assertEqual(text, 'ordinary text')
                self.assertEqual(native.final_text('ordinary reply', 'plain-text'), 'ordinary reply')
            native.release_event(event)

    async def test_plain_text_cleanup_does_not_wait_for_another_file_transfer(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading
        event = self.event('text-during-download')
        event.media_urls = []
        event.media_types = []
        entered, release = threading.Event(), threading.Event()
        def transfer():
            with self.store.lock('cache'):
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('test transfer was not released')
        def text_turn():
            with native.conversation(SimpleNamespace(session_id='text-only'), 'ordinary text') as text:
                self.assertEqual(text, 'ordinary text')
            native.release_event(event)
            return 'done'
        with ThreadPoolExecutor(max_workers=2) as pool:
            transfer_future = pool.submit(transfer)
            self.assertTrue(entered.wait(5))
            try:
                self.assertEqual(pool.submit(text_turn).result(timeout=2), 'done')
            finally:
                release.set()
            transfer_future.result(timeout=5)

    async def test_recovered_single_attachment_queues_without_interrupting(self):
        event = self.event('recovered')
        event.metadata = {'recovered': True, '_brai_artifacts': [{'groupId': 'not-admitted'}]}
        with patch.object(self.store, 'db', side_effect=AssertionError('recovered attachment must queue')):
            self.assertTrue(native.should_queue_inbound_set(event))

    async def test_recovered_files_do_not_merge_into_pending_user_text(self):
        seen, scheduled = [], []
        async def busy(event, session_key):
            seen.append(event)
        task = asyncio.get_running_loop().create_future()
        adapter = SimpleNamespace(_handle_message_while_active=busy, _session_tasks={'chat': task})
        native.install_adapter(adapter)
        recovered = self.event('restored')
        recovered.metadata = {'recovered': True}
        text = self.event('new-text')
        text.media_urls = []
        with patch.object(native, 'release_event') as release, patch.object(native, 'schedule_recovery', side_effect=scheduled.append):
            await adapter._handle_message_while_active(recovered, 'chat')
            await adapter._handle_message_while_active(recovered, 'chat')
            self.assertEqual(seen, [])
            self.assertEqual(release.call_count, 2)
            await adapter._handle_message_while_active(text, 'chat')
            self.assertEqual(seen, [text])
            task.set_result(None)
            await asyncio.sleep(0)
            self.assertEqual(scheduled, [adapter])

    async def test_recovery_file_error_does_not_notify_unrelated_text_chat(self):
        seen = []
        async def notify(event, error):
            seen.append((event, error))
            return {'thread': 'metadata'}
        adapter = SimpleNamespace(_notify_turn_error=notify)
        native.install_adapter(adapter)
        recovered = self.event('recovered')
        recovered.metadata = {'recovered': True}
        with self.assertLogs(native.logging.getLogger(native.__name__), level='WARNING'):
            self.assertIsNone(await adapter._notify_turn_error(recovered, FileError('ARTIFACTS_UNAVAILABLE')))
        self.assertEqual(seen, [])
        direct = self.event('direct')
        self.assertEqual(await adapter._notify_turn_error(direct, FileError('ARTIFACTS_UNAVAILABLE')), {'thread': 'metadata'})
        self.assertEqual(len(seen), 1)
        self.assertEqual(await adapter._notify_turn_error(recovered, RuntimeError('other failure')), {'thread': 'metadata'})
        self.assertEqual(len(seen), 2)

    async def test_publisher_markdown_keeps_unicode_labels_and_parentheses(self):
        path = self.input / 'картинка (выбор).png'
        path.write_bytes(b'image')
        value = self.store.publish(path, 'unicode')
        text = '![' + 'выбор ' + chr(92) + '[A' + chr(92) + ']' + '](<' + value['localPath'] + '>)'
        result = native.final_text(text, 'publisher-descriptor')
        self.assertTrue(result.startswith('MEDIA:'))
        items, _ = native.output_items([json.loads(result.removeprefix('MEDIA:'))])
        self.assertEqual(items[0]['caption'], 'выбор [A]')
        self.assertEqual(items[0]['file']['artifactId'], value['artifactId'])


if __name__ == '__main__':
    unittest.main()
