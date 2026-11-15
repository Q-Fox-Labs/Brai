# ABOUTME: Проверяет аргументы гостевых веб-инструментов перед фактическим исполнением.
# ABOUTME: Код, локальные пути, настройки и внешние изображения не принимаются.
"""Сетевые адреса дополнительно проверяет Root egress."""
from copy import deepcopy
import ipaddress
import json
import re
from urllib.parse import urlsplit

FIELDS = {
 'web_search': ({'query'}, {'limit'}),
 'image_generate': ({'prompt'}, {'aspect_ratio'}),
 'text_to_speech': ({'text'}, {'speed','instructions'}),
 'browser_navigate': ({'url'}, set()), 'browser_snapshot': (set(), {'full'}),
 'browser_click': ({'ref'}, set()), 'browser_type': ({'ref','text'}, set()),
 'browser_scroll': ({'direction'}, set()), 'browser_back': (set(), set()),
 'browser_press': ({'key'}, set()), 'browser_get_images': (set(), set()),
 'browser_vision': ({'question'}, {'annotate'}),
 'browser_dialog': ({'action'}, {'prompt_text','dialog_id'}),
}
KEYS = frozenset(('Enter','Tab','Escape','Space','ArrowUp','ArrowDown','ArrowLeft',
                 'ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete'))


def _text(value, limit, *, empty=False):
    return (isinstance(value,str) and (empty or bool(value.strip()))
            and len(value.encode('utf-8')) <= limit and '\x00' not in value)


def validate(name, args):
    """Неизвестные поля отклоняются и после изменения аргументов hooks/middleware."""
    if name not in FIELDS:
        return True
    try:
        required, optional = FIELDS[name]
        if not isinstance(args,dict) or not required <= set(args) <= required | optional:
            return False
        if len(json.dumps(args,ensure_ascii=False,allow_nan=False).encode()) > 131072:
            return False
        if name == 'web_search':
            return _text(args['query'],8192) and ('limit' not in args or type(args['limit']) is int and 1 <= args['limit'] <= 20)
        if name == 'image_generate':
            return _text(args['prompt'],16384) and args.get('aspect_ratio','landscape') in ('landscape','square','portrait')
        if name == 'text_to_speech':
            return (_text(args['text'],3600) and len(args['text']) <= 900
                and ('speed' not in args or type(args['speed']) in (int,float) and 0.25 <= args['speed'] <= 4)
                and ('instructions' not in args or _text(args['instructions'],2000,empty=True)))
        if name == 'browser_navigate':
            value=args['url']
            if not _text(value,8192) or any(ord(c)<33 or ord(c)==127 for c in value) or '\\' in value:
                return False
            parsed=urlsplit(value); host=parsed.hostname
            if parsed.scheme not in ('https','http') or not host or parsed.username is not None or parsed.password is not None:
                return False
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                return False
            host=host.lower().rstrip('.')
            if host=='localhost' or host.endswith(('.localhost','.local','.internal')):
                return False
            try:
                if not ipaddress.ip_address(host).is_global:
                    return False
            except ValueError:
                pass
        if 'ref' in args and (not isinstance(args['ref'],str) or not re.fullmatch(r'@?e[0-9]{1,8}',args['ref'])):
            return False
        if name == 'browser_type' and not _text(args['text'],65536,empty=True):
            return False
        if name == 'browser_scroll' and args['direction'] not in ('up','down'):
            return False
        if name == 'browser_press' and args['key'] not in KEYS:
            return False
        if 'full' in args and type(args['full']) is not bool:
            return False
        if 'annotate' in args and type(args['annotate']) is not bool:
            return False
        if name == 'browser_vision' and not _text(args['question'],8192):
            return False
        if name == 'browser_dialog':
            if args['action'] not in ('accept','dismiss'):
                return False
            if 'prompt_text' in args and not _text(args['prompt_text'],65536,empty=True):
                return False
            if 'dialog_id' in args and (not _text(args['dialog_id'],128) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*',args['dialog_id'])):
                return False
        return True
    except (ValueError,TypeError,UnicodeError,OverflowError):
        return False


def definitions(rows):
    """Показать только поддерживаемые гостем поля SDK, не меняя общий каталог."""
    result=deepcopy(rows)
    for row in result:
        if not isinstance(row,dict):
            continue
        definition=row.get('function',row); name=definition.get('name')
        if name not in FIELDS:
            continue
        required,optional=FIELDS[name]
        parameters=definition.get('parameters',{})
        parameters.update(type='object', properties={k:v for k,v in parameters.get('properties',{}).items() if k in required | optional},
                          required=sorted(required), additionalProperties=False)
        definition['parameters']=parameters
        if name=='web_search' and 'limit' in parameters['properties']:
            parameters['properties']['limit']['maximum']=20
        if name=='text_to_speech' and 'text' in parameters['properties']:
            parameters['properties']['text']['maxLength']=900
        if name=='browser_press' and 'key' in parameters['properties']:
            parameters['properties']['key']['enum']=sorted(KEYS)
    return result
