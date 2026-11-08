# ABOUTME: Предоставляет Hermes ограниченные инструменты через доверенный брокер.
# ABOUTME: UID и владелец определяются брокером; код входа не поступает в процесс.
"""MCP stdio клиент без пользовательских секретов и прямых доступов к сервисам."""
import json
import os
import socket
import struct
import sys
import uuid

MAX_FRAME = 2 * 1024 * 1024 + 65536


def broker_call(method, params, *, path=None, timeout=120):
    """Вызвать доверенный UNIX broker по одному ограниченному JSON-RPC запросу."""
    path = path or os.environ.get('BRAI_IDENTITY_BROKER')
    if not isinstance(path, str) or not path.startswith('/'):
        raise ValueError('Broker socket is not configured')
    ident = uuid.uuid4().hex
    raw = (json.dumps({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params}, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    if len(raw) > MAX_FRAME:
        raise ValueError('Broker request exceeds limit')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(path)
        _, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 0:
            raise PermissionError('Broker must run as root')
        conn.sendall(raw)
        with conn.makefile('rb') as incoming:
            line = incoming.readline(MAX_FRAME + 1)
    if not line.endswith(b'\n') or len(line) > MAX_FRAME:
        raise ConnectionError('Broker response incomplete')
    response = json.loads(line)
    if (not isinstance(response, dict) or response.get('jsonrpc') != '2.0'
            or response.get('id') != ident or 'error' in response or 'result' not in response):
        raise ConnectionError('Broker rejected request')
    return response['result']


def handle(method, params):
    """Предоставить только MCP initialize и ограниченный каталог инструментов."""
    # Native MCP SDK передаёт params:null для tools/list и ping.
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ValueError('Invalid params')
    if method == 'initialize':
        requested = params.get('protocolVersion', '2024-11-05')
        if requested not in ('2024-11-05', '2025-03-26', '2025-06-18'):
            requested = '2024-11-05'
        return {'protocolVersion': requested, 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'brai-identity', 'version': '1.0.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        result = broker_call('tools.list', {})
        if not isinstance(result, dict) or not isinstance(result.get('tools'), list):
            raise RuntimeError('Broker tools unavailable')
        tools = result['tools']
        if any(not isinstance(item, dict) or item.get('name') in ('brai_login', 'brai_telegram_link_account', 'brai_telegram_unlink_account', 'publish_file', 'fetch_file') for item in tools):
            raise RuntimeError('Invalid tool catalog')
        return {'tools': [*tools,
                {'name': 'brai_telegram_link_account', 'description': 'Подключить второй личный Telegram-аккаунт владельца к этому профилю. Первый вызов отправляет объяснение: другой аккаунт получит всю память, файлы и данные; передача команды постороннему даст ему полный доступ. Запрашивает подтверждение пользователя. После нового явного подтверждения в этой личке вызови инструмент снова: одноразовая команда придёт отдельным сообщением. Оба аккаунта равноправны; максимум два аккаунта. Не выдавай команду до подтверждения; не повторяй отправку при неизвестном исходе. Беседы отдельные, память и файлы общие. После успешной доставки не добавляй ответ.',
                 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
                {'name': 'brai_telegram_unlink_account', 'description': 'Только по заданию пользователя отключить этот (current) или другой (other) его Telegram-аккаунт. Сначала отправляет предупреждение с ID выбранного аккаунта и просит подтверждение. После нового явного подтверждения этого ID вызови снова с тем же target. Можно отключить первый аккаунт; главного нет. Пользователь может отключить все аккаунты, администратор должен сохранить хотя бы один канал связи. Память и файлы сохраняются, входы на сайт отзываются. Модель не задаёт подтверждение. Не повторяй при неизвестном исходе. После успешной доставки не добавляй ответ.',
                 'inputSchema': {'type': 'object', 'properties': {'target': {'type': 'string', 'enum': ['current', 'other']}},
                                 'required': ['target'], 'additionalProperties': False}},
                {'name': 'brai_login', 'description': 'Вход в веб-интерфейс этой установки Brai (наш сайт). Только по явной просьбе владельца о входе в личном чате Telegram отправить одноразовый код и адрес сайта отдельным сообщением. Не ищи код на сайте и не проси искать кнопку. Код не показывается инструменту. После подтверждённой отправки не добавляй ответ.',
                 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
                {'name': 'publish_file', 'description': 'Опубликовать собственный готовый файл и получить ссылку.',
                 'inputSchema': {'type':'object', 'properties':{'path':{'type':'string'}, 'requestId':{'type':'string'}}, 'required':['path'], 'additionalProperties':False}},
                {'name': 'fetch_file', 'description': 'Получить собственный опубликованный файл.',
                 'inputSchema': {'type':'object', 'properties':{'artifactId':{'type':'string'}}, 'required':['artifactId'], 'additionalProperties':False}}]}
    if method == 'tools/call':
        name, arguments = params.get('name'), params.get('arguments', {})
        if not isinstance(name, str) or not isinstance(arguments, dict):
            raise ValueError('Invalid tool call')
        if name == 'brai_telegram_link_account':
            if arguments:
                raise ValueError('Account linking does not accept arguments')
            response = broker_call('telegram.link', {})
            if not isinstance(response, dict) or response.get('status') != 'sent' or response.get('suppressFinal') is not True:
                return {'isError': True, 'content': [{'type': 'text', 'text': 'Доставка привязки не подтверждена. Не повторяй автоматически.'}]}
            text = ('Предупреждение и вопрос о подтверждении уже отправлены. Дождись нового ответа пользователя.'
                    if response.get('phase') == 'offer' else 'Одноразовая команда отправлена в исходную личку.')
            return {'content': [{'type': 'text', 'text': text + ' Не отправляй дополнительный ответ.'}]}
        if name == 'brai_telegram_unlink_account':
            if set(arguments) != {'target'} or arguments['target'] not in ('current', 'other'):
                raise ValueError('Invalid account target')
            response = broker_call('telegram.unlink', arguments)
            if not isinstance(response, dict) or response.get('status') != 'sent' or response.get('suppressFinal') is not True:
                reason = response.get('reason') if isinstance(response, dict) else None
                message = ('У администратора должен оставаться хотя бы один канал связи. Этот аккаунт не отключён.'
                           if reason == 'admin-last-channel' else
                           'Выбранный аккаунт недоступен для отвязки.' if reason == 'account-unavailable' else
                           'Результат отвязки не подтверждён. Не повторяй автоматически.')
                return {'isError': True, 'content': [{'type': 'text', 'text': message}]}
            message = ('Предупреждение с ID аккаунта и вопрос о подтверждении отправлены. Дождись нового ответа пользователя.'
                       if response.get('phase') == 'offer' else 'Выбранный аккаунт отключён; результат отправлен отдельно.')
            return {'content': [{'type': 'text', 'text': message + ' Не отправляй дополнительный ответ.'}]}
        if name == 'brai_login':
            if arguments:
                raise ValueError('Login does not accept arguments')
            response = broker_call('login.send', {})
            if not isinstance(response, dict) or response.get('status') != 'sent' or response.get('suppressFinal') is not True:
                return {'isError': True, 'content': [{'type': 'text', 'text': 'Не удалось подтвердить отправку кода входа.'}]}
            return {'content': [{'type': 'text', 'text': 'Код отправлен отдельным сообщением. Не отправляй дополнительный ответ.'}]}
        if name in ('publish_file', 'fetch_file'):
            if name == 'publish_file':
                if set(arguments) - {'path', 'requestId'} or not isinstance(arguments.get('path'), str):
                    raise ValueError('Invalid file request')
                request_id = arguments.get('requestId') or str(uuid.uuid4())
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 256:
                    raise ValueError('Invalid request identity')
                payload = {'path':arguments['path'], 'requestId':request_id}
                operation = 'files.publish'
            else:
                if set(arguments) != {'artifactId'} or not isinstance(arguments['artifactId'], str):
                    raise ValueError('Invalid artifact identity')
                payload = {'artifactId':arguments['artifactId']}
                operation = 'files.fetch'
            result = broker_call(operation, payload)
            if not isinstance(result, dict) or not isinstance(result.get('markdown'), str) or not result['markdown']:
                raise RuntimeError('Invalid artifact receipt')
            return {'content':[{'type':'text', 'text':result['markdown']}], 'structuredContent':result}
        result = broker_call('tools.call', {'name': name, 'args': arguments})
        if isinstance(result, dict) and isinstance(result.get('content'), list):
            return result
        return {'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}]}
    raise LookupError('Method not found')


def _one(request):
    ident = request.get('id') if isinstance(request, dict) else None
    if not isinstance(request, dict) or request.get('jsonrpc') != '2.0' or not isinstance(request.get('method'), str):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
    try:
        result = handle(request['method'], request.get('params', {}))
        response = {'jsonrpc': '2.0', 'id': ident, 'result': result}
    except LookupError:
        response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': 'Method not found'}}
    except (ValueError, TypeError):
        response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32602, 'message': 'Invalid params'}}
    except Exception:
        response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32603, 'message': 'Broker unavailable'}}
    return response if 'id' in request else None


def main():
    """Обслужить строки MCP до EOF; stdout содержит только JSON-RPC."""
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            return
        if len(line) > MAX_FRAME or not line.endswith(b'\n'):
            return
        try:
            obj = json.loads(line)
        except (ValueError, UnicodeError):
            result = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
        else:
            if isinstance(obj, list):
                result = [r for item in obj if (r := _one(item)) is not None] if obj else [{'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}]
            else:
                result = _one(obj)
        if result:
            sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
