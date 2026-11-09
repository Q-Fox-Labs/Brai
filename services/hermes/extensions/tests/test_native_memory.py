# ABOUTME: Проверяет удаление файловой памяти на скомпонованном Hermes.
# ABOUTME: Использует временные подмены зависимостей; MemOS и рабочие файлы не изменяет.
import ast
from contextlib import suppress
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
ENGINE = os.environ.get('BRAI_NATIVE_ENGINE')


def functions(path, names, **namespace):
    """Загрузить настоящие native функции без запуска сетевого окружения движка."""
    tree = ast.parse((Path(ENGINE) / path).read_text())
    body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert len(body) == len(names), (path, names)
    for node in body:
        node.decorator_list = []
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *body], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), path, 'exec'), namespace)
    return types.SimpleNamespace(**namespace)


class DefaultsTests(unittest.TestCase):
    def test_new_profiles_use_memos_without_file_memory(self):
        settings = json.loads((ROOT / 'config/server-defaults.json').read_text())
        self.assertEqual(settings['memory']['provider'], 'memos-rest')
        self.assertIs(settings['memory']['memory_enabled'], False)
        self.assertIs(settings['memory']['user_profile_enabled'], False)
        self.assertEqual(settings['memory']['nudge_interval'], 0)
        # Имя группы memory нужно штатной инъекции инструментов внешнего provider.
        self.assertIn('memory', settings['platform_toolsets']['telegram'])


@unittest.skipUnless(ENGINE, 'BRAI_NATIVE_ENGINE points to a composed pinned engine')
class NativeMemoryTests(unittest.TestCase):
    def memory(self):
        return functions('tools/memory_tool.py', {'get_builtin_memory_store_flags', 'memory_tool', 'check_memory_requirements'},
                         _memory_surface_flags=Mock(), tool_error=lambda text, **kw: {'error': text, **kw})

    def test_stale_profile_cannot_restore_file_memory(self):
        memory = self.memory()
        for config in (None, {}, {'memory': {'memory_enabled': True, 'user_profile_enabled': True}}):
            self.assertEqual(memory.get_builtin_memory_store_flags(config), (False, False))
        self.assertFalse(memory.check_memory_requirements())

    def test_direct_old_tool_calls_cannot_read_write_or_stage(self):
        memory = self.memory()
        store = Mock()
        for action in ('add', 'replace', 'remove'):
            result = memory.memory_tool(action=action, content='synthetic', store=store)
            self.assertIs(result['success'], False)
            self.assertIn('MemOS', result['error'])
        self.assertEqual(store.mock_calls, [])

    def test_cli_and_gateway_have_no_memory_handler_but_keep_skills(self):
        for name in ('hermes_cli/cli_commands_mixin.py', 'gateway/slash_commands.py'):
            tree = ast.parse((Path(ENGINE) / name).read_text())
            methods = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
            self.assertNotIn('_handle_memory_command', methods)
            self.assertIn('_handle_skills_command', methods)

    def test_idle_dispatch_omits_removed_memory_command(self):
        tree = ast.parse((Path(ENGINE) / 'gateway/run_busy.py').read_text())
        assignment = next(node for node in ast.walk(tree)
                          if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == '_IDLE_COMMANDS'
                                  for target in node.targets))
        commands = ast.literal_eval(assignment.value)
        self.assertNotIn('memory', commands)
        self.assertIn('skills', commands)

    def test_idle_dispatch_does_not_bind_removed_memory_handler(self):
        tree = ast.parse((Path(ENGINE) / 'gateway/run_busy.py').read_text())
        names = {'_command_handler_table', '_gateway_idle_command_handlers'}
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                     and any(isinstance(child, ast.FunctionDef) and child.name in names for child in node.body))
        constants = {}
        for node in owner.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in {'_IDLE_COMMANDS', '_COMMAND_HANDLER_ALIASES'}:
                        constants[target.id] = ast.literal_eval(node.value)
        body = [node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name in names]
        namespace = {}
        future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *body], type_ignores=[])),
                     'gateway/run_busy.py', 'exec'), namespace)
        runner = types.SimpleNamespace(**constants)
        runner._command_handler_table = types.MethodType(namespace['_command_handler_table'], runner)
        # Удалённого метода действительно нет; обычный idle вход всё равно строит эту таблицу.
        for command in runner._IDLE_COMMANDS:
            if command != 'memory':
                method = runner._COMMAND_HANDLER_ALIASES.get(command, f"_handle_{command.replace('-', '_')}_command")
                setattr(runner, method, Mock(name=method))
        handlers = namespace['_gateway_idle_command_handlers'](runner)
        self.assertNotIn('memory', handlers)
        self.assertIs(handlers['skills'], runner._handle_skills_command)
        self.assertIn('model', handlers)

    def test_shared_command_catalog_has_no_memory_command(self):
        # Реальные CommandDef и реестр выполняются с нейтральными импортами.
        source = ast.parse((Path(ENGINE) / 'hermes_cli/commands.py').read_text())
        body = [node for node in source.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
        import dataclasses, logging, re
        from typing import Optional
        from collections.abc import Iterable
        namespace = dict(dataclass=dataclasses.dataclass, logging=logging, re=re, Optional=Optional,
                         Iterable=Iterable, is_truthy_value=bool, t=lambda value: value, INDICATOR_STYLES=())
        # Нужен только CommandDef и объявление каталога, без plugin discovery.
        registry = next(i for i, node in enumerate(body) if isinstance(node, ast.AnnAssign)
                        and isinstance(node.target, ast.Name) and node.target.id == 'COMMAND_REGISTRY')
        exec(compile(ast.Module(body=body[:registry+1], type_ignores=[]), 'commands.py', 'exec'), namespace)
        names = {command.name for command in namespace['COMMAND_REGISTRY']}
        self.assertNotIn('memory', names)
        self.assertIn('skills', names)

    def test_existing_memos_manager_and_tools_survive_initialization(self):
        memory = self.memory()
        store_factory = Mock(side_effect=AssertionError('File memory must not open'))
        native = types.ModuleType('tools.memory_tool')
        native.MemoryStore = store_factory
        native.get_builtin_memory_config = lambda config: config['memory']
        native.get_builtin_memory_store_flags = memory.get_builtin_memory_store_flags
        manager = types.ModuleType('agent.memory_manager')
        manager.inject_memory_provider_tools = Mock()
        agent = types.SimpleNamespace(enabled_toolsets=['memory'], disabled_toolsets=[])
        memos_manager = object()
        init = functions('agent/agent_init.py', {'_init_memory'}, suppress=suppress)
        with patch.dict('sys.modules', {'tools.memory_tool': native, 'agent.memory_manager': manager}):
            init._init_memory(agent, {'memory': {'provider': 'memos-rest', 'memory_enabled': True,
                              'user_profile_enabled': True}}, False, 'telegram', memory_manager=memos_manager)
        self.assertIs(agent._memory_manager, memos_manager)
        self.assertIsNone(agent._memory_store)
        self.assertFalse(agent._memory_enabled or agent._user_profile_enabled)
        store_factory.assert_not_called()
        manager.inject_memory_provider_tools.assert_called_once_with(agent)
        tick = functions('agent/turn_context.py', {'_tick_memory_nudge'})
        agent.valid_tool_names = ['memory']
        for _ in range(25):
            self.assertFalse(tick._tick_memory_nudge(agent))

    def test_external_provider_tools_keep_their_technical_toolset(self):
        manager = functions('agent/memory_manager.py', {'memory_provider_tools_enabled'})
        self.assertTrue(manager.memory_provider_tools_enabled(['memory']))
        self.assertFalse(manager.memory_provider_tools_enabled(['memory'], ['memory']))


if __name__ == '__main__':
    unittest.main()
