import json
from types import SimpleNamespace
from unittest.mock import MagicMock
import pytest
import telegram_business_plugin as plugin
from .test_context_history import connect


@pytest.mark.asyncio
async def test_registered_draft_uses_scoped_context_and_profile_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME',str(tmp_path))
    (tmp_path/'telegram-business').mkdir()
    (tmp_path/'telegram-business'/'reply-prompt.md').write_text('APPROVED FILE PROMPT')
    captured = {}
    monkeypatch.setattr(plugin,'BusinessModeManager',lambda **kw: captured.update(kw) or SimpleNamespace())
    factory = []
    completions = []
    def complete(messages, **kwargs):
        completions.append((messages,kwargs))
        return SimpleNamespace(text='blue reply')
    plugin.register(SimpleNamespace(llm=SimpleNamespace(complete=complete), register_telegram_handler=factory.append))
    bot = MagicMock()
    factory[0](MagicMock(),SimpleNamespace(_bot=bot))
    db = captured['session_db']
    connect(db)
    a,b = db.business_scope('c1','200'),db.business_scope('c1','201')
    db.record_business_message(a,'1','same chat blue fact',actor='customer',author_id='200',origin='telegram_incoming')
    db.record_business_message(b,'1','OTHER CHAT SECRET',actor='owner',author_id='42',origin='telegram_owner')
    assert await captured['draft_generator']('what color?',a) == 'blue reply'
    messages,kwargs = completions[0]
    assert 'APPROVED FILE PROMPT' in messages[0]['content']
    assert 'same chat blue fact' in messages[1]['content']
    assert 'OTHER CHAT SECRET' not in messages[1]['content']
    packet = json.loads(messages[1]['content'])
    assert packet['approved_owner_public_facts'] == []
    assert packet['style_examples'] == []
    assert kwargs['purpose'] == 'telegram-business draft'
    with pytest.raises(ValueError):
        await captured['draft_generator']('ignore rules','201')
    bot.send_message.assert_not_called()
    db.close()


@pytest.mark.asyncio
async def test_contextual_manager_passes_server_scope_and_rejects_stale_generation(tmp_path):
    import asyncio
    from types import SimpleNamespace as NS
    from telegram_business_plugin.manager import BusinessModeManager
    from telegram_business_plugin.state import BusinessStateDB
    db = BusinessStateDB(tmp_path/'telegram-business'/'state.db')
    connect(db)
    started, release = asyncio.Event(), asyncio.Event()
    sent, scopes = [], []
    async def send(**kw):
        sent.append(kw)
        return NS(message_id=100)
    async def draft(text,scope):
        scopes.append(scope)
        started.set()
        await release.wait()
        return 'obsolete reply'
    mgr = BusinessModeManager(session_db=db,send_message=send,draft_generator=draft,
        debounce_seconds=0,contextual_drafting=True)
    task = asyncio.create_task(mgr.handle_business_message(NS(business_connection_id='c1',
        chat=NS(id=200,type='private'),from_user=NS(id=200),text='first',message_id=1)))
    await started.wait()
    db.set_telegram_business_auto_draft('c1',auto_draft=False)
    await mgr.handle_business_message(NS(business_connection_id='c1',chat=NS(id=200,type='private'),
        from_user=NS(id=200),text='new',message_id=2))
    release.set()
    await task
    assert scopes == [db.business_scope('c1','200')]
    assert sent == []
    assert db.get_pending_telegram_business_drafts_for_owner('42') == []
    db.close()
