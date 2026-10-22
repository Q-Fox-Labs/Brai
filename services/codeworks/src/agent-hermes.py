#!/usr/bin/env python3
# ABOUTME: Подключает Codeworks tool через публичный registry настоящего Hermes engine.
# ABOUTME: HMAC key читается один раз из FD; native session_id задаёт отдельную identity.
"""Native Hermes bootstrap for CLI/conversation or the existing gateway."""
import argparse
import ctypes
import hashlib
import hmac
import json
import os
import secrets
import select
import time
import threading
import inspect
import stat
from types import ModuleType
from pathlib import Path
import sys
from functools import wraps

from importlib.util import spec_from_file_location, module_from_spec


def read_profile_document(profile, path):
    """Read bounded instruction text only; never execute skills or follow escaped links."""
    profile = Path(profile).resolve(strict=True)
    candidate = Path(path)
    if not candidate.is_absolute() or '..' in candidate.parts:
        raise ValueError('PROFILE_DOCUMENT_DENIED')
    candidate = candidate.resolve(strict=True)
    relative = candidate.relative_to(profile)
    parts = relative.parts
    allowed = (len(parts) == 1 or parts[:1] == ('skills',)
               or parts[:2] in (('usercustom', 'hermescustom'), ('usercustom', 'userdata')))
    if not allowed or candidate.suffix.lower() not in {'.md', '.txt'}:
        raise ValueError('PROFILE_DOCUMENT_DENIED')
    # Walk directory FDs so a path replacement cannot redirect the final read to auth/state.
    fd = os.open(profile, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        target = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(target, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
                raise ValueError('PROFILE_DOCUMENT_LIMIT')
            content = source.read(262145)
            if len(content) > 262144:
                raise ValueError('PROFILE_DOCUMENT_LIMIT')
    finally:
        os.close(fd)
    return {'path': str(candidate), 'content': content.decode('utf-8'),
            'sha256': hashlib.sha256(content).hexdigest()}


def install(bootstrap_path=Path('/run/codeworks-key'), channel_fd=None):
    """Register the signed tool, keeping the signing key outside child environments."""
    # Become nondumpable before reading any private bootstrap bytes.
    if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
        raise RuntimeError('PROCESS_ISOLATION_REQUIRED')
    key_file = bootstrap_path
    bootstrap = json.loads(key_file.read_text())
    key_file.unlink()
    try:
        os.close(3)
    except OSError:
        pass
    key = bytes.fromhex(bootstrap.pop('key'))
    for name, value in bootstrap.pop('env', {}).items():
        os.environ[name] = value
    if channel_fd is None:
        # bubblewrap preserves stdio only. Reserve these pipes before any native import,
        # then give the native gateway ordinary EOF stdin and stderr-backed stdout.
        os.dup2(0, 4, inheritable=False)
        os.dup2(1, 5, inheritable=False)
        with open('/dev/null', 'rb') as null:
            os.dup2(null.fileno(), 0)
        os.dup2(2, 1)
        input_fd, output_fd = 4, 5
    else:
        input_fd = output_fd = channel_fd
        os.set_inheritable(channel_fd, False)
    lock = threading.Lock()
    channel_failed = False

    def private_call(request, timeout=30):
        """Use one non-inheritable duplex FD; tools never see its request protocol."""
        nonlocal channel_failed
        request_id = secrets.token_hex(16)
        request = {'id': request_id, **request}
        encoded = (json.dumps(request, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        if len(encoded) > 65_536:
            raise RuntimeError('PRIVATE_CALL_LIMIT')
        with lock:
            if channel_failed:
                raise RuntimeError('PRIVATE_CHANNEL_UNAVAILABLE')
            # Any unknown result permanently fences this channel; never resend side effects.
            channel_failed = True
            deadline = time.monotonic() + max(0.01, min(timeout, 300))
            while encoded:
                sent = os.write(output_fd, encoded)
                encoded = encoded[sent:]
            result = bytearray()
            while not result.endswith(b'\n'):
                if not select.select([input_fd], [], [], max(0, deadline - time.monotonic()))[0]:
                    raise RuntimeError('PRIVATE_CALL_TIMEOUT')
                chunk = os.read(input_fd, 65_536)
                if not chunk or len(result) + len(chunk) > 1_048_576:
                    raise RuntimeError('PRIVATE_RESPONSE_REJECTED')
                result.extend(chunk)
            value = json.loads(result)
            if value.get('id') != request_id:
                raise RuntimeError('PRIVATE_RESPONSE_REJECTED')
            channel_failed = False
            if 'error' in value:
                raise RuntimeError(value['error'])
            return value['result']

    plugin = bootstrap.pop('plugin', None)
    capability = bootstrap.pop('capability', None)

    def canonical(path):
        """Authorize only exact immutable canonical plugin bytes, never a model path."""
        if not plugin or not path:
            return False
        candidate = Path(path)
        return (candidate.resolve() == Path(plugin['path']).resolve()
                and hashlib.sha256(candidate.read_bytes()).hexdigest() == plugin['sha256'])

    if plugin:
        private = ModuleType('_brai_codeworks_gateway')

        def call_plugin(method, params, timeout=15):
            if not canonical(inspect.currentframe().f_back.f_code.co_filename):
                raise RuntimeError('TRUSTED_PLUGIN_REQUIRED')
            request_id = secrets.token_hex(16)
            response = private_call({'channel': 'trusted', 'capability': capability,
                                     'request': {'jsonrpc': '2.0', 'id': request_id,
                                                 'method': method, 'params': params}}, timeout)
            if response.get('id') != request_id:
                raise RuntimeError('PRIVATE_RESPONSE_REJECTED')
            if 'error' in response:
                raise RuntimeError(response['error'].get('data', {}).get('code', 'RPC_REJECTED'))
            return response['result']

        private.call_plugin = call_plugin
        sys.modules[private.__name__] = private
    spec = spec_from_file_location('codeworks_proxy', Path(__file__).with_name('agent-proxy.py'))
    proxy = module_from_spec(spec)
    spec.loader.exec_module(proxy)
    from tools.registry import registry
    from toolsets import create_custom_toolset

    document_profile = os.environ.get('HERMES_HOME') if os.environ.get('CODEWORKS_HERMES_PROFILE_READS') == '1' else None

    def handle(args, session_id='', **kwargs):
        """Use only dispatcher identity; model payload cannot choose another session."""
        if not session_id:
            return json.dumps({'error': 'NATIVE_SESSION_REQUIRED'})
        if document_profile and args.get('action') == 'read' and str(args.get('path', '')).startswith(document_profile + '/'):
            try:
                return json.dumps(read_profile_document(document_profile, args['path']), ensure_ascii=False)
            except (OSError, ValueError, UnicodeError):
                return json.dumps({'error': 'PROFILE_DOCUMENT_DENIED'})
        payload = json.dumps({'native_session_id': session_id, 'request': args}, ensure_ascii=False, separators=(',', ':'))
        envelope = {'payload': payload, 'signature': hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()}
        return json.dumps(proxy.call(envelope), ensure_ascii=False)

    schema = {'name': 'codeworks', 'description': proxy.TOOL['description'], 'parameters': proxy.TOOL['inputSchema']}
    if document_profile:
        schema['description'] += ' In this gateway action=read also reads absolute Markdown/text instruction paths in HERMES_HOME (top-level policies, usercustom/hermescustom, usercustom/userdata, skills). This grants no writes or shell access.'
    registry.register(name='codeworks', toolset='codeworks', schema=schema, handler=handle)
    create_custom_toolset('codeworks', description='Managed project file access', tools=['codeworks'])
    document_schemas = []
    if document_profile:
        view_schema = {'name': 'skill_view', 'description': 'Read an installed skill or its Markdown/text references without executing preprocessing or installing dependencies.', 'parameters': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'file_path': {'type': 'string'}}, 'required': ['name'], 'additionalProperties': False}}

        def view_skill(args, **kwargs):
            try:
                name = Path(args.get('name', ''))
                file = Path(args.get('file_path') or 'SKILL.md')
                if not str(name) or name.is_absolute() or file.is_absolute() or '..' in (*name.parts, *file.parts):
                    raise ValueError('PROFILE_DOCUMENT_DENIED')
                skill_root = (Path(document_profile) / 'skills' / name).resolve(strict=True)
                document = read_profile_document(document_profile, skill_root / file)
                Path(document['path']).relative_to(skill_root)
                return json.dumps({'success': True, 'name': str(name), **document}, ensure_ascii=False)
            except (OSError, ValueError, UnicodeError):
                return json.dumps({'success': False, 'error': 'PROFILE_DOCUMENT_DENIED'})

        registry.register(name='skill_view', toolset='codeworks', schema=view_schema, handler=view_skill)
        document_schemas.append(view_schema)
    owner_schemas = []
    for definition in bootstrap.pop('tools', []):
        name = definition['name']
        if name == 'codeworks' or name.startswith('brai_telegram_'):
            raise RuntimeError('OWNER_TOOL_COLLISION')
        visible = {'name': name, 'description': definition.get('description', ''),
                   'parameters': definition['inputSchema']}

        def owner_handle(args, _name=name, **kwargs):
            try:
                return json.dumps(private_call({'channel': 'owner', 'name': _name, 'args': args}), ensure_ascii=False)
            except Exception as error:
                code = str(error)
                return json.dumps({'error': code if code.isupper() and len(code) <= 80 else 'OWNER_API_UNAVAILABLE'})

        registry.register(name=name, toolset='codeworks_owner', schema=visible, handler=owner_handle)
        owner_schemas.append(visible)
    owner_names = {item['name'] for item in owner_schemas}
    plugin_names = {'brai_telegram_request_confirmation', 'brai_telegram_submit_feedback', 'brai_telegram_submit_result'}

    def plugin_schema(name):
        entry = registry.get_entry(name)
        handler = getattr(entry, 'handler', None)
        code = getattr(getattr(handler, '__func__', handler), '__code__', None)
        return registry.get_schema(name) if code and canonical(code.co_filename) else None

    native_dispatch = registry.dispatch

    def dispatch(name, args, **kwargs):
        """Fail closed before any native in-process code tool can access signer memory."""
        if name not in {'codeworks', *owner_names, *(value['name'] for value in document_schemas)} and not (name in plugin_names and plugin_schema(name)):
            return json.dumps({'error': 'NATIVE_TOOL_DISABLED_USE_CODEWORKS'})
        return native_dispatch(name, args, **kwargs)

    registry.dispatch = dispatch
    # Gateway and conversation instantiate this same native class. Keep its model loop,
    # while exporting the owner tool directly instead of the native deferred-tool bridge.
    from run_agent import AIAgent
    native_init = AIAgent.__init__

    @wraps(native_init)
    def managed_init(agent, *args, **kwargs):
        native_init(agent, *args, **kwargs)
        schemas = [schema, *document_schemas, *owner_schemas, *(value for name in sorted(plugin_names) if (value := plugin_schema(name)))]
        agent.tools = [{'type': 'function', 'function': value} for value in schemas]
        agent.valid_tool_names = {value['name'] for value in schemas}

    AIAgent.__init__ = managed_init
    return {'schema': schema, 'owner_schemas': owner_schemas, 'plugin': plugin, 'input': bootstrap.pop('input', '')}


def main():
    """Use the installed Hermes runtime; never replace its model or conversation loop."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', required=True)
    parser.add_argument('--conversation')
    parser.add_argument('--model', default='gpt-6.1-sol')
    parser.add_argument('--session-id')
    parser.add_argument('--gateway', action='store_true')
    parser.add_argument('--check-isolation', action='store_true')
    parser.add_argument('--check-owner-bridge', action='store_true')
    args, rest = parser.parse_known_args()
    sys.path.insert(0, args.engine)
    installed = install()
    if args.check_isolation:
        target = Path(os.environ['CODEWORKS_PROJECT_ROOT']) / ('.codeworks-native-probe-' + secrets.token_hex(8))
        try:
            target.write_text('native bypass')
        except OSError:
            print('PASS real Hermes launcher native source write denied by OS')
            return
        target.unlink()
        raise RuntimeError('NATIVE_SOURCE_WRITABLE')
    if args.check_owner_bridge:
        from tools.registry import registry
        assert 'elements_graph_get' in {value['name'] for value in installed['owner_schemas']}
        value = json.loads(registry.dispatch('elements_graph_get', {}))
        assert isinstance(value.get('elements'), list) and isinstance(value.get('moves'), list)
        for name in ['terminal', 'read_file', 'python', 'actions.complete']:
            assert 'NATIVE_TOOL_DISABLED_USE_CODEWORKS' in registry.dispatch(name, {})
        # A subprocess has neither the consumed bootstrap, channel nor broker config.
        import subprocess
        hidden = ['/etc/brai-dev/hermes/tools.json', '/etc/brai-dev/codeworks/nats-service.json']
        for path in hidden:
            try:
                Path(path).read_bytes()
            except OSError:
                continue
            raise RuntimeError('BROKER_CONFIG_VISIBLE')
        assert not Path('/run/codeworks-key').exists()
        command = "import os; from pathlib import Path; bad=['TELEGRAM_BOT_TOKEN','NATS_PASSWORD','NATS_USER','BRAI_HERMES_CONFIG']; assert not any(k in os.environ for k in bad), 'PRIVATE_ENV_VISIBLE'; assert not Path('/run/codeworks-key').exists(), 'BOOTSTRAP_FILE_VISIBLE'; assert not os.access('/etc/brai-dev/hermes/tools.json',os.R_OK), 'BROKER_CONFIG_VISIBLE'; assert not os.access('/etc/brai-dev/codeworks/nats-service.json',os.R_OK), 'SERVICE_CONFIG_VISIBLE';\nfor p in Path('/proc').glob('[0-9]*/environ'):\n try: value=p.read_bytes()\n except OSError: continue\n assert not any((k+'=').encode() in value for k in bad), 'PROCESS_SECRET_ENV_VISIBLE'\nprint('MODEL_COMMAND_PRIVATE_INPUTS_DENIED')"
        result = json.loads(registry.dispatch('codeworks', {'action': 'command', 'mode': 'read', 'argv': ['/usr/bin/python3', '-B', '-c', command]}, session_id=args.session_id))
        import time
        for _ in range(100):
            if result.get('done'):
                break
            assert 'command_id' in result, 'MODEL_COMMAND_NOT_ACCEPTED'
            time.sleep(0.02)
            result = json.loads(registry.dispatch('codeworks', {'action': 'poll', 'command_id': result['command_id']}, session_id=args.session_id))
        if not result.get('done') or result.get('exit_code') != 0:
            import re
            failure = re.search(r'AssertionError: ([A-Z_]+)', result.get('stderr', ''))
            raise RuntimeError(failure.group(1) if failure else 'MODEL_COMMAND_PRIVATE_PROBE_FAILED')
        child = subprocess.run([sys.executable, '-B', '-c', "import os; assert not any(x in os.environ for x in ['NATS_PASSWORD','NATS_USER']);\nfor fd in [4,5]:\n try: os.fstat(fd)\n except OSError: pass\n else: raise AssertionError('PRIVATE_FD_INHERITED')"], capture_output=True)
        assert child.returncode == 0
        print('PASS actual owner graph, model human/native denied, broker config hidden, bootstrap consumed, private FD not inherited')
        if installed['plugin']:
            path = installed['plugin']['path']
            spec = spec_from_file_location('codeworks_plugin_probe', path)
            module = module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
            config = module.Config.from_env()
            try:
                module.Bridge(config).call('actions.read', {'moveId': '00000000-0000-4000-8000-000000000000'})
            except module.BridgeError as error:
                assert str(error) == 'NOT_FOUND', 'TRUSTED_OWNER_READ_NOT_CONFIRMED'
                print('PASS exact canonical trusted plugin private call safely rejected missing Action; no Telegram sent')
            else:
                raise RuntimeError('EXPECTED_MISSING_ACTION')
            try:
                sys.modules['_brai_codeworks_gateway'].call_plugin('actions.read', {}, 2)
            except RuntimeError as error:
                assert str(error) == 'TRUSTED_PLUGIN_REQUIRED'
            else:
                raise RuntimeError('TRUSTED_CALLER_CHECK_BYPASSED')
        return
    if args.gateway:
        from hermes_cli.main import main as native_main
        sys.argv = ['hermes', 'gateway', 'run', *rest]
        native_main()
        return
    if os.environ.get('CODEWORKS_IMPORT_CODEX_AUTH') == '1':
        from hermes_cli.auth_codex import _recover_codex_tokens_from_cli
        _recover_codex_tokens_from_cli('isolated Codeworks profile')
    from run_agent import AIAgent
    agent = AIAgent(provider='openai-codex', model=args.model, enabled_toolsets=['codeworks'],
                    max_iterations=24, quiet_mode=True, skip_context_files=True,
                    ephemeral_system_prompt='Use codeworks for all project access. It creates and selects the worktree automatically before code writes. Never use native filesystem tools.',
                    session_id=args.session_id, cwd=os.environ.get('CODEWORKS_PROJECT_ROOT'))
    try:
        result = agent.run_conversation(args.conversation or installed['input'])
        print(json.dumps({'native_session_id': agent.session_id, 'final_response': result.get('final_response', '')}, ensure_ascii=False))
    finally:
        agent.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print('CW_ERROR_' + (code if code.isupper() and len(code) <= 80 else type(error).__name__.upper()), file=sys.stderr)
        sys.exit(1)
