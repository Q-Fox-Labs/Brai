# ABOUTME: Проверяет сохранение активного ответа после завершения отправки запроса.
# ABOUTME: Использует только потоки в памяти, без модели и пользовательских данных.
import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from identity import egress, network


def stream_writer():
    """Создать writer без сокета с наблюдаемым закрытием и передачей байтов."""
    return Mock(drain=AsyncMock(), wait_closed=AsyncMock())


class RelayLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_progress_survives_silent_request_direction(self):
        """Пустое направление запроса не обрывает продолжающийся ответ."""
        request, response = asyncio.StreamReader(), asyncio.StreamReader()
        client, upstream = stream_writer(), stream_writer()
        request.feed_data(b'complete request')
        with patch.object(network, 'IDLE_TIMEOUT', 0.04), patch.object(
            network.asyncio, 'open_unix_connection',
            AsyncMock(return_value=(response, upstream)),
        ):
            relay = asyncio.create_task(network._relay(request, client, 'unused'))
            try:
                for _ in range(8):
                    response.feed_data(b'response progress')
                    await asyncio.sleep(0.015)
                self.assertFalse(relay.done(), 'active response was interrupted by request silence')
                self.assertFalse(client.close.called)
            finally:
                request.feed_eof()
                response.feed_eof()
                await asyncio.wait_for(relay, 1)

    async def test_connect_activity_in_one_direction_keeps_tunnel_open(self):
        request, response = asyncio.StreamReader(), asyncio.StreamReader()
        client, upstream = stream_writer(), stream_writer()
        with patch.object(network, 'IDLE_TIMEOUT', 0.04):
            transfer = asyncio.create_task(egress._duplex(request, client, response, upstream))
            try:
                for _ in range(8):
                    response.feed_data(b'progress')
                    await asyncio.sleep(0.015)
                self.assertFalse(transfer.done())
            finally:
                request.feed_eof()
                response.feed_eof()
                await asyncio.wait_for(transfer, 1)

    async def test_half_close_keeps_reverse_direction_open(self):
        request, response = asyncio.StreamReader(), asyncio.StreamReader()
        client, upstream = stream_writer(), stream_writer()
        transfer = asyncio.create_task(network._duplex(request, client, response, upstream))
        request.feed_eof()
        await asyncio.sleep(0.01)
        upstream.write_eof.assert_called_once()
        self.assertFalse(transfer.done())
        response.feed_data(b'final response')
        response.feed_eof()
        await asyncio.wait_for(transfer, 1)
        client.write.assert_called_once_with(b'final response')
        client.write_eof.assert_called_once()

    async def test_idle_deadline_and_cancellation_release_copies(self):
        request, response = asyncio.StreamReader(), asyncio.StreamReader()
        with patch.object(network, 'IDLE_TIMEOUT', 0.03):
            with self.assertRaises(network.IdleTimeout):
                await network._duplex(request, stream_writer(), response, stream_writer())
        transfer = asyncio.create_task(network._duplex(request, stream_writer(), response, stream_writer()))
        await asyncio.sleep(0.01)
        transfer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await transfer
        self.assertIsNone(request._waiter)
        self.assertIsNone(response._waiter)

    async def test_slow_writer_is_bounded(self):
        request, response = asyncio.StreamReader(), asyncio.StreamReader()
        client, upstream = stream_writer(), stream_writer()
        async def blocked():
            await asyncio.sleep(10)
        upstream.drain = AsyncMock(side_effect=blocked)
        request.feed_data(b'blocked')
        with patch.object(network, 'IDLE_TIMEOUT', 1), patch.object(network, 'DRAIN_TIMEOUT', 0.03):
            with self.assertRaises(network.DrainTimeout):
                await network._duplex(request, client, response, upstream)

    async def test_egress_waits_for_delayed_first_byte_and_gaps(self):
        response = asyncio.StreamReader()
        client = stream_writer()
        with patch.object(egress, 'IDLE_TIMEOUT', 0.12):
            transfer = asyncio.create_task(egress._pipe(response, client))
            await asyncio.sleep(0.05)
            response.feed_data(b'first')
            await asyncio.sleep(0.05)
            response.feed_data(b'last')
            response.feed_eof()
            await asyncio.wait_for(transfer, 1)
        self.assertEqual([call.args[0] for call in client.write.call_args_list], [b'first', b'last'])

    async def test_close_logs_distinguish_reasons_without_payload(self):
        for error, expected in [(network.IdleTimeout(), 'idle'),
                                (network.DrainTimeout(), 'drain'),
                                (asyncio.CancelledError(), 'cancel')]:
            reader, response = asyncio.StreamReader(), asyncio.StreamReader()
            reader.feed_data(b'fixture-secret-payload')
            client, upstream = stream_writer(), stream_writer()
            with patch.object(network.asyncio, 'open_unix_connection',
                              AsyncMock(return_value=(response, upstream))), patch.object(
                    network, '_duplex', AsyncMock(side_effect=error)), self.assertLogs(
                    network.LOGGER, level='INFO') as captured:
                if expected == 'cancel':
                    with self.assertRaises(asyncio.CancelledError):
                        await network._relay(reader, client, 'fixture-secret-path')
                else:
                    await network._relay(reader, client, 'fixture-secret-path')
            self.assertIn('reason=' + expected, captured.output[0])
            self.assertIn('stage=transfer', captured.output[0])
            self.assertNotIn('fixture-secret', captured.output[0])


if __name__ == '__main__':
    unittest.main()
