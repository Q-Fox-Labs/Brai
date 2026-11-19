# ABOUTME: Проверяет временный Codex и проверку ответа без сети и авторизации.
# ABOUTME: Имитирует JSON-RPC и не создаёт пользовательские темы.
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'topic_names.py'
spec = importlib.util.spec_from_file_location('topic_names_test', path)
topic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(topic)


class FakeProcess:
    def __init__(self, selected=0):
        self.stdin = self
        self.stdout = asyncio.StreamReader()
        self.returncode = None
        self.calls = []
        self.selected = selected

    def emit(self, value):
        self.stdout.feed_data((json.dumps(value, ensure_ascii=False) + '\n').encode())

    def write(self, raw):
        value = json.loads(raw)
        if 'id' not in value:
            return
        self.calls.append(value)
        method, ident = value['method'], value['id']
        if method == 'initialize': result = {}
        elif method == 'model/list': result = {'data': [{'model': 'gpt-6-luna',
            'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}]}
        elif method == 'config/read': result = {'config': {'mcp_servers': {'foreign': {}}, 'plugins': {'foreign': {}}}}
        elif method == 'thread/start': result = {'model': 'gpt-6-luna', 'thread': {'id': 'own', 'ephemeral': True}}
        elif method == 'turn/start':
            result = {'turn': {'id': 'turn'}}
            self.emit({'method': 'item/completed', 'params': {'threadId': 'foreign', 'item':
                {'id': 'foreign', 'type': 'agentMessage', 'text': 'wrong'}}})
            self.emit({'method': 'item/completed', 'params': {'threadId': 'own', 'item':
                {'id': 'answer', 'type': 'agentMessage', 'phase': 'final_answer',
                 'text': json.dumps({'title': 'План отпуска', 'icon': self.selected})}}})
            self.emit({'method': 'turn/completed', 'params': {'threadId': 'own',
                'turn': {'id': 'turn', 'status': 'completed', 'items': []}}})
        else: raise AssertionError(method)
        self.emit({'id': ident, 'result': result})

    async def drain(self): pass
    def terminate(self): self.returncode = 0
    async def wait(self): return 0


@asynccontextmanager
async def fake_lock():
    yield


class TopicModelTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, selection=0):
        process = FakeProcess(selection)
        owner = SimpleNamespace(HOME=Path('/fixture'), CODEX_HOME=Path('/fixture/.codex'),
                                BINARY=Path('/fixture/codex'), owner_lock_async=fake_lock)
        async def start(*args, **kwargs): return process
        with patch.dict(sys.modules, {'hermes_cli': SimpleNamespace(codex_cli_owner=owner)}), \
                patch.object(topic.asyncio, 'create_subprocess_exec', side_effect=start):
            if selection:
                with self.assertRaises(ValueError):
                    await topic.suggest('Отпуск', [{'id': '12', 'emoji': '🏖️'}])
            else:
                self.assertEqual(await topic.suggest('Отпуск', [{'id': '12', 'emoji': '🏖️'}]),
                                 {'title': 'План отпуска', 'iconId': '12'})
        return process

    async def test_isolation_and_early_events(self):
        process = await self.exercise()
        thread = next(call['params'] for call in process.calls if call['method'] == 'thread/start')
        self.assertTrue(thread['ephemeral'])
        self.assertEqual(thread['dynamicTools'], [])
        self.assertFalse(thread['config']['mcp_servers.foreign.enabled'])
        self.assertFalse(thread['config']['plugins.foreign.enabled'])
        self.assertFalse(thread['config']['include_environment_context'])
        self.assertEqual(len([call for call in process.calls if call['method'] == 'turn/start']), 1)
        self.assertEqual(process.returncode, 0)

    async def test_rejects_foreign_icon_number(self):
        await self.exercise(selection=1)
