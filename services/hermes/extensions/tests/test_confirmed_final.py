# ABOUTME: Проверяет передачу подтверждённого финала без следующего inference.
# ABOUTME: Использует вымышленные tool receipts; сеть и пользовательские данные не читает.
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest


def budget_module():
    """Загрузить именно поставляемый модуль из native patch."""
    path = Path(__file__).resolve().parents[1] / 'patches/turn-request-budget.patch'
    section = path.read_text().split('diff --git a/agent/brai_turn_budget.py b/agent/brai_turn_budget.py', 1)[1]
    section = section.split('diff --git ', 1)[0]
    source = '\n'.join(line[1:] for line in section.splitlines()
                       if line.startswith('+') and not line.startswith('+++'))
    module = types.ModuleType('confirmed_final_fixture')
    exec(compile(source, 'agent/brai_turn_budget.py', 'exec'), module.__dict__)
    return module


def finished_messages(*, wrapped=True, envelope=True):
    """Создать одиночный finish и квитанцию тех же байтов и идентификаторов."""
    text = 'Подготовленный ответ.\n\nBRAI_FILES:{"mode":"files","items":[]}'
    submitted = {'request_id': 'finish-1', 'dialogue_id': 'telegram:synthetic',
                 'turn_id': 'turn-1', 'expected_version': '5',
                 'final': {'id': 'final-1', 'text': text}}
    args = {'action': 'finish', 'arguments': submitted}
    name = 'mcp__brai__dialogues_exchange'
    call = {'id': 'call-1', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
    if wrapped:
        call['function'] = {'name': 'tool_call', 'arguments': json.dumps({'calls': [{'name': name, 'arguments': args}]})}
    receipt = {'request_id': 'finish-1', 'dialogue_id': 'telegram:synthetic', 'turn_id': 'turn-1',
               'version': '6', 'status': 'completed',
               'final': {'id': 'final-1', 'sha256': hashlib.sha256(text.encode()).hexdigest()}}
    content = json.dumps({'result': receipt})
    if envelope:
        content = '<untrusted_tool_result source="mcp__brai__dialogues_exchange">\nExternal data.\n\n' + content + '\n</untrusted_tool_result>'
    return [{'role': 'user', 'content': 'Подготовь ответ'},
            {'role': 'assistant', 'content': '', 'tool_calls': [call]},
            {'role': 'tool', 'tool_call_id': 'call-1', 'tool_name': name, 'content': content}], text


class ConfirmedFinalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.budget = budget_module()

    def test_confirmed_bytes_preserve_files_marker_without_model_rewrite(self):
        for wrapped in (False, True):
            for envelope in (False, True):
                messages, text = finished_messages(wrapped=wrapped, envelope=envelope)
                before = copy.deepcopy(messages)
                self.assertEqual(self.budget.confirmed_dialogues_final(messages, 0), text)
                self.assertEqual(messages, before)

    def test_native_transcript_without_optional_tool_name_is_supported(self):
        messages, text = finished_messages()
        messages[-1].pop('tool_name')
        self.assertEqual(self.budget.confirmed_dialogues_final(messages, 0), text)

    def test_unknown_or_conflicting_receipt_cannot_finish_turn(self):
        for field, value in [('status', 'pending'), ('request_id', 'other'), ('dialogue_id', 'other'),
                             ('turn_id', 'other'), ('final', {'id': 'final-1', 'sha256': '0' * 64}),
                             ('final', {'id': 'other', 'sha256': '0' * 64})]:
            messages, _ = finished_messages(envelope=False)
            receipt = json.loads(messages[-1]['content'])
            receipt['result'][field] = value
            messages[-1]['content'] = json.dumps(receipt)
            with self.subTest(field=field, value=value):
                self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 0))

    def test_new_user_input_or_later_tool_disallows_old_final(self):
        messages, _ = finished_messages()
        messages.append({'role': 'user', 'content': 'Измени ответ'})
        self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 3))
        self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 0))
        messages.append({'role': 'tool', 'content': '{}'})
        self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 0))

    def test_parallel_batch_and_foreign_tool_are_not_completion_authority(self):
        for change in ('batch', 'foreign', 'id', 'operation'):
            messages, _ = finished_messages()
            fn = messages[1]['tool_calls'][0]['function']
            args = json.loads(fn['arguments'])
            if change == 'batch':
                args['calls'].append(copy.deepcopy(args['calls'][0]))
            elif change == 'foreign':
                args['calls'][0]['name'] = 'terminal'
            elif change == 'id':
                messages[-1]['tool_call_id'] = 'other'
            else:
                args['calls'][0]['arguments']['action'] = 'update'
            fn['arguments'] = json.dumps(args)
            with self.subTest(change=change):
                self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 0))

    def test_malformed_result_cannot_interrupt_normal_tool_loop(self):
        for value in ('not json', '{}', 'null', '[]', '{"result":null}'):
            messages, _ = finished_messages()
            messages[-1]['content'] = value
            self.assertIsNone(self.budget.confirmed_dialogues_final(messages, 0))


if __name__ == '__main__':
    unittest.main()
