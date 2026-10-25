#!/usr/bin/python3
# ABOUTME: Освобождает простаивающие stdio MCP, сохраняя соединение с Codex.
# ABOUTME: Не повторяет tool calls; состояние браузера и Security удерживает консервативно.
"""Прозрачный MCP stdio: отдельный backend на клиента, без общих сессий и секретов на диске."""
import argparse
import asyncio
import contextlib
import json
import os
import signal
import sys
import time
import uuid

LIMIT = 16 * 1024 * 1024
DISCOVERY = {'initialize', 'ping', 'tools/list', 'resources/list',
             'resources/templates/list', 'prompts/list', 'logging/setLevel'}


class Proxy:
    """Проксировать MCP; выгружать только без запросов в обе стороны и сохраняемого состояния."""

    def __init__(self, command, policy, idle, grace=5):
        self.command, self.policy, self.idle, self.grace = command, policy, idle, grace
        self.child = self.reader = None
        self.lock = asyncio.Lock()
        self.pending, self.server_pending = {}, set()
        self.initialize = self.initial_result = self.ready = None
        self.private_id = None
        self.private_method = self.logging = None
        self.initialized = False
        self.sticky = self.default_touched = False
        self.last = time.monotonic()
        self.catalog = {}
        self.stopping = False
        self.done = asyncio.Event()
        self.failed = False

    async def send(self, message):
        """Передать ровно одно JSON-RPC сообщение с обратным давлением stdout."""
        self.output.write(json.dumps(message, separators=(',', ':')).encode() + b'\n')
        await self.output.drain()

    async def write(self, message):
        """Передать сообщение запущенному backend без повторов при ошибке записи."""
        self.child.stdin.write(json.dumps(message, separators=(',', ':')).encode() + b'\n')
        await self.child.stdin.drain()

    async def start(self, replay):
        """Создать личную группу процессов; при пробуждении повторить только MCP handshake."""
        self.child = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=None, start_new_session=True, limit=LIMIT)
        self.reader = asyncio.create_task(self.read_backend(self.child))
        print(f'mcp-idle: started backend pid={self.child.pid}', file=sys.stderr)
        if replay:
            await self.restore_setting('initialize', self.initialize['params'])
            if self.initialized:
                await self.write({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
            if self.logging is not None:
                await self.restore_setting('logging/setLevel', self.logging)

    async def restore_setting(self, method, params):
        """Восстановить handshake/уровень логов; рабочие RPC через этот путь не проходят."""
        self.private_id = 'mcp-idle-' + uuid.uuid4().hex
        self.private_method = method
        self.ready = asyncio.get_running_loop().create_future()
        await self.write({'jsonrpc': '2.0', 'id': self.private_id, 'method': method, 'params': params})
        await asyncio.wait_for(self.ready, 60)

    async def stop(self):
        """Закрыть stdin; после grace завершить только собственную группу backend."""
        if self.child is None:
            return
        self.stopping = True
        child, reader = self.child, self.reader
        child.stdin.close()
        try:
            await asyncio.wait_for(child.wait(), self.grace)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(child.wait(), self.grace)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                await child.wait()
        # AIDEV-NOTE: Runner может выйти раньше своего engine; не оставляем его группу.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGTERM)
        reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reader
        print(f'mcp-idle: released backend pid={child.pid}', file=sys.stderr)
        self.child = self.reader = None
        self.stopping = False

    async def client_message(self, message):
        """Сохранять ID, порядок и уведомления; не выгружать неизвестные stateful операции."""
        async with self.lock:
            method = message.get('method')
            ident = message.get('id')
            if method != 'ping':
                self.last = time.monotonic()
            if method == 'initialize':
                if self.initialize is not None:
                    raise RuntimeError('duplicate initialize')
                self.initialize = message
            if method == 'notifications/initialized':
                self.initialized = True
                if self.child is None:
                    return
            if self.child is None and method == 'ping':
                await self.send({'jsonrpc': '2.0', 'id': ident, 'result': {}})
                return
            key = json.dumps(message.get('params', {}), sort_keys=True)
            if self.child is None and method == 'tools/list' and key in self.catalog:
                await self.send({'jsonrpc': '2.0', 'id': ident, 'result': self.catalog[key]})
                return
            if self.child is None and not method:
                raise RuntimeError('response without backend')
            if self.child is None and method and method.startswith('notifications/'):
                # Нет in-flight запросов: cancel/progress без получателя не создаёт backend.
                return
            if self.child is None:
                await self.start(replay=method != 'initialize')
            if method and ident is not None:
                if len(self.pending) >= 128 or ident in self.pending:
                    raise RuntimeError('request bound or duplicate id')
                self.pending[ident] = message
                if method not in DISCOVERY and self.policy != 'stateless':
                    self.sticky = True
                    if self.policy == 'browser' and method != 'tools/call':
                        self.default_touched = True
                    if self.policy == 'browser' and method == 'tools/call':
                        # AIDEV-NOTE: При параллельных browser calls порядок снимков страниц неизвестен.
                        if sum(x.get('method') == 'tools/call' for x in self.pending.values()) > 1:
                            self.default_touched = True
                        params = message.get('params', {})
                        if params.get('name') not in {'new_page', 'close_page', 'list_pages'}:
                            if params.get('arguments', {}).get('pageId', 1) == 1:
                                self.default_touched = True
            elif method is None:
                self.server_pending.discard(ident)
            await self.write(message)

    async def read_backend(self, child):
        """Передать ответы и server requests; неожиданный обрыв закрывает proxy без replay."""
        try:
            while line := await child.stdout.readline():
                message = json.loads(line)
                method, ident = message.get('method'), message.get('id')
                if not method and ident == self.private_id:
                    if 'error' in message or (self.private_method == 'initialize' and message.get('result') != self.initial_result):
                        self.ready.set_exception(RuntimeError('backend handshake changed'))
                    else:
                        self.ready.set_result(None)
                    self.private_id = None
                    continue
                if method and ident is not None:
                    self.server_pending.add(ident)
                    self.last = time.monotonic()
                elif not method:
                    request = self.pending.pop(ident, {})
                    original = request.get('method')
                    if original != 'ping':
                        self.last = time.monotonic()
                    if original == 'initialize':
                        self.initial_result = message.get('result')
                    elif original == 'logging/setLevel' and 'result' in message:
                        self.logging = request.get('params', {})
                    elif original == 'tools/list' and 'result' in message:
                        key = json.dumps(request.get('params', {}), sort_keys=True)
                        if len(self.catalog) < 32 or key in self.catalog:
                            self.catalog[key] = message['result']
                    elif original == 'tools/call' and self.policy == 'browser':
                        self.browser_response(request, message)
                elif method == 'notifications/tools/list_changed':
                    self.catalog.clear()
                await self.send(message)
            if not self.stopping:
                raise RuntimeError('backend EOF')
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.stopping:
                self.failed = True
                if self.ready and not self.ready.done():
                    self.ready.set_exception(RuntimeError('backend closed'))
                self.done.set()

    def browser_response(self, request, message):
        """Разрешить выгрузку лишь после явного закрытия страниц до нетронутого blank tab."""
        name = request.get('params', {}).get('name')
        result = message.get('result', {})
        pages = result.get('structuredContent', {}).get('pages')
        if name not in {'close_page', 'list_pages'}:
            self.sticky = True
        if name in {'close_page', 'list_pages'} and not result.get('isError') and not self.default_touched:
            if (isinstance(pages, list) and len(pages) == 1 and pages[0].get('id') == 1
                    and pages[0].get('url') == 'about:blank' and not pages[0].get('isolatedContext')):
                self.sticky = False

    async def reap_idle(self):
        """Выгружать idle backend только между сообщениями и после завершения обеих сторон RPC."""
        while True:
            await asyncio.sleep(min(1, self.idle / 4))
            async with self.lock:
                if (self.child and self.initial_result is not None and self.initialized
                        and not self.pending and not self.server_pending and not self.sticky
                        and time.monotonic() - self.last >= self.idle):
                    await self.stop()

    async def run(self):
        """Обслуживать stdin до EOF/сигнала; завершение всегда освобождает принадлежащий backend."""
        loop = asyncio.get_running_loop()
        incoming = asyncio.StreamReader(limit=LIMIT)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(incoming), sys.stdin.buffer)
        transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
        self.output = asyncio.StreamWriter(transport, protocol, None, loop)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            loop.add_signal_handler(sig, self.done.set)

        async def consume():
            try:
                while line := await incoming.readline():
                    await self.client_message(json.loads(line))
            finally:
                self.done.set()

        consumer, reaper = asyncio.create_task(consume()), asyncio.create_task(self.reap_idle())
        reaper.add_done_callback(lambda _: self.done.set())
        try:
            await self.done.wait()
            if consumer.done() and not consumer.cancelled() and consumer.exception():
                self.failed = True
            if reaper.done() and not reaper.cancelled() and reaper.exception():
                self.failed = True
        finally:
            consumer.cancel()
            reaper.cancel()
            await asyncio.gather(consumer, reaper, return_exceptions=True)
            await self.stop()
        return int(self.failed)


def main():
    """Запустить stdio proxy; policy stateful освобождает backend только до первого рабочего RPC."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', choices=['stateless', 'stateful', 'browser'], required=True)
    parser.add_argument('--idle-seconds', type=float, default=60)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.idle_seconds <= 0:
        parser.error('positive idle time and backend command are required')
    return asyncio.run(Proxy(command, args.policy, args.idle_seconds).run())


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('mcp-idle: transport failed; operation was not retried', file=sys.stderr)
        sys.exit(1)
