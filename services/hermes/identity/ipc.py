# ABOUTME: Двусторонний JSON-RPC поверх локального сокета процессов Hermes.
# ABOUTME: Идентичность проверяется до создания канала; повторы операций не выполняются.
"""Ограниченный канал, допускающий встречные вызовы без блокировки чтения."""
import asyncio
import json
import socket
import struct
import uuid

MAX_FRAME = 1024 * 1024
MAX_INFLIGHT = 64

# AIDEV-NOTE: Через RPC передаём категории; текст исключения может содержать секреты.
_FAILURE_REASONS = frozenset((
    'FORBIDDEN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'OUTCOME_UNKNOWN',
    'UPSTREAM_UNAVAILABLE', 'INVALID_UPSTREAM_RESPONSE', 'OWNER_MISMATCH', 'OVERLOADED',
    'CANCELLED', 'NOT_FOUND', 'CONFLICT', 'REQUEST_TOO_LARGE',
    'RESULT_TOO_LARGE', 'UNAVAILABLE', 'INTERNAL', 'MODEL_NOT_FOUND',
    'MODEL_NOT_INSTALLED', 'UNSUPPORTED_OPERATION', 'MODEL_IN_USE', 'INPUT_TOO_LARGE',
    'BUSY', 'MODEL_LOAD_FAILED', 'ENGINE_UNAVAILABLE', 'ARTIFACT_NOT_AVAILABLE',
    'DEPENDENCY_UNAVAILABLE', 'INSTALLATION_FAILED', 'REVISION_CONFLICT', 'NOT_SUPPORTED',
))


def safe_failure(reason=None, stage=None):
    """Вернуть ограниченную диагностику ошибки для границы процессов."""
    return {'reason': reason if isinstance(reason, str) and reason in _FAILURE_REASONS else 'INTERNAL',
            'stage': stage if stage in ('control', 'broker') else 'broker'}


class RpcError(Exception):
    """Ошибка JSON-RPC с кодом, безопасным для удалённой стороны."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def peer_uid(writer):
    """Вернуть UID ядра для подключённого UNIX socket."""
    sock = writer.get_extra_info('socket')
    if sock is None or sock.family != socket.AF_UNIX:
        raise PermissionError('UNIX socket required')
    _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return uid


class Peer:
    """Асинхронный JSON-RPC 2.0; один кадр UTF-8 JSON на строку."""
    def __init__(self, reader, writer, methods):
        self.reader, self.writer, self.methods = reader, writer, methods
        self.pending, self.tasks = {}, set()
        self.write_lock = asyncio.Lock()
        self.closed = False

    async def send(self, item):
        """Записать ограниченный кадр целиком или завершить соединение ошибкой."""
        raw = json.dumps(item, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        if len(raw) > MAX_FRAME:
            raise RpcError(-32600, 'Frame too large')
        async with self.write_lock:
            self.writer.write(raw)
            await self.writer.drain()

    async def call(self, method, params, timeout=120):
        """Вызвать операцию; timeout не означает отмену удалённого действия."""
        if self.closed or len(self.pending) >= MAX_INFLIGHT:
            raise ConnectionError('RPC closed or saturated')
        ident = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(ident, None)

    async def _one(self, obj):
        ident = obj.get('id') if isinstance(obj, dict) else None
        if not isinstance(obj, dict) or obj.get('jsonrpc') != '2.0' or not isinstance(obj.get('method'), str) or ('id' in obj and (isinstance(ident, bool) or not isinstance(ident, (str, int, float, type(None))))):
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
        notification = 'id' not in obj
        try:
            method = self.methods.get(obj['method'])
            if method is None:
                raise RpcError(-32601, 'Method not found')
            params = obj.get('params', {})
            if not isinstance(params, dict):
                raise RpcError(-32602, 'Invalid params')
            result = await method(**params)
            reply = {'jsonrpc': '2.0', 'id': ident, 'result': result}
        except RpcError as exc:
            reply = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': exc.code, 'message': str(exc)}}
        except PermissionError:
            reply = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32003, 'message': 'Forbidden'}}
        except (TypeError, ValueError):
            reply = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32602, 'message': 'Invalid params'}}
        except Exception:
            reply = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32603, 'message': 'Internal error'}}
        return None if notification else reply

    async def _request(self, obj):
        if isinstance(obj, list):
            if len(obj) > MAX_INFLIGHT:
                raise RpcError(-32600, 'Batch too large')
            replies = [x for x in await asyncio.gather(*(self._one(x) for x in obj)) if x is not None] if obj else [{'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}]
            if replies:
                await self.send(replies)
        else:
            reply = await self._one(obj)
            if reply is not None:
                await self.send(reply)

    async def run(self):
        """Читать ответы и параллельно обслуживать запросы до закрытия сокета."""
        try:
            while True:
                try:
                    line = await self.reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    break
                if not line:
                    break
                if len(line) > MAX_FRAME or not line.endswith(b'\n'):
                    break
                try:
                    obj = json.loads(line)
                except (UnicodeError, ValueError):
                    await self.send({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}})
                    continue
                if isinstance(obj, dict) and 'method' not in obj and obj.get('jsonrpc') == '2.0':
                    future = self.pending.get(obj.get('id'))
                    if future and not future.done():
                        if 'error' in obj and 'result' not in obj and isinstance(obj['error'], dict):
                            future.set_exception(RpcError(obj['error'].get('code', -32603), obj['error'].get('message', 'Remote error')))
                        elif 'result' in obj and 'error' not in obj:
                            future.set_result(obj['result'])
                    continue
                if len(self.tasks) >= MAX_INFLIGHT:
                    break
                task = asyncio.create_task(self._request(obj))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
        finally:
            self.closed = True
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError('RPC disconnected; outcome unknown'))
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            self.writer.close()
            await self.writer.wait_closed()
