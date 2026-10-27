from types import SimpleNamespace as NS
import pytest
from telegram_business_plugin.state import BusinessStateDB
from telegram_business_plugin.manager import BusinessModeManager
from .test_context_history import connect


@pytest.mark.asyncio
async def test_bot_echo_before_send_ack_is_not_owner_style(tmp_path):
    db=BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    async def no_draft(*args): raise AssertionError('outgoing echo cannot draft')
    msg=NS(business_connection_id='c1',chat=NS(id=200,type='private'),from_user=NS(id=42),
        sender_business_bot=NS(id=900),text='AI sent wording',message_id=88)
    async def send(**kw):
        await mgr.handle_business_message(msg)
        return NS(message_id=88)
    async def noop(**kw): pass
    mgr=BusinessModeManager(session_db=db,send_message=send,draft_generator=no_draft,debounce_seconds=0)
    did=db.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text='hi',draft_text=msg.text)
    await mgr.handle_callback(data=f'bd:send:{did}',caller_user_id='42',answer=noop,edit_message_text=noop)
    scope=db.business_scope('c1','200')
    rows=db.business_history(scope)
    assert len(rows)==1 and rows[0]['actor']=='approved_ai'
    assert not db.record_business_message(scope,'88','AI sent wording',actor='approved_ai',author_id='42',origin='approved_send')
    await mgr.handle_business_message(msg)  # Known identity after acknowledgement.
    assert db.business_history(scope) == rows
    msg.message_id = 89  # Same wording cannot authenticate a new bot message.
    await mgr.handle_business_message(msg)
    assert db.business_history(scope) == rows
    db.close()


def test_state_drafts_redact_recognized_secrets(tmp_path):
    db=BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    text='Bearer sk-'+'a'*32
    did=db.create_telegram_business_draft(connection_id='c1',owner_chat_id='42',customer_chat_id='200',
        customer_msg_id='1',customer_text=text,draft_text=text)
    row=db.get_telegram_business_draft(did)
    assert text not in row['customer_text'] and text not in row['draft_text']
    db.close()
