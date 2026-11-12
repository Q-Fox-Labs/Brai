# ABOUTME: Проверяет закрепление guest browser client за принятым PM и чистым config.
# ABOUTME: Не запускает браузер и не устанавливает пакеты.
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import guest_browser


class GuestBrowserGuardTest(unittest.TestCase):
    def test_binary_only_from_accepted_store(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / 'tools/agent-browser'
            binary.parent.mkdir()
            binary.write_text('fixture')
            binary.chmod(0o755)
            pm = SimpleNamespace(installed_package=lambda name: SimpleNamespace(binary=binary))
            original_lstat = Path.lstat
            def trusted(path):
                info = original_lstat(path)
                return SimpleNamespace(st_uid=0, st_mode=info.st_mode & ~0o022)
            with patch.dict(sys.modules, {'pm': pm}), patch.object(guest_browser, 'PM_ROOT', root), \
                    patch.object(Path, 'lstat', trusted):
                self.assertEqual(guest_browser.accepted_binary(), str(binary))
                binary.unlink()
                with self.assertRaises(FileNotFoundError):
                    guest_browser.accepted_binary()
                pm.installed_package = lambda name: None
                with self.assertRaises(FileNotFoundError):
                    guest_browser.accepted_binary()
                pm.installed_package = lambda name: SimpleNamespace(binary=Path('/bin/sh'))
                with self.assertRaises(FileNotFoundError):
                    guest_browser.accepted_binary()

    def test_clean_environment_rejects_inherited_and_pm_browser_overrides(self):
        pm = SimpleNamespace(env_for=lambda name, base_env: {**base_env,
            'AGENT_BROWSER_ARGS': '--no-sandbox', 'PATH': '/trusted/bin:/usr/bin:/bin'})
        with patch.dict(sys.modules, {'pm': pm}), patch.dict(os.environ,
                {'HOME': '/worker', 'AGENT_BROWSER_ARGS': '--evil', 'NODE_OPTIONS': '--require bad'}, clear=True):
            env = guest_browser.command_env('/tmp/session')
        self.assertEqual(env['AGENT_BROWSER_CONFIG'], guest_browser.CONFIG)
        self.assertEqual(env['AGENT_BROWSER_SOCKET_DIR'], '/tmp/session')
        self.assertNotIn('AGENT_BROWSER_ARGS', env)
        self.assertNotIn('NODE_OPTIONS', env)

    def test_install_locks_cdp_and_disables_lookup_fallback(self):
        tools = ModuleType('tools')
        tools.browser_tool_cdp = SimpleNamespace()
        tools.browser_tool_install = SimpleNamespace()
        tools.browser_tool_lightpanda_fallback = SimpleNamespace()
        tools.browser_tool_real_profile = SimpleNamespace()
        tools.browser_tool_session = SimpleNamespace(_dispatch_browser_command=lambda *a: a,
            _popen_agent_browser=lambda *a: a, _create_cdp_session=lambda task, url: (task, url),
            _shim_safe_args=lambda argv0, command, args: (command,args,None))
        with patch.dict(sys.modules, {'tools': tools}), patch.dict(os.environ,
                {'AGENT_BROWSER_CONFIG': '/evil', 'AGENT_BROWSER_ARGS': '--evil'}, clear=True):
            guest_browser.install()
            self.assertNotIn('AGENT_BROWSER_ARGS', os.environ)
            self.assertEqual(os.environ['AGENT_BROWSER_CONFIG'], guest_browser.CONFIG)
            self.assertEqual(tools.browser_tool_cdp._get_cdp_override_raw(), guest_browser.CDP_URL)
            self.assertIs(tools.browser_tool_install._find_agent_browser, guest_browser.accepted_binary)
            self.assertIs(tools.browser_tool_session._agent_browser_command_env, guest_browser.command_env)
            session = tools.browser_tool_session._create_session_for_key('test', True)
            self.assertEqual(session, ('test', guest_browser.CDP_URL))
            dispatched = tools.browser_tool_session._dispatch_browser_command('test',
                {'session_name': 'fake', 'cdp_url': None}, '/bin/fake', 'open', [], 1, 'lightpanda')
            self.assertEqual(dispatched[1]['cdp_url'], guest_browser.CDP_URL)
            self.assertEqual(dispatched[-1], 'auto')

    def test_typed_text_cannot_become_a_global_client_option(self):
        original = lambda argv0, command, args: (command,args,None)
        for command in ('fill','type'):
            for text in ('--allow-file-access','--auto-connect','--ignore-https-errors',
                         '--config=/untrusted.json','Кириллица\n100% literal'):
                with self.subTest(command=command,text=text):
                    actual, args, payload = guest_browser.data_arguments(
                        original,'/trusted/agent-browser',command,['@e1',text])
                    self.assertEqual((actual,args),('batch',[]))
                    self.assertEqual(json.loads(payload),[[command,'@e1',text]])
        self.assertEqual(guest_browser.data_arguments(original,'/trusted/agent-browser',
            'snapshot',['--compact']),('snapshot',['--compact'],None))

    def test_spawn_refuses_unsafe_or_missing_cdp(self):
        original = lambda *args: args
        with patch.object(guest_browser, 'accepted_binary', return_value='/trusted/agent-browser'), \
                patch.object(guest_browser, 'command_env', return_value={'safe': 'yes'}):
            argv = ['/trusted/agent-browser', '--session', 's', '--cdp', guest_browser.CDP_URL, '--json', 'open']
            result = guest_browser.guarded_spawn(original, argv, {'evil': 'yes'}, '/tmp/s', 'open')
            self.assertEqual(result[1], {'safe': 'yes'})
            for bad in (['/trusted/agent-browser', '--json', 'open'],
                        ['/trusted/agent-browser', '--cdp', 'http://evil', '--json', 'open'],
                        ['/trusted/agent-browser', '--cdp', guest_browser.CDP_URL, '--engine', 'chrome', '--json', 'open']):
                with self.assertRaises(PermissionError):
                    guest_browser.guarded_spawn(original, bad, {}, '/tmp/s', 'open')


if __name__ == '__main__':
    unittest.main()
