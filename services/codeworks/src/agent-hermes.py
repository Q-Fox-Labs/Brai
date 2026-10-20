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
from pathlib import Path
import sys
from functools import wraps

from importlib.util import spec_from_file_location, module_from_spec


def install():
    """Register the signed tool, keeping the signing key outside child environments."""
    key_file = Path('/run/codeworks-key')
    key = bytes.fromhex(key_file.read_text().strip())
    key_file.unlink()
    # AIDEV-NOTE: Untrusted native subprocesses cannot read this trusted process memory.
    if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
        raise RuntimeError('PROCESS_ISOLATION_REQUIRED')
    spec = spec_from_file_location('codeworks_proxy', Path(__file__).with_name('agent-proxy.py'))
    proxy = module_from_spec(spec)
    spec.loader.exec_module(proxy)
    from tools.registry import registry
    from toolsets import create_custom_toolset

    def handle(args, session_id='', **kwargs):
        """Use only dispatcher identity; model payload cannot choose another session."""
        if not session_id:
            return json.dumps({'error': 'NATIVE_SESSION_REQUIRED'})
        payload = json.dumps({'native_session_id': session_id, 'request': args}, ensure_ascii=False, separators=(',', ':'))
        envelope = {'payload': payload, 'signature': hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()}
        return json.dumps(proxy.call(envelope), ensure_ascii=False)

    schema = {'name': 'codeworks', 'description': proxy.TOOL['description'], 'parameters': proxy.TOOL['inputSchema']}
    registry.register(name='codeworks', toolset='codeworks', schema=schema, handler=handle)
    create_custom_toolset('codeworks', description='Managed project file access', tools=['codeworks'])
    native_dispatch = registry.dispatch

    def dispatch(name, args, **kwargs):
        """Fail closed before any native in-process code tool can access signer memory."""
        if name != 'codeworks':
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
        agent.tools = [{'type': 'function', 'function': schema}]
        agent.valid_tool_names = {'codeworks'}

    AIAgent.__init__ = managed_init
    return schema


def main():
    """Use the installed Hermes runtime; never replace its model or conversation loop."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', required=True)
    parser.add_argument('--conversation')
    parser.add_argument('--model', default='gpt-6.1-sol')
    parser.add_argument('--session-id')
    parser.add_argument('--gateway', action='store_true')
    parser.add_argument('--check-isolation', action='store_true')
    args, rest = parser.parse_known_args()
    sys.path.insert(0, args.engine)
    schema = install()
    if args.check_isolation:
        target = Path(os.environ['CODEWORKS_PROJECT_ROOT']) / ('.codeworks-native-probe-' + secrets.token_hex(8))
        try:
            target.write_text('native bypass')
        except OSError:
            print('PASS real Hermes launcher native source write denied by OS')
            return
        target.unlink()
        raise RuntimeError('NATIVE_SOURCE_WRITABLE')
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
        result = agent.run_conversation(args.conversation or sys.stdin.read())
        print(json.dumps({'native_session_id': agent.session_id, 'final_response': result.get('final_response', '')}, ensure_ascii=False))
    finally:
        agent.close()


if __name__ == '__main__':
    main()
