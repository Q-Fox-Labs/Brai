# ABOUTME: Выдаёт native auth.command только access из закрытого credential RPC.
# ABOUTME: Проверяет binding до stdout; ошибки не содержат credential или ответ RPC.
"""Stdlib client auth.command для запуска Python -I -S -B client.py."""
import argparse
import json
import os
import re
import socket
import sys
import time

BASE_URL = 'https://chatgpt.com/backend-api/codex'
ERRORS = {'HELPER_BINDING_CHANGED', 'HELPER_STOPPING', 'HELPER_REJECTED',
          'OWNER_OUTCOME_UNKNOWN', 'CODEX_OWNER_REJECTED', 'CODEX_OWNER_BUSY',
          'CODEX_OWNER_ACCESS_EXPIRED', 'CODEX_OWNER_UNAVAILABLE'}


class ClientError(ValueError):
    """Хранить только фиксированный публичный код ошибки."""


class Arguments(argparse.ArgumentParser):
    """Исключить неверные аргументы команды из диагностики."""

    def error(self, message):
        """Отклонить неверный запуск без вывода аргументов."""
        raise ClientError('HELPER_REJECTED')


def access(socket_path, binding):
    """Получить access с явным binding и проверить весь закрытый ответ.

    Разрыв не отменяет owner вызов. Client не повторяет потерянный запрос
    и не добавляет deadline к существующей ограниченной операции resolver.
    """
    if (not isinstance(socket_path, str) or not os.path.isabs(socket_path)
            or os.path.normpath(socket_path) != socket_path or not binding):
        raise ClientError('HELPER_REJECTED')
    request = {'jsonrpc': '2.0', 'id': 'credential', 'method': 'credentials.resolve',
               'params': {'expectedBinding': binding}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(socket_path)
        connection.sendall(json.dumps(request, separators=(',', ':')).encode() + b'\n')
        with connection.makefile('rb') as source:
            response = json.loads(source.readline())
    if not isinstance(response, dict) or response.get('jsonrpc') != '2.0' or response.get('id') != 'credential':
        raise ClientError('HELPER_REJECTED')
    if set(response) == {'jsonrpc', 'id', 'error'}:
        error = response['error']
        code = (error.get('message') if isinstance(error, dict)
                and set(error) == {'code', 'message'} and type(error['code']) is int
                and error['code'] == -32000 else None)
        raise ClientError(code if isinstance(code, str) and code in ERRORS else 'HELPER_REJECTED')
    if set(response) != {'jsonrpc', 'id', 'result'} or not isinstance(response['result'], dict):
        raise ClientError('HELPER_REJECTED')
    value = response['result']
    if (set(value) != {'access', 'binding', 'accountId', 'expiresAt', 'baseUrl', 'sourceRef'}
            or value['binding'] != binding or value['baseUrl'] != BASE_URL
            or not isinstance(value['sourceRef'], str) or not re.fullmatch('[a-f0-9]{64}', value['sourceRef'])
            or type(value['expiresAt']) is not int or value['expiresAt'] <= time.time() + 120
            or any(not isinstance(value[key], str) or not value[key]
                   or any(not 33 <= ord(char) <= 126 for char in value[key])
                   for key in ('access', 'accountId'))):
        raise ClientError('HELPER_REJECTED')
    return value['access']


def main(argv=None):
    """Вывести одну bearer строку при успехе или фиксированный код в stderr."""
    try:
        parser = Arguments(add_help=False)
        parser.add_argument('--socket', required=True)
        parser.add_argument('--binding', required=True)
        args = parser.parse_args(argv)
        value = access(args.socket, args.binding)
        sys.stdout.write(value + '\n')
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ClientError) and str(error) in ERRORS else 'HELPER_REJECTED'
        sys.stderr.write(code + '\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
