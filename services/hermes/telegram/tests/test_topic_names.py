# ABOUTME: Проверяет закрытый протокол предложения названия на временном Unix-сокете.
# ABOUTME: Запрос не передаёт Telegram IDs, а ответ не может выбрать чужой значок.
import asyncio
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

path = Path(__file__).resolve().parents[1] / 'topic_names.py'
spec = importlib.util.spec_from_file_location('topic_names_test', path)
topic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(topic)


class TopicSocketTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, response):
        async def answer(reader, writer):
            self.request = json.loads(await reader.read())
            writer.write(json.dumps(response).encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        with TemporaryDirectory(prefix='brai-topics-', dir='/tmp') as root:
            path = Path(root) / 'topic.sock'
            async with await asyncio.start_unix_server(answer, path=path):
                return await topic.suggest(path, 'Отпуск', [{'id': '12', 'emoji': '🏖️'}])

    async def test_selected_index_and_no_route_in_request(self):
        self.assertEqual(await self.exchange({'title': 'План отпуска', 'icon': 0}),
                         {'title': 'План отпуска', 'iconId': '12'})
        self.assertEqual(self.request, {'request': 'Отпуск', 'icons': ['🏖️']})

    async def test_rejects_invalid_title_or_icon(self):
        for response in ({'title': 'План', 'icon': 1}, {'title': 'План', 'icon': True},
                         {'title': 'План\nотпуска', 'icon': 0}, {'error': 'TOPIC_SUGGESTION_FAILED'}):
            with self.subTest(response=response), self.assertRaises(ValueError):
                await self.exchange(response)
