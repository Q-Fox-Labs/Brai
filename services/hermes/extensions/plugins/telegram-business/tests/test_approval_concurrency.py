from concurrent.futures import ThreadPoolExecutor
import threading
from telegram_business_plugin.state import BusinessStateDB
from .test_context_history import connect


def test_two_db_instances_cannot_claim_same_approval(tmp_path, monkeypatch):
    path = tmp_path/'telegram-business'/'state.db'
    a,b = BusinessStateDB(path),BusinessStateDB(path)
    connect(a)
    did = a.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text='hi',draft_text='reply')
    gate = threading.Barrier(2)
    for db in (a,b):
        original = db.get_telegram_business_draft
        def read(identifier, original=original):
            row = original(identifier)
            gate.wait(timeout=3)
            return row
        monkeypatch.setattr(db,'get_telegram_business_draft',read)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda db: db.claim_business_draft(did,'42'),(a,b)))
    assert sum(r is not None for r in results) == 1
    a.close(); b.close()
