"""Independent review regressions; synthetic DBs and fixture transport only."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from telegram_business_plugin.manager import BusinessModeManager
from telegram_business_plugin.state import BusinessStateDB
from .test_context_history import connect


async def noop(**kwargs):
    pass


async def unused_draft(*args):
    raise AssertionError('drafting is not part of these send probes')


def make_draft(db, **kwargs):
    return db.create_telegram_business_draft(connection_id='c1', owner_chat_id='42',
        customer_chat_id='200', customer_msg_id='1', customer_text='hi',
        draft_text='original owner private wording', **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize('edited', [False, True])
@pytest.mark.parametrize('change', ['owner', 'disabled'])
async def test_send_ack_keeps_claimed_owner_scope(tmp_path, edited, change):
    path = tmp_path/'telegram-business'/'state.db'
    db = BusinessStateDB(path)
    connect(db)
    scope = db.business_scope('c1', '200')
    did = make_draft(db)
    started, release = asyncio.Event(), asyncio.Event()
    async def send(**kwargs):
        if kwargs.get('business_connection_id'):
            started.set()
            await release.wait()
        return NS(message_id=88)
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=unused_draft)
    if edited:
        await mgr.handle_callback(data=f'bd:edit:{did}', caller_user_id='42', answer=noop, edit_message_text=noop)
        task = asyncio.create_task(mgr.maybe_handle_edit_capture(owner_chat_id='42',
            caller_user_id='42', text='owner edited private wording'))
    else:
        task = asyncio.create_task(mgr.handle_callback(data=f'bd:send:{did}', caller_user_id='42',
            answer=noop, edit_message_text=noop))
    await asyncio.wait_for(started.wait(), 2)
    db.upsert_telegram_business_connection(connection_id='c1', owner_user_id='43' if change == 'owner' else '42',
        owner_chat_id='43' if change == 'owner' else '42', can_reply=True, is_enabled=change != 'disabled')
    release.set()
    await task
    db.close()
    db = BusinessStateDB(path)  # Immutable claimed scope must be durable, not manager-local.
    row = db.get_telegram_business_draft(did)
    assert row['status'] == ('edited' if edited else 'sent')
    messages = db.pending_business_archives()
    assert len(messages) == 1
    assert json.loads(messages[0]['scope']) == scope
    assert messages[0]['author_id'] == '42'
    assert messages[0]['actor'] == ('owner' if edited else 'approved_ai')
    with pytest.raises(ValueError):
        db.business_history(scope)
    if change == 'owner':
        assert db.business_history(db.business_scope('c1', '200')) == []
    db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('echo_before_ack', [True, False])
@pytest.mark.parametrize('edited', [False, True])
async def test_rebound_owner_echo_never_enters_new_owner_history(tmp_path, echo_before_ack, edited):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    original_scope = db.business_scope('c1', '200')
    did = make_draft(db)
    started, release = asyncio.Event(), asyncio.Event()
    echo = NS(business_connection_id='c1', chat=NS(id=200, type='private'),
        from_user=NS(id=42), sender_business_bot=NS(id=900), message_id=88,
        text='OLD_OWNER_PRIVATE_CANARY' if edited else 'original owner private wording')
    async def send(**kwargs):
        started.set()
        await release.wait()
        return NS(message_id=88)
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=unused_draft)
    if edited:
        await mgr.handle_callback(data=f'bd:edit:{did}', caller_user_id='42', answer=noop, edit_message_text=noop)
        task = asyncio.create_task(mgr.maybe_handle_edit_capture(owner_chat_id='42',
            caller_user_id='42', text=echo.text))
    else:
        task = asyncio.create_task(mgr.handle_callback(data=f'bd:send:{did}', caller_user_id='42',
            answer=noop, edit_message_text=noop))
    await asyncio.wait_for(started.wait(), 2)
    db.upsert_telegram_business_connection(connection_id='c1', owner_user_id='43',
        owner_chat_id='43', can_reply=True, is_enabled=True)
    current_scope = db.business_scope('c1', '200')
    try:
        if echo_before_ack:
            await mgr.handle_business_message(echo)
            assert db.business_history(current_scope) == []
    finally:
        release.set()
        await task
    if not echo_before_ack:
        await mgr.handle_business_message(echo)
    assert db.business_history(current_scope) == []
    assert mgr._debounce_buffers == {}
    rows = db.pending_business_archives()
    assert len(rows) == 1
    assert json.loads(rows[0]['scope']) == original_scope
    assert rows[0]['author_id'] == '42'
    assert rows[0]['text'] == echo.text
    db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('author', [42, 43, 200, 999])
async def test_unknown_bot_echo_after_rebind_never_reaches_memos(tmp_path, monkeypatch, author):
    from importlib import import_module
    from telegram_business_plugin.context import DraftContext
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'memos-rest' / 'tests'))
    from test_routing import RoutingTests
    fixture = RoutingTests()
    fixture.setUp()
    db = BusinessStateDB(fixture.home/'telegram-business'/'state.db')
    try:
        connect(db)
        db.upsert_telegram_business_connection(connection_id='c1', owner_user_id='43',
            owner_chat_id='43', can_reply=True, is_enabled=True)
        module = import_module(fixture.provider.__class__.__module__.rsplit('.', 1)[0] + '.business')
        context = DraftContext(db, fixture.home)
        context.memory = module.BusinessMemory(fixture.provider)
        fixture.router_reply([fixture.fact()])
        mgr = BusinessModeManager(session_db=db, send_message=noop, draft_generator=unused_draft,
            archive_context=context)
        await mgr.handle_business_message(NS(business_connection_id='c1', chat=NS(id=200, type='private'),
            from_user=NS(id=author), sender_business_bot=NS(id=123456), message_id=88,
            text='I am studying sales. OLD_OWNER_PRIVATE_CANARY'))
        context.archive_pending()
        assert db.business_history(db.business_scope('c1', '200')) == []
        assert db.pending_business_archives() == []
        assert fixture.provider.outbox.status()['pending'] == 0
        assert fixture.backend.rows == {}
        assert mgr._debounce_buffers == {}
    finally:
        db.close()
        fixture.tearDown()


@pytest.mark.asyncio
@pytest.mark.parametrize('author,expected_actor', [(43, 'owner'), (200, 'customer'), (42, None), (999, None)])
async def test_private_sender_identity_after_rebind(tmp_path, author, expected_actor):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    db.upsert_telegram_business_connection(connection_id='c1', owner_user_id='43',
        owner_chat_id='43', can_reply=True, is_enabled=True)
    db.set_telegram_business_auto_draft('c1', auto_draft=False)
    mgr = BusinessModeManager(session_db=db, send_message=noop, draft_generator=unused_draft)
    await mgr.handle_business_message(NS(business_connection_id='c1', chat=NS(id=200, type='private'),
        from_user=NS(id=author), sender_business_bot=None, message_id=88, text='manual private wording'))
    rows = db.business_history(db.business_scope('c1', '200'))
    if expected_actor is None:
        assert rows == []
        assert db.pending_business_archives() == []
    else:
        assert len(rows) == 1
        assert rows[0]['author_id'] == str(author)
        assert rows[0]['actor'] == expected_actor
        assert rows[0]['origin'] == ('telegram_owner' if expected_actor == 'owner' else 'telegram_incoming')
    assert mgr._debounce_buffers == {}
    db.close()


@pytest.mark.asyncio
async def test_bot_echo_with_ambiguous_send_claims_is_rejected(tmp_path):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    first = make_draft(db)
    assert db.claim_business_draft(first, '42')
    second = make_draft(db)
    assert db.claim_business_draft(second, '42')
    mgr = BusinessModeManager(session_db=db, send_message=noop, draft_generator=unused_draft)
    await mgr.handle_business_message(NS(business_connection_id='c1', chat=NS(id=200, type='private'),
        from_user=NS(id=42), sender_business_bot=NS(id=900), message_id=88,
        text='original owner private wording'))
    assert db.business_history(db.business_scope('c1', '200')) == []
    assert db.pending_business_archives() == []
    db.close()


def test_two_instances_incoming_cannot_leave_stale_insert_pending(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path/'telegram-business'/'state.db'
    a, b = BusinessStateDB(path), BusinessStateDB(path)
    connect(a)
    scope = a.business_scope('c1', '200')
    version = a.business_version(scope)
    attempted, done = threading.Event(), threading.Event()
    def incoming():
        attempted.set()
        b.record_business_message(scope, '2', 'new incoming', actor='customer',
            author_id='200', origin='telegram_incoming')
        done.set()
    original = a.business_version
    with ThreadPoolExecutor(max_workers=1) as pool:
        def version_with_race(scope):
            result = original(scope)
            pool.submit(incoming)
            assert attempted.wait(2)
            done.wait(.15)  # Pre-fix commits here; fixed write transaction blocks it.
            return result
        monkeypatch.setattr(a, 'business_version', version_with_race)
        make_draft(a, expected_version=version)
    monkeypatch.setattr(a, 'business_version', original)
    assert done.is_set()
    assert a.get_pending_telegram_business_drafts_for_owner('42') == []
    a.close(); b.close()


def test_claim_revalidates_persisted_source_version(tmp_path):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    scope = db.business_scope('c1', '200')
    did = make_draft(db, expected_version=db.business_version(scope))
    db.record_business_message(scope, '2', 'new incoming', actor='customer', author_id='200', origin='telegram_incoming')
    # Reproduce a legacy missed invalidation: a pending row with obsolete sources.
    db._conn.execute("UPDATE business_drafts SET status='pending' WHERE draft_id=?", (did,))
    db._conn.commit()
    assert db.claim_business_draft(did, '42') is None
    db.close()


@pytest.mark.asyncio
async def test_two_managers_stale_discard_cannot_cancel_sending(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path/'telegram-business'/'state.db'
    a, b = BusinessStateDB(path), BusinessStateDB(path)
    connect(a)
    did = make_draft(a)
    started, release = threading.Event(), threading.Event()
    async def send(**kwargs):
        started.set()
        await asyncio.to_thread(release.wait, 3)
        return NS(message_id=88)
    async def forbidden(**kwargs):
        raise AssertionError('discard must not send')
    sender = BusinessModeManager(session_db=a, send_message=send, draft_generator=unused_draft)
    discarder = BusinessModeManager(session_db=b, send_message=forbidden, draft_generator=unused_draft)
    original = b.resolve_telegram_business_draft
    answers, edits = [], []
    async def answer(**kwargs): answers.append(kwargs['text'])
    async def edit(**kwargs): edits.append(kwargs)
    with ThreadPoolExecutor(max_workers=1) as pool:
        tasks = []
        def stale_resolve(*args, **kwargs):
            tasks.append(pool.submit(lambda: asyncio.run(sender.handle_callback(data=f'bd:send:{did}',
                caller_user_id='42', answer=noop, edit_message_text=noop))))
            assert started.wait(2)
            return original(*args, **kwargs)
        monkeypatch.setattr(b, 'resolve_telegram_business_draft', stale_resolve)
        try:
            await discarder.handle_callback(data=f'bd:discard:{did}', caller_user_id='42',
                answer=answer, edit_message_text=edit)
            assert b.get_telegram_business_draft(did)['status'] == 'sending'
            assert '✕ Discarded' not in answers
            assert edits == []
        finally:
            release.set()
        for task in tasks: task.result(timeout=3)
    assert b.get_telegram_business_draft(did)['status'] == 'sent'
    assert len(b.business_history(b.business_scope('c1', '200'))) == 1
    a.close(); b.close()


def test_finalization_without_matching_send_claim_is_rejected(tmp_path):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    did = make_draft(db)
    assert db.resolve_telegram_business_draft(did, status='sent') is None
    claim = db.claim_business_draft(did, '42')
    assert claim is not None
    assert db.resolve_telegram_business_draft(did, status='sent') is None
    assert db.resolve_telegram_business_draft(did, status='sent', send_token='forged') is None
    assert db.resolve_telegram_business_draft(did, status='edited', send_token=claim['send_token']) is None
    assert db.get_telegram_business_draft(did)['status'] == 'sending'
    assert db.resolve_telegram_business_draft(did, status='sent', send_token=claim['send_token']) is not None
    assert db.resolve_telegram_business_draft(did, status='sent', send_token=claim['send_token']) is None
    db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('dated_ack', [True, False])
async def test_delayed_send_ack_does_not_roll_back_observed_edit(tmp_path, dated_ack):
    from datetime import datetime, timezone
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    did = make_draft(db)
    t = lambda seconds: datetime.fromtimestamp(seconds, timezone.utc)
    async def send(**kwargs):
        await mgr.handle_business_message(NS(business_connection_id='c1', chat=NS(id=200, type='private'),
            from_user=NS(id=42), sender_business_bot=NS(id=900), text='newer observed edit',
            message_id=88, date=t(100), edit_date=t(200)), edited=True)
        return NS(message_id=88, date=t(100) if dated_ack else None)
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=unused_draft)
    await mgr.handle_callback(data=f'bd:send:{did}', caller_user_id='42', answer=noop, edit_message_text=noop)
    row = db.business_history(db.business_scope('c1', '200'))[0]
    assert row['text'] == 'newer observed edit'
    assert row['event_at'] == 200
    assert db.get_telegram_business_draft(did)['status'] == 'sent'
    db.close()


def test_two_instances_edit_between_ack_read_and_write_survives(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path/'telegram-business'/'state.db'
    a, b = BusinessStateDB(path), BusinessStateDB(path)
    connect(a)
    scope = a.business_scope('c1', '200')
    a.record_business_message(scope, '88', 'earlier wording', actor='approved_ai', author_id='42',
        origin='telegram_bot_echo', event_at=50)
    claim = a.claim_business_draft(make_draft(a), '42')
    attempted, done = threading.Event(), threading.Event()
    def edit():
        attempted.set()
        b.record_business_message(scope, '88', 'newest edit', actor='owner', author_id='42',
            origin='telegram_edited', event_at=200)
        done.set()
    connection = a._conn
    with ThreadPoolExecutor(max_workers=1) as pool:
        class Cursor:
            def __init__(self, cursor): self.cursor = cursor
            def fetchone(self):
                prior = self.cursor.fetchone()
                pool.submit(edit)
                assert attempted.wait(2)
                done.wait(.15)
                return prior
        class Connection:
            def __getattr__(self, name): return getattr(connection, name)
            def __enter__(self): connection.__enter__(); return self
            def __exit__(self, *args): return connection.__exit__(*args)
            def execute(self, query, *args):
                cursor = connection.execute(query, *args)
                return Cursor(cursor) if query.startswith('SELECT * FROM business_messages WHERE scope_id=') else cursor
        monkeypatch.setattr(a, '_conn', Connection())
        a.record_business_message(scope, '88', claim['draft_text'], actor='approved_ai', author_id='42',
            origin='approved_send', event_at=100, send_claim=claim)
    monkeypatch.setattr(a, '_conn', connection)
    assert done.is_set()
    row = a.business_history(scope)[0]
    assert (row['text'], row['event_at']) == ('newest edit', 200)
    a.close(); b.close()


def test_unchanged_echo_advances_ordering_before_delayed_revision(tmp_path):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    scope = db.business_scope('c1', '200')
    def observe(text, stamp):
        return db.record_business_message(scope, '88', text, actor='owner', author_id='42',
            origin='telegram_edited', event_at=stamp)
    observe('current wording', 100)
    observe('current wording', 300)
    assert not observe('delayed stale edit', 200)
    assert db.business_history(scope)[0]['event_at'] == 300
    db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('echo_before_ack', [True, False])
@pytest.mark.parametrize('dated', [True, False])
async def test_owner_edit_provenance_survives_unchanged_bot_echo(tmp_path, echo_before_ack, dated):
    from datetime import datetime, timezone
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    did = make_draft(db)
    stamp = datetime.fromtimestamp(100, timezone.utc) if dated else None
    echo = NS(business_connection_id='c1', chat=NS(id=200, type='private'), from_user=NS(id=42),
        sender_business_bot=NS(id=900), text='verified owner override', message_id=88, date=stamp)
    async def send(**kwargs):
        if kwargs.get('business_connection_id') and echo_before_ack:
            await mgr.handle_business_message(echo)
        return NS(message_id=88, date=stamp)
    mgr = BusinessModeManager(session_db=db, send_message=send, draft_generator=unused_draft)
    await mgr.handle_callback(data=f'bd:edit:{did}', caller_user_id='42', answer=noop, edit_message_text=noop)
    await mgr.maybe_handle_edit_capture(owner_chat_id='42', caller_user_id='42', text=echo.text)
    if not echo_before_ack:
        await mgr.handle_business_message(echo)
    scope = db.business_scope('c1', '200')
    row = db.business_history(scope)[0]
    assert (row['actor'], row['author_id'], row['origin']) == ('owner', '42', 'owner_edit_send')
    # A genuinely different owner-authored Telegram edit is still a new revision.
    echo.text = 'subsequently edited owner wording'
    echo.sender_business_bot = None
    echo.edit_date = datetime.fromtimestamp(200, timezone.utc)
    await mgr.handle_business_message(echo, edited=True)
    changed = db.business_history(scope)[0]
    assert (changed['text'], changed['actor'], changed['origin']) == (echo.text, 'owner', 'telegram_edited')
    assert changed['revision'] != row['revision']
    db.close()


@pytest.mark.parametrize('blocked_reason', ['disabled', 'changed_owner', 'invalid_scope'])
def test_archive_sweep_reaches_existing_outbox_past_blocked_rows(monkeypatch, blocked_reason):
    from importlib import import_module
    from telegram_business_plugin.context import DraftContext
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'memos-rest' / 'tests'))
    from test_routing import RoutingTests
    fixture = RoutingTests()
    fixture.setUp()
    db = BusinessStateDB(fixture.home/'telegram-business'/'state.db')
    try:
        connect(db)
        blocked = db.business_scope('c1', '200')
        for index in range(105):
            db.record_business_message(blocked, str(index), 'blocked private wording', actor='customer',
                author_id='200', origin='telegram_incoming')
        db.upsert_telegram_business_connection(connection_id='c1',
            owner_user_id='43' if blocked_reason == 'changed_owner' else '42',
            owner_chat_id='43' if blocked_reason == 'changed_owner' else '42', can_reply=True,
            is_enabled=blocked_reason != 'disabled')
        if blocked_reason == 'invalid_scope':
            db._conn.execute("UPDATE business_messages SET scope='{' WHERE scope_id=?", (db._digest(blocked),))
            db._conn.commit()
        connect(db, conn='c2')
        eligible = db.business_scope('c2', '201')
        db.record_business_message(eligible, 'valid', 'I am studying sales.', actor='customer',
            author_id='201', origin='telegram_incoming')
        module = import_module(fixture.provider.__class__.__module__.rsplit('.', 1)[0] + '.business')
        context = DraftContext(db, fixture.home)
        context.memory = module.BusinessMemory(fixture.provider)
        fixture.router_reply([fixture.fact()])
        context.archive_pending()
        assert fixture.provider.outbox.status()['pending'] == 1, 'Eligible source must reach the existing durable Outbox'
        fixture.send()
        assert len(fixture.backend.rows) == 2
        assert all(row['metadata']['info']['hermes_business_scope'] == eligible for row in fixture.backend.rows.values())
        assert all(row['metadata']['info']['hermes_visibility'] == 'business_private' for row in fixture.backend.rows.values())
        assert db._conn.execute('SELECT count(*) FROM business_messages WHERE archive_pending=1').fetchone()[0] == 105
        context.archive_pending()
        assert fixture.provider.outbox.status()['pending'] == 0
    finally:
        db.close()
        fixture.tearDown()
