# ABOUTME: Проверяет русский каталог команд и описания встроенных навыков Hermes.
# ABOUTME: Выполняет настоящий форматировщик в подготовленной копии без подключения к сервисам.
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CommandCatalogRussianTests(unittest.TestCase):
    def test_product_skill_descriptions_are_russian(self):
        import yaml
        project = Path(__file__).resolve().parents[4]
        roots = (project / 'docs/user-agent/instructions/hermes/skills',
                 project / 'docs/user-agent/instructions/skills/brai-task-workflows')
        paths = [path for root in roots for path in root.rglob('SKILL.md')]
        self.assertEqual(len(paths), 12)
        for path in paths:
            with self.subTest(skill=str(path.relative_to(project))):
                front = path.read_text(encoding='utf-8-sig').split('---', 2)[1]
                description = yaml.safe_load(front)['description']
                self.assertRegex(description, '[А-Яа-яЁё]')
                self.assertNotRegex(description, '[\u3400-\u9fff]')

    def test_all_bundled_skill_descriptions_reach_paginated_catalog_in_russian(self):
        candidate = os.environ.get('HERMES_TEST_CANDIDATE')
        if not candidate:
            self.skipTest('Нужна проверочная копия движка HERMES_TEST_CANDIDATE')
        code = r'''
import json, sys, types, yaml
from pathlib import Path
sys.modules['hermes_yaml'] = yaml
from hermes_cli import slash_exec, commands
commands._resolve_config_gates = lambda: set()
skills = {}
for path in sorted((Path(sys.argv[1]) / 'skills').rglob('SKILL.md')):
    front = path.read_text(encoding='utf-8-sig').split('---', 2)[1]
    metadata = yaml.safe_load(front)
    name = metadata['name']
    skills['/' + name] = {'name': name, 'description': metadata['description']}
slash_exec._skill_commands = lambda: skills
sys.modules['tools.skills_tool'] = types.SimpleNamespace(_find_all_skills=lambda: [])
ctx = lambda page: slash_exec.CommandContext(surface='gateway', args=str(page), options={'page_size': 15})
first = slash_exec._exec_commands(ctx(1)).text
pages = [slash_exec._exec_commands(ctx(page)).text for page in range(1, 20)]
commands.get_language = lambda: 'en'
english_hint = commands._gateway_argument_hint('[name] <prompt>')
print(json.dumps({'skills': skills, 'first': first, 'pages': pages, 'english_hint': english_hint}, ensure_ascii=False))
'''
        with tempfile.TemporaryDirectory() as home:
            env = {**os.environ, 'HERMES_LANGUAGE': 'ru', 'HERMES_HOME': home,
                   'PYTHONPATH': str(Path(candidate).resolve())}
            result = subprocess.run([sys.executable, '-c', code, candidate], env=env,
                                    capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(len(data['skills']), 58)
        output = '\n'.join(data['pages'])
        self.assertIn('Команды', data['first'])
        for command, info in data['skills'].items():
            with self.subTest(command=command):
                self.assertRegex(info['description'], '[А-Яа-яЁё]')
                self.assertNotRegex(info['description'], '[\u3400-\u9fff]')
                self.assertIn(f"`{command}` — {info['description']}", output)
        self.assertIn('Создавать инфографику', data['skills']['/baoyu-infographic']['description'])
        self.assertNotIn('信息图', output)
        self.assertNotIn('Поставить промпт', output)
        self.assertIn('Добавить сообщение в очередь', output)
        self.assertIn('`/bg <запрос>`', output)
        self.assertIn('`/new [название]`', output)
        self.assertNotIn('<prompt>', output)
        self.assertIn('--provider название', output)
        self.assertEqual(data['english_hint'], '[name] <prompt>')


if __name__ == '__main__':
    unittest.main()
