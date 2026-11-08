# ABOUTME: Проверяет UID-bound JSON-RPC broker и привилегированные файловые границы.
# ABOUTME: Использует временные fixtures без модели, сети и live-профилей.
import asyncio
import json
from contextlib import suppress
from pathlib import Path
import os
import socket
import stat
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from services.hermes.identity import broker as broker_module
from services.hermes.identity.broker import Broker


TEMP_ROOT = Path(os.environ["BRAI_BROKER_TMP"])
WORKER_UID = os.getuid()
INGRESS_UID = 995
OTHER_UID = WORKER_UID + 1


def make_profile(uid=WORKER_UID, *, user_id="user-a", profile_id="profile-a",
                 telegram_id="111222", status="active", home="/unused/home"):
    return {
        "userId": user_id,
        "profileId": profile_id,
        "telegramId": telegram_id,
        "status": status,
        "home": home,
    }


class FakeControl:
    def __init__(self, profiles=None):
        self.profiles = profiles or {WORKER_UID: make_profile()}
        self.calls = []

    async def call(self, method, params, timeout=35):
        self.calls.append((method, dict(params), timeout))
        if method == "authorize":
            profile = self.profiles.get(params.get("uid"))
            if not profile:
                raise PermissionError("synthetic inactive principal")
            return {"userId": profile["userId"], "profileId": profile["profileId"]}
        if method == "identity.resolve":
            telegram_id = params.get("telegramId")
            profile = next((p for p in self.profiles.values()
                            if p["telegramId"] == telegram_id and p["status"] == "active"), None)
            if not profile:
                return {"user": {"id": "unknown", "profileId": "unknown", "telegramId": telegram_id,
                                 "status": "inactive"}}
            return {"user": {"id": profile["userId"], "profileId": profile["profileId"],
                             "telegramId": profile["telegramId"], "status": "active"}}
        if method == "login.send":
            return {"status": "sent", "code": "synthetic-code-must-not-escape"}
        if method == "tools.list":
            return {"tools": []}
        if method == "tools.call":
            return {"ok": True}
        if method == "artifacts.publish":
            return {"artifactId": "synthetic-artifact"}
        return {"ok": True}


class BrokerSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.profile = make_profile()
        self.control = FakeControl({WORKER_UID: self.profile})
        self.config = {
            "registryPath": "unused-registry",
            "ingressUid": INGRESS_UID,
            "stagingRoot": str(TEMP_ROOT / "staging"),
        }
        self.broker = Broker(self.config, self.control)
        self.broker.login_state = broker_module.LoginDeliveryState(':memory:')
        self.addCleanup(self.broker.login_state.close)
        self.broker.profiles = lambda: {WORKER_UID: self.profile}

    async def test_worker_cannot_choose_uid_or_call_root_and_ingress_methods(self):
        before = len(self.control.calls)
        with self.assertRaises((PermissionError, ValueError)):
            await self.broker.call(WORKER_UID, "tools.call", {
                "uid": OTHER_UID, "name": "synthetic_tool", "args": {},
            })
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "tools.list", {"uid": OTHER_UID})

        for method, params in (
            ("authorize", {"uid": WORKER_UID}),
            ("identity.resolve", {"telegramId": "111222"}),
            ("identity.invite-redeem", {"telegramId": "111222", "code": "synthetic"}),
            ("ingress.admit", {"telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "turn"}),
        ):
            with self.subTest(method=method), self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, method, params)
        self.assertFalse(any(method == "tools.call" and params.get("uid") == OTHER_UID
                             for method, params, _timeout in self.control.calls[before:]))

        ingress_before = len(self.control.calls)
        for method, params in (
            ("authorize", {"uid": WORKER_UID}),
            ("tools.call", {"uid": WORKER_UID, "name": "synthetic_tool", "args": {}}),
            ("identity.invite-redeem", {"telegramId": "111222", "code": "synthetic", "uid": WORKER_UID}),
        ):
            with self.subTest(ingress_method=method), self.assertRaises((PermissionError, ValueError)):
                await self.broker.call(INGRESS_UID, method, params)
        self.assertFalse(any(method in {"authorize", "tools.call", "identity.invite-redeem"}
                             for method, _params, _timeout in self.control.calls[ingress_before:]))

    async def test_inactive_auth_profile_is_denied_before_control_or_tools(self):
        self.profile["status"] = "suspended"
        with self.assertRaises(PermissionError):
            await self.broker.authorize(WORKER_UID)
        self.assertEqual(self.control.calls, [])

    async def test_login_requires_registered_private_dm_and_returns_only_suppression(self):
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "login.send", {})
        self.assertFalse(any(method == "login.send" for method, _params, _timeout in self.control.calls))

        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, "ingress.admit", {
                "telegramId": "999999", "chatId": "999999", "privateChat": True, "turnId": "unregistered",
            })
        self.assertFalse(self.broker.turns)

        admitted = await self.broker.call(INGRESS_UID, "ingress.admit", {
            "telegramId": "111222", "chatId": "-100", "privateChat": False, "turnId": "group-turn",
        })
        self.assertEqual(admitted["uid"], WORKER_UID)
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "login.send", {})
        self.assertFalse(any(method == "login.send" for method, _params, _timeout in self.control.calls))

        await self.broker.call(INGRESS_UID, "ingress.close", {"uid": WORKER_UID, "turnId": "group-turn"})
        await self.broker.call(INGRESS_UID, "ingress.admit", {
            "telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "private-turn",
        })
        result = await self.broker.call(WORKER_UID, "login.send", {})
        self.assertEqual(result, {"status": "sent", "suppressFinal": True})
        self.assertNotIn("code", result)
        self.assertTrue(self.broker.turns[WORKER_UID]["suppressFinal"])
        sent = [call for call in self.control.calls if call[0] == "login.send"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1], {
            "uid": WORKER_UID, "telegramId": "111222", "privateChat": True,
            "requestId": self.broker.turns[WORKER_UID]["requestId"],
        })
        status = await self.broker.call(INGRESS_UID, "ingress.status", {
            "uid": WORKER_UID, "turnId": "private-turn",
        })
        self.assertEqual(status, {"suppressFinal": True})

    def _publish_fixture(self, filename="file.bin"):
        root = Path(tempfile.mkdtemp(prefix="broker-publish-", dir=TEMP_ROOT))
        home = root / "home"
        workspace = home / "workspace"
        workspace.mkdir(parents=True, mode=0o700)
        source = workspace / filename
        source.write_bytes(b"synthetic-file")
        self.profile["home"] = str(home)
        staging_uid = Path(self.config["stagingRoot"]) / str(WORKER_UID)
        original_lstat = Path.lstat

        def fake_lstat(path):
            if path == staging_uid:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
            return original_lstat(path)

        return root, source, staging_uid, fake_lstat

    async def _assert_publish_rejected(self, path, *, patches=()):
        before = len(self.control.calls)
        params = {"path": str(path), "requestId": "synthetic-request"}
        with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=patches[0] if patches else lambda path: Path.lstat(path)):
            with self.assertRaises((PermissionError, OSError)):
                await self.broker.publish(WORKER_UID, self.profile, params)
        self.assertFalse(any(method == "artifacts.publish" for method, _params, _timeout in self.control.calls[before:]))

    async def test_publish_rejects_nofollow_symlinks_hardlinks_and_foreign_owners(self):
        root, source, staging_uid, fake_lstat = self._publish_fixture()
        try:
            link = source.parent / "symlink.bin"
            link.symlink_to(source)
            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat):
                with self.assertRaises(OSError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(link), "requestId": "synthetic-symlink",
                    })
            self.assertFalse(any(call[0] == "artifacts.publish" for call in self.control.calls))

            hardlink = source.parent / "hardlink.bin"
            os.link(source, hardlink)
            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat):
                with self.assertRaises(PermissionError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(source), "requestId": "synthetic-hardlink",
                    })

            hardlink.unlink()
            real_open = os.open
            real_fstat = os.fstat
            opened_files = set()

            def track_open(path, flags, *args, **kwargs):
                fd = real_open(path, flags, *args, **kwargs)
                if path == source.name and kwargs.get("dir_fd") is not None:
                    opened_files.add(fd)
                return fd

            def foreign_fstat(fd):
                info = real_fstat(fd)
                if fd in opened_files:
                    return SimpleNamespace(
                        st_mode=info.st_mode, st_uid=WORKER_UID + 1,
                        st_nlink=info.st_nlink, st_size=info.st_size,
                    )
                return info

            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat), \
                 mock.patch.object(broker_module.os, "open", side_effect=track_open), \
                 mock.patch.object(broker_module.os, "fstat", side_effect=foreign_fstat):
                with self.assertRaises(PermissionError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(source), "requestId": "synthetic-foreign-owner",
                    })
            self.assertFalse(any(call[0] == "artifacts.publish" for call in self.control.calls))
        finally:
            shutil.rmtree(root)


    async def test_jsonrpc_batch_notifications_standard_errors_and_peer_uid(self):
        calls = []
        async def call(uid, method, params):
            calls.append((uid, method, params))
            return {'uid': uid}
        port = SimpleNamespace(call=call)
        response = await broker_module.rpc_frame(port, WORKER_UID, b'not JSON\n')
        self.assertEqual(response['error']['code'], -32700)
        response = await broker_module.rpc_frame(port, WORKER_UID, '{"jsonrpc":"2.0","id":NaN,"method":"tools.list"}')
        self.assertEqual(response['error']['code'], -32700)
        for request, code in [
                ({}, -32600),
                ({'jsonrpc': '2.0', 'id': True, 'method': 'tools.list'}, -32600),
                ({'jsonrpc': '2.0', 'id': 0, 'method': 'missing'}, -32601),
                ({'jsonrpc': '2.0', 'id': '', 'method': 'tools.list', 'params': []}, -32602),
                ({'jsonrpc': '2.0', 'id': 2, 'method': 'tools.list', 'params': {'uid': OTHER_UID}}, -32602)]:
            response = await broker_module.rpc_request(port, WORKER_UID, request)
            self.assertEqual(response['error']['code'], code)
        self.assertEqual(calls, [])
        batch = [
            {'jsonrpc': '2.0', 'id': 0, 'method': 'tools.list', 'params': {}},
            {'jsonrpc': '2.0', 'method': 'tools.list', 'params': {}},
            {'jsonrpc': '2.0', 'id': 'attack', 'method': 'tools.list', 'params': {'uid': OTHER_UID}},
            {'jsonrpc': '2.0', 'id': None, 'method': 'missing'}]
        import json
        response = await broker_module.rpc_frame(port, WORKER_UID, json.dumps(batch))
        self.assertEqual([item['id'] for item in response], [0, 'attack', None])
        self.assertEqual(response[0]['result'], {'uid': WORKER_UID})
        self.assertEqual(response[1]['error']['code'], -32602)
        self.assertEqual(response[2]['error']['code'], -32601)
        self.assertEqual([item[0] for item in calls], [WORKER_UID, WORKER_UID])
        response = await broker_module.rpc_frame(port, WORKER_UID, json.dumps(batch * 5))
        self.assertEqual(response['error']['code'], -32600)
        response = await broker_module.rpc_frame(port, WORKER_UID, '[]')
        self.assertEqual(response['error']['code'], -32600)
        notification = await broker_module.rpc_request(port, WORKER_UID,
            {'jsonrpc': '2.0', 'method': 'tools.list'})
        self.assertIsNone(notification)

    async def test_repeated_ingress_admit_preserves_suppression_and_request_id(self):
        params = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True, 'turnId': 'same'}
        await self.broker.call(INGRESS_UID, 'ingress.admit', params)
        await self.broker.call(WORKER_UID, 'login.send', {})
        previous = dict(self.broker.turns[WORKER_UID])
        await self.broker.call(INGRESS_UID, 'ingress.admit', params)
        self.assertEqual(self.broker.turns[WORKER_UID], previous)
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.admit', {**params, 'turnId': 'competing'})
        self.assertEqual(self.broker.turns[WORKER_UID], previous)




    async def admit_login_input(self, input_id='a' * 64):
        """Зарегистрировать реальный private input без параметров из модели."""
        return await self.broker.call(INGRESS_UID, 'ingress.admit', {
            'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
            'turnId': 'login-turn', 'inputId': input_id})

    async def test_login_parallel_duplicate_and_replay_send_only_once(self):
        await self.admit_login_input()
        started, release, sends = asyncio.Event(), asyncio.Event(), []
        original = self.control.call
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            self.assertEqual(self.broker.delivery_state().lookup(params['requestId']), 'unknown')
            started.set()
            await release.wait()
            return {'status': 'sent', 'code': 'must-not-be-cached'}
        self.control.call = call
        first = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.wait_for(started.wait(), 1)
        second = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(first, second)
        self.assertEqual(results, [{'status': 'sent', 'suppressFinal': True}] * 2)
        self.assertEqual(len(sends), 1)
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), results[0])
        self.assertEqual(len(sends), 1)
        self.assertEqual(self.broker.login_state.db.execute(
            'SELECT request_id,outcome FROM login_receipts').fetchall(),
            [(sends[0]['requestId'], 'sent')])

    async def test_new_actual_input_uses_fresh_login_request_and_clears_suppression(self):
        await self.admit_login_input('a' * 64)
        first_id = self.broker.turns[WORKER_UID]['requestId']
        await self.broker.call(WORKER_UID, 'login.send', {})
        await self.admit_login_input('a' * 64)
        self.assertEqual(self.broker.turns[WORKER_UID]['requestId'], first_id)
        self.assertTrue(self.broker.turns[WORKER_UID]['suppressFinal'])
        await self.admit_login_input('b' * 64)
        second_id = self.broker.turns[WORKER_UID]['requestId']
        self.assertNotEqual(second_id, first_id)
        self.assertIsNone(self.broker.turns[WORKER_UID]['loginRecord']['outcome'])
        self.assertFalse(self.broker.turns[WORKER_UID]['suppressFinal'])
        await self.broker.call(WORKER_UID, 'login.send', {})
        issued = [params['requestId'] for method, params, _ in self.control.calls if method == 'login.send']
        self.assertEqual(issued, [first_id, second_id])

    async def test_login_uses_admitted_topic_and_rejects_worker_topic_override(self):
        admission = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                     'turnId': 'topic-turn', 'inputId': 'a' * 64, 'threadId': 73}
        broker_module.validate_params('ingress.admit', admission)
        await self.broker.call(INGRESS_UID, 'ingress.admit', admission)
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'login.send', {'threadId': 99})
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.admit', {**admission, 'threadId': 99})
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}),
                         {'status': 'sent', 'suppressFinal': True})
        sends = [params for method, params, _ in self.control.calls if method == 'login.send']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]['threadId'], 73)
        # Смена темы после закрытия хода не разрешает повтор прежнего input.
        await self.broker.call(INGRESS_UID, 'ingress.close', {'uid': WORKER_UID, 'turnId': 'topic-turn'})
        await self.broker.call(INGRESS_UID, 'ingress.admit', {**admission, 'turnId': 'next-turn', 'threadId': 99})
        await self.broker.call(WORKER_UID, 'login.send', {})
        self.assertEqual(len([c for c in self.control.calls if c[0] == 'login.send']), 1)
        for invalid in (0, -1, True, '73', None, 1.5, 9007199254740992):
            with self.subTest(threadId=invalid), self.assertRaises(ValueError):
                broker_module.validate_params('ingress.admit', {**admission, 'threadId': invalid})

    async def test_failed_unknown_exception_and_cancellation_are_not_automatically_replayed(self):
        original = self.control.call
        sends = []
        for index, outcome in enumerate(('failed', 'unknown', 'raise', 'cancel')):
            await self.admit_login_input(format(index, '064x'))
            started = asyncio.Event()
            async def call(method, params, timeout=35):
                if method != 'login.send':
                    return await original(method, params, timeout)
                sends.append(dict(params))
                started.set()
                if outcome == 'raise':
                    raise ConnectionError('synthetic lost response')
                if outcome == 'cancel':
                    await asyncio.Event().wait()
                return {'status': 'failed' if outcome == 'failed' else 'unknown'}
            self.control.call = call
            expected = {'status': 'failed' if outcome == 'failed' else 'unknown', 'suppressFinal': False}
            if outcome == 'cancel':
                sending = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
                await asyncio.wait_for(started.wait(), 1)
                sending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await sending
            else:
                self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), expected)
            self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), expected)
            self.assertEqual(len(sends), index + 1)

    async def test_late_old_login_completion_does_not_suppress_new_input(self):
        await self.admit_login_input('a' * 64)
        old_id = self.broker.turns[WORKER_UID]['requestId']
        started, release, sends = asyncio.Event(), asyncio.Event(), []
        original = self.control.call
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            started.set()
            await release.wait()
            return {'status': 'sent'}
        self.control.call = call
        old = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.wait_for(started.wait(), 1)
        await self.admit_login_input('b' * 64)
        new_turn = self.broker.turns[WORKER_UID]
        self.assertNotEqual(new_turn['requestId'], old_id)
        release.set()
        self.assertEqual(await old, {'status': 'sent', 'suppressFinal': False})
        self.assertIs(self.broker.turns[WORKER_UID], new_turn)
        self.assertFalse(new_turn['suppressFinal'])
        self.assertIsNone(new_turn['loginRecord']['outcome'])
        self.assertEqual(self.broker.login_state.lookup(old_id), 'sent')
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}),
                         {'status': 'sent', 'suppressFinal': True})
        self.assertEqual(len(sends), 2)

    async def test_persistent_receipt_precedes_network_and_survives_restart(self):
        root = Path(tempfile.mkdtemp(prefix='broker-login-state-', dir=TEMP_ROOT))
        state_path = root / 'delivery.sqlite'
        state_path.touch(mode=0o600)
        self.config['loginDeliveryStatePath'] = str(state_path)
        original = self.control.call
        sends = []
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            with broker_module.sqlite3.connect(state_path) as observer:
                self.assertEqual(observer.execute(
                    'SELECT outcome FROM login_receipts WHERE request_id=?',
                    (params['requestId'],)).fetchone(), ('unknown',))
            return {'status': 'sent', 'code': 'never-save-this-code'}
        self.control.call = call
        # Только проверка root metadata заменена: реальные SQLite commit/reopen не подменяются.
        with mock.patch.object(broker_module, '_secure_login_state_path', return_value=str(state_path)):
            disk_state = broker_module.LoginDeliveryState(str(state_path))
            self.broker.login_state = disk_state
            try:
                await self.admit_login_input('a' * 64)
                first_id = self.broker.turns[WORKER_UID]['requestId']
                await self.broker.call(WORKER_UID, 'login.send', {})
                await self.broker.call(INGRESS_UID, 'ingress.close', {'uid': WORKER_UID, 'turnId': 'login-turn'})
                disk_state.close()
                restarted = Broker(self.config, self.control)
                restarted.profiles = self.broker.profiles
                try:
                    await restarted.call(INGRESS_UID, 'ingress.admit', {
                        'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                        'turnId': 'after-restart', 'inputId': 'a' * 64})
                    self.assertEqual(restarted.turns[WORKER_UID]['requestId'], first_id)
                    self.assertEqual(await restarted.call(WORKER_UID, 'login.send', {}),
                                     {'status': 'sent', 'suppressFinal': True})
                    self.assertEqual(len(sends), 1)
                    columns = restarted.login_state.db.execute('PRAGMA table_info(login_receipts)').fetchall()
                    self.assertEqual([row[1] for row in columns], ['request_id', 'outcome'])
                    self.assertNotIn(b'never-save-this-code', state_path.read_bytes())
                    self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)
                    self.assertEqual(restarted.login_state.db.execute('PRAGMA synchronous').fetchone(), (2,))
                finally:
                    if restarted.login_state is not None:
                        restarted.login_state.close()
            finally:
                # connection уже закрыт перед настоящим reopen.
                disk_state.close()
                shutil.rmtree(root)


    async def test_unknown_receipt_survives_crash_and_cannot_be_replayed(self):
        root = Path(tempfile.mkdtemp(prefix='broker-login-unknown-', dir=TEMP_ROOT))
        state_path = root / 'delivery.sqlite'
        state_path.touch(mode=0o600)
        self.config['loginDeliveryStatePath'] = str(state_path)
        request_id = broker_module.login_request_id(WORKER_UID, self.profile, '111222', 'a' * 64)
        with mock.patch.object(broker_module, '_secure_login_state_path', return_value=str(state_path)):
            before_crash = broker_module.LoginDeliveryState(str(state_path))
            self.assertEqual(before_crash.claim(request_id), (True, 'unknown'))
            before_crash.close()
            restarted = Broker(self.config, self.control)
            restarted.profiles = self.broker.profiles
            try:
                await restarted.call(INGRESS_UID, 'ingress.admit', {
                    'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                    'turnId': 'restart-turn', 'inputId': 'a' * 64})
                self.assertEqual(await restarted.call(WORKER_UID, 'login.send', {}),
                                 {'status': 'unknown', 'suppressFinal': False})
                self.assertFalse(any(method == 'login.send' for method, params, timeout in self.control.calls))
            finally:
                if restarted.login_state is not None:
                    restarted.login_state.close()
                shutil.rmtree(root)

    async def test_delivery_capacity_keeps_existing_receipts_and_ordinary_admission(self):
        state = broker_module.LoginDeliveryState(':memory:', max_records=1)
        self.addCleanup(state.close)
        self.broker.login_state = state
        await self.admit_login_input('a' * 64)
        await self.broker.call(WORKER_UID, 'login.send', {})
        await self.admit_login_input('b' * 64)
        self.assertFalse(self.broker.turns[WORKER_UID]['suppressFinal'])
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'login.send', {})
        self.assertEqual(len([call for call in self.control.calls if call[0] == 'login.send']), 1)
        self.assertEqual(state.db.execute('SELECT count(*) FROM login_receipts').fetchone()[0], 1)

    def test_trusted_input_identity_schema_and_private_state_path(self):
        params = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True, 'turnId': 't'}
        broker_module.validate_params('ingress.admit', params)
        broker_module.validate_params('ingress.admit', {**params, 'inputId': 'a' * 64})
        for invalid in ('', 'a' * 63, 'z' * 64, 1, None):
            with self.subTest(inputId=invalid), self.assertRaises(ValueError):
                broker_module.validate_params('ingress.admit', {**params, 'inputId': invalid})
        with self.assertRaises(PermissionError):
            broker_module._secure_login_state_path(str(TEMP_ROOT / 'unsafe-delivery.sqlite'))

    async def test_provisioning_can_bootstrap_own_configuration_but_no_data_or_tools(self):
        self.profile['status'] = 'provisioning'
        home = self.profile['home']
        entry = {'userId': self.profile['userId'], 'profileId': self.profile['profileId'], 'home': home,
                 'cacheRoot': '/protected/cache', 'stagingRoot': '/protected/staging/' + str(WORKER_UID)}
        self.broker.files.config['runtimeProfilesPath'] = '/protected/runtime-profiles.json'
        self.broker.files.config_reader = lambda path: {str(WORKER_UID): entry}
        expected = {'ownerId': self.profile['userId'], 'stateRoot': home + '/workspace/files',
                    'resultRoot': home + '/results', 'readRoots': [home + '/workspace', home + '/media', home + '/results']}
        async def configuration(method, params, **kwargs):
            self.assertEqual(method, 'files.configuration')
            self.assertEqual(params, {'uid': WORKER_UID})
            return expected
        self.broker.files.control = SimpleNamespace(call=configuration)
        result = await self.broker.call(WORKER_UID, 'files.configuration', {})
        self.assertEqual(result, expected)
        for method, params in [
                ('files.get', {'artifactId': 'a'}), ('files.list', {}),
                ('files.prepare', {'mode': 'files', 'items': []}),
                ('files.fetch', {'artifactId': 'a'}),
                ('files.publish', {'path': home + '/workspace/file', 'requestId': 'request'}),
                ('tools.list', {}), ('tools.call', {'name': 'any', 'args': {}}),
                ('login.send', {}), ('memory.search', {}),
                ('files.configuration', {'uid': OTHER_UID})]:
            with self.subTest(method=method), self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, method, params)
        self.assertEqual(self.control.calls, [])
        with self.assertRaises(PermissionError):
            await self.broker.call(OTHER_UID, 'files.configuration', {})
        entry['userId'] = 'foreign-user'
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'files.configuration', {})
        entry['userId'] = self.profile['userId']
        self.profile['status'] = 'blocked'
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'files.configuration', {})

    async def test_large_unicode_crosses_real_private_control_without_ascii_expansion(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        source = (Path(__file__).resolve().parents[1] / 'control.mjs').as_uri()
        program = ("import {servePrivateRpc} from " + json.dumps(source) + ";"
            "const control={invokeTool:async(uid,name,args)=>({bytes:Buffer.byteLength(args.text)})};"
            "await servePrivateRpc({control},process.stdin,process.stdout);")
        port = broker_module.ControlPort([node, '--input-type=module', '-e', program], '/unused')
        await port.start()
        try:
            for text in ('a' * 400000, 'я' * 400000, '🧠' * 200000):
                result = await port.call('tools.call', {'uid': WORKER_UID,
                    'name': 'dialogues_exchange', 'args': {'text': text}})
                self.assertEqual(result, {'bytes': len(text.encode())})
        finally:
            await port.close()

    async def test_control_reserves_authorization_capacity_when_tool_calls_are_full(self):
        control = broker_module.ControlPort([], '/unused')
        class Input:
            def write(self, _payload):
                pass
            async def drain(self):
                pass
        control.process = SimpleNamespace(returncode=None, stdin=Input())
        tools = [asyncio.create_task(control.call('tools.call', {'uid': i})) for i in range(32)]
        await asyncio.sleep(0)
        try:
            self.assertEqual(len(control.pending), 32)
            with self.assertRaises(ConnectionError):
                await control.call('tools.call', {})
            authorization = asyncio.create_task(control.call('authorize', {'uid': WORKER_UID}))
            await asyncio.sleep(0)
            self.assertEqual(len(control.pending), 33)
            control.pending[control.counter].set_result({'allowed': True})
            self.assertEqual(await authorization, {'allowed': True})
            self.assertEqual(control.pending_budgets[True], 0)
        finally:
            for task in tools:
                task.cancel()
            await asyncio.gather(*tools, return_exceptions=True)
        self.assertEqual(control.pending_budgets, {False: 0, True: 0})

    async def test_late_control_response_does_not_break_current_request(self):
        control = broker_module.ControlPort([], '/unused')
        reader = asyncio.StreamReader()
        control.process = SimpleNamespace(stdout=reader)
        control.counter = 2
        current = asyncio.get_running_loop().create_future()
        control.pending[2] = current
        reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"late":true}}\n')
        reader.feed_data(b'{"jsonrpc":"2.0","id":2,"result":{"current":true}}\n')
        reader.feed_eof()
        await control.read()
        self.assertEqual(current.result(), {'current': True})

    async def test_actual_unix_listener_accepts_notifications_without_response(self):
        socket_path = TEMP_ROOT / ("broker-" + str(os.getpid()) + ".sock")
        config = {
            "controlCommand": [sys.executable, "-c", "import time; time.sleep(60)"],
            "controlConfigPath": "synthetic-control-config",
            "socketPath": str(socket_path),
            "ingressUid": INGRESS_UID,
            "stagingRoot": self.config["stagingRoot"],
            "registryPath": "unused-registry",
        }
        serving = asyncio.create_task(broker_module.serve(config))
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while not socket_path.exists() and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.01)
            self.assertTrue(socket_path.exists(), "broker AF_UNIX listener did not start")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(socket_path))
                client.sendall(b'{"jsonrpc":"2.0","method":"tools.list","params":{}}\n')
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(await asyncio.to_thread(client.recv, 1024), b"", "notifications must receive no broker result")

            async def exchange(raw):
                reader, writer = await asyncio.open_unix_connection(str(socket_path))
                try:
                    writer.write(raw)
                    await writer.drain()
                    return await reader.read()
                finally:
                    writer.close()
                    await writer.wait_closed()
            import json
            for raw, expected in [
                    (b'{bad json\n', -32700),
                    (b'{}\n', -32600),
                    (b'{"jsonrpc":"2.0","id":0,"method":"unknown"}\n', -32601),
                    (b'{"jsonrpc":"2.0","id":"invalid","method":"tools.list","params":{"uid":1}}\n', -32602)]:
                response = json.loads(await exchange(raw))
                self.assertEqual(response['error']['code'], expected)
            response = json.loads(await exchange(b'[{"jsonrpc":"2.0","id":1,"method":"unknown"},{"jsonrpc":"2.0","method":"unknown"}]\n'))
            self.assertEqual(len(response), 1)
            self.assertEqual(response[0]['id'], 1)
        finally:
            serving.cancel()
            with suppress(asyncio.CancelledError):
                await serving


if __name__ == "__main__":
    unittest.main()
