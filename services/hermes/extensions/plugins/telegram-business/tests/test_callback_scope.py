import pytest
from telegram_business_plugin.state import BusinessStateDB
from telegram_business_plugin.manager import BusinessModeManager
from .test_context_history import connect


@pytest.mark.asyncio
async def test_owner_change_cannot_render_old_private_draft_via_discard(tmp_path):
    db=BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    did=db.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text='OLD OWNER CUSTOMER PRIVATE',draft_text='reply')
    connect(db,owner='43')
    async def no_send(**kw): raise AssertionError('no send')
    async def draft(*args): return 'unused'
    edits=[]
    async def answer(**kw): pass
    async def edit(**kw): edits.append(kw)
    mgr=BusinessModeManager(session_db=db,send_message=no_send,draft_generator=draft)
    await mgr.handle_callback(data=f'bd:discard:{did}',caller_user_id='43',answer=answer,edit_message_text=edit)
    assert edits==[], 'Every action, not only sending, must validate the original owner scope'
    assert db.get_telegram_business_draft(did)['status']=='pending'
    db.close()
