from datetime import datetime, timezone
from types import SimpleNamespace as NS
import pytest
from telegram_business_plugin.state import BusinessStateDB
from telegram_business_plugin.manager import BusinessModeManager
from .test_context_history import connect


@pytest.mark.asyncio
async def test_edits_invalidate_reserved_approval_and_ignore_old_events(tmp_path):
    db=BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    scope=db.business_scope('c1','200')
    async def noop(**kw): pass
    async def draft(*args): return 'reply'
    mgr=BusinessModeManager(session_db=db,send_message=noop,draft_generator=draft,debounce_seconds=0)
    did=db.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text='old',draft_text='reply')
    await mgr.handle_callback(data=f'bd:edit:{did}',caller_user_id='42',answer=noop,edit_message_text=noop)
    def msg(text,stamp):
        return NS(business_connection_id='c1',chat=NS(id=200,type='private'),from_user=NS(id=200),
            message_id=1,text=text,edit_date=datetime.fromtimestamp(stamp,timezone.utc))
    db.set_telegram_business_auto_draft('c1',auto_draft=False)
    await mgr.handle_business_message(msg('updated fact',20),edited=True)
    await mgr.handle_business_message(msg('old fact',10),edited=True)
    assert db.get_telegram_business_draft(did)['status']=='superseded'
    rows=db.business_history(scope)
    assert [(r['text'],r['origin']) for r in rows]==[('updated fact','telegram_edited')]
    db.delete_business_messages(scope,['1'])
    await mgr.handle_business_message(msg('updated fact',20),edited=True)
    assert db.business_history(scope)==[]
    db.close()
