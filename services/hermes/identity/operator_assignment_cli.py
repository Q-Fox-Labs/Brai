# ABOUTME: Отправляет root-owned поручение в существующий Unix socket Telegram ingress.
# ABOUTME: Не читает Telegram token, не генерирует ответ и не вызывает Bot API.
"""Usage: python -m identity.operator_assignment_cli /absolute/ingress.sock action < request.json."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import uuid

from .ipc import MAX_FRAME, peer_uid


async def call(path, action, params):
    node = path.lstat()
    if (not path.is_absolute() or path.resolve(strict=True) != path
            or not stat.S_ISSOCK(node.st_mode) or node.st_mode & 0o007):
        raise PermissionError('Unprotected ingress control socket')
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=MAX_FRAME + 1), 5)
    try:
        if peer_uid(writer) != node.st_uid:
            raise PermissionError('Ingress owner changed')
        ident = uuid.uuid4().hex
        request = {'jsonrpc': '2.0', 'id': ident, 'method': 'operator.assignment',
                   'params': {**params, 'action': action}}
        encoded = json.dumps(request, ensure_ascii=False).encode() + b'\n'
        if len(encoded) > MAX_FRAME:
            raise ValueError('Operator request too large')
        writer.write(encoded)
        await writer.drain()
        raw = await asyncio.wait_for(reader.readline(), 210 if action == 'approve' else 40)
        if not raw or len(raw) > MAX_FRAME:
            raise ConnectionError('Operator assignment response unavailable')
        response = json.loads(raw)
        if response.get('id') != ident or not isinstance(response.get('result'), dict):
            raise RuntimeError('Operator assignment refused or unconfirmed')
        return response['result']
    finally:
        writer.close()
        await writer.wait_closed()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('socket', type=Path)
    parser.add_argument('action', choices=('start', 'status', 'approve', 'cancel'))
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Root is required')
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('Operator request too large')
        params = json.loads(raw)
        if not isinstance(params, dict) or 'action' in params:
            raise ValueError('Invalid operator request')
        result = asyncio.run(call(arguments.socket, arguments.action, params))
    except (ConnectionError, OSError, RuntimeError, ValueError):
        raise SystemExit('Operator assignment failed. Check status before sending another request.') from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
