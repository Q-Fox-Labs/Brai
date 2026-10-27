"""Native PTB callback regressions; synthetic SQLite, no external delivery/memory."""
import asyncio
import importlib
import sys
import threading
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock

import pytest
import telegram_business_plugin as plugin

secret = pytest.importorskip('agent.secret_scope')
from hermes_constants import get_hermes_home, get_hermes_home_override, set_hermes_home_override, reset_hermes_home_override
from hermes_cli.plugins import PluginContext, PluginManifest


@pytest.fixture
def native_ptb():
    # conftest's compatibility stubs must not stand in for the registered SDK handler.
    saved = {k: v for k, v in sys.modules.items() if k == 'telegram' or k.startswith('telegram.')}
    for k in saved:
        del sys.modules[k]
    try:
        ext = importlib.import_module('telegram.ext')
        yield ext
    finally:
        for k in list(sys.modules):
            if k == 'telegram' or k.startswith('telegram.'):
                del sys.modules[k]
        sys.modules.update(saved)


def wiring(tmp_path, monkeypatch, native_ptb):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(secret, '_MULTIPLEX_ACTIVE', True)
    (tmp_path / '.env').write_text('COPILOT_GITHUB_TOKEN=synthetic-own-profile\n')
    (tmp_path / 'telegram-business').mkdir()
    (tmp_path / 'telegram-business/reply-prompt.md').write_text('Synthetic test prompt')
    monkeypatch.setattr(plugin, '_plugin_config', lambda ctx: {'debounce_seconds': 0.01})
    seen, captured = [], {}
    main_thread = threading.get_ident()

    def observe(stage):
        seen.append(stage)
        assert get_hermes_home().resolve() == tmp_path.resolve()
        assert secret.get_secret('COPILOT_GITHUB_TOKEN') == 'synthetic-own-profile'
        from agent.auxiliary_client import _runtime_main_value
        assert _runtime_main_value('api_key') == captured.get('expected_runtime_key', '')
        assert threading.get_ident() != main_thread

    class LocalContext(plugin.DraftContext):
        def _memory(self):
            return None
        def archive_pending(self):
            observe('archive')
            return super().archive_pending()
        def prepare(self, text, scope):
            observe('prepare')
            return super().prepare(text, scope)

    original = plugin.BusinessModeManager
    def make_manager(**kwargs):
        captured.update(kwargs)
        captured['manager'] = original(**kwargs)
        return captured['manager']
    monkeypatch.setattr(plugin, 'DraftContext', LocalContext)
    monkeypatch.setattr(plugin, 'BusinessModeManager', make_manager)
    host = NS(home_path=tmp_path, _platform_handler_factories={})
    ctx = PluginContext(PluginManifest(name='telegram-business'), host)
    def complete(messages, **kwargs):
        observe('completion')
        return NS(text='  Синтетический ответ  ')
    ctx._llm = NS(complete=complete)
    plugin.register(ctx)
    application = MagicMock()
    bot = NS(send_message=AsyncMock(return_value=NS(message_id=100)))
    host._platform_handler_factories['telegram'][0][0](application, NS(_bot=bot))
    handlers = [call.args[0] for call in application.add_handler.call_args_list]
    captured['handlers'] = handlers
    handler = next(h for h in handlers if isinstance(h, native_ptb.MessageHandler) and h.callback.__name__ == '_on_business_message')
    db = captured['session_db']
    db.upsert_telegram_business_connection(connection_id='synthetic', owner_user_id='42', owner_chat_id='42', can_reply=True, is_enabled=True)
    return handler, captured, bot, seen


@pytest.mark.asyncio
@pytest.mark.parametrize('ambient', ['unscoped', 'foreign', 'inherited'])
async def test_native_callback_binds_registered_home_and_debounce_workers(tmp_path, monkeypatch, native_ptb, ambient):
    handler, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    before_home, before_secret = get_hermes_home_override(), secret.current_secret_scope()
    ht = st = rt = None
    foreign = tmp_path / 'other-profile'
    if ambient == 'foreign':
        from agent.auxiliary_client import scoped_runtime_main
        rt = scoped_runtime_main({'provider': 'custom', 'model': 'synthetic', 'api_key': 'must-not-inherit-runtime'})
        rt.__enter__()
        ht = set_hermes_home_override(foreign)
        st = secret.set_secret_scope({'COPILOT_GITHUB_TOKEN': 'must-not-inherit'}, profile_home=str(foreign))
    elif ambient == 'inherited':
        from agent.auxiliary_client import scoped_runtime_main
        captured['expected_runtime_key'] = 'synthetic-own-runtime'
        rt = scoped_runtime_main({'provider': 'custom', 'model': 'synthetic', 'api_key': 'synthetic-own-runtime'})
        rt.__enter__()
        ht = set_hermes_home_override(tmp_path)
        st = secret.set_secret_scope({'COPILOT_GITHUB_TOKEN': 'synthetic-own-profile'}, profile_home=str(tmp_path))
        from gateway import run
        monkeypatch.setattr(run, '_load_profile_secret_scope', MagicMock(side_effect=AssertionError('Must preserve inherited host scope')))
    expected_home, expected_secrets = get_hermes_home_override(), secret.current_secret_scope()
    from agent.auxiliary_client import _runtime_main_value
    expected_runtime_key = _runtime_main_value('api_key')
    try:
        update = NS(business_message=NS(business_connection_id='synthetic', chat=NS(id=200, type='private'), from_user=NS(id=200), text='Привет!', message_id=1), edited_business_message=None)
        await handler.callback(update, NS())
        # Callback reset does not erase the context copied into the debounce task.
        assert get_hermes_home_override() == expected_home
        assert secret.current_secret_scope() is expected_secrets
        assert _runtime_main_value('api_key') == expected_runtime_key
        tasks = list(captured['manager']._debounce_tasks.values())
        assert tasks, 'Native update must schedule drafting despite initially absent/wrong profile scope'
        await asyncio.gather(*tasks)
        assert seen == ['archive', 'prepare', 'archive', 'completion']
        drafts = captured['session_db'].get_pending_telegram_business_drafts_for_owner('42')
        assert len(drafts) == 1 and drafts[0]['draft_text'] == 'Синтетический ответ'
        assert bot.send_message.await_count == 1
        assert bot.send_message.call_args.kwargs['chat_id'] == 42
        assert 'business_connection_id' not in bot.send_message.call_args.kwargs
        assert await asyncio.get_running_loop().run_in_executor(None, secret.current_secret_scope) is None
        assert await asyncio.get_running_loop().run_in_executor(None, _runtime_main_value, 'api_key') == ''
        assert _runtime_main_value('api_key') == expected_runtime_key
    finally:
        if st is not None:
            secret.reset_secret_scope(st)
            reset_hermes_home_override(ht)
        if rt is not None:
            rt.__exit__(None, None, None)
        captured['session_db'].close()
    assert get_hermes_home_override() == before_home
    assert secret.current_secret_scope() is before_secret


@pytest.mark.asyncio
async def test_deferred_draft_entry_binds_without_callback_context(tmp_path, monkeypatch, native_ptb):
    _, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    db = captured['session_db']
    before_home = get_hermes_home_override()
    try:
        result = await captured['draft_generator']('Привет!', db.business_scope('synthetic', '200'))
        assert result == 'Синтетический ответ'
        assert seen == ['prepare', 'archive', 'completion']
        assert secret.current_secret_scope() is None
        assert get_hermes_home_override() == before_home
        bot.send_message.assert_not_awaited()
    finally:
        db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('edited', [False, True])
async def test_native_owner_approval_archive_retains_registered_scope(tmp_path, monkeypatch, native_ptb, edited):
    _, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    db = captured['session_db']
    did = db.create_telegram_business_draft(connection_id='synthetic', owner_chat_id='42', customer_chat_id='200', customer_msg_id='1', customer_text='Synthetic', draft_text='Approved synthetic reply')
    button = next(h for h in captured['handlers'] if isinstance(h, native_ptb.CallbackQueryHandler))
    query = NS(data=f'bd:{"edit" if edited else "send"}:{did}', from_user=NS(id=42), answer=AsyncMock(), edit_message_text=AsyncMock())
    before_home = get_hermes_home_override()
    try:
        await button.callback(NS(callback_query=query), NS())
        if edited:
            owner = next(h for h in captured['handlers'] if isinstance(h, native_ptb.MessageHandler) and h.callback.__name__ == '_on_owner_dm')
            with pytest.raises(native_ptb.ApplicationHandlerStop):
                await owner.callback(NS(message=NS(chat=NS(id=42), from_user=NS(id=42), text='Edited synthetic reply')), NS())
        assert seen == ['archive']
        assert db.get_telegram_business_draft(did)['status'] == ('edited' if edited else 'sent')
        assert secret.current_secret_scope() is None
        assert get_hermes_home_override() == before_home
        assert any(c.kwargs.get('business_connection_id') == 'synthetic' for c in bot.send_message.call_args_list)
    finally:
        db.close()


@pytest.mark.asyncio
async def test_native_generation_failure_logs_type_not_sensitive_message(tmp_path, monkeypatch, native_ptb, caplog):
    handler, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    async def fail(*args):
        raise RuntimeError('PRIVATE CUSTOMER TEXT AND SECRET TOKEN')
    captured['manager']._draft_generator = fail
    try:
        await handler.callback(NS(business_message=NS(business_connection_id='synthetic', chat=NS(id=200, type='private'), from_user=NS(id=200), text='Привет!', message_id=1), edited_business_message=None), NS())
        await asyncio.gather(*captured['manager']._debounce_tasks.values())
        assert 'exception=RuntimeError' in caplog.text
        assert 'stage=draft_generation' in caplog.text
        assert 'PRIVATE CUSTOMER' not in caplog.text
        assert all(record.exc_info is None for record in caplog.records)
        assert 'Не удалось подготовить ответ' in bot.send_message.call_args.kwargs['text']
    finally:
        captured['session_db'].close()


@pytest.mark.asyncio
async def test_native_handler_failure_logs_exception_type_and_resets_scope(tmp_path, monkeypatch, native_ptb, caplog):
    handler, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    def fail():
        raise ValueError('PRIVATE CUSTOMER TEXT AND SECRET TOKEN')
    captured['archive_context'].archive_pending = fail
    try:
        await handler.callback(NS(business_message=NS(business_connection_id='synthetic', chat=NS(id=200, type='private'), from_user=NS(id=200), text='Привет!', message_id=1), edited_business_message=None), NS())
        assert 'stage=business_message exception=ValueError' in caplog.text
        assert 'PRIVATE CUSTOMER' not in caplog.text
        assert all(record.exc_info is None for record in caplog.records)
        assert secret.current_secret_scope() is None
        assert get_hermes_home_override() is None
        bot.send_message.assert_not_awaited()
    finally:
        captured['session_db'].close()


@pytest.mark.asyncio
async def test_forged_profile_refused_before_loading_any_credentials(tmp_path, monkeypatch, native_ptb):
    _, captured, bot, seen = wiring(tmp_path, monkeypatch, native_ptb)
    from gateway import run
    loader = MagicMock(side_effect=AssertionError('Must not hydrate a forged recipient scope'))
    monkeypatch.setattr(run, '_load_profile_secret_scope', loader)
    db = captured['session_db']
    forged = db.business_scope('synthetic', '200') | {'profile': str(tmp_path / 'other-profile')}
    try:
        with pytest.raises(ValueError, match='Business scope mismatch'):
            await captured['draft_generator']('Привет!', forged)
        loader.assert_not_called()
        assert seen == []
        bot.send_message.assert_not_awaited()
    finally:
        db.close()
