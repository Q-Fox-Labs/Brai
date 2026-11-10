# ABOUTME: Проверяет Root-only preseed и атомарность operator audit с паузой.
# ABOUTME: Использует вымышленные bindings и SQLite fixtures; реальные UID и сервисы не меняет.
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import pause_preseed as helper
from identity.chat_journal import IdentityJournal

USER = '11111111-1111-4111-8111-111111111111'
PROFILE = '22222222-2222-4222-8222-222222222222'
OPERATION = '33333333-3333-4333-8333-333333333333'
OWNER = {'userId': USER, 'profileId': PROFILE, 'telegramId': '123'}
CONFIG = {'version': 1, 'registryPath': '/protected/registry.json',
          'telegramJournalRoot': '/trusted/chats', 'ingressUid': 995, 'ingressGid': 995}
REQUEST = {'version': 1, 'operationId': OPERATION, 'expectedUserId': USER, 'expectedProfileId': PROFILE,
           'expectedWorkerUid': 1001, 'expectedAuthorTelegramId': '123',
           'chat': '123', 'thread': '77', 'reason': 'Операторская пауза перед обновлением'}


def payload(operation=OPERATION, reason='Операторская пауза'):
    return {'actor': 'os:root', 'operationId': operation,
            'binding': {'userId': USER, 'profileId': PROFILE, 'workerUid': 1001, 'authorTelegramId': '123'},
            'chat': '123', 'thread': '77', 'reason': reason, 'configSha256': 'a' * 64}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class BoundaryTest(unittest.TestCase):
    def test_nonroot_fails_before_any_input_or_registry_read(self):
        with patch.object(helper.os, 'getuid', return_value=1002), patch.object(
                helper.os, 'geteuid', return_value=1002), patch.object(helper, 'protected_json') as read:
            with self.assertRaises(PermissionError):
                helper.execute('/config', '/request')
        read.assert_not_called()

    def test_strict_keys_types_paths_and_exact_owner_binding(self):
        self.assertEqual(helper.validate_config(CONFIG), CONFIG)
        self.assertEqual(helper.validate_request(REQUEST), REQUEST)
        for value in (dict(CONFIG, credentials='forbidden'), dict(CONFIG, ingressUid=True),
                      dict(CONFIG, telegramJournalRoot='/trusted/../other')):
            with self.assertRaises(ValueError):
                helper.validate_config(value)
        for value in (dict(REQUEST, action='resume'), dict(REQUEST, actor='human'),
                      dict(REQUEST, chat='456'), dict(REQUEST, expectedWorkerUid=True),
                      dict(REQUEST, thread='1'), dict(REQUEST, reason=''),
                      dict(REQUEST, operationId='invalid')):
            with self.assertRaises(ValueError):
                helper.validate_request(value)
        self.assertEqual(helper.exact_binding(CONFIG, REQUEST, {1001: OWNER}), OWNER)
        for registry in ({}, {1002: OWNER}, {1001: dict(OWNER, userId=PROFILE)},
                         {1001: dict(OWNER, profileId=USER)}, {1001: dict(OWNER, telegramId='456')},
                         {1001: OWNER, 995: dict(OWNER, userId='other')}):
            with self.assertRaises(PermissionError):
                helper.exact_binding(CONFIG, REQUEST, registry)

    def test_protected_inputs_reject_links_permissions_duplicate_and_unknown_fields(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'input.json'
            path.write_text(json.dumps(CONFIG))
            path.chmod(0o600)
            good_dir = NS(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            good_file = NS(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1, st_size=path.stat().st_size)
            with patch.object(Path, 'lstat', return_value=good_dir), patch.object(
                    helper.os, 'fstat', return_value=good_file):
                self.assertEqual(helper.protected_json(str(path)), CONFIG)
                path.write_text('{"version":1,"version":1}')
                with self.assertRaises(ValueError):
                    helper.protected_json(str(path))
                alias = Path(root) / 'alias.json'
                alias.symlink_to(path)
                with self.assertRaises(OSError):
                    helper.protected_json(str(alias))
            for info in (NS(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_nlink=1, st_size=10),
                         NS(st_mode=stat.S_IFREG | 0o600, st_uid=1002, st_nlink=1, st_size=10),
                         NS(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=2, st_size=10)):
                with patch.object(Path, 'lstat', return_value=good_dir), patch.object(
                        helper.os, 'fstat', return_value=info), self.assertRaises(PermissionError):
                    helper.protected_json(str(path))
            with patch.object(Path, 'lstat', return_value=NS(st_mode=stat.S_IFDIR | 0o777, st_uid=0)):
                with self.assertRaises(PermissionError):
                    helper.protected_json(str(path))

    def test_privileges_drop_permanently_and_saved_root_is_rejected(self):
        calls = []
        with patch.object(helper.os, 'setgroups', side_effect=lambda value: calls.append(('groups', value))), patch.object(
                helper.os, 'setgid', side_effect=lambda value: calls.append(('gid', value))), patch.object(
                helper.os, 'setuid', side_effect=lambda value: calls.append(('uid', value))), patch.object(
                helper.os, 'getresuid', return_value=(995, 995, 995)), patch.object(
                helper.os, 'getresgid', return_value=(995, 995, 995)), patch.object(helper.os, 'getgroups', return_value=[]):
            helper._drop_privileges(995, 995)
        self.assertEqual(calls, [('groups', []), ('gid', 995), ('uid', 995)])
        with patch.object(helper.os, 'setgroups'), patch.object(helper.os, 'setgid'), patch.object(
                helper.os, 'setuid'), patch.object(helper.os, 'getresuid', return_value=(995, 995, 0)):
            with self.assertRaises(PermissionError):
                helper._drop_privileges(995, 995)

    def test_journal_is_opened_only_after_binding_validation_and_privilege_drop(self):
        events = []
        def drop(uid, gid):
            events.append('drop')
        class Journal:
            def __init__(self, root):
                assert events == ['registry', 'drop']
                events.append('journal')
            def seed_operator_pause(self, profile, route, operation, digest, value):
                assert value['actor'] == 'os:root' and value['binding']['workerUid'] == 1001
                assert len(digest) == 64 and route == ('123', '77')
                events.append('atomic-readback')
                return {'status': 'paused', 'verified': True}
        def registry(path):
            events.append('registry')
            return {1001: OWNER}
        with patch.object(helper.os, 'getuid', return_value=0), patch.object(helper.os, 'geteuid', return_value=0), patch.object(
                helper, 'protected_json', side_effect=[CONFIG, REQUEST]), patch.object(
                helper, 'load_registry', side_effect=registry), patch.object(helper, '_journal_path'), patch.object(
                helper, '_drop_privileges', side_effect=drop), patch.object(helper, 'IdentityJournal', Journal):
            self.assertTrue(helper.execute('/config', '/request')['verified'])
        self.assertEqual(events, ['registry', 'drop', 'journal', 'atomic-readback'])

    def test_failure_output_never_contains_input_or_partial_success(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(helper, 'execute', side_effect=OSError('SECRET_SENTINEL')), patch.object(
                sys, 'stdout', stdout), patch.object(sys, 'stderr', stderr):
            self.assertEqual(helper.main(['--config', '/config', '--request', '/request']), 1)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), 'OPERATOR_PAUSE_PRESEED_FAILED\n')


class AtomicPauseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = IdentityJournal(Path(self.temp.name) / 'journal')

    def seed(self, value=None):
        value = payload() if value is None else value
        return self.journal.seed_operator_pause(OWNER, ('123', '77'), value['operationId'], fingerprint(value), value)

    def test_atomic_pause_audit_restart_idempotency_and_fresh_readback(self):
        first = self.seed()
        self.assertEqual(first['status'], 'paused')
        self.assertEqual(first['actor'], 'os:root')
        self.assertTrue(first['verified'])
        self.assertEqual(first['userId'], USER)
        self.assertEqual(first['profileId'], PROFILE)
        self.assertEqual(first['chat'], '123')
        self.assertEqual(first['thread'], '77')
        self.assertTrue(self.journal.chat_state(OWNER, ('123', '77'))['paused'])
        self.journal = IdentityJournal(Path(self.temp.name) / 'journal')
        self.assertEqual(self.seed(), first)
        db = self.journal.database(OWNER)
        try:
            self.assertEqual(db.execute('SELECT count(*) FROM operator_pause_audit').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        finally:
            db.close()

    def test_audit_insert_failure_rolls_back_pause(self):
        db = self.journal.database(OWNER)
        try:
            db.execute("CREATE TRIGGER reject_operator_audit BEFORE INSERT ON operator_pause_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
            db.commit()
        finally:
            db.close()
        with self.assertRaises(Exception):
            self.seed()
        self.assertFalse(self.journal.chat_state(OWNER, ('123', '77'))['paused'])

    def test_conflict_and_replay_after_later_resume_do_not_reapply_old_operation(self):
        self.seed()
        with self.assertRaises(ValueError):
            self.seed(payload(reason='Different operator intent'))
        self.journal.set_chat_pause(OWNER, ('123', '77'), False)
        with self.assertRaises(ValueError):
            self.seed()
        self.assertFalse(self.journal.chat_state(OWNER, ('123', '77'))['paused'])
        fresh = payload(operation='44444444-4444-4444-8444-444444444444')
        self.assertTrue(self.seed(fresh)['verified'])

    def test_unknown_readback_recovers_by_same_operation_without_duplicate_audit(self):
        with patch.object(self.journal, 'verify_operator_pause', side_effect=OSError('synthetic disconnect')):
            with self.assertRaises(OSError):
                self.seed()
        self.assertTrue(self.journal.chat_state(OWNER, ('123', '77'))['paused'])
        self.journal = IdentityJournal(Path(self.temp.name) / 'journal')
        self.assertTrue(self.seed()['verified'])
        db = self.journal.database(OWNER)
        try:
            self.assertEqual(db.execute('SELECT count(*) FROM operator_pause_audit').fetchone()[0], 1)
        finally:
            db.close()


    def test_existing_history_rows_and_native_state_file_are_unchanged(self):
        from datetime import datetime, timezone
        chat, user = NS(id=123), NS(full_name='Synthetic', username='')
        self.journal.incoming(OWNER, NS(chat=chat, message_id=7, message_thread_id=77,
            text='Точные синтетические байты истории', date=datetime.now(timezone.utc)), chat, user)
        untouched = Path(self.temp.name) / 'native-state.sentinel'
        untouched.write_bytes(b'native session bytes remain unchanged')
        db = self.journal.database(OWNER)
        try:
            before = [tuple(row) for row in db.execute('SELECT * FROM messages ORDER BY id')]
        finally:
            db.close()
        self.seed()
        db = self.journal.database(OWNER)
        try:
            self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM messages ORDER BY id')], before)
        finally:
            db.close()
        self.assertEqual(untouched.read_bytes(), b'native session bytes remain unchanged')

if __name__ == '__main__':
    unittest.main()
