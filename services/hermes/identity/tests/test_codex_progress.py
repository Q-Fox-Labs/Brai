# ABOUTME: Проверяет различение прогресса и итогов событий Codex app-server.
# ABOUTME: Использует синтетические события без сервиса и сетевых вызовов.
from types import SimpleNamespace
import unittest

from identity.codex_progress import CodexProgress


def event(method, **params):
    return {'method': method, 'params': params}


def message(ident, text, phase=None):
    return {'id': ident, 'type': 'agentMessage', 'text': text, 'phase': phase}


class CodexProgressTests(unittest.TestCase):
    def setUp(self):
        self.progress = CodexProgress()

    def completed(self, *items, status='completed'):
        self.progress.observe(event('turn/completed', turn={'status': status, 'items': list(items)}))

    def result(self):
        turn = SimpleNamespace(final_text='старое значение', interrupted=False, error=None, projected_messages=[])
        partial = self.progress.reconcile(turn)
        return turn, partial

    def test_commentary_and_final_are_distinct(self):
        comment, final = message('a', 'Проверяю документы', 'commentary'), message('b', 'Итог готов', 'final_answer')
        for item in (comment, final):
            self.progress.observe(event('item/completed', item=item))
        self.completed(comment, final)
        turn, partial = self.result()
        self.assertEqual(turn.final_text, 'Итог готов')
        self.assertEqual(partial, '')
        self.assertFalse(turn.interrupted)

    def test_partial_answer_not_lost_or_duplicated(self):
        for final_text, expected in [('Первая часть и продолжение', 'Первая часть и продолжение'),
                                     ('Продолжение', 'Первая часть\n\nПродолжение')]:
            with self.subTest(final=final_text):
                self.progress.reset()
                first, final = message('a', 'Первая часть', 'partial_answer'), message('b', final_text, 'final_answer')
                self.progress.observe(event('item/completed', item=first))
                self.progress.observe(event('item/completed', item=final))
                self.completed(first, final)
                self.assertEqual(self.result()[0].final_text, expected)

    def test_missing_final_snapshot_is_recovered_and_recorded(self):
        final = message('a', 'Полный ответ', 'final_answer')
        self.progress.observe(event('item/started', item=message('a', '', 'final_answer')))
        self.progress.observe(event('item/agentMessage/delta', itemId='a', delta='Полный ответ'))
        self.completed(final)
        turn, partial = self.result()
        self.assertEqual((turn.final_text, partial), ('Полный ответ', ''))
        self.assertIn({'role': 'assistant', 'content': 'Полный ответ'}, turn.projected_messages)

    def test_interrupted_delta_is_partial_and_keeps_error(self):
        self.progress.observe(event('item/started', item=message('a', '', None)))
        self.progress.observe(event('item/agentMessage/delta', itemId='a', delta='Полученная часть'))
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertTrue(turn.error)
        self.assertEqual(partial, 'Полученная часть')

    def test_abort_marker_is_not_shown_as_partial_text(self):
        self.progress.observe(event('item/agentMessage/delta', itemId='a', delta='Часть<turn_aborted>'))
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(partial, 'Часть')

    def test_empty_completed_does_not_confirm_nonempty_delta(self):
        self.progress.observe(event('item/started', item=message('a', '', 'final_answer')))
        self.progress.observe(event('item/agentMessage/delta', itemId='a', delta='Полученная часть'))
        self.progress.observe(event('item/completed', item=message('a', '', 'final_answer')))
        self.completed(message('a', '', 'final_answer'))
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(partial, 'Полученная часть')

    def test_snapshot_cannot_hide_unfinished_later_delta(self):
        first = message('a', 'Начальная часть', 'final_answer')
        self.progress.observe(event('item/completed', item=first))
        self.progress.observe(event('item/started', item=message('b', '', 'final_answer')))
        self.progress.observe(event('item/agentMessage/delta', itemId='b', delta='Последующие важные данные'))
        self.completed(first)
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertIn('Начальная часть', partial)
        self.assertIn('Последующие важные данные', partial)

    def test_shortened_completed_text_does_not_discard_delta_tail(self):
        final = message('a', 'Первый фрагмент', 'final_answer')
        self.progress.observe(event('item/started', item=message('a', '', 'final_answer')))
        self.progress.observe(event('item/agentMessage/delta', itemId='a', delta='Первый фрагмент и скрытый хвост'))
        self.progress.observe(event('item/completed', item=final))
        self.completed(final)
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(partial, 'Первый фрагмент и скрытый хвост')

    def test_multiple_unfinished_items_are_all_preserved(self):
        for ident, phase, text in [('a', 'partial_answer', 'Первая наблюдённая часть'),
                                   ('b', 'final_answer', 'Вторая наблюдённая часть')]:
            self.progress.observe(event('item/started', item=message(ident, '', phase)))
            self.progress.observe(event('item/agentMessage/delta', itemId=ident, delta=text))
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(partial, 'Первая наблюдённая часть\n\nВторая наблюдённая часть')

    def test_snapshot_does_not_promote_message_before_tool(self):
        initial = message('a', 'Перед поиском проверю базу', None)
        for observed, kind in ((True, 'webSearch'), (False, 'webSearch'), (False, 'collabAgentToolCall')):
            with self.subTest(observed=observed, kind=kind):
                self.progress.reset()
                tool = {'id': 't', 'type': kind}
                if observed:
                    self.progress.observe(event('item/completed', item=initial))
                    self.progress.observe(event('item/completed', item=tool))
                self.completed(initial, tool)
                turn, partial = self.result()
                self.assertTrue(turn.interrupted)
                self.assertEqual((turn.final_text, partial), ('', ''))

    def test_full_snapshot_order_takes_priority_over_live_arrival_order(self):
        final, tool = message('a', 'Готовый итог', 'final_answer'), {'id': 't', 'type': 'commandExecution'}
        self.progress.observe(event('item/completed', item=final))
        self.progress.observe(event('item/completed', item=tool))
        self.completed(tool, final)
        turn, _ = self.result()
        self.assertFalse(turn.interrupted)
        self.assertEqual(turn.final_text, 'Готовый итог')

    def test_summary_snapshot_does_not_claim_missing_full_final(self):
        self.progress.observe(event('turn/completed', turn={'status': 'completed', 'itemsView': 'summary',
            'items': [message('a', 'Краткое содержание', 'final_answer')]}))
        turn, _ = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(turn.final_text, '')

    def test_empty_unloaded_snapshot_does_not_confirm_final(self):
        self.progress.observe(event('turn/completed', turn={'status': 'completed', 'itemsView': 'notLoaded', 'items': []}))
        turn, _ = self.result()
        self.assertTrue(turn.interrupted)
        self.assertTrue(turn.error)

    def test_commentary_followed_by_tool_is_not_final_or_resent(self):
        comment = message('a', 'Начинаю поиск', 'commentary')
        tool = {'id': 't', 'type': 'webSearch'}
        self.progress.observe(event('item/completed', item=comment))
        self.progress.observe(event('item/completed', item=tool))
        turn, partial = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(partial, '')

    def test_partial_only_and_missing_status_are_not_confirmed(self):
        part = message('a', 'Первая часть', 'partial_answer')
        for status in ('completed', None):
            with self.subTest(status=status):
                self.progress.reset()
                self.progress.observe(event('item/completed', item=part))
                self.completed(part, status=status)
                turn, partial = self.result()
                self.assertTrue(turn.interrupted)
                self.assertEqual(partial, 'Первая часть')

    def test_unknown_phase_can_be_final_only_after_successful_turn(self):
        item = message('a', 'Ответ без фазы', None)
        self.progress.observe(event('item/completed', item=item))
        self.completed(item)
        turn, partial = self.result()
        self.assertEqual((turn.final_text, partial), ('Ответ без фазы', ''))
        self.assertFalse(turn.interrupted)

    def test_reset_discards_previous_turn(self):
        self.progress.observe(event('item/completed', item=message('a', 'Старый ответ', 'final_answer')))
        self.completed()
        self.progress.reset()
        turn, _ = self.result()
        self.assertTrue(turn.interrupted)
        self.assertEqual(turn.final_text, '')
