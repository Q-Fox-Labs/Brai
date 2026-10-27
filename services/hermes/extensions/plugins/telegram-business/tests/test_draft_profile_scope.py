"""Regression: drafting workers must retain the host's routed profile scope.

Run with the Hermes source on PYTHONPATH for the host integration seam.
No Telegram or provider network calls are made by this regression.
"""
from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import telegram_business_plugin as plugin

scope = pytest.importorskip("agent.secret_scope")
from hermes_constants import (
    get_hermes_home, reset_hermes_home_override, set_hermes_home_override,
)
from hermes_cli.plugins import PluginContext, PluginManifest


@pytest.mark.asyncio
async def test_draft_retains_routed_profile_scope(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Process-wide flag intentionally remains active inside the executor too.
    monkeypatch.setattr(scope, "_MULTIPLEX_ACTIVE", True)
    captured = {}

    def capture_manager(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    monkeypatch.setattr(plugin, "BusinessModeManager", capture_manager)
    manager = SimpleNamespace(_platform_handler_factories={})
    ctx = PluginContext(PluginManifest(name="telegram-business"), manager)
    event_loop_thread = threading.get_ident()

    def complete(messages, **kwargs):
        # Real fail-closed host reader reproduces the reported token-name error
        # if the worker lost its context. No actual credential is needed.
        assert scope.get_secret("COPILOT_GITHUB_TOKEN") is None
        assert scope.current_secret_scope() == {}
        assert get_hermes_home() == tmp_path
        assert threading.get_ident() != event_loop_thread
        assert messages[-1]['role'] == 'user'
        assert json.loads(messages[-1]['content'])['current_message'] == 'Привет!'
        assert kwargs == dict(max_tokens=700, timeout=60.0,
                              purpose="telegram-business draft")
        return SimpleNamespace(text="  Привет! Как дела?  ")

    ctx._llm = SimpleNamespace(complete=complete)
    plugin.register(ctx)
    factory = manager._platform_handler_factories["telegram"][0][0]
    bot = MagicMock()
    factory(MagicMock(), SimpleNamespace(_bot=bot))
    (tmp_path / 'telegram-business' / 'reply-prompt.md').write_text('Draft only from scoped supplied data.')
    db = captured['session_db']
    db.upsert_telegram_business_connection(connection_id='test',owner_user_id='42',owner_chat_id='42',can_reply=True,is_enabled=True)
    recipient_scope = db.business_scope('test','123')
    home_token = set_hermes_home_override(tmp_path)
    secret_token = scope.set_secret_scope({}, profile_home=str(tmp_path))
    try:
        assert await captured["draft_generator"]("Привет!", recipient_scope) == "Привет! Как дела?"
    finally:
        scope.reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
    bot.send_message.assert_not_called()
    assert scope.current_secret_scope() is None
    # Pool reuse must not leak the completed draft's scope into another job.
    assert await asyncio.get_running_loop().run_in_executor(
        None, scope.current_secret_scope
    ) is None
