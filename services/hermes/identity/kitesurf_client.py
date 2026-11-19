# ABOUTME: Предоставляет агенту отдельный инструмент браузера Kitesurf через MCP.
# ABOUTME: Подключается только к личному изолированному CDP; Chrome не изменяет.
"""MCP stdio адаптер к принятому agent-browser и личному Kitesurf."""

import json
import re
import subprocess
import sys

CDP_URL = 'http://127.0.0.1:19366'
SOCKET_DIR = '/tmp/brai-kitesurf-agent-browser'
DESCRIPTION = (
    'Лёгкий браузер Kitesurf для публичных страниц, поиска и простых действий на сайте. '
    'Для сайтов с авторизацией, сложных приложений и задач, где нужен Chrome, '
    'используй существующие инструменты browser_*. Сессии независимы. '
    'Открой страницу через open, затем используй snapshot и ссылки элементов @eN.'
)
TOOL = {'name': 'kitesurf', 'description': DESCRIPTION, 'inputSchema': {
    'type': 'object', 'properties': {
        'action': {'enum': ['open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'back', 'close']},
        'url': {'type': 'string'}, 'ref': {'type': 'string'}, 'text': {'type': 'string'},
        'key': {'type': 'string'}, 'direction': {'enum': ['up', 'down', 'left', 'right']},
    }, 'required': ['action'], 'additionalProperties': False}}
FIELDS = {'open': 'url', 'click': 'ref', 'fill': ('ref', 'text'),
          'press': 'key', 'scroll': 'direction'}


def command(arguments):
    """Преобразовать действие в одну команду, отклоняя посторонние поля."""
    if not isinstance(arguments, dict) or arguments.get('action') not in TOOL['inputSchema']['properties']['action']['enum']:
        raise ValueError('Invalid browser action')
    action = arguments['action']
    fields = FIELDS.get(action, ())
    if isinstance(fields, str):
        fields = (fields,)
    if set(arguments) != {'action', *fields}:
        raise ValueError('Invalid browser arguments')
    for name in fields:
        if not isinstance(arguments[name], str) or (name != 'text' and not arguments[name]):
            raise ValueError('Invalid browser argument')
    if 'ref' in fields and not re.fullmatch(r'@e[0-9]+', arguments['ref']):
        raise ValueError('Expected a browser snapshot reference')
    if action == 'scroll' and arguments['direction'] not in ('up', 'down', 'left', 'right'):
        raise ValueError('Invalid scroll direction')
    if action == 'open':
        from urllib.parse import urlsplit
        url = urlsplit(arguments['url'])
        if (url.scheme not in ('http', 'https') or not url.hostname
                or url.username is not None or url.password is not None
                or any(ord(char) < 33 or ord(char) == 127 for char in arguments['url'])):
            raise ValueError('Expected an HTTP or HTTPS URL')
        _ = url.port
    return [action, *(arguments[name] for name in fields)]


def run_browser(arguments):
    """Выполнить одну команду через принятый CLI без shell и автоматического повтора."""
    from identity.guest_browser import accepted_binary, command_env
    argv = [accepted_binary(), '--session', 'brai-kitesurf', '--cdp', CDP_URL, '--json', 'batch']
    payload = json.dumps([command(arguments)], ensure_ascii=False).encode('utf-8')
    env = command_env(SOCKET_DIR)
    env['AGENT_BROWSER_CONFIG'] = '/opt/brai-profile/runtime/services/hermes/identity/browser-defaults.json'
    result = subprocess.run(argv, input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, check=False)
    if result.returncode:
        raise RuntimeError('Kitesurf command failed')
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError) as error:
        raise RuntimeError('Invalid Kitesurf result') from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RuntimeError('Invalid Kitesurf result')
    return value[0]


def handle(method, params):
    """Обработать MCP discovery и вызов единственного инструмента Kitesurf."""
    params = params or {}
    if not isinstance(params, dict):
        raise ValueError('Invalid parameters')
    if method == 'initialize':
        version = params.get('protocolVersion', '2024-11-05')
        if version not in ('2024-11-05', '2025-03-26', '2025-06-18'):
            version = '2024-11-05'
        return {'protocolVersion': version, 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'brai-kitesurf', 'version': '1.0.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': [TOOL]}
    if method == 'tools/call' and params.get('name') == 'kitesurf':
        result = run_browser(params.get('arguments', {}))
        return {'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}]}
    raise LookupError('Method not found')


def main():
    """Обслуживать JSON-RPC строки; stdout предназначен только для MCP."""
    for line in sys.stdin:
        ident = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or request.get('jsonrpc') != '2.0' or not isinstance(request.get('method'), str):
                raise ValueError('Invalid request')
            ident = request.get('id')
            result = handle(request['method'], request.get('params'))
            response = {'jsonrpc': '2.0', 'id': ident, 'result': result}
        except LookupError:
            response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': 'Method not found'}}
        except (ValueError, TypeError):
            response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32602, 'message': 'Invalid request'}}
        except Exception:
            response = {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32603, 'message': 'Kitesurf unavailable'}}
        if ident is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(',', ':')) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
