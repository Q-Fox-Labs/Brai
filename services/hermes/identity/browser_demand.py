# ABOUTME: Передаёт личный CDP в Chrome, запущенный на время работы Hermes.
# ABOUTME: Проверка TCP и разговоры без браузера оставляют Chrome выключенным.
import asyncio
from contextlib import suppress
import json
import logging
import re

from .network import CONNECT_TIMEOUT, MAX_CONNECTIONS, _duplex, close_relay
from .tool_client import broker_call


LOGGER = logging.getLogger(__name__)
CHROME_PORT = 19365
CDP_PORT = 19364
BROWSER_IDLE_SECONDS = 10 * 60


class BrowserDemand:
    def __init__(self, working):
        self.working = working
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(MAX_CONNECTIONS)
        self.started = False
        self.idle_timer = None
        self.busy_check = None
        self.cleanup = None
        self.server = None
        self.closing = False

    async def open(self):
        self.server = await asyncio.start_server(self._serve, '127.0.0.1', CDP_PORT)

    def task_ended(self):
        if (not self.closing and self.started and self.idle_timer is None
                and (self.cleanup is None or self.cleanup.done())):
            loop = asyncio.get_running_loop()
            if self.working():
                # Native cron and background jobs may end outside dispatch callbacks.
                if self.busy_check is None:
                    self.busy_check = loop.call_later(1, self._check_work)
            else:
                self._cancel_busy_check()
                self.idle_timer = loop.call_later(BROWSER_IDLE_SECONDS, self._idle_elapsed)

    def _check_work(self):
        self.busy_check = None
        self.task_ended()

    def _idle_elapsed(self):
        self.idle_timer = None
        if self.working():
            self.task_ended()
        else:
            self.cleanup = asyncio.create_task(self._stop_if_idle())

    async def close(self):
        self.closing = True
        self._cancel_idle()
        self._cancel_busy_check()
        await close_relay(self.server)
        if self.cleanup is not None:
            await self.cleanup
        # During a systemd stop the unit dependency also stops Chrome.

    def _cancel_idle(self):
        if self.idle_timer is not None:
            self.idle_timer.cancel()
            self.idle_timer = None

    def _cancel_busy_check(self):
        if self.busy_check is not None:
            self.busy_check.cancel()
            self.busy_check = None

    async def _command(self, action):
        await asyncio.to_thread(broker_call, 'browser.lifecycle', {'action': action})

    async def _connect(self):
        async with self.lock:
            if not self.working():
                raise ConnectionError('No Hermes task owns this browser request')
            self._cancel_idle()
            self.task_ended()
            if self.started:
                try:
                    return await asyncio.open_connection('127.0.0.1', CHROME_PORT)
                except OSError:
                    pass
            self.started = True
            self.task_ended()
            await self._command('start')
            async with asyncio.timeout(30):
                while True:
                    try:
                        return await asyncio.open_connection('127.0.0.1', CHROME_PORT)
                    except OSError:
                        await asyncio.sleep(.1)

    async def _serve(self, reader, writer):
        upstream = None
        try:
            if self.slots.locked():
                return
            async with self.slots:
                first = await asyncio.wait_for(reader.read(1), CONNECT_TIMEOUT)
                if first:
                    source, upstream = await self._connect()
                    upstream.write(first)
                    await upstream.drain()
                    await _duplex(reader, writer, source, upstream)
        except (OSError, TimeoutError):
            pass
        finally:
            for stream in (writer, upstream):
                if stream is not None:
                    stream.close()
                    with suppress(OSError):
                        await stream.wait_closed()
            self.task_ended()

    async def _stop_if_idle(self):
        async with self.lock:
            if not self.started:
                return
            if self.working():
                self.cleanup = None
                self.task_ended()
                return
            try:
                await self._graceful_exit()
            except Exception as error:
                LOGGER.warning('HERMES_BROWSER_GRACEFUL_EXIT_FAILED type=%s', type(error).__name__)
            try:
                await self._command('stop')
            except (OSError, TimeoutError) as error:
                LOGGER.error('HERMES_BROWSER_STOP_FAILED type=%s', type(error).__name__)
                self.cleanup = None
                self.task_ended()
            else:
                self.started = False

    @staticmethod
    async def _graceful_exit():
        import websockets
        async with asyncio.timeout(CONNECT_TIMEOUT):
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', CHROME_PORT)
            except ConnectionRefusedError:
                return
            try:
                writer.write(b'GET /json/version HTTP/1.0\r\nHost: localhost\r\n\r\n')
                await writer.drain()
                headers, body = (await reader.read()).split(b'\r\n\r\n', 1)
                if not headers.startswith(b'HTTP/1.0 200 ') and not headers.startswith(b'HTTP/1.1 200 '):
                    raise ValueError('Chrome version endpoint unavailable')
                url = json.loads(body)['webSocketDebuggerUrl']
            finally:
                writer.close()
                await writer.wait_closed()
            endpoint = re.fullmatch(r'ws://(?:localhost|127\.0\.0\.1)(?::[0-9]+)?(/devtools/browser/[0-9a-f-]+)', url)
            if endpoint is None:
                raise ValueError('Invalid Chrome debugger endpoint')
            async with websockets.connect('ws://127.0.0.1:' + str(CHROME_PORT) + endpoint[1], proxy=None) as ws:
                await ws.send('{"id":1,"method":"Browser.close"}')
                await ws.wait_closed()
