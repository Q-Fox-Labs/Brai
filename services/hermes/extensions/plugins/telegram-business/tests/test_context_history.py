import pytest
from telegram_business_plugin.state import BusinessStateDB


def connect(db, owner='42', conn='c1'):
    db.upsert_telegram_business_connection(connection_id=conn, owner_user_id=owner,
        owner_chat_id=owner, can_reply=True, is_enabled=True)


def test_history_is_durable_scoped_and_deduplicated(tmp_path):
    path = tmp_path / 'state.db'
    db = BusinessStateDB(path)
    connect(db)
    a = db.business_scope('c1', '200')
    b = db.business_scope('c1', '201')
    assert db.record_business_message(a, '1', 'remember blue', actor='customer', author_id='200', origin='telegram_incoming')
    assert not db.record_business_message(a, '1', 'remember blue', actor='customer', author_id='200', origin='telegram_incoming')
    db.record_business_message(b, '1', 'private red', actor='customer', author_id='201', origin='telegram_incoming')
    db.close()
    db = BusinessStateDB(path)
    assert [r['text'] for r in db.business_history(a)] == ['remember blue']
    connect(db, owner='43')
    with pytest.raises(ValueError):
        db.business_history(a)
    assert db.business_history(db.business_scope('c1', '200')) == []
    with pytest.raises(ValueError):
        db.business_scope('unknown', '200')
    db.close()


@pytest.mark.asyncio
async def test_manager_records_incoming_and_owner_without_learning_drafts(tmp_path):
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    db = BusinessStateDB(tmp_path / 'telegram-business' / 'state.db')
    connect(db)
    sent = []
    async def send(**kwargs):
        sent.append(kwargs)
        return NS(message_id=99)
    async def draft(text, chat):
        return 'UNSENT AI PROPOSAL'
    manager = BusinessModeManager(session_db=db, send_message=send, draft_generator=draft, debounce_seconds=0)
    def msg(author, text, mid):
        return NS(business_connection_id='c1', chat=NS(id=200, type='private'),
            from_user=NS(id=author), text=text, message_id=mid)
    await manager.handle_business_message(msg(200, 'blue fact', 1))
    await manager.handle_business_message(msg(42, 'owner wording', 2))
    await manager.handle_business_message(msg(42, 'owner wording', 2))
    history = db.business_history(db.business_scope('c1', '200'))
    assert [(r['actor'], r['text']) for r in history] == [('customer', 'blue fact'), ('owner', 'owner wording')]
    assert len(sent) == 1, 'owner outgoing must not create another draft'
    db.close()


@pytest.mark.asyncio
async def test_approval_is_authenticated_one_shot_and_records_only_success(tmp_path):
    import asyncio
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    db = BusinessStateDB(tmp_path / 'telegram-business' / 'state.db')
    connect(db)
    calls = []
    async def send(**kwargs):
        calls.append(kwargs)
        await asyncio.sleep(.01)
        return NS(message_id=88)
    async def draft(*args): return 'approved wording'
    async def noop(**kwargs): pass
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=draft, debounce_seconds=0)
    did = db.create_telegram_business_draft(connection_id='c1', owner_chat_id='42', customer_chat_id='200',
        customer_msg_id='1', customer_text='hi', draft_text='approved wording')
    async def tap(caller):
        await mgr.handle_callback(data=f'bd:send:{did}', caller_user_id=caller, answer=noop, edit_message_text=noop)
    await tap(None)
    assert calls == [], 'missing identity fails closed'
    await asyncio.gather(tap('42'), tap('42'))
    assert len(calls) == 1, 'concurrent approvals send once'
    hist = db.business_history(db.business_scope('c1', '200'))
    assert [(r['actor'],r['origin']) for r in hist] == [('approved_ai','approved_send')]
    db.close()


@pytest.mark.asyncio
async def test_new_incoming_invalidates_old_draft_even_when_paused(tmp_path):
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    db = BusinessStateDB(tmp_path / 'telegram-business' / 'state.db')
    connect(db)
    async def send(**kwargs): return NS(message_id=90)
    async def draft(*args): return 'old reply'
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=draft, debounce_seconds=0)
    did = db.create_telegram_business_draft(connection_id='c1', owner_chat_id='42', customer_chat_id='200',
        customer_msg_id='1', customer_text='old', draft_text='old reply')
    db.set_telegram_business_auto_draft('c1', auto_draft=False)
    await mgr.handle_business_message(NS(business_connection_id='c1', chat=NS(id=200,type='private'),
        from_user=NS(id=200), text='new', message_id=2))
    assert db.get_telegram_business_draft(did)['status'] == 'superseded'
    scope = db.business_scope('c1','200')
    db.delete_business_messages(scope,['2'])
    assert db.business_history(scope) == []
    db.close()


@pytest.mark.asyncio
async def test_owner_edit_auth_and_failed_send_never_becomes_history(tmp_path):
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    calls = []
    async def send(**kw):
        calls.append(kw)
        if kw.get('business_connection_id'):
            raise RuntimeError('SECRET ERROR CONTENT')
        return NS(message_id=9)
    async def draft(*args): return 'draft'
    async def noop(**kw): pass
    mgr = BusinessModeManager(session_db=db,send_message=send,draft_generator=draft,debounce_seconds=0)
    did = db.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text='hi',draft_text='draft')
    await mgr.handle_callback(data=f'bd:edit:{did}',caller_user_id='42',answer=noop,edit_message_text=noop)
    assert not await mgr.maybe_handle_edit_capture(owner_chat_id='42',caller_user_id='200',text='intruder')
    assert calls == []
    assert await mgr.maybe_handle_edit_capture(owner_chat_id='42',caller_user_id='42',text='real owner')
    assert db.business_history(db.business_scope('c1','200')) == []
    assert db.get_telegram_business_draft(did)['status'] == 'failed'
    assert 'SECRET ERROR CONTENT' not in repr(calls)
    db.close()


@pytest.mark.asyncio
async def test_observed_messages_are_archived_even_without_drafting(tmp_path):
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    from telegram_business_plugin.context import DraftContext
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    db.set_telegram_business_auto_draft('c1',auto_draft=False)
    archives = []
    class Memory:
        def archive(self,scope,row):
            archives.append((scope,row['text']))
            return 'durable-event'
    context = DraftContext(db,tmp_path)
    context.memory = Memory()
    async def send(**kw): raise AssertionError('no send permitted')
    async def draft(*args): raise AssertionError('paused')
    mgr = BusinessModeManager(session_db=db,send_message=send,draft_generator=draft,
        archive_context=context,debounce_seconds=0)
    await mgr.handle_business_message(NS(business_connection_id='c1',chat=NS(id=200,type='private'),
        from_user=NS(id=42),text='real owner text',message_id=1))
    assert [t for s,t in archives] == ['real owner text']
    assert db.pending_business_archives() == []
    db.close()
