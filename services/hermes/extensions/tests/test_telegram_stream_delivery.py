# ABOUTME: Проверяет потоковую доставку Telegram без сети.
# ABOUTME: Конструктор адаптера изолирован от bootstrap внешнего файлового модуля.
"""Contract: Telegram finalization replaces its preview even after a bounded flood wait."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch
import unittest

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import SendResult

# Optional isolated candidate, never a profile or a live adapter.
for name, relative in [('plugins.platforms.telegram.adapter', 'plugins/platforms/telegram/adapter.py'),
                       ('gateway.run_turn', 'gateway/run_turn.py')]:
    if os.environ.get('STREAM_DELIVERY_CANDIDATE'):
        importlib.import_module(name)
        spec = importlib.util.spec_from_file_location(name, Path(os.environ['STREAM_DELIVERY_CANDIDATE']) / relative)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        parent, attr = name.rsplit(".", 1)
        setattr(importlib.import_module(parent), attr, module)
from plugins.platforms.telegram import adapter as telegram
from gateway.run_turn import GatewayTurnMixin
from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig


class RetryAfter(Exception):
    def __init__(self, seconds):
        self.retry_after = seconds
        super().__init__(f"Flood control exceeded. Retry in {seconds} seconds")


BadRequest = ValueError


class StreamDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def patch(self, target, name, value):
        guard = patch.object(target, name, value)
        guard.start()
        self.addCleanup(guard.stop)

    def adapter(self):
        self.patch(telegram, 'ParseMode', NS(MARKDOWN_V2="MarkdownV2"))
        with patch.dict(sys.modules, {'brai_files': NS(install_adapter=lambda _: None)}):
            value = telegram.TelegramAdapter(PlatformConfig(enabled=True))
        value._bot = NS(edit_message_text=AsyncMock())
        self.patch(value, '_rich_eligible', lambda _: False)
        return value


    async def test_rate_limited_final_replaces_preview_without_a_second_message(self):
        value = self.adapter()
        self.patch(value, '_chat_outbound_slot_remaining', lambda _: 0)
        messages = {}
        sent = asyncio.Event()
        final = '**Итог**\nВсе пункты проверены.'
        waits = []
        async def send(chat_id, content, **kwargs):
            mid = str(101 + len(messages))
            messages[mid] = value.format_message(content)
            sent.set()
            return SendResult(success=True, message_id=mid)
        async def edit(**kwargs):
            if 'Итог' in kwargs['text'] and not waits:
                raise RetryAfter(39)
            messages[str(kwargs['message_id'])] = kwargs['text']
        value.send = AsyncMock(side_effect=send)
        value._bot.edit_message_text.side_effect = edit
        real_sleep = asyncio.sleep
        async def sleep(seconds):
            if seconds == 39:
                waits.append(seconds)
                await real_sleep(0)
            else:
                await real_sleep(seconds)
        self.patch(telegram.asyncio, 'sleep', sleep)
        consumer = GatewayStreamConsumer(value, '-100001', StreamConsumerConfig(transport='edit'))
        consumer.on_delta('**Предварительный ответ**')
        task = asyncio.create_task(consumer.run())
        await asyncio.wait_for(sent.wait(), timeout=3)
        consumer.finish(final)
        await asyncio.wait_for(task, timeout=3)
        assert list(messages) == ['101']
        assert messages['101'] == value.format_message(final)
        assert waits == [39]
        assert consumer.final_content_delivered
        assert consumer.delivered_final_matches(final) is True


    async def test_stream_preview_uses_formatted_entities(self):
        value = self.adapter()
        self.patch(value, '_chat_outbound_slot_remaining', lambda _: 0)
        content = '**Заголовок**\nТекст'
        result = await value.edit_message('-100001', '101', content)
        assert result.success
        call = value._bot.edit_message_text.call_args.kwargs
        assert call['parse_mode'] == telegram.ParseMode.MARKDOWN_V2
        assert call['text'] == value.format_message(content)


    async def test_flood_refusal_does_not_retry_as_plain_text(self):
        value = self.adapter()
        value._bot.edit_message_text.side_effect = RetryAfter(3600)
        sleep = AsyncMock()
        self.patch(telegram.asyncio, 'sleep', sleep)
        result = await value.edit_message('-100001', '101', '**Итог**', finalize=True)
        assert not result.success
        assert result.retry_after == 3600
        value._bot.edit_message_text.assert_awaited_once()
        sleep.assert_not_awaited()


    async def test_parse_error_keeps_plain_text_fallback(self):
        value = self.adapter()
        value._bot.edit_message_text.side_effect = [BadRequest("Can't parse entities"), None]
        result = await value.edit_message('-100001', '101', '**Итог**', finalize=True)
        assert result.success
        assert len(value._bot.edit_message_text.await_args_list) == 2
        assert 'parse_mode' not in value._bot.edit_message_text.call_args.kwargs
        assert '**' not in value._bot.edit_message_text.call_args.kwargs['text']


    async def test_shared_group_budget_paces_stream_and_sends(self):
        value = self.adapter()
        value._hold_chat_outbound_slot('-100001')
        assert value._chat_outbound_slot_remaining('-100001') > 3
        value._hold_chat_outbound_slot('100001')
        assert 0 < value._chat_outbound_slot_remaining('100001') <= 1


    async def test_gateway_cleanup_allows_telegram_finalize_to_wait(self):
        runner = GatewayTurnMixin()
        runner._draining = False
        runner._await_stream_task = AsyncMock()
        tracking = asyncio.create_task(asyncio.sleep(5))
        ctx = NS(stream_consumer_holder=[object()], session_key=None,
                 source=NS(platform=Platform.TELEGRAM), streaming_tts_consumer_holder=[None])
        stream_task = object()
        await runner._run_agent_cleanup_turn_tasks(
            ctx, progress_task=None, log_task=None, interrupt_monitor=None,
            _notify_task=None, tracking_task=tracking, stream_task=stream_task)
        runner._await_stream_task.assert_awaited_once_with(stream_task, timeout=125.0)

if __name__ == "__main__":
    unittest.main()
