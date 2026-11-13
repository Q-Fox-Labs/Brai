# ABOUTME: Синтетические реальные SQLite/PTB проверки прототипа inbox.
# ABOUTME: Не подключается к Telegram, systemd и личным профилям.
import json
import multiprocessing
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

try:
    from telegram import Bot, Update
except ImportError:
    raise unittest.SkipTest('Нужен закреплённый python-telegram-bot')
from identity.chat_journal import IdentityJournal
from identity.update_inbox import UpdateInbox, ProfileGateStore

PROFILE = {'profileId':'11111111-1111-4111-8111-111111111111','userId':'synthetic-owner','uid':1001,
           'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
OTHER = {'profileId':'22222222-2222-4222-8222-222222222222','userId':'synthetic-other','uid':1002,
         'telegramId':'42','authorTelegramId':'42','role':'member','generation':1}
OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

def update(ident, text='synthetic', **changes):
    raw={'update_id':ident,'message':{'message_id':ident,'date':1,
         'chat':{'id':42,'type':'private'}, 'from':{'id':42,'is_bot':False,'first_name':'synthetic'},
         'text':text}}
    raw.update(changes)
    return Update.de_json(raw, Bot('123:abc'))

def competitor(root, ready, go, result):
    inbox = UpdateInbox(IdentityJournal(Path(root)))
    ready.put('ready'); go.wait()
    try:
        value = inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        result.put(('claimed',value['update']['update_id']))
    except Exception as error:
        result.put(('denied',type(error).__name__))

class InboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'chats'
        self.journal=IdentityJournal(self.root)
        self.inbox=UpdateInbox(self.journal)

    def capture(self, ident=1, text='synthetic'):
        return self.inbox.capture(PROFILE, update(ident,text), '123')

    def test_same_id_same_payload_idempotent_conflict_fails(self):
        first=self.capture()
        self.assertEqual(first,self.capture())
        with self.assertRaisesRegex(ValueError,'IDENTITY_CONFLICT'):
            self.capture(text='different')
        changed={**PROFILE,'userId':'other'}
        with self.assertRaisesRegex(ValueError,'SCHEMA_OWNER_CHANGED'):
            self.inbox.capture(changed,update(1),'123')
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'captured')

    def test_held_order_original_json_and_operation_binding(self):
        for ident in (3,1,2):
            self.capture(ident)
            self.inbox.disposition(PROFILE,'123',ident,'held',operation_id=OP)
        rows=self.inbox.held(PROFILE,OP)
        self.assertEqual([r['update_id'] for r in rows],['3','1','2'])
        restored=Update.de_json(rows[0]['update'], Bot('123:abc'))
        self.assertEqual(restored.update_id,3)
        self.assertEqual(restored.effective_message.message_id,3)
        with self.assertRaises(PermissionError):
            self.inbox.claim_for_delivery(PROFILE,'123',3,operation_id=str(uuid.uuid4()))
        self.assertEqual(self.inbox.observe(PROFILE,'123',3)['state'],'held')

    def test_owner_rebinding_cannot_hide_held_events(self):
        self.capture();self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        changed={**PROFILE,'uid':PROFILE['uid']+1}
        with self.assertRaisesRegex(PermissionError,'OWNER_CHANGED'):
            self.inbox.held(changed,OP)
        self.assertEqual(len(self.inbox.held(PROFILE,OP)),1)

    def test_partial_batch_failure_propagates_and_retry_is_idempotent(self):
        actual=self.inbox.capture
        def fail_second(profile, event, bot_id):
            if event.update_id == 2: raise OSError('synthetic fsync failure')
            return actual(profile,event,bot_id)
        with patch.object(self.inbox,'capture',side_effect=fail_second):
            with self.assertRaisesRegex(OSError,'fsync'):
                self.inbox.capture_batch([(PROFILE,update(1)),(OTHER,update(2))],'123')
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'captured')
        result=self.inbox.capture_batch([(PROFILE,update(1)),(OTHER,update(2))],'123')
        self.assertEqual(len(result),2)
        self.assertEqual(self.inbox.observe(OTHER,'123',2)['state'],'captured')

    def test_directory_fsync_failure_propagates_and_retries_same_row(self):
        self.inbox.install_v2(PROFILE)
        with patch('identity.update_inbox.os.fsync', side_effect=OSError('synthetic directory fsync failure')):
            with self.assertRaisesRegex(OSError,'directory fsync'):
                self.capture()
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'captured')
        first=self.capture()
        self.assertEqual(first,self.capture())

    def test_commit_failure_rolls_back_and_propagates(self):
        actual=self.journal.database
        class BrokenCommit:
            def __init__(self,db): self.db=db
            def __getattr__(self,name): return getattr(self.db,name)
            def __enter__(self): self.db.__enter__(); return self
            def __exit__(self,*args):
                self.db.rollback()
                raise OSError('synthetic durable commit failure')
        with patch.object(self.journal,'database',side_effect=lambda profile: BrokenCommit(actual(profile))):
            with self.assertRaisesRegex(OSError,'commit failure'): self.capture()
        with self.assertRaisesRegex(ValueError,'NOT_FOUND'):
            self.inbox.observe(PROFILE,'123',1)

    def test_claim_across_two_processes_exactly_one(self):
        self.capture();self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        ctx=multiprocessing.get_context('fork')
        ready=ctx.Queue(); result=ctx.Queue(); go=ctx.Event()
        processes=[ctx.Process(target=competitor,args=(str(self.root),ready,go,result)) for _ in range(2)]
        for process in processes: process.start()
        for _ in processes: self.assertEqual(ready.get(),'ready')
        go.set()
        values=[result.get() for _ in processes]
        for process in processes:
            process.join()
            self.assertEqual(process.exitcode,0)
        self.assertEqual(sorted(x[0] for x in values),['claimed','denied'])
        self.assertEqual(next(x[1] for x in values if x[0]=='denied'),'ValueError')
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'handing_off')

    def test_unknown_after_effect_is_never_automatically_replayed(self):
        self.capture(); self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        event=self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        effects=[event['update']['update_id']]
        self.assertEqual(effects,[1])
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'handing_off')
        self.inbox.markunknown(PROFILE,'123',1)
        with self.assertRaisesRegex(ValueError,'UNRESOLVED_HANDOFF'):
            self.inbox.held(PROFILE,OP)
        with self.assertRaisesRegex(ValueError,'NOT_REPLAYABLE'):
            self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        self.assertEqual(effects,[1])

    def test_unknown_earlier_delivery_prevents_later_reordering(self):
        for ident in (1,2):
            self.capture(ident); self.inbox.disposition(PROFILE,'123',ident,'held',operation_id=OP)
        self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        self.inbox.markunknown(PROFILE,'123',1)
        with self.assertRaisesRegex(ValueError,'UNRESOLVED_HANDOFF'):
            self.inbox.held(PROFILE,OP)
        self.assertEqual(self.inbox.observe(PROFILE,'123',2)['state'],'held')
        with self.assertRaisesRegex(ValueError,'ORDER_BLOCKED'):
            self.inbox.claim_for_delivery(PROFILE,'123',2,operation_id=OP)

    def test_handoff_fsync_failure_never_returns_event_for_delivery(self):
        self.capture();self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        with patch('identity.update_inbox.os.fsync', side_effect=OSError('synthetic handoff fsync failure')):
            with self.assertRaisesRegex(OSError,'handoff fsync'):
                self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'handing_off')
        with self.assertRaisesRegex(ValueError,'NOT_REPLAYABLE'):
            self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)

    def test_unknown_prior_operation_blocks_later_operation(self):
        newer=str(uuid.uuid4())
        self.capture();self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        self.inbox.markunknown(PROFILE,'123',1)
        self.capture(2);self.inbox.disposition(PROFILE,'123',2,'held',operation_id=newer)
        with self.assertRaisesRegex(ValueError,'UNRESOLVED_HANDOFF'):
            self.inbox.held(PROFILE,newer)
        with self.assertRaisesRegex(ValueError,'ORDER_BLOCKED'):
            self.inbox.claim_for_delivery(PROFILE,'123',2,operation_id=newer)

    def test_accepted_receipt_and_native_duplicate_are_distinct(self):
        self.capture();self.inbox.claim_for_delivery(PROFILE,'123',1)
        self.inbox.markaccepted(PROFILE,'123',1,{'accepted':True,'turn_id':'synthetic-turn'})
        self.assertEqual(json.loads(self.inbox.observe(PROFILE,'123',1)['receipt'])['turn_id'],'synthetic-turn')
        self.capture(2);self.inbox.disposition(PROFILE,'123',2,'native_duplicate')
        row=self.inbox.observe(PROFILE,'123',2)
        self.assertEqual(row['state'],'native_duplicate')
        self.assertIsNone(row['receipt'])
        with self.assertRaises(ValueError): self.inbox.markaccepted(PROFILE,'123',2,{'accepted':True})

    def test_revoked_generation_or_pause_refuse_without_changing_consent(self):
        self.capture();self.inbox.disposition(PROFILE,'123',1,'held',operation_id=OP)
        db=self.journal.database(PROFILE)
        with db:
            db.execute('INSERT INTO chat_pauses VALUES(?,?,?,?,?,?,?)',('42','',1,1,1,0,0))
        db.close()
        original=self.journal.chat_state(PROFILE,('42',''))
        with self.assertRaisesRegex(PermissionError,'CONSENT_CHANGED'):
            self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)
        self.assertEqual(self.journal.chat_state(PROFILE,('42','')),original)
        self.assertEqual(self.inbox.observe(PROFILE,'123',1)['state'],'held')
        db=self.journal.database(PROFILE)
        with db: db.execute("UPDATE chat_pauses SET paused=0 WHERE chat='42'")
        db.close()
        with self.assertRaisesRegex(PermissionError,'CONSENT_CHANGED'):
            self.inbox.claim_for_delivery(PROFILE,'123',1,operation_id=OP)

class GateStoreTests(InboxTests):
    def setUp(self):
        super().setUp()
        self.store=ProfileGateStore(self.inbox)
        self.boot=str(uuid.uuid4())
        self.request={'operationId':OP,'attemptId':str(uuid.uuid4()),'profileId':PROFILE['profileId'],
            'targetPayloadHash':'a'*64,'workerPid':123,'workerStartTime':'456'}

    def test_ready_resume_receipt_survives_reopen_and_wrong_boot_is_unknown(self):
        self.assertEqual(self.store.begin(PROFILE,self.request,self.boot)['state'],'arming')
        self.assertEqual(self.store.transition(PROFILE,self.request,self.boot,'arming','ready')['state'],'ready')
        self.store.transition(PROFILE,self.request,self.boot,'ready','resuming')
        self.store.transition(PROFILE,self.request,self.boot,'resuming','resumed',replacement_pid=124,replacement_start='789')
        reopened=ProfileGateStore(UpdateInbox(IdentityJournal(self.root)))
        receipt=reopened.status(PROFILE,self.request,self.boot)
        self.assertEqual((receipt['state'],receipt['replacement_pid'],receipt['replacement_start']),('resumed',124,'789'))
        self.assertEqual(reopened.current(PROFILE,str(uuid.uuid4()))['state'],'unknown')
        with self.assertRaises(ValueError):
            reopened.transition(PROFILE,self.request,self.boot,'resuming','resumed',replacement_pid=125,replacement_start='789')

    def test_busy_attempt_is_idempotent_but_superseded_status_unknown(self):
        self.store.begin(PROFILE,self.request,self.boot)
        self.store.transition(PROFILE,self.request,self.boot,'arming','reopening')
        self.store.transition(PROFILE,self.request,self.boot,'reopening','busy')
        second={**self.request,'attemptId':str(uuid.uuid4())}
        self.store.begin(PROFILE,second,self.boot)
        self.assertEqual(self.store.status(PROFILE,self.request,self.boot)['state'],'unknown')
        with self.assertRaisesRegex(ValueError,'SUPERSEDED'):
            self.store.begin(PROFILE,self.request,self.boot)
        with self.assertRaisesRegex(ValueError,'UNFINISHED'):
            self.store.begin(PROFILE,{**second,'attemptId':str(uuid.uuid4())},self.boot)

    def test_wrong_process_or_owner_cannot_reuse_attempt(self):
        self.store.begin(PROFILE,self.request,self.boot)
        with self.assertRaisesRegex(ValueError,'BINDING_CHANGED'):
            self.store.status(PROFILE,{**self.request,'workerPid':124},self.boot)
        changed={**PROFILE,'uid':PROFILE['uid']+1}
        with self.assertRaisesRegex(ValueError,'SCHEMA_OWNER_CHANGED'):
            self.store.current(changed,self.boot)


class AdditiveBindingMigrationTests(InboxTests):
    def test_failed_registration_does_not_leave_partial_v2_schema(self):
        actual=self.journal.database
        class BrokenCommit:
            def __init__(self,db): self.db=db
            def __getattr__(self,name): return getattr(self.db,name)
            def __enter__(self): self.db.__enter__(); return self
            def __exit__(self,*args):
                self.db.rollback()
                raise OSError('synthetic registration failure')
        with patch.object(self.journal,'database',side_effect=lambda profile: BrokenCommit(actual(profile))):
            with self.assertRaisesRegex(OSError,'registration failure'):
                self.inbox.install_v2(PROFILE)
        db=actual(PROFILE)
        try:
            names={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'release_%'")}
            self.assertEqual(names,set())
        finally:
            db.close()
        self.inbox.install_v2(PROFILE)

    def test_legacy_unbound_input_is_preserved_and_blocks_replay_and_rollback(self):
        # Simulate an old journal without the Auth snapshot table. Never infer
        # the missing owner binding from today's Auth state.
        from identity.update_inbox import SCHEMA
        profile={**PROFILE,'telegramId':'42','authorTelegramId':'42','role':'member','generation':7}
        db=self.journal.database(profile)
        db.execute(SCHEMA)
        db.execute("""INSERT INTO release_inbox
            (bot_id,update_id,profile_id,user_id,uid,actor_id,chat,thread,chat_generation,payload,digest,state)
            VALUES('123','1',?,?,?,'42','42','',0,'{}','synthetic','captured')""",
            (profile['profileId'],profile['userId'],profile['uid']))
        db.commit();db.close()
        self.inbox.install_v2(profile)
        db=sqlite3.connect(f'file:{self.root / profile["profileId"] / "telegram.sqlite3"}?mode=ro', uri=True)
        try:
            report=self.inbox.disposition_summary(db,profile)
            self.assertEqual(report['schemaVersion'],2)
            self.assertEqual(report['counts']['captured'],1)
            self.assertEqual(report['unbound'],1)
            self.assertFalse(report['rollbackSafe'])
            self.assertEqual(db.execute('SELECT payload FROM release_inbox').fetchone()[0],'{}')
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError,'INBOX_AUTH_UNAVAILABLE'):
            self.inbox.capture(profile,update(1),'123')
        self.inbox.install_v2(profile)  # idempotent; no reclassification or deletion

    def test_summary_marks_receipt_terminal_and_foreign_binding_invalid(self):
        self.capture()
        self.inbox.claim_for_delivery(PROFILE,123,1)
        self.inbox.markaccepted(PROFILE,123,1,{'accepted':True})
        db=sqlite3.connect(f'file:{self.root / PROFILE["profileId"] / "telegram.sqlite3"}?mode=ro', uri=True)
        try:
            report=self.inbox.disposition_summary(db,PROFILE)
            self.assertEqual(report['counts']['accepted'],1)
            self.assertTrue(report['rollbackSafe'])
            with self.assertRaisesRegex(ValueError,'SCHEMA_OWNER_CHANGED'):
                self.inbox.disposition_summary(db,{**PROFILE,'uid':PROFILE['uid']+1})
        finally:
            db.close()

if __name__ == '__main__': unittest.main()
