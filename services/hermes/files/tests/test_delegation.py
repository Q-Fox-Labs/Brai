# ABOUTME: Проверяет потребление результатов помощников на реальной SQLite.
# ABOUTME: Исполняет точные функции native patch без модели, Telegram и пользовательских данных.
import contextlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.db'
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE messages (session_id TEXT,role TEXT,display_metadata TEXT)')
            db.execute('CREATE TABLE async_delegations (delegation_id TEXT PRIMARY KEY,parent_session_id TEXT,state TEXT,event_json TEXT,result_json TEXT,delivery_state TEXT,delivered_at REAL,updated_at REAL,completed_at REAL)')
        @contextlib.contextmanager
        def transaction():
            db = sqlite3.connect(self.path)
            try:
                with db: yield db
            finally: db.close()
        self.transaction = transaction
        source = (Path(__file__).parents[1] / 'native.patch').read_text()
        added = '\n'.join(line[1:] for line in source.splitlines() if line.startswith('+') and not line.startswith('+++'))
        start = added.index('def _context_was_persisted(')
        end = added.index('    return bool(fresh)', start) + len('    return bool(fresh)')
        scope = dict(_DB_LOCK=threading.Lock(), _transaction=transaction,
                     _json_object=lambda value: json.loads(value or '{}'), time=time)
        exec(compile(added[start:end], '<native-delegation>', 'exec'), scope)
        self.consume = scope['consume_completed_context']
        self.consumed = scope['context_completion_consumed']
        self.agent = types.SimpleNamespace(session_id='parent', _session_db=True,
            _brai_delegation_turn_started=10, _flush_messages_to_session_db=lambda *a: True)
        self.messages = []
        self.ports = patch.dict(sys.modules, {
            'agent.message_metadata': types.SimpleNamespace(append_message=lambda rows,row: rows.append(row)),
            'tools.process_registry_notifications': types.SimpleNamespace(_format_async_delegation=lambda event: json.dumps(event))})
        self.ports.start()
    def tearDown(self):
        self.ports.stop()
        self.temp.cleanup()
    def add(self, identity, parent='parent', state='completed', dispatched=20):
        with self.transaction() as db:
            db.execute('INSERT INTO async_delegations VALUES (?,?,?,?,?,?,?,?,?)',
                (identity,parent,state,json.dumps(dict(delegation_id=identity,dispatched_at=dispatched)), '{}','pending',None,0,30))
    def run_gate(self):
        return self.consume(self.agent, {'role':'assistant','content':'candidate'}, self.messages, [])
    def test_three_results_are_included_before_final_and_not_replayed(self):
        for i in range(3): self.add(str(i))
        self.assertTrue(self.run_gate())
        self.assertEqual(len(self.messages),2)
        for i in range(3): self.assertTrue(self.consumed(str(i)))
        self.assertFalse(self.run_gate())
        self.assertEqual(len(self.messages),2)
    def test_other_session_running_and_historical_results_are_not_consumed(self):
        self.add('other',parent='other');self.add('running',state='running');self.add('old',dispatched=1)
        self.assertFalse(self.run_gate())
        for name in ('other','running','old'): self.assertFalse(self.consumed(name))
    def test_failed_flush_leaves_result_for_recovery(self):
        self.add('retry');self.agent._flush_messages_to_session_db=lambda *a: False
        with self.assertRaisesRegex(RuntimeError,'NOT_PERSISTED'): self.run_gate()
        self.assertFalse(self.consumed('retry'))
    def test_late_internal_result_is_acknowledged_without_duplicate_context(self):
        self.add('late',dispatched=1);self.agent._brai_internal_delegation_ids=('late',)
        self.messages.append({'role':'user','content':'trusted completion'})
        self.assertFalse(self.run_gate())
        self.assertTrue(self.consumed('late'))
        self.assertEqual(len(self.messages),1)
    def test_crash_after_context_flush_does_not_append_or_deliver_again(self):
        self.add('crash')
        with self.transaction() as db:
            db.execute('INSERT INTO messages VALUES (?,?,?)', ('parent','user',json.dumps({'brai_delegation_ids':['crash']})))
        self.assertTrue(self.consumed('crash'))
        self.assertFalse(self.run_gate())
        self.assertEqual(self.messages,[])
    def test_new_result_after_previous_consumption_still_runs(self):
        self.add('first');self.assertTrue(self.run_gate())
        self.add('second');self.assertTrue(self.run_gate())
        self.assertTrue(self.consumed('second'))

if __name__ == '__main__': unittest.main()
