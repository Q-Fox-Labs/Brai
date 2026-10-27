"""Wiring tests: register(ctx) queues a factory; the factory adds handlers."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import telegram_business_plugin as plugin


class _FakeCtx:
    def __init__(self):
        self.factories = []
        self.llm = MagicMock()

    def register_telegram_handler(self, factory):
        assert callable(factory)
        self.factories.append(factory)


def test_register_queues_one_factory():
    ctx = _FakeCtx()
    plugin.register(ctx)
    assert len(ctx.factories) == 1


def test_factory_wires_handlers(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    ctx = _FakeCtx()
    plugin.register(ctx)
    factory = ctx.factories[0]

    application = MagicMock()
    adapter = SimpleNamespace(_bot=MagicMock(), name="telegram")

    factory(application, adapter)

    # 7 handlers: connection, deletion, 2x business message, bd: callback,
    # /biz command, owner-DM edit capture.
    assert application.add_handler.call_count == 7

    # The edit-capture handler must be registered in group -1 so it runs
    # before (and can yield to) the core adapter's text handler.
    groups = [
        kwargs.get("group")
        for args, kwargs in application.add_handler.call_args_list
    ]
    assert -1 in groups

    # Plugin state DB created under HERMES_HOME, not the core state.db.
    assert (tmp_path / "telegram-business" / "state.db").exists()


@pytest.mark.asyncio
async def test_cached_manager_sends_through_reconnected_adapter(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    managers = []
    manager_class = plugin.BusinessModeManager

    def capture_manager(**kwargs):
        manager = manager_class(**kwargs)
        managers.append(manager)
        return manager

    monkeypatch.setattr(plugin, "BusinessModeManager", capture_manager)
    ctx = _FakeCtx()
    plugin.register(ctx)
    factory = ctx.factories[0]
    old_bot = SimpleNamespace(send_message=AsyncMock())
    old_adapter = SimpleNamespace(_bot=old_bot)
    factory(MagicMock(), old_adapter)
    manager = managers[0]
    await manager._send(chat_id=123, text="before reconnect")
    old_bot.send_message.assert_awaited_once()

    # The gateway rebuilds the adapter after a fatal network error.
    old_adapter._bot = None
    new_bot = SimpleNamespace(send_message=AsyncMock())
    new_adapter = SimpleNamespace(_bot=new_bot)
    factory(MagicMock(), new_adapter)
    assert managers == [manager]  # keep pending drafts and edit captures
    await manager._send(chat_id=123, text="after reconnect")
    new_bot.send_message.assert_awaited_once_with(
        chat_id=123, text="after reconnect", parse_mode=None,
        disable_web_page_preview=True,
    )
    old_bot.send_message.assert_awaited_once()

    # Reinitializing the same adapter must also use its current bot.
    replacement_bot = SimpleNamespace(send_message=AsyncMock())
    new_adapter._bot = replacement_bot
    await manager._send(chat_id=123, text="after bot replacement")
    replacement_bot.send_message.assert_awaited_once()
    new_adapter._bot = None
    with pytest.raises(RuntimeError, match="not connected"):
        await manager._send(chat_id=123, text="while disconnected")
