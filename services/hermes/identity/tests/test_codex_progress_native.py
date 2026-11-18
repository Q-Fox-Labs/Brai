# ABOUTME: Проверяет подключение фаз Codex к настоящим функциям закреплённого Hermes.
# ABOUTME: Использует синтетические события и не запускает службы или модель.
import ast
import functools
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

IDENTITY = Path(__file__).resolve().parents[1]


def patched_tree(target, fixture):
    """Применить продуктовый патч к закреплённому участку исходника."""
    marker = f'--- a/{target}\n+++ b/{target}\n'
    source = (IDENTITY / 'native.patch').read_text()
    block = marker + source.split(marker, 1)[1].split('--- a/', 1)[0].split('diff --git ', 1)[0]
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        path = root / target
        path.parent.mkdir(parents=True)
        path.write_text((IDENTITY / 'tests/fixtures/ordinary_release/agent' / fixture).read_text())
        subprocess.run(['patch', '-p1', '--batch'], cwd=root, input=block, text=True,
                       stdout=subprocess.DEVNULL, check=True)
        return ast.parse(path.read_text())


def load_function(tree, name, scope):
    """Загрузить фактическую функцию без запуска gateway."""
    node = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    node.decorator_list = []
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, node], type_ignores=[])), 'native-codex', 'exec'), scope)
    return scope[name]


def guarded(callback, _message, *_args, args=(), kwargs=None):
    if callable(callback):
        callback(*args, **(kwargs or {}))


class CodexProgressNativeTests(unittest.TestCase):
    def setUp(self):
        self.runtime = patched_tree('agent/codex_runtime.py', 'codex_runtime.py')
        self.session = patched_tree('agent/transports/codex_app_server_session.py', 'codex_app_server_session.py')

    def test_bridge_only_publishes_confirmed_commentary(self):
        tools = {'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'}
        delta_methods = (('item/agentMessage/delta', '_fire_stream_delta'),
                         ('item/reasoning/delta', '_fire_reasoning_delta'))
        scope = dict(os=os, functools=functools, time=time, _call_guarded=guarded,
                     _CODEX_TOOL_ITEM_TYPES=tools, _CODEX_TEXT_DELTA_METHODS=delta_methods,
                     _CODEX_PROGRESS_DELTA_METHODS={item[0] for item in delta_methods},
                     _CODEX_PROGRESS_ITEM_TYPES=tools | {'agentMessage', 'reasoning'},
                     _delta_text=lambda params: params.get('delta', ''),
                     _codex_item_to_tool_name=lambda item: 'tool', _codex_item_to_args=lambda item: {},
                     _codex_item_to_preview=lambda item: '', _stable_call_id=lambda item, name: 'id')
        make = load_function(self.runtime, 'make_codex_app_server_event_bridge', scope)
        agent = SimpleNamespace(show_commentary=True, _current_streamed_assistant_text='',
            _fire_stream_delta=Mock(), _fire_reasoning_delta=Mock(), _emit_interim_assistant_message=Mock(),
            _touch_activity=Mock(), tool_progress_callback=Mock(), tool_start_callback=Mock())
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            bridge = make(agent)
            for ident, phase, text in [('a', 'commentary', 'Проверяю'), ('b', 'final_answer', 'Готово'),
                                       ('c', None, 'Без фазы')]:
                item = {'id': ident, 'type': 'agentMessage', 'phase': phase, 'text': text}
                bridge({'method': 'item/started', 'params': {'item': item}})
                bridge({'method': 'item/agentMessage/delta', 'params': {'itemId': ident, 'delta': text}})
                bridge({'method': 'item/completed', 'params': {'item': item}})
            agent._emit_interim_assistant_message.assert_called_once_with({'role': 'assistant', 'content': 'Проверяю'})
            agent._fire_stream_delta.assert_not_called()
            self.assertEqual(agent._brai_codex_progress.items['c']['text'], 'Без фазы')
            self.assertEqual(agent._brai_codex_progress.items['c']['deltas'], ['Без фазы'])

    def test_session_does_not_accept_commentary_or_unknown_as_early_final(self):
        scope = dict(os=os, _apply_accounting_notification=lambda *_: None,
                     _has_turn_aborted_marker=lambda text: '<turn_aborted>' in text)
        absorb = load_function(self.session, '_absorb_notification', scope)
        session = SimpleNamespace(_on_event=None, _track_pending_file_change=lambda note: None)
        turn = SimpleNamespace(final_text='', projected_messages=[], tool_iterations=0, interrupted=False, error=None)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            for phase in ('commentary', 'partial_answer', None):
                projection = SimpleNamespace(final_text='Работаю', messages=[{'role': 'assistant', 'content': 'Работаю'}],
                                             is_tool_iteration=False)
                projector = SimpleNamespace(project=lambda note: projection)
                note = {'params': {'item': {'type': 'agentMessage', 'phase': phase}}}
                absorb(session, turn, projector, note)
                self.assertEqual(turn.final_text, '')
                self.assertIsNone(projection.final_text)
            projection = SimpleNamespace(final_text='Итог', messages=[], is_tool_iteration=False)
            absorb(session, turn, SimpleNamespace(project=lambda note: projection),
                   {'params': {'item': {'type': 'agentMessage', 'phase': 'final_answer'}}})
            self.assertEqual(turn.final_text, 'Итог')
            projection = SimpleNamespace(final_text=None, messages=[], is_tool_iteration=True)
            absorb(session, turn, SimpleNamespace(project=lambda note: projection),
                   {'params': {'item': {'type': 'commandExecution'}}})
            self.assertEqual(turn.final_text, '')

    def test_session_keeps_abort_marker_interrupt(self):
        scope = dict(os=os, _apply_accounting_notification=lambda *_: None,
                     _has_turn_aborted_marker=lambda text: '<turn_aborted>' in text)
        absorb = load_function(self.session, '_absorb_notification', scope)
        session = SimpleNamespace(_on_event=None, _track_pending_file_change=lambda note: None)
        turn = SimpleNamespace(final_text='', projected_messages=[], tool_iterations=0, interrupted=False, error=None)
        projection = SimpleNamespace(final_text='<turn_aborted>', messages=[], is_tool_iteration=False)
        with patch.dict(os.environ, {'BRAI_IDENTITY_MODE': 'worker'}):
            _, aborted = absorb(session, turn, SimpleNamespace(project=lambda note: projection),
                                {'params': {'item': {'type': 'agentMessage', 'phase': None}}})
        self.assertTrue(aborted)
        self.assertTrue(turn.interrupted)
        self.assertTrue(turn.error)

    def test_turn_reconciles_result_and_preserves_interrupted_delta(self):
        from identity.codex_progress import CodexProgress
        progress = CodexProgress()
        agent = SimpleNamespace(_brai_codex_progress=progress, _codex_session_model_provider=None)
        scope = dict(_ensure_codex_session=lambda *_: None, _start_codex_thread=lambda *_: None,
                     _codex_wire_model=lambda *_: 'model', _codex_turn_effort=lambda *_: None,
                     _codex_turn_service_tier=lambda *_: None,
                     _persist_projected_messages=lambda *a: False, _close_codex_session=lambda *_: None,
                     _finish_codex_turn=lambda *a, **kw: {}, logger=logging.getLogger('test-codex-turn'))
        load_function(self.runtime, '_consume_user_interrupt', scope)
        load_function(self.runtime, '_turn_result', scope)
        run = load_function(self.runtime, 'run_codex_app_server_turn', scope)
        def run_turn(**kwargs):
            progress.observe({'method': 'item/completed', 'params': {'item': {
                'id': 'a', 'type': 'agentMessage', 'phase': 'commentary', 'text': 'Проверяю'}}})
            progress.observe({'method': 'turn/completed', 'params': {'turn': {'status': 'completed', 'items': [
                {'id': 'b', 'type': 'agentMessage', 'phase': 'final_answer', 'text': 'Полный итог'}]}}})
            return SimpleNamespace(interrupted=False, error=None, final_text='Проверяю', should_retire=False,
                                   projected_messages=[], thread_id='thread', turn_id='turn')
        agent._codex_session = SimpleNamespace(run_turn=run_turn)
        result = run(agent, user_message='тест', original_user_message='тест', messages=[], effective_task_id='task')
        self.assertEqual(result['final_response'], 'Полный итог')
        self.assertTrue(result['completed'])

        def failed_turn(**kwargs):
            progress.observe({'method': 'item/agentMessage/delta', 'params': {'itemId': 'a', 'delta': 'Часть'}})
            raise RuntimeError('сбой транспорта')
        agent._codex_session.run_turn = failed_turn
        with self.assertLogs('test-codex-turn', level='ERROR'):
            result = run(agent, user_message='тест', original_user_message='тест', messages=[], effective_task_id='task')
        self.assertEqual(result['brai_delivered_partial'], 'Часть')
        self.assertFalse(result['completed'])
        self.assertFalse(result['interrupted'])
        self.assertEqual(result['error'], 'сбой транспорта')

        def incomplete_turn(**kwargs):
            progress.observe({'method': 'item/agentMessage/delta', 'params': {'itemId': 'a', 'delta': 'Неполный ответ'}})
            return SimpleNamespace(interrupted=True, error='обрыв связи', final_text='', should_retire=False,
                                   projected_messages=[], thread_id='thread', turn_id='turn')
        agent._codex_session.run_turn = incomplete_turn
        result = run(agent, user_message='тест', original_user_message='тест', messages=[], effective_task_id='task')
        self.assertEqual(result['brai_delivered_partial'], 'Неполный ответ')
        self.assertFalse(result['interrupted'])
        self.assertTrue(result['partial'])

        agent._interrupt_requested = True
        agent._interrupt_message = 'Новое сообщение'
        agent.clear_interrupt = Mock()
        result = run(agent, user_message='тест', original_user_message='тест', messages=[], effective_task_id='task')
        self.assertTrue(result['interrupted'])
        self.assertEqual(result['interrupt_message'], 'Новое сообщение')
        agent.clear_interrupt.assert_called_once()
