import pytest
from types import SimpleNamespace as NS
from telegram_business_plugin.state import BusinessStateDB
from telegram_business_plugin.manager import BusinessModeManager
from .test_context_history import connect


@pytest.mark.asyncio
async def test_generation_errors_do_not_expose_content(tmp_path, caplog):
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    sent=[]
    async def send(**kw):
        sent.append(kw)
        return NS(message_id=9)
    async def draft(*args): raise RuntimeError('API_SECRET_ERROR')
    mgr=BusinessModeManager(session_db=db,send_message=send,draft_generator=draft,debounce_seconds=0)
    await mgr.handle_business_message(NS(business_connection_id='c1',chat=NS(id=200,type='private'),
        from_user=NS(id=200),message_id=1,text='CUSTOMER_PRIVATE_TEXT'))
    assert 'API_SECRET_ERROR' not in caplog.text
    assert 'CUSTOMER_PRIVATE_TEXT' not in repr(sent)
    assert 'API_SECRET_ERROR' not in repr(sent)
    db.close()
