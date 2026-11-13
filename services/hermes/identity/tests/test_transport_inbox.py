# ABOUTME: Проверяет глобальную привязку до ack на временной SQLite.
# ABOUTME: Все пользователи и Telegram Update синтетические.
import tempfile
import unittest
from pathlib import Path

from telegram import Bot, Update
from identity.chat_journal import IdentityJournal
from identity.transport_inbox import TransportInbox


class TransportTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.inbox=TransportInbox(IdentityJournal(Path(self.tmp.name)/'chats'))
        self.update=Update.de_json({'update_id':7,'message':{'message_id':7,'date':1,
            'chat':{'id':42,'type':'private'},'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
            'text':'synthetic'}},Bot('123:abc'))
        self.a={'state':'known','profile':{'uid':1001,'profileId':'11111111-1111-4111-8111-111111111111',
            'userId':'a','telegramId':'42','authorTelegramId':'42','role':'user','generation':1}}

    def test_owner_rebinding_after_commit_blocks_original(self):
        self.assertEqual(self.inbox.capture_batch([(self.update,self.a)],123),['captured'])
        other={'state':'known','profile':{**self.a['profile'],'uid':1002,
            'profileId':'22222222-2222-4222-8222-222222222222','userId':'b'}}
        reopened=TransportInbox(self.inbox.journal)
        self.assertEqual(reopened.capture_batch([(self.update,other)],123),['binding_changed'])
        rows=reopened.pending()
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['state'],'blocked')
        self.assertIn('"userId":"a"',rows[0]['binding'])

    def test_onboarding_never_becomes_worker_input_after_auth_change(self):
        self.assertEqual(self.inbox.capture_batch([(self.update,{'state':'unregistered'})],123),['captured'])
        self.assertEqual(self.inbox.capture_batch([(self.update,self.a)],123),['binding_changed'])
        self.assertEqual(self.inbox.pending()[0]['state'],'blocked')

    def test_outside_and_forbidden_are_terminal_without_effect(self):
        self.assertEqual(self.inbox.capture_batch([(self.update,{'state':'forbidden'})],123),['rejected'])
        self.assertEqual(self.inbox.pending(),[])
        self.assertEqual(self.inbox.capture_batch([(self.update,self.a)],123),['binding_changed'])

    def test_reserved_profile_and_malformed_schema_are_rejected(self):
        from identity.transport_inbox import TRANSPORT_SCHEMA, TRANSPORT_PROFILE
        bad={'state':'known','profile':{**self.a['profile'],'profileId':TRANSPORT_PROFILE['profileId']}}
        with self.assertRaisesRegex(ValueError,'TRANSPORT_PROFILE_COLLISION'):
            self.inbox.capture_batch([(self.update,bad)],123)
        db=self.inbox._open()
        try:
            db.execute('DROP TABLE release_transport')
            db.execute(TRANSPORT_SCHEMA.replace(' NOT NULL',''))
            db.execute("INSERT INTO release_transport(state) VALUES(NULL)")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError,'TRANSPORT_SCHEMA_CHANGED'):
            self.inbox.pending()
