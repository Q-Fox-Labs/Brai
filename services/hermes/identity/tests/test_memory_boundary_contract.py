# ABOUTME: Проверяет запрет доступа к памяти другого пользователя через Unix-шлюз.
# ABOUTME: Использует синтетические данные и управляемые порты без живой памяти.
import json
import os
from pathlib import Path
from unittest.mock import patch
import socket
import threading
import time
import unittest

from services.hermes.identity.memory_gateway import Boundary, Denied, Server


TEMP_ROOT = Path(os.environ["BRAI_MEMORY_GATEWAY_TMP"])
A_UID = 21001
B_UID = 21002


def profile(user_id, profile_id, telegram_id, home, epoch, author, cubes):
    return {
        "userId": user_id,
        "profileId": profile_id,
        "status": "active",
        "telegramId": telegram_id,
        "homeScope": home,
        "memoryEpoch": epoch,
        "authorId": author,
        "cubes": cubes,
    }


PROFILE_A = profile("user-a", "profile-a", "telegram-a", "home-a", "epoch-a", "author-a", ["main"])
PROFILE_B = profile("user-b", "profile-b", "telegram-b", "home-b", "epoch-b", "author-b", ["other"])


def row(identifier, *, user="user-a", home="home-a", epoch="epoch-a", author="author-a", cube="main"):
    physical = ("profile-a" if user == "user-a" else "profile-b") + "__" + cube
    return {
        "id": identifier,
        "memory": "synthetic " + identifier,
        "metadata": {
            "user_id": user,
            "info": {
                "hermes_home_scope": home,
                "hermes_memory_epoch": epoch,
                "hermes_author_id": author,
                "hermes_cube": physical,
                "hermes_memberships": [physical],
                "hermes_primary_cube": physical,
            },
        },
        "_cube_id": physical,
    }


class FakeClient:
    calls = []
    rows_by_cube = {}
    capabilities = {"memory_stream": 1, "recall_index": 1}
    ignore_filter = False

    def __init__(self, config):
        self.config = config
        self.cube = config.get("cube_id", "main")
        type(self).calls.append(("init", self.cube))

    def request(self, path, body=None, **kwargs):
        type(self).calls.append((path, body))
        if path == "/product/memory_capabilities":
            return {"code": 200, "data": dict(type(self).capabilities)}
        if path == "/product/add":
            return {"code": 200, "data": [{"cube_id": self.cube, "memory_id": "committed-id"}]}
        if path in {"/product/delete_memory", "/product/search"}:
            return {"code": 200, "data": {}}
        raise AssertionError("unexpected upstream path: " + path)

    def _memory_read(self, body, timeout=None):
        type(self).calls.append(("/product/get_memory", body))
        cube = body.get("mem_cube_id", self.cube)
        records = list(type(self).rows_by_cube.get(cube, type(self).rows_by_cube.get(cube.split('__', 1)[-1], [])))
        filter_ = body.get("filter") or {}
        if not type(self).ignore_filter and filter_.get("id"):
            records = [item for item in records if item.get("id") == filter_["id"]]
        return {
            "code": 200,
            "data": {"text_mem": [{"cube_id": cube, "memories": records}]},
        }

    def iter_memory(self, body, deadline):
        """Вернуть синтетические записи через потоковый интерфейс клиента."""
        yield from self._memory_read(body)['data']['text_mem'][0]['memories']

    def indexed_search(self, *args, **kwargs):
        type(self).calls.append(("/product/recall_index", args, kwargs))
        records = [item for values in type(self).rows_by_cube.values() for item in values
                   if item.get('_cube_id') in kwargs['cubes']]
        return {'version': 1, 'complete': True, 'physical_count': len(records), 'logical_count': len(records),
                'matched_count': len(records), 'memories': records}

    def delete(self, memory_ids):
        body = {
            "writable_cube_ids": [self.cube],
            "memory_ids": list(memory_ids),
            "auto_cleanup_working": False,
        }
        return self.request("/product/delete_memory", body)


class MemoryGatewayBoundaryTests(unittest.TestCase):
    def setUp(self):
        FakeClient.calls = []
        FakeClient.rows_by_cube = {"main": []}
        FakeClient.capabilities = {"memory_stream": 1, "recall_index": 1}
        FakeClient.ignore_filter = False
        self.registry = {
            A_UID: dict(PROFILE_A),
            B_UID: dict(PROFILE_B),
            os.getuid(): dict(PROFILE_A),
        }
        self.boundary = self.make_boundary()

    def make_boundary(self, authorize=None):
        return Boundary(
            str(TEMP_ROOT / "registry.json"),
            "http://127.0.0.1:1",
            authorize=authorize or (lambda user_id, profile_id: True),
            cursor_key=b"synthetic-cursor-key-that-is-long-enough",
            admin_uid=0,
            registry_loader=lambda _path: self.registry,
            clients=FakeClient,
        )

    def call(self, body, *, uid=A_UID, method="POST", path="/product/get_memory"):
        return self.boundary.handle(uid, method, path, body)

    def test_rejects_foreign_identity_scope_cube_and_author_before_backend(self):
        requests = [
            {"mem_cube_id": "main", "user_id": "user-b", "filter": {}},
            {"mem_cube_id": "other", "filter": {}},
            {"mem_cube_id": "main", "filter": {"info.hermes_home_scope": "home-b"}},
            {"mem_cube_id": "main", "filter": {"info.hermes_memory_epoch": "epoch-b"}},
            {"mem_cube_id": "main", "filter": {"info.hermes_author_id": "author-b"}},
        ]
        for body in requests:
            with self.subTest(body=body):
                FakeClient.calls = []
                with self.assertRaises(Denied):
                    self.call(body)
                self.assertEqual(FakeClient.calls, [], "forged identity or scope must fail before upstream access")

    def test_rejects_each_foreign_physical_record_even_when_backend_ignores_filter(self):
        FakeClient.ignore_filter = True
        foreign_rows = [
            row("foreign-user", user="user-b"),
            row("foreign-scope", home="home-b"),
            row("foreign-epoch", epoch="epoch-b"),
            row("foreign-author", author="author-b"),
            row("foreign-cube", cube="other"),
        ]
        for item in foreign_rows:
            FakeClient.rows_by_cube = {"main": [row("own"), item]}
            with self.subTest(record=item["id"]):
                with self.assertRaises(Denied):
                    self.call({"mem_cube_id": "main", "filter": {"id": item["id"]}})

    def test_exact_id_delete_denies_foreign_record_and_allows_only_owned_id(self):
        FakeClient.rows_by_cube = {"main": [row("foreign", user="user-b")]}
        with self.assertRaises(Denied):
            self.call({"memory_ids": ["foreign"], "mem_cube_id": "main"}, path="/product/delete_memory")
        self.assertFalse(any(call[0] == "/product/delete_memory" for call in FakeClient.calls))

        FakeClient.calls = []
        FakeClient.rows_by_cube = {"main": [row("own")]}
        self.call({"memory_ids": ["own"], "mem_cube_id": "main"}, path="/product/delete_memory")
        delete_calls = [call for call in FakeClient.calls if call[0] == "/product/delete_memory"]
        self.assertEqual(delete_calls, [("/product/delete_memory", {
            "writable_cube_ids": ["profile-a__main"],
            "memory_ids": ["own"],
            "auto_cleanup_working": False,
        })])

    def test_legacy_search_is_denied_and_unsupported_index_does_not_fall_back(self):
        with self.assertRaises(Denied):
            self.call({"query": "synthetic"}, path="/product/search")
        self.assertFalse(any(call[0] == "/product/search" for call in FakeClient.calls))

        FakeClient.calls = []
        FakeClient.capabilities = {"memory_stream": 0, "recall_index": 0}
        with self.assertRaises(Denied):
            self.call({"query": "synthetic", "cubes": ["main"]}, path="/product/recall_index")
        self.assertFalse(any(call[0] == "/product/search" for call in FakeClient.calls))

    def test_admin_root_private_controls_and_cursor_target_binding(self):
        FakeClient.rows_by_cube = {"main": [row("one"), row("two")]}
        first = self.boundary.admin(0, "/admin/list", {"userId": "user-a", "limit": 1, "query": ""})
        self.assertEqual(len(first["items"]), 1)
        self.assertTrue(first["nextCursor"])
        second = self.boundary.admin(0, "/admin/list", {"userId": "user-a", "limit": 1, "cursor": first["nextCursor"]})
        self.assertEqual(first["items"][0]["id"], "one")
        self.assertEqual(second["items"][0]["id"], "two")
        self.assertIsNone(second["nextCursor"])
        with self.assertRaises(Denied):
            self.boundary.admin(A_UID, "/admin/list", {"userId": "user-a", "limit": 1, "query": ""})
        with self.assertRaises(Denied):
            self.boundary.admin(0, "/admin/list", {
                "userId": "user-b", "limit": 1, "query": "", "cursor": first["nextCursor"],
            })
        self.assertEqual(
            self.boundary.admin(0, "/admin/read", {"userId": "user-a", "memoryId": "one"})["id"],
            "one",
        )

    def test_admin_quarantine_preserves_unknown_author_and_rejects_collision(self):
        qid = 'a' * 64
        q = {'userId':'quarantine-' + qid, 'profileId':qid, 'homeScope':'h',
             'memoryEpoch':'e', 'cubes':['История Куб'], '_quarantine':True}
        self.boundary.quarantine_profile = q
        physical = qid + '__История Куб'
        saved = {'id':'q1', 'memory':'synthetic quarantine', '_cube_id':physical,
                 'metadata':{'user_id':q['userId'], 'info':{'hermes_home_scope':'h',
                 'hermes_memory_epoch':'e', 'hermes_author_id':'multiple_or_unknown',
                 'hermes_quarantined':True, 'hermes_profile_id':qid, 'hermes_user_id':q['userId'],
                 'hermes_cube':physical, 'hermes_memberships':[physical]}}}
        FakeClient.rows_by_cube = {physical:[saved]}
        self.assertEqual(self.boundary.admin(0, '/admin/list', {'userId':q['userId']})['items'][0]['id'], 'q1')
        self.assertEqual(self.boundary.admin(0, '/admin/read', {'userId':q['userId'], 'memoryId':'q1'})['metadata']['info']['hermes_author_id'], 'multiple_or_unknown')
        with self.assertRaises(Denied):
            self.boundary.admin(A_UID, '/admin/list', {'userId':q['userId']})
        with self.assertRaises(Denied):
            self.call({'mem_cube_id':physical, 'filter':{}}, uid=A_UID)
        saved['metadata']['info']['hermes_quarantined'] = False
        with self.assertRaises(Denied):
            self.boundary.admin(0, '/admin/list', {'userId':q['userId']})
        self.registry[B_UID] = {**PROFILE_B, 'userId':q['userId']}
        with self.assertRaises(Denied):
            self.boundary.admin(0, '/admin/list', {'userId':q['userId']})

    def test_authorize_callback_denies_before_upstream_access(self):
        denied = self.make_boundary(authorize=lambda user_id, profile_id: False)
        with self.assertRaises(Denied):
            denied.handle(A_UID, "POST", "/product/get_memory", {"mem_cube_id": "main", "filter": {}})
        self.assertEqual(FakeClient.calls, [])

    def test_shared_logical_cube_uses_separate_physical_cubes(self):
        self.registry[B_UID] = {**PROFILE_B, 'cubes': ['main']}
        for uid, name in ((A_UID, 'profile-a__main'), (B_UID, 'profile-b__main')):
            FakeClient.calls = []
            result = self.call({'writable_cube_ids': ['main'], 'messages': [{'role': 'user', 'content': 'test'}],
                       'info': {'hermes_primary_cube': 'main'}},
                      uid=uid, path='/product/add')
            payload = next(call[1] for call in FakeClient.calls if call[0] == '/product/add')
            self.assertEqual(payload['writable_cube_ids'], [name])
            self.assertEqual(payload['info']['hermes_cube'], name)
            self.assertEqual(payload['info']['hermes_memberships'], [name])
            self.assertEqual(payload['info']['hermes_primary_cube'], name)
            self.assertEqual(result['data'], [{'cube_id': 'main', 'memory_id': 'committed-id'}])

    def test_add_rejects_foreign_or_incomplete_receipts(self):
        body = {'writable_cube_ids': ['main'], 'messages': [{'role': 'user', 'content': 'test'}]}
        for data in (None, {}, [], [None],
                     [{'cube_id': 'profile-b__main', 'memory_id': 'foreign'}],
                     [{'cube_id': 'main', 'memory_id': 'unqualified'}],
                     [{'cube_id': 'profile-a__main', 'memory_id': ''}],
                     [{'cube_id': 'profile-a__main', 'memory_id': 123}],
                     [{'cube_id': 'profile-a__main', 'memory_id': 'own'},
                      {'cube_id': 'profile-b__main', 'memory_id': 'foreign'}]):
            with self.subTest(data=data), patch.object(FakeClient, 'request', return_value={'code': 200, 'data': data}):
                with self.assertRaisesRegex(Denied, 'UPSTREAM_SCOPE_MISMATCH'):
                    self.call(body, path='/product/add')

    def test_shared_logical_reads_stay_in_physical_profile(self):
        self.registry[B_UID] = {**PROFILE_B, 'cubes': ['main']}
        FakeClient.rows_by_cube = {
            'profile-a__main': [row('a')],
            'profile-b__main': [row('b', user='user-b', home='home-b', epoch='epoch-b', author='author-b')],
        }
        for uid, expected in ((A_UID, 'a'), (B_UID, 'b')):
            result = self.call({'mem_cube_id': 'main', 'filter': {}}, uid=uid)
            rows = result['data']['text_mem'][0]['memories']
            self.assertEqual([item['id'] for item in rows], [expected])
            self.assertEqual(rows[0]['_cube_id'], 'main')
            self.assertEqual(rows[0]['metadata']['info']['hermes_memberships'], ['main'])
            self.assertEqual(rows[0]['metadata']['info']['hermes_primary_cube'], 'main')
            result = self.call({'query': 'test', 'cubes': ['main']}, uid=uid, path='/product/recall_index')
            self.assertEqual([item['id'] for item in result['data']['memories']], [expected])
            self.assertEqual(result['data']['memories'][0]['_cube_id'], 'main')
            call = [call for call in FakeClient.calls if call[0] == '/product/recall_index'][-1]
            self.assertEqual(call[2]['cubes'], [('profile-a' if uid == A_UID else 'profile-b') + '__main'])

    def test_revocation_during_read_prevents_response(self):
        FakeClient.rows_by_cube = {'main': [row('private-result')]}
        allowed = [True]
        boundary = self.make_boundary(authorize=lambda user, profile: allowed[0])
        original = FakeClient._memory_read
        def revoked(client, body, timeout=None):
            result = original(client, body, timeout)
            allowed[0] = False
            return result
        FakeClient._memory_read = revoked
        socket_path = str(TEMP_ROOT / ('revocation-' + str(os.getpid()) + '.sock'))
        server = Server(socket_path, boundary, admin=False)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            response = self._request(socket_path, '/product/get_memory', {'mem_cube_id': 'main', 'filter': {}})
            self.assertIn(b' 403 ', response.split(b'\r\n', 1)[0])
            self.assertNotIn(b'private-result', response)
        finally:
            FakeClient._memory_read = original
            server.shutdown()
            worker.join(timeout=5)
            server.server_close()

    def test_af_unix_peer_uid_and_stream_trailer(self):
        FakeClient.rows_by_cube = {"main": [row("stream-own")]}
        socket_path = str(TEMP_ROOT / ("memory-" + str(os.getpid()) + ".sock"))
        server = Server(socket_path, self.boundary, admin=False)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 5
            while not Path(socket_path).exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(Path(socket_path).exists(), "AF_UNIX listener did not start")

            denied = self._request(socket_path, "/admin/list", {"userId": "user-a"})
            status = denied.split(b"\r\n", 1)[0]
            self.assertNotIn(b" 200 ", status, "ordinary listener exposed root-only admin controls")

            stream = self._request(socket_path, "/product/get_memory_stream", {"mem_cube_id": "main", "filter": {}})
            self.assertIn(b" 200 ", stream.split(b"\r\n", 1)[0], stream[:200])
            payload = stream.split(b"\r\n\r\n", 1)[1]
            events = [json.loads(line) for line in payload.splitlines() if line.strip()]
            self.assertEqual(events[0], {"type": "header", "version": 1, "cube_id": "main", "user_id": "user-a"})
            self.assertTrue(any(
                event.get("type") == "memory" and event.get("memory", {}).get("id") == "stream-own"
                for event in events
            ))
            self.assertEqual(events[-1].get("type"), "end")
            self.assertEqual(events[-1].get("count"), 1)
        finally:
            server.shutdown()
            worker.join(timeout=5)
            server.server_close()

    @staticmethod
    def _request(socket_path, path, body):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(socket_path)
        data = json.dumps(body).encode()
        request = (
            ("POST " + path + " HTTP/1.1\r\n").encode()
            + b"Host: localhost\r\nContent-Type: application/json\r\n"
            + b"Content-Length: " + str(len(data)).encode()
            + b"\r\nConnection: close\r\n\r\n" + data
        )
        sock.sendall(request)
        response = bytearray()
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response.extend(chunk)
        sock.close()
        return bytes(response)


if __name__ == "__main__":
    unittest.main()
