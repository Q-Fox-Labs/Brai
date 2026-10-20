#!/usr/bin/env python3
# ABOUTME: Проксирует MCP stdio к одной закреплённой сессии доверенного Codeworks host.
# ABOUTME: Не читает credentials или control socket; файловые эффекты выполняет только host.
"""Thin MCP transport, also usable by the native Hermes tool adapter."""
import json
import os
from pathlib import Path
import socket
import sys

TOOL = json.loads(Path(__file__).with_name('agent-tools.json').read_text())


def call(request, endpoint=None):
    """Send one bounded request; never retry uncertain mutations."""
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(180)
        connection.connect(endpoint or os.environ['CODEWORKS_AGENT_SOCKET'])
        connection.sendall((json.dumps(request, ensure_ascii=False) + '\n').encode())
        connection.shutdown(socket.SHUT_WR)
        result = bytearray()
        while chunk := connection.recv(65536):
            result.extend(chunk)
            if len(result) > 2097152:
                raise ValueError('OUTPUT_LIMIT')
        return json.loads(result)


def main():
    """Implement MCP framing and expose exactly the single owner-described tool."""
    for line in sys.stdin:
        if len(line) > 2097152:
            return
        request = json.loads(line)
        if 'id' not in request:
            continue
        method = request.get('method')
        response = {'jsonrpc': '2.0', 'id': request['id']}
        if method == 'initialize':
            response['result'] = {'protocolVersion': request.get('params', {}).get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'codeworks-agent', 'version': '1.0.0'}}
        elif method == 'ping':
            response['result'] = {}
        elif method == 'tools/list':
            response['result'] = {'tools': [TOOL]}
        elif method == 'tools/call':
            try:
                params = request['params']
                if params['name'] != TOOL['name']:
                    raise ValueError('UNKNOWN_TOOL')
                body = call(params.get('arguments', {}))
                response['result'] = {'isError': 'error' in body, 'content': [{'type': 'text', 'text': json.dumps(body, ensure_ascii=False)}]}
            except (OSError, ValueError, KeyError):
                response['result'] = {'isError': True, 'content': [{'type': 'text', 'text': 'CODEWORKS_UNAVAILABLE: inspect status; no automatic retry.'}]}
        else:
            response['error'] = {'code': -32601, 'message': 'Method not found'}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
