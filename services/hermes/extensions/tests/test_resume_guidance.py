# ABOUTME: Проверяет правила продолжения прерванной работы в поставляемой подсказке.
# ABOUTME: Не запускает модель, Telegram или пользовательские процессы.
import ast
from pathlib import Path
import unittest
from typing import Optional


class ResumeGuidanceTests(unittest.TestCase):
    def test_new_message_keeps_interrupted_work_and_checks_action_outcomes(self):
        patch = (Path(__file__).resolve().parents[1] / 'patches/hermes-core.patch').read_text()
        section = patch.split('diff --git a/gateway/return_notices.py b/gateway/return_notices.py', 1)[1]
        section = section.split('diff --git ', 1)[0]
        source = '\n'.join(line[1:] for line in section.splitlines()
                           if line.startswith('+') and not line.startswith('+++'))
        tree = ast.parse(source)
        node = next(node for node in tree.body
                    if isinstance(node, ast.FunctionDef) and node.name == 'build_resume_recovery_note')
        scope = {'Optional': Optional}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                     'return_notices.py', 'exec'), scope)
        note = scope['build_resume_recovery_note']('restart_timeout', 'Ты тут?', interactive=True)
        self.assertIn('continue the interrupted task unless the user stopped or replaced it', note)
        self.assertIn('check the outcome of uncertain actions before retrying', note)
        self.assertNotIn('skip any unfinished work', note)


if __name__ == '__main__':
    unittest.main()
